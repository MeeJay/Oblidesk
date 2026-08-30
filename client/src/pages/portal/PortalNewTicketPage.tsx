/**
 * PortalNewTicketPage — `/portal/new`, where a customer files a request.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 *  "WHEN DID IT HAPPEN?" IS A FIRST-CLASS FIELD, NOT AN ADVANCED OPTION.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * HARD RULE 6: `tickets.occurred_at` answers when the incident actually
 * started, `created_at` answers when the row was written, and the two are
 * different columns because the first one CANNOT BE RECONSTRUCTED AFTERWARDS.
 * A customer who noticed at 02:14 and got round to filing at 09:00 is the whole
 * reason the column exists: put 09:00 in it and the detection gap, every
 * elapsed-time metric on the ticket and Rewind — the reconstruction of what the
 * environment looked like at incident time — are all quietly wrong for ever,
 * with nothing on the ticket showing that they are.
 *
 * The intake form is the only place this fact is ever available. That is why the
 * field sits in the form, above the description, rather than behind a
 * disclosure triangle nobody opens: the person who knows the real time has to be
 * ASKED, in plain words, while they still remember. It defaults to now, which is
 * right for the common case, and it is capped at now, because an incident that
 * has not happened yet makes every duration on the ticket negative.
 *
 * ── What the customer is NOT asked ──────────────────────────────────────────
 * No priority, no queue, no category. Not out of distrust: those are DERIVED —
 * the priority matrix owns priority, routing owns the queue, the state machine
 * owns the opening status. A portal that let a requester tick "critical" would
 * be a portal where everything is critical inside a month, and the matrix would
 * be decoration.
 *
 * ── Required-ness (HARD RULE 12) ────────────────────────────────────────────
 * Only the subject is demanded, because only the subject is demanded by the
 * server. A thin request that a customer can actually send beats a complete
 * form they abandon, and the desk can ask for the rest in the first reply.
 *
 * ── Attachments come after the ticket, and that is not a workaround ─────────
 * The portal's upload route is `POST /portal/tickets/:id/attachments`: a blob is
 * linked to a ticket as it is stored, so `assertAttachmentVisible` can answer
 * for it on the very next request and the orphan sweeper never collects a file
 * somebody is about to attach. There is therefore no ticket-less upload to call
 * here. Files picked on this form are held in the browser and uploaded against
 * the new ticket the instant it exists — before the customer is navigated to it,
 * so the request they land on is already complete.
 */

import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import { ChevronLeft, Paperclip, Send, X } from 'lucide-react';
import { LIMITS } from '@oblidesk/shared';

import { portalApi } from '@/api/portal.api';
import { ApiError } from '@/api/client';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { formatBytes } from '@/utils/format';
import { cn } from '@/utils/cn';

import { usePortalSession } from './PortalSession';
import { PortalCard } from './PortalFrame';

/**
 * `datetime-local` speaks `YYYY-MM-DDTHH:mm` in LOCAL time and nothing else.
 * Handing it an ISO string with a `Z` renders an empty field with no error.
 */
function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

interface PickedFile {
  key: string;
  file: File;
}

export function PortalNewTicketPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { me } = usePortalSession();

  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [occurredAt, setOccurredAt] = useState(() => toLocalInput(new Date()));
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [saving, setSaving] = useState(false);

  const fileInput = useRef<HTMLInputElement>(null);

  // Computed once per mount rather than per render: a `max` that ticks forward
  // every keystroke makes the browser's own picker fight the user.
  const maxLocal = useMemo(() => toLocalInput(new Date()), []);

  function addFiles(selected: FileList | null) {
    if (!selected || selected.length === 0) return;
    const next: PickedFile[] = [];
    for (const file of Array.from(selected)) {
      if (file.size > LIMITS.attachmentMaxBytes) {
        toast.error(
          t('portal.ticket.fileTooBig', '{{name}} is larger than {{max}} and was not added.', {
            name: file.name,
            max: formatBytes(LIMITS.attachmentMaxBytes),
          }),
        );
        continue;
      }
      next.push({ key: `${file.name}:${file.size}:${file.lastModified}:${Math.random()}`, file });
    }
    if (next.length > 0) setFiles((current) => [...current, ...next]);
    if (fileInput.current) fileInput.current.value = '';
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = subject.trim();
    if (trimmed === '' || saving) return;

    setSaving(true);
    try {
      const parsed = new Date(occurredAt);
      const ticket = await portalApi.createTicket({
        subject: trimmed,
        bodyMd: description.trim(),
        // Only send an instant we could actually parse. A malformed value must
        // not travel as a silent "now" that then looks like a real observation
        // nobody can tell apart from one the customer typed.
        occurredAt: Number.isNaN(parsed.getTime()) ? null : parsed.toISOString(),
      });

      // The ticket exists from here on. Every later failure is reported and
      // then walked past — sending the customer back to a form whose content
      // has already been filed would produce a duplicate request.
      let failed = 0;
      for (const picked of files) {
        try {
          await portalApi.uploadAttachment(ticket.id, picked.file);
        } catch {
          failed += 1;
        }
      }

      if (failed > 0) {
        toast.error(
          t(
            'portal.new.someFilesFailed',
            'Your request was created, but {{count}} file(s) could not be attached. You can add them from the request itself.',
            { count: failed },
          ),
        );
      } else {
        toast.success(
          t('portal.submitted', 'Your request has been recorded.'),
        );
      }

      navigate(`/portal/tickets/${ticket.id}`, { replace: true });
    } catch (error) {
      toast.error(
        error instanceof ApiError && error.message
          ? error.message
          : t('portal.new.failed', 'Your request could not be created.'),
      );
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <Link
        to="/portal"
        className="inline-flex items-center gap-1 text-[12px] text-text-muted transition-colors hover:text-text-primary"
      >
        <ChevronLeft size={14} />
        {t('portal.myRequests', 'My requests')}
      </Link>

      <div>
        <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">
          {t('portal.newRequest', 'New request')}
        </h1>
        <p className="mt-0.5 text-[13px] text-text-secondary">
          {t(
            'portal.new.subtitle',
            'Tell us what happened. Only the subject is required, and we will come back to you for the rest.',
          )}
        </p>
      </div>

      <form onSubmit={submit} className="space-y-4">
        <PortalCard className="space-y-4">
          <Input
            label={t('portal.new.subject', 'Subject')}
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            placeholder={t('portal.new.subjectPlaceholder', 'Sum it up in one sentence')}
            maxLength={LIMITS.subjectMaxLength}
            autoFocus
          />

          {/* HARD RULE 6 — in the form, not behind a disclosure. See the header. */}
          <Input
            type="datetime-local"
            label={t('portal.new.occurredAt', 'When did it happen?')}
            hint={t(
              'portal.new.occurredAtHint',
              'Not when you are filling this in. The moment you first noticed the problem.',
            )}
            value={occurredAt}
            onChange={(event) => setOccurredAt(event.target.value)}
            max={maxLocal}
          />

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="portal-new-description"
              className="text-[12px] font-medium text-text-secondary"
            >
              {t('portal.new.description', 'What is happening?')}
            </label>
            <textarea
              id="portal-new-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={7}
              placeholder={t(
                'portal.new.descriptionPlaceholder',
                'What you expected, what happened instead, and anything you already tried.',
              )}
              className="w-full rounded-card bg-bg-tertiary px-3 py-2.5 text-[13px] leading-relaxed text-text-primary outline-none transition-colors placeholder:text-text-muted focus:bg-bg-hover"
            />
          </div>

          {/* Absent rather than disabled when the desk does not take uploads. */}
          {me?.canAttach && (
            <div className="space-y-2">
              <input
                ref={fileInput}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => addFiles(event.target.files)}
              />

              <Button
                type="button"
                variant="secondary"
                size="sm"
                icon={<Paperclip size={14} />}
                onClick={() => fileInput.current?.click()}
                disabled={saving}
              >
                {t('portal.ticket.attach', 'Attach a file')}
              </Button>

              {files.length > 0 && (
                <ul className="flex flex-wrap gap-1.5">
                  {files.map((picked) => (
                    <li
                      key={picked.key}
                      className={cn(
                        'flex items-center gap-1.5 rounded-pill bg-bg-tertiary px-2.5 py-1',
                        'text-[11px] text-text-secondary',
                      )}
                    >
                      <Paperclip size={11} className="shrink-0" />
                      <span className="max-w-[12rem] truncate">{picked.file.name}</span>
                      <span className="font-mono text-[10px] text-text-muted">
                        {formatBytes(picked.file.size)}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setFiles((current) => current.filter((f) => f.key !== picked.key))
                        }
                        aria-label={t('portal.ticket.removeFile', 'Remove {{name}}', {
                          name: picked.file.name,
                        })}
                        title={t('portal.ticket.removeFile', 'Remove {{name}}', {
                          name: picked.file.name,
                        })}
                        className="shrink-0 text-text-muted transition-colors hover:text-text-primary"
                      >
                        <X size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {files.length > 0 && (
                <p className="text-[11px] leading-relaxed text-text-muted">
                  {t(
                    'portal.new.filesAfterCreate',
                    'Files are uploaded once the request has been created, so they arrive attached to it.',
                  )}
                </p>
              )}
            </div>
          )}
        </PortalCard>

        <div className="flex items-center justify-end gap-2">
          {saving && files.length > 0 && (
            <span className="flex items-center gap-2 text-[11px] text-text-muted">
              <LoadingSpinner size="xs" />
              {t('portal.new.uploading', 'Sending your files…')}
            </span>
          )}
          <Link to="/portal">
            <Button type="button" variant="ghost">
              {t('common.cancel', 'Cancel')}
            </Button>
          </Link>
          <Button
            type="submit"
            variant="primary"
            icon={<Send size={14} />}
            loading={saving}
            disabled={subject.trim() === ''}
          >
            {t('portal.new.submit', 'Send my request')}
          </Button>
        </div>
      </form>
    </div>
  );
}

export default PortalNewTicketPage;
