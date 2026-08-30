/**
 * NewTicketModal — intake from the desk itself.
 *
 * The button has always existed and always navigated to `/tickets/new`; nothing
 * ever rendered there, so "New ticket" was a dead end. This is that screen.
 *
 * ── Why `occurredAt` is a first-class field and not an advanced option ───────
 * HARD RULE 6: `occurred_at` answers "when did this actually happen?" and is
 * captured AT INTAKE, because it can never be reconstructed afterwards. An
 * outage a user reports at 09:00 that started at 02:14 must carry 02:14, or the
 * detection gap on the ticket, the SLA arithmetic and Rewind are all quietly
 * wrong. It defaults to now, which is right for the common case, and the field
 * sits in the form rather than behind a disclosure so the agent who knows the
 * real time is invited to say so.
 *
 * ── Required-ness ───────────────────────────────────────────────────────────
 * Only `subject` is demanded here, because only `subject` is demanded by the
 * server (`CreateTicketRequest`). HARD RULE 12 puts required-ness at the state
 * transition, not at the keyboard: a ticket may be created thin and completed
 * later, and refusing to open one because a queue was not picked would just
 * push agents to invent a value.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import type { TicketRecordType } from '@oblidesk/shared';

import apiClient from '@/api/client';
import { ticketsApi } from '@/api/tickets.api';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Select, type SelectOption } from '@/components/common/Select';

interface ConfigRef {
  slug: string;
  name: string;
}

interface NewTicketModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (ticketId: number) => void;
}

/** `datetime-local` wants `YYYY-MM-DDTHH:mm` in LOCAL time, not an ISO string. */
function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export function NewTicketModal({ open, onClose, onCreated }: NewTicketModalProps) {
  const { t } = useTranslation();

  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [occurredAt, setOccurredAt] = useState(() => toLocalInput(new Date()));
  const [recordType, setRecordType] = useState<TicketRecordType>('incident');
  const [prioritySlug, setPrioritySlug] = useState('');
  const [queueSlug, setQueueSlug] = useState('');

  const [priorities, setPriorities] = useState<ConfigRef[]>([]);
  const [queues, setQueues] = useState<ConfigRef[]>([]);
  const [saving, setSaving] = useState(false);

  // Reset on every open: a modal that remembers the last draft hands the next
  // ticket somebody else's subject.
  useEffect(() => {
    if (!open) return;
    setSubject('');
    setDescription('');
    setOccurredAt(toLocalInput(new Date()));
    setRecordType('incident');
    setPrioritySlug('');
    setQueueSlug('');
  }, [open]);

  // Priorities and queues are config objects, read from the config store like
  // everywhere else. Failing quietly is deliberate: an empty select still lets
  // the ticket be created, and the engines assign their own defaults.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const load = async (kind: string, apply: (rows: ConfigRef[]) => void) => {
      try {
        const res = await apiClient.get<{ data?: unknown }>(`/config/${kind}?status=published`);
        const raw = Array.isArray(res.data?.data) ? (res.data.data as unknown[]) : [];
        const rows = raw
          .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
          .filter((r) => typeof r.slug === 'string')
          .map((r) => ({
            slug: r.slug as string,
            name: typeof r.name === 'string' ? r.name : (r.slug as string),
          }));
        if (!cancelled) apply(rows);
      } catch {
        /* Silent: the select simply stays empty. */
      }
    };

    void load('priority', setPriorities);
    void load('queue', setQueues);
    return () => {
      cancelled = true;
    };
  }, [open]);

  const typeOptions: SelectOption[] = [
    { value: 'incident', label: t('ticket.type.incident', 'Incident') },
    { value: 'request', label: t('ticket.type.request', 'Request') },
  ];

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = subject.trim();
    if (!trimmed) return;

    setSaving(true);
    try {
      const parsed = new Date(occurredAt);
      const ticket = await ticketsApi.create({
        recordType,
        subject: trimmed,
        descriptionMd: description.trim() || null,
        // Only send a time we could actually parse; a malformed value must not
        // become a silent "now" that looks like a real observation.
        occurredAt: Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString(),
        prioritySlug: prioritySlug || undefined,
        queueSlug: queueSlug || undefined,
        source: 'web',
      });
      toast.success(t('ticket.created', 'Ticket created.'));
      onCreated(ticket.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      toast.error(message || t('ticket.createFailed', 'The ticket could not be created.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('ticket.newTitle', 'New ticket')}
      subtitle={t('ticket.newSubtitle', 'Only the subject is required. Everything else can be filled in later.')}
      closeLabel={t('common.close', 'Close')}
      size="lg"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} type="button">
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="new-ticket-form"
            loading={saving}
            disabled={!subject.trim()}
          >
            {t('ticket.create', 'Create ticket')}
          </Button>
        </div>
      }
    >
      <form id="new-ticket-form" onSubmit={submit} className="flex flex-col gap-4">
        <Input
          label={t('ticket.subject', 'Subject')}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder={t('ticket.subjectPlaceholder', 'Sum the problem up in one sentence')}
          autoFocus
          maxLength={512}
        />

        <div className="flex flex-col gap-1.5">
          <label htmlFor="new-ticket-description" className="text-xs font-medium text-text-secondary">
            {t('ticket.description', 'Description')}
          </label>
          <textarea
            id="new-ticket-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={6}
            placeholder={t('ticket.descriptionPlaceholder', 'What happened, what was expected, what was tried')}
            className="w-full rounded-input bg-bg-tertiary px-3 py-2 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:bg-bg-hover"
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            type="datetime-local"
            label={t('ticket.occurredAt', 'When did it happen?')}
            hint={t(
              'ticket.occurredAtHint',
              'Not when you are filing this. The moment the incident actually started.',
            )}
            value={occurredAt}
            onChange={(e) => setOccurredAt(e.target.value)}
            max={toLocalInput(new Date())}
          />
          <Select
            label={t('ticket.recordType', 'Type')}
            options={typeOptions}
            value={recordType}
            onChange={(e) => setRecordType(e.target.value as TicketRecordType)}
          />
          <Select
            label={t('ticket.priority', 'Priority')}
            options={priorities.map((p) => ({ value: p.slug, label: p.name }))}
            value={prioritySlug}
            onChange={(e) => setPrioritySlug(e.target.value)}
            placeholder={t('ticket.priorityAuto', 'Let the rules decide')}
          />
          <Select
            label={t('ticket.queue', 'Queue')}
            options={queues.map((q) => ({ value: q.slug, label: q.name }))}
            value={queueSlug}
            onChange={(e) => setQueueSlug(e.target.value)}
            placeholder={t('ticket.queueAuto', 'Let routing decide')}
          />
        </div>
      </form>
    </Modal>
  );
}

export default NewTicketModal;
