/**
 * JournalEntry.tsx — one row of the append-only spine.
 *
 * ── Public vs internal is LAYOUT AND COLOUR, never a checkbox ────────────────
 * There is no "internal?" toggle anywhere on a rendered entry, because a
 * checkbox is a thing you read and misread. An internal note is a different
 * SURFACE: amber tint, a solid amber rule down its left edge, a padlock, and
 * the sentence "non visible par le demandeur" spelled out in the header. A
 * public reply sits on the ordinary card surface and says "envoyée au
 * demandeur".
 *
 * From two metres away, with the screen out of focus, an agent can still tell
 * which of the two they are looking at. That is the actual requirement: the
 * failure mode this guards against is a work note written as if nobody outside
 * would read it, sitting in an email the customer has already received.
 *
 * The left rule is an inset `box-shadow`, not a `border-left` — HARD RULE 11
 * says no borders on cards, and a shadow gives the same 3 px stripe without
 * one.
 *
 * ── Noise ────────────────────────────────────────────────────────────────────
 * `COLLAPSIBLE_JOURNAL_KINDS` (system, state_change, assignment, automation)
 * render as a single dense line. TicketJournal groups consecutive ones; this
 * component only knows how to be dense when asked.
 *
 * ── The body is server-rendered HTML ─────────────────────────────────────────
 * `bodyHtml` was produced and sanitised by `server/src/utils/markdown.ts`. It
 * is injected as-is; re-parsing the markdown client-side would give a second
 * renderer with a second sanitiser, and the day they disagreed the one running
 * in the browser would be the one that mattered.
 */
import { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  CheckCheck,
  ChevronRight,
  Clock,
  FileText,
  GitMerge,
  HelpCircle,
  Lock,
  Mail,
  Paperclip,
  Quote,
  Send,
  Settings2,
  ShieldAlert,
  Sparkles,
  UserCog,
} from 'lucide-react';
import { COLLAPSIBLE_JOURNAL_KINDS } from '@oblidesk/shared';
import type { JournalKind, TicketJournalEntry } from '@oblidesk/shared';
import StatusPill from './StatusPill';
import { formatAbsolute, formatRelative } from './SlaChip';

/** The amber of the design system's `--amber` token, used only for internal. */
const INTERNAL_AMBER = '#f5a623';

const NOISE_KINDS = new Set<string>(COLLAPSIBLE_JOURNAL_KINDS);

export function isNoiseKind(kind: JournalKind): boolean {
  return NOISE_KINDS.has(kind);
}

const KIND_ICON: Readonly<Record<JournalKind, typeof Send>> = {
  public_reply: Send,
  work_note: Lock,
  system: Settings2,
  state_change: CheckCheck,
  assignment: UserCog,
  attachment: Paperclip,
  ai_suggestion: Sparkles,
  automation: Bot,
  approval: ShieldAlert,
  time: Clock,
  merge: GitMerge,
  alert: ShieldAlert,
};

const KIND_LABEL: Readonly<Record<JournalKind, { key: string; fallback: string }>> = {
  public_reply: { key: 'journal.kind.publicReply', fallback: 'Réponse publique' },
  work_note: { key: 'journal.kind.workNote', fallback: 'Note interne' },
  system: { key: 'journal.kind.system', fallback: 'Système' },
  state_change: { key: 'journal.kind.stateChange', fallback: 'Changement d’état' },
  assignment: { key: 'journal.kind.assignment', fallback: 'Affectation' },
  attachment: { key: 'journal.kind.attachment', fallback: 'Pièce jointe' },
  ai_suggestion: { key: 'journal.kind.aiSuggestion', fallback: 'Suggestion IA' },
  automation: { key: 'journal.kind.automation', fallback: 'Automatisation' },
  approval: { key: 'journal.kind.approval', fallback: 'Approbation' },
  time: { key: 'journal.kind.time', fallback: 'Temps passé' },
  merge: { key: 'journal.kind.merge', fallback: 'Fusion' },
  alert: { key: 'journal.kind.alert', fallback: 'Alerte' },
};

function authorName(entry: TicketJournalEntry, fallback: string): string {
  if (entry.author) return entry.author.displayName?.trim() || entry.author.username;
  if (entry.authorContact) return entry.authorContact.displayName?.trim() || entry.authorContact.email;
  if (entry.authorType === 'automation') return 'Automation';
  if (entry.authorType === 'ai') return 'Assistant';
  if (entry.authorType === 'system') return 'Système';
  return fallback;
}

function initialsOf(name: string): string {
  const parts = name.split(/[\s._@-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export interface JournalEntryProps {
  entry: TicketJournalEntry;
  /** Dense single-line rendering — used inside a collapsed noise group. */
  dense?: boolean;
  /** Quote this entry into the composer. */
  onQuote?: (entry: TicketJournalEntry) => void;
  /** Open the Why drawer at this entry's decision. */
  onOpenWhy?: (decisionLogId: number) => void;
  /** The seq the URL is pointing at — highlights on deep link. */
  highlighted?: boolean;
  className?: string;
}

export default function JournalEntry({
  entry,
  dense = false,
  onQuote,
  onOpenWhy,
  highlighted = false,
  className,
}: JournalEntryProps): JSX.Element {
  const { t } = useTranslation();
  const [showRaw, setShowRaw] = useState(false);

  const internal = entry.visibility === 'internal';
  const Icon = KIND_ICON[entry.kind] ?? FileText;
  const kindLabel = KIND_LABEL[entry.kind] ?? KIND_LABEL.system;
  const name = authorName(entry, t('journal.unknownAuthor', 'Auteur inconnu'));

  const stamp = useMemo(
    () => ({
      relative: formatRelative(entry.createdAt, t),
      absolute: formatAbsolute(entry.createdAt),
    }),
    [entry.createdAt, t],
  );

  // ── Dense: the collapsed-noise line ──────────────────────────────────────
  if (dense) {
    return (
      <div
        className={clsx(
          'flex items-center gap-2 px-3 py-1 text-[12px] text-text-muted',
          className,
        )}
      >
        <Icon size={12} className="shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">
          <NoiseSummary entry={entry} />
        </span>
        <time
          dateTime={entry.createdAt}
          title={stamp.absolute}
          className="shrink-0 font-mono text-[10px]"
        >
          {stamp.relative}
        </time>
      </div>
    );
  }

  // ── Full entry ───────────────────────────────────────────────────────────
  const conversational = entry.kind === 'public_reply' || entry.kind === 'work_note';

  return (
    <article
      id={`journal-${entry.seq}`}
      data-visibility={entry.visibility}
      data-kind={entry.kind}
      className={clsx(
        'rounded-card bg-bg-secondary px-3.5 py-3 shadow-card transition-colors',
        highlighted && 'ring-1 ring-accent',
        className,
      )}
      style={
        internal
          ? {
              // HARD RULE 11 — the stripe and the tint, no border.
              boxShadow: `inset 3px 0 0 0 ${INTERNAL_AMBER}, var(--shadow-card)`,
              background: `linear-gradient(0deg, rgba(245,166,35,0.055), rgba(245,166,35,0.055)), rgb(var(--c-bg-secondary))`,
            }
          : undefined
      }
    >
      {/* ── Header line ──────────────────────────────────────────────────── */}
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          aria-hidden
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-mono text-[10px] text-white"
          style={{
            background: internal
              ? 'rgba(245,166,35,0.35)'
              : 'rgb(var(--c-bg-active))',
          }}
        >
          {entry.author?.avatar ? (
            <img src={entry.author.avatar} alt="" className="h-full w-full rounded-full object-cover" />
          ) : entry.authorType === 'user' || entry.authorType === 'portal' ? (
            initialsOf(name)
          ) : (
            <Bot size={12} />
          )}
        </span>

        <span className="truncate text-[13px] font-medium text-text-primary">{name}</span>

        {/* The badge that carries the whole distinction. */}
        <span
          className={clsx(
            'inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-[11px] font-medium',
            internal ? 'text-[#f5a623]' : 'bg-bg-tertiary text-text-secondary',
          )}
          style={internal ? { background: 'rgba(245,166,35,0.14)' } : undefined}
        >
          {internal ? <Lock size={11} aria-hidden /> : <Icon size={11} aria-hidden />}
          {t(kindLabel.key, kindLabel.fallback)}
        </span>

        <span className="text-[11px] text-text-muted">
          {internal
            ? t('journal.internalHint', 'non visible par le demandeur')
            : entry.kind === 'public_reply'
              ? t('journal.publicHint', 'envoyée au demandeur')
              : null}
        </span>

        <span className="flex-1" />

        {entry.meta?.decisionLogId !== undefined && onOpenWhy && (
          <button
            type="button"
            onClick={() => onOpenWhy(Number(entry.meta.decisionLogId))}
            className="inline-flex items-center gap-1 rounded-pill px-1.5 py-0.5 text-[11px] text-accent hover:bg-bg-hover"
            title={t('journal.why', 'Pourquoi cette décision ?')}
          >
            <HelpCircle size={12} aria-hidden />
            {t('journal.whyShort', 'Pourquoi ?')}
          </button>
        )}

        {conversational && onQuote && (
          <button
            type="button"
            onClick={() => onQuote(entry)}
            className="inline-flex items-center gap-1 rounded-pill px-1.5 py-0.5 text-[11px] text-text-muted hover:bg-bg-hover hover:text-text-secondary"
            title={t('journal.quote', 'Citer dans la réponse')}
          >
            <Quote size={12} aria-hidden />
          </button>
        )}

        <time
          dateTime={entry.createdAt}
          title={stamp.absolute}
          className="shrink-0 font-mono text-[11px] text-text-muted"
        >
          {stamp.relative}
        </time>

        <span className="shrink-0 font-mono text-[10px] text-text-muted opacity-60">
          #{entry.seq}
        </span>
      </header>

      {/* ── Kind-specific structured payload ─────────────────────────────── */}
      {entry.kind === 'state_change' && entry.meta?.toStatusSlug && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {entry.meta.fromStatusSlug && (
            <StatusPill
              statusSlug={entry.meta.fromStatusSlug}
              category={entry.meta.fromCategory ?? 'open'}
              label={entry.meta.fromStatusSlug}
              size="sm"
            />
          )}
          <ChevronRight size={13} className="text-text-muted" aria-hidden />
          <StatusPill
            statusSlug={entry.meta.toStatusSlug}
            category={entry.meta.toCategory ?? 'open'}
            label={entry.meta.toStatusSlug}
            size="sm"
          />
        </div>
      )}

      {entry.kind === 'automation' && entry.meta?.ruleSlug && (
        <p className="mt-2 font-mono text-[11px] text-text-muted">
          {t('journal.byRule', 'Règle')} : {entry.meta.ruleSlug}
          {entry.meta.ruleVersion ? ` v${entry.meta.ruleVersion}` : ''}
        </p>
      )}

      {entry.kind === 'alert' && entry.meta?.dedupeKey && (
        <p className="mt-2 font-mono text-[11px] text-text-muted">
          {t('journal.dedupeKey', 'Clé de regroupement')} : {String(entry.meta.dedupeKey)}
        </p>
      )}

      {entry.kind === 'time' && entry.meta?.minutes !== undefined && (
        <p className="mt-2 font-mono text-[11px] text-text-secondary">
          {t('journal.minutes', '{{count}} min', { count: Number(entry.meta.minutes) })}
        </p>
      )}

      {/* ── Body ─────────────────────────────────────────────────────────── */}
      {(entry.bodyHtml || entry.bodyMd) && (
        <div className="mt-2">
          {showRaw || !entry.bodyHtml ? (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-card bg-bg-tertiary p-2.5 font-mono text-[12px] leading-relaxed text-text-secondary">
              {entry.bodyMd ?? ''}
            </pre>
          ) : (
            <div
              className="text-[13px] leading-relaxed text-text-primary [&_a]:text-accent [&_blockquote]:pl-3 [&_blockquote]:text-text-muted [&_code]:rounded [&_code]:bg-bg-tertiary [&_code]:px-1 [&_code]:font-mono [&_code]:text-[12px] [&_img]:max-w-full [&_img]:rounded-card [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1.5 [&_pre]:overflow-x-auto [&_pre]:rounded-card [&_pre]:bg-bg-tertiary [&_pre]:p-2.5 [&_table]:w-full [&_ul]:list-disc [&_ul]:pl-5"
              // Sanitised server-side by utils/markdown.ts. See the header.
              dangerouslySetInnerHTML={{ __html: entry.bodyHtml }}
            />
          )}

          {entry.bodyHtml && entry.bodyMd && (
            <button
              type="button"
              onClick={() => setShowRaw((previous) => !previous)}
              className="mt-1 font-mono text-[10px] uppercase tracking-[0.1em] text-text-muted hover:text-text-secondary"
            >
              {showRaw
                ? t('journal.showRendered', 'Affichage formaté')
                : t('journal.showSource', 'Source markdown')}
            </button>
          )}
        </div>
      )}

      {/* ── Attachments ──────────────────────────────────────────────────── */}
      {entry.attachments && entry.attachments.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {entry.attachments.map((attachment) => (
            <li key={attachment.id}>
              <a
                href={`/api/attachments/${attachment.id}/download`}
                className="inline-flex items-center gap-1.5 rounded-pill bg-bg-tertiary px-2 py-1 text-[11px] text-text-secondary hover:bg-bg-hover"
                title={`${attachment.filename} · ${Math.max(1, Math.round(attachment.byteSize / 1024))} Ko`}
              >
                <Paperclip size={11} aria-hidden />
                <span className="max-w-[16rem] truncate">{attachment.filename}</span>
              </a>
            </li>
          ))}
        </ul>
      )}

      {/* ── Mail provenance ──────────────────────────────────────────────── */}
      {entry.meta?.emailMessageId && (
        <p className="mt-2 flex items-center gap-1 font-mono text-[10px] text-text-muted">
          <Mail size={10} aria-hidden />
          {String(entry.meta.emailMessageId)}
        </p>
      )}
    </article>
  );
}

/** One-line rendering of a noise entry, used inside collapsed groups. */
function NoiseSummary({ entry }: { entry: TicketJournalEntry }): JSX.Element {
  const { t } = useTranslation();
  const meta = entry.meta ?? {};

  if (entry.kind === 'state_change' && meta.toStatusSlug) {
    return (
      <>
        {t('journal.summary.status', 'Statut')}{' '}
        <span className="font-mono text-text-secondary">{meta.fromStatusSlug ?? '—'}</span>
        {' → '}
        <span className="font-mono text-text-secondary">{meta.toStatusSlug}</span>
      </>
    );
  }

  if (entry.kind === 'assignment') {
    return (
      <>
        {t('journal.summary.assignment', 'Affectation modifiée')}
        {meta.ruleSlug ? (
          <span className="font-mono"> · {String(meta.ruleSlug)}</span>
        ) : null}
      </>
    );
  }

  if (entry.kind === 'automation') {
    return (
      <>
        {t('journal.summary.automation', 'Règle')}{' '}
        <span className="font-mono text-text-secondary">{String(meta.ruleSlug ?? '?')}</span>
      </>
    );
  }

  return <>{entry.bodyMd?.split('\n')[0] ?? t('journal.summary.system', 'Événement système')}</>;
}
