/**
 * ContextRail.tsx — who, where, under what contract, on which machine.
 *
 * ── Two tiers, and the difference is visible ─────────────────────────────────
 * The top of the rail is data Oblidesk OWNS and already has: the requester, the
 * organisation, the linked CI's name. It is on screen at first paint, because
 * it arrived with the ticket.
 *
 * Everything below it is data somebody ELSE owns — the contract ledger, the
 * device's health in Obliance, the monitor's state in Obliview, the bans in
 * Obliguard, the site in Oblimap. Those load asynchronously AFTER paint, each
 * with its own timeout and its own circuit breaker (see `api/ci.api.ts`), and
 * each degrades ON ITS OWN.
 *
 * ── Why a dead section stays on screen ───────────────────────────────────────
 * The tempting design is to hide a section that failed: the rail stays tidy and
 * nothing looks broken. It is the wrong design, and the reason is specific — a
 * technician who has been shown a rail with four sections and later sees three
 * has no way to tell "there are no bans on this host" from "Obliguard is down".
 * The first is a fact they will act on; the second is a fact they must not act
 * on. Once they have been burned by that ambiguity once, they stop trusting
 * every section, including the ones that work.
 *
 * So every section renders, always, with its state and the age of its data:
 * "dernière lecture il y a 4 min". A stale section looks stale. An unavailable
 * one says which source, and why, and offers a retry.
 *
 * ── The rail dates what it shows by the SOURCE's clock, not the browser's ────
 * `GET /api/ci/:id/live/:app` answers 200 in two very different situations: the
 * sibling app answered, or it did not and the desk served the payload it had
 * cached. The difference travels INSIDE the record (`stale`, `lastFetchedAt`,
 * `reason`, `reasonText`), because the envelope around it is dropped before a
 * human could read it. Every live section is therefore re-dated here from those
 * fields: a cached answer is shown with the age it really has, never with the
 * age of the request that failed to refresh it.
 *
 * A section that failed with nothing cached has no last read at all, so its line
 * says "dernier essai" instead of "dernière lecture". Those two words are the
 * whole difference between "this is how the machine looked 14 minutes ago" and
 * "we have never managed to look at this machine".
 *
 * ── Contract coverage ───────────────────────────────────────────────────────
 * `/api/contracts` does not exist on this server: that module is not built yet.
 * The section says exactly that. It must never render as an empty card, because
 * an empty card reads as "this customer has no contract", which is the one
 * sentence a module that does not exist is in no position to say.
 *
 * ── Collapsing ──────────────────────────────────────────────────────────────
 * The rail's open/closed state belongs to the pages that lay it out
 * (`TicketsPage`, `TicketDetailPage`) and is persisted in `uiStore`. Nothing
 * here duplicates it: a second source of truth for one toggle is how a panel
 * ends up reopening itself on reload.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  AlertTriangle,
  Building2,
  CircleSlash,
  ExternalLink,
  FileClock,
  Fingerprint,
  Loader2,
  Mail,
  Network,
  RefreshCw,
  Server,
  ShieldCheck,
  Ticket as TicketIcon,
  TimerOff,
  User as UserIcon,
} from 'lucide-react';
import type { Ci, CiCriticality, CiKind, Contract, TicketWithRelations } from '@oblidesk/shared';
import {
  CI_LIVE_SECTIONS,
  CI_SECTION_LABELS,
  fetchCi,
  fetchCiLiveSection,
  fetchCiTickets,
  fetchContractCoverage,
  resetCircuitBreakers,
  type CiLiveSection,
  type SectionResult,
  type SectionStatus,
} from '@/api/ci.api';
import { formatAbsolute, formatRelative } from './SlaChip';
import StatusPill from './StatusPill';

/** `t()` as this file uses it: a key, a French fallback, optional variables. */
type Translate = (key: string, fallback: string, options?: Record<string, unknown>) => string;

// ═════════════════════════════════════════════════════════════════════════════
// Section shell — the honesty machinery
// ═════════════════════════════════════════════════════════════════════════════

const STATUS_TONE: Readonly<Record<SectionStatus, string>> = {
  ok: 'text-sla-ok',
  empty: 'text-text-muted',
  unavailable: 'text-sla-breach',
  forbidden: 'text-sla-warn',
  timeout: 'text-sla-warn',
  circuit_open: 'text-sla-breach',
};

const STATUS_LABEL: Readonly<Record<SectionStatus, { key: string; fallback: string }>> = {
  ok: { key: 'ci.status.ok', fallback: 'à jour' },
  empty: { key: 'ci.status.empty', fallback: 'rien à afficher' },
  unavailable: { key: 'ci.status.unavailable', fallback: 'source indisponible' },
  forbidden: { key: 'ci.status.forbidden', fallback: 'accès refusé' },
  timeout: { key: 'ci.status.timeout', fallback: 'délai dépassé' },
  circuit_open: { key: 'ci.status.circuitOpen', fallback: 'appels suspendus' },
};

const STATUS_ICON: Readonly<Record<SectionStatus, typeof AlertTriangle>> = {
  ok: ShieldCheck,
  empty: CircleSlash,
  unavailable: AlertTriangle,
  forbidden: CircleSlash,
  timeout: TimerOff,
  circuit_open: AlertTriangle,
};

/** Statuses that mean nothing was read. Their timestamp is an ATTEMPT, not a read. */
const FAILED_STATUSES: ReadonlySet<SectionStatus> = new Set<SectionStatus>([
  'unavailable',
  'forbidden',
  'timeout',
  'circuit_open',
]);

interface SectionShellProps<T> {
  title: string;
  icon: typeof Server;
  state: SectionResult<T> | null;
  onRetry: () => void;
  children?: ReactNode;
}

function SectionShell<T>({
  title,
  icon: Icon,
  state,
  onRetry,
  children,
}: SectionShellProps<T>): JSX.Element {
  const { t } = useTranslation();
  const loading = state === null;
  const StatusIcon = state ? STATUS_ICON[state.status] : Loader2;

  // Nothing came back and nothing was cached: dating that moment "dernière
  // lecture" would claim a read that never happened.
  const neverRead = state !== null && state.data === null && FAILED_STATUSES.has(state.status);

  return (
    <section className="rounded-card bg-bg-secondary p-3 shadow-card">
      <header className="flex items-center gap-2">
        <Icon size={13} className="shrink-0 text-text-muted" aria-hidden />
        <h3 className="flex-1 truncate font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
          {title}
        </h3>

        {state?.href && (
          <a
            href={state.href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-text-muted hover:text-accent"
            title={t('ci.openInSource', 'Ouvrir dans l’application source')}
          >
            <ExternalLink size={12} />
          </a>
        )}

        <button
          type="button"
          onClick={onRetry}
          className="rounded-pill p-1 text-text-muted hover:bg-bg-hover hover:text-text-secondary"
          title={t('ci.refresh', 'Relire cette source')}
          aria-label={t('ci.refresh', 'Relire cette source')}
        >
          <RefreshCw size={11} />
        </button>
      </header>

      {/* The state line. Always present — this is the whole point of the rail. */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
        <span className={clsx('inline-flex items-center gap-1', loading ? 'text-text-muted' : STATUS_TONE[state.status])}>
          <StatusIcon size={11} className={loading ? 'animate-spin' : undefined} aria-hidden />
          {loading
            ? t('ci.loading', 'lecture en cours…')
            : t(STATUS_LABEL[state.status].key, STATUS_LABEL[state.status].fallback)}
        </span>

        {state && (
          <span className="font-mono text-text-muted" title={formatAbsolute(state.fetchedAt)}>
            {neverRead ? t('ci.lastAttempt', 'dernier essai') : t('ci.lastRead', 'dernière lecture')}{' '}
            {formatRelative(state.fetchedAt, t)}
          </span>
        )}

        {state?.stale && (
          <span className="rounded-pill bg-sla-warn-bg px-1.5 py-0.5 text-sla-warn">
            {t('ci.staleData', 'données périmées')}
          </span>
        )}
      </div>

      {/* A stale section is a 200 that is also a failure: it must show its reason. */}
      {state?.reason && (state.status !== 'ok' || state.stale) && (
        <p className="mt-1.5 text-[11px] leading-snug text-text-muted">
          {state.reasonKey ? t(state.reasonKey, state.reason) : state.reason}
        </p>
      )}

      {children && <div className="mt-2">{children}</div>}
    </section>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Async section hook — fires AFTER first paint, never during it
// ═════════════════════════════════════════════════════════════════════════════

function useAfterPaint<T>(
  load: (() => Promise<SectionResult<T>>) | null,
  deps: readonly unknown[],
): [SectionResult<T> | null, () => void] {
  const [state, setState] = useState<SectionResult<T> | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!load) {
      setState(null);
      return undefined;
    }

    let alive = true;
    let timer = 0;
    setState(null);

    // The rail must not delay the ticket. A rAF callback still runs BEFORE the
    // browser paints, so the read is armed there and fired from a timeout in
    // the next task: the owned tier is on screen before any cross-app socket
    // is opened, and the section's four-second budget starts on a request the
    // browser can actually send.
    const frame = window.requestAnimationFrame(() => {
      timer = window.setTimeout(() => {
        void load().then((result) => {
          if (alive) setState(result);
        });
      }, 0);
    });

    return () => {
      alive = false;
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const retry = useCallback(() => setNonce((value) => value + 1), []);
  return [state, retry];
}

// ═════════════════════════════════════════════════════════════════════════════
// Live reads: one gate, so the budget is spent on requests that are in flight
// ═════════════════════════════════════════════════════════════════════════════

/**
 * How many cross-app reads may be open at once.
 *
 * Each section starts its own four-second clock the moment `fetchCiLiveSection`
 * is called, and a browser opens six connections per host. Firing five live
 * sections next to the three desk-owned reads would leave the last two queued
 * in the browser, unsent, until their budget expired — and the rail would then
 * report a timeout for a source that was never asked. Three keeps every live
 * read on a connection it actually has, and the sections still resolve
 * independently and render as they land.
 */
const LIVE_CONCURRENCY = 3;

let liveInFlight = 0;
const liveQueue: Array<() => void> = [];

function pumpLiveQueue(): void {
  while (liveInFlight < LIVE_CONCURRENCY && liveQueue.length > 0) {
    const next = liveQueue.shift();
    if (!next) return;
    liveInFlight += 1;
    next();
  }
}

function queueLiveRead<T>(run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    liveQueue.push(() => {
      // Started through a resolved promise so that even a synchronous throw
      // becomes a rejection: a slot that leaks here would starve the rail for
      // the rest of the session.
      Promise.resolve()
        .then(run)
        .then(resolve, reject)
        .finally(() => {
          liveInFlight -= 1;
          pumpLiveQueue();
        });
    });
    pumpLiveQueue();
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Live sections: the real reason, and the real last read
// ═════════════════════════════════════════════════════════════════════════════

/** The desk's machine-readable reasons (`CiLiveReason`), in fr and en. */
const LIVE_REASON_LABEL: Readonly<Record<string, { key: string; fallback: string }>> = {
  no_ci: {
    key: 'ci.reason.noCi',
    fallback: "Cet équipement n’est pas visible dans cet espace de travail.",
  },
  not_linked: {
    key: 'ci.reason.notLinked',
    fallback: 'Cette application ne connaît pas cette machine.',
  },
  not_configured: {
    key: 'ci.reason.notConfigured',
    fallback:
      "La passerelle Obligate n’est pas configurée : aucune lecture inter-applications n’est possible.",
  },
  not_authorised: {
    key: 'ci.reason.notAuthorised',
    fallback:
      'Cette application refuse la lecture inter-applications (jeton délégué non disponible).',
  },
  not_found: {
    key: 'ci.reason.notFound',
    fallback: 'Cette application ne trouve plus cet objet.',
  },
  timeout: {
    key: 'ci.reason.timeout',
    fallback: 'La source n’a pas répondu dans le délai imparti.',
  },
  unreachable: { key: 'ci.reason.unreachable', fallback: 'Source injoignable.' },
  source_error: {
    key: 'ci.reason.sourceError',
    fallback: 'La source a répondu par une erreur.',
  },
  circuit_open: {
    key: 'ci.reason.circuitOpen',
    fallback: 'Source injoignable à plusieurs reprises, les appels sont suspendus une minute.',
  },
};

/**
 * The bridge back to the code, for the failure path.
 *
 * On a 4xx/5xx the desk sends `{ error, reason }`, but `probe()` keeps only the
 * sentence — so nine distinct situations would otherwise collapse into one
 * generic line, and an English technician would read a French one. The
 * sentences are constants in `server/src/services/ciLive.service.ts`; matching
 * them back to their code costs one table, and when a sentence is reworded the
 * fallback is the sentence itself, exactly as the desk sent it.
 */
const REASON_BY_TEXT: ReadonlyArray<readonly [RegExp, string]> = [
  [/^cet equipement n existe pas/, 'no_ci'],
  [/^cette application ne connait pas cette machine/, 'not_linked'],
  [/^la passerelle obligate n est pas configuree/, 'not_configured'],
  [/refuse la lecture inter applications/, 'not_authorised'],
  [/^cette application ne trouve plus cet objet/, 'not_found'],
  [/^pas de reponse en \d+ s/, 'timeout'],
  [/^source injoignable a plusieurs reprises/, 'circuit_open'],
  [/^source injoignable/, 'unreachable'],
  [/^la source a repondu par une erreur/, 'source_error'],
];

/** Accents and punctuation are cosmetic here; the words are what identify the reason. */
function normaliseReason(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function reasonLabelFromText(text: string): { key: string; fallback: string } | null {
  const normalised = normaliseReason(text);
  for (const [pattern, code] of REASON_BY_TEXT) {
    if (pattern.test(normalised)) return LIVE_REASON_LABEL[code] ?? null;
  }
  return null;
}

/**
 * Re-date and re-word one live section from what the desk actually said.
 *
 * Two corrections, both of which the rail would otherwise get wrong:
 *   • a 200 carrying `stale: true` is a FAILED refresh served from cache, so it
 *     is shown with the cache's real `lastFetchedAt` and the reason the refresh
 *     failed, not with "à jour" and a timestamp of now;
 *   • a 404 on this route means the desk could not resolve the CI for this
 *     tenant (`no_ci`), which `probe()` reports as "endpoint not deployed"
 *     because that is what a 404 means on the routes that predate this one.
 */
function refineLive(
  state: SectionResult<Record<string, unknown>> | null,
): SectionResult<Record<string, unknown>> | null {
  if (!state) return state;

  if (state.status === 'ok' && state.data) {
    const record = state.data;
    const lastFetchedAt = typeof record.lastFetchedAt === 'string' ? record.lastFetchedAt : null;
    const stale = record.stale === true;
    if (!stale && !lastFetchedAt) return state;

    const label =
      typeof record.reason === 'string' ? LIVE_REASON_LABEL[record.reason] ?? null : null;
    const sent = typeof record.reasonText === 'string' ? record.reasonText : null;

    return {
      ...state,
      stale: stale || state.stale,
      fetchedAt: lastFetchedAt ?? state.fetchedAt,
      reasonKey: label ? label.key : state.reasonKey,
      reason: label ? label.fallback : sent ?? state.reason,
    };
  }

  if (state.reasonKey === 'ci.section.notDeployed') {
    return {
      ...state,
      reasonKey: 'ci.reason.noCiHere',
      reason:
        "Cet équipement n’est pas visible dans cet espace de travail, ou cette lecture n’est pas déployée sur ce serveur.",
    };
  }

  if (state.reason) {
    const label = reasonLabelFromText(state.reason);
    if (label) return { ...state, reasonKey: label.key, reason: label.fallback };
  }

  return state;
}

// ═════════════════════════════════════════════════════════════════════════════
// Contract coverage
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `/api/contracts` is not on this server, and the honest answer is to name the
 * MODULE that is missing rather than the URL that 404'd: `module_not_deployed`.
 *
 * The section stays UNAVAILABLE and keeps its retry. It must not fall back to
 * "aucun contrat actif": a module that does not exist has no opinion on whether
 * this customer is covered, and only one of those two answers is something a
 * technician may act on.
 */
function refineContract(state: SectionResult<Contract[]> | null): SectionResult<Contract[]> | null {
  if (!state || state.reasonKey !== 'ci.section.notDeployed') return state;
  return {
    ...state,
    reasonKey: 'rail.contractModuleNotDeployed',
    reason:
      'Le module Contrats n’est pas encore déployé sur ce serveur : la couverture ne peut pas être vérifiée ici.',
  };
}

function ContractChip({ contract }: { contract: Contract }): JSX.Element {
  const { t } = useTranslation();
  const total = contract.totalMinutes ?? null;
  const used = contract.consumedMinutes ?? 0;
  const remaining = contract.remainingMinutes ?? (total === null ? null : total - used);
  const percent =
    total && total > 0 ? Math.min(100, Math.round((used / total) * 100)) : null;

  const tone =
    percent === null ? 'text-text-secondary' : percent >= 100 ? 'text-sla-breach' : percent >= 85 ? 'text-sla-warn' : 'text-sla-ok';

  return (
    <div className="rounded-card bg-bg-tertiary p-2">
      <div className="flex items-center gap-2">
        <span className="flex-1 truncate text-[12px] text-text-primary">{contract.name}</span>
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-text-muted">
          {contract.kind}
        </span>
      </div>

      {percent !== null && (
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-pill bg-bg-active">
          <div
            className={clsx(
              'h-full rounded-pill',
              percent >= 100 ? 'bg-sla-breach' : percent >= 85 ? 'bg-sla-warn' : 'bg-sla-ok',
            )}
            style={{ width: `${percent}%` }}
          />
        </div>
      )}

      <p className={clsx('mt-1 font-mono text-[11px]', tone)}>
        {remaining === null
          ? t('contract.unlimited', 'sans limite de temps')
          : t('contract.remaining', '{{minutes}} min restantes', { minutes: remaining })}
        {' · '}
        {t('contract.until', 'jusqu’au {{date}}', {
          date: new Date(contract.periodEnd).toLocaleDateString(),
        })}
      </p>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Live-section payload rendering
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The sibling apps' payloads are not typed here on purpose.
 *
 * Oblidesk mirrors them (`ci_source_links.payload`) without owning their shape,
 * and a hard-coded field list would silently drop whatever the source added
 * last week. Rendering the keys we were given — flattened, skipping the
 * plumbing — is honest about what arrived. Names are looked up under
 * `ci.field.*` and fall back to the raw key, so a field nobody has translated
 * yet still shows its value instead of disappearing.
 */
const PAYLOAD_META_KEYS: ReadonlySet<string> = new Set([
  'url',
  'externalPath',
  'stale',
  'lastFetchedAt',
  'reason',
  'reasonText',
]);

/** Deep enough for `changes48h.counts.software`, shallow enough to stay a rail. */
const MAX_PAYLOAD_DEPTH = 2;
const MAX_PAYLOAD_ROWS = 16;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

interface PayloadRow {
  path: string;
  label: string;
  value: string;
  /** Set when the value is an instant, so the row can carry an absolute title. */
  iso: string | null;
}

function flattenPayload(payload: Record<string, unknown>, t: Translate): PayloadRow[] {
  const rows: PayloadRow[] = [];

  const labelFor = (path: readonly string[]): string =>
    path.map((part) => t(`ci.field.${part}`, part)).join(' · ');

  const push = (path: string[], value: unknown, depth: number): void => {
    if (value === null || value === undefined || value === '') return;

    if (Array.isArray(value)) {
      if (value.length === 0) return;
      const scalars = value.every((entry) => entry === null || typeof entry !== 'object');
      rows.push({
        path: path.join('.'),
        label: labelFor(path),
        value: scalars
          ? value.join(', ')
          : t('ci.entries', '{{count}} entrées', { count: value.length }),
        iso: null,
      });
      return;
    }

    if (typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) return;
      if (depth >= MAX_PAYLOAD_DEPTH) {
        rows.push({
          path: path.join('.'),
          label: labelFor(path),
          value: t('ci.entries', '{{count}} entrées', { count: entries.length }),
          iso: null,
        });
        return;
      }
      for (const [key, nested] of entries) push([...path, key], nested, depth + 1);
      return;
    }

    if (typeof value === 'boolean') {
      rows.push({
        path: path.join('.'),
        label: labelFor(path),
        value: value ? t('common.yes', 'Oui') : t('common.no', 'Non'),
        iso: null,
      });
      return;
    }

    const isInstant = typeof value === 'string' && ISO_INSTANT.test(value);
    rows.push({
      path: path.join('.'),
      label: labelFor(path),
      value: isInstant ? formatRelative(value, t) : String(value),
      iso: isInstant ? value : null,
    });
  };

  for (const [key, value] of Object.entries(payload)) {
    if (PAYLOAD_META_KEYS.has(key)) continue;
    push([key], value, 0);
  }

  return rows;
}

function PayloadTable({ payload }: { payload: Record<string, unknown> }): JSX.Element {
  const { t } = useTranslation();
  const rows = useMemo(() => flattenPayload(payload, t), [payload, t]);

  if (rows.length === 0) {
    return (
      <p className="text-[11px] text-text-muted">
        {t('ci.noFields', 'La source a répondu sans aucun champ exploitable.')}
      </p>
    );
  }

  const shown = rows.slice(0, MAX_PAYLOAD_ROWS);
  const hidden = rows.length - shown.length;

  return (
    <>
      <dl className="flex flex-col gap-1">
        {shown.map((row) => (
          <div key={row.path} className="flex items-start gap-2 text-[11px]">
            <dt className="w-28 shrink-0 truncate font-mono text-text-muted" title={row.label}>
              {row.label}
            </dt>
            <dd
              className="min-w-0 flex-1 truncate text-text-secondary"
              title={row.iso ? formatAbsolute(row.iso) : row.value}
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>

      {hidden > 0 && (
        <p className="mt-1 text-[11px] text-text-muted">
          {t('ci.moreFields', '{{count}} autres champs dans la source', { count: hidden })}
        </p>
      )}
    </>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// The CI, as the desk owns it
// ═════════════════════════════════════════════════════════════════════════════

const CRITICALITY_TONE: Readonly<Record<CiCriticality, string>> = {
  critical: 'bg-sla-breach-bg text-sla-breach',
  high: 'bg-sla-warn-bg text-sla-warn',
  medium: 'bg-bg-tertiary text-text-secondary',
  low: 'bg-bg-tertiary text-text-muted',
};

function Pill({ tone, children }: { tone?: string; children: ReactNode }): JSX.Element {
  return (
    <span
      className={clsx(
        'rounded-pill px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em]',
        tone ?? 'bg-bg-tertiary text-text-secondary',
      )}
    >
      {children}
    </span>
  );
}

function DeskField({ label, value, title }: { label: string; value: string; title?: string }): JSX.Element {
  return (
    <div className="flex items-start gap-2 text-[11px]">
      <dt className="w-28 shrink-0 truncate text-text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 truncate font-mono text-text-secondary" title={title ?? value}>
        {value}
      </dd>
    </div>
  );
}

/**
 * The CI card: the identity line paints with the ticket, the desk-owned fields
 * arrive after.
 *
 * Everything in here is Oblidesk's own (`cis`, `ci_overlays`, `ci_state_cache`).
 * Hardware, software and patches are deliberately absent: they belong to the
 * sections below, which read them through and date them. A copy of the hostname
 * kept here would be a second answer nobody could tell from the first.
 */
function CiCard({
  ciId,
  fallbackName,
  fallbackKind,
  fallbackCriticality,
  detail,
  onRetry,
}: {
  ciId: number;
  fallbackName: string | null;
  fallbackKind: CiKind | null;
  fallbackCriticality: CiCriticality | null;
  detail: SectionResult<Ci> | null;
  onRetry: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const ci = detail?.status === 'ok' ? detail.data : null;

  const name = ci?.displayName ?? fallbackName ?? `CI #${ciId}`;
  const kind = ci?.kind ?? fallbackKind;
  const criticality = ci?.criticality ?? fallbackCriticality;
  const state = ci?.state ?? null;
  const overlays = ci?.overlays ?? [];
  const unreadable = detail !== null && detail.status !== 'ok';

  return (
    <section className="rounded-card bg-bg-secondary p-3 shadow-card">
      <h3 className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
        <Server size={13} aria-hidden />
        {t('rail.ci', 'Élément de configuration')}
      </h3>

      <p className="mt-2 truncate text-[13px] font-medium text-text-primary" title={name}>
        {name}
      </p>

      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        {kind && <Pill>{t(`assets.kinds.${kind}`, kind)}</Pill>}
        {criticality && (
          <Pill tone={CRITICALITY_TONE[criticality]}>
            {t(`assets.criticalities.${criticality}`, criticality)}
          </Pill>
        )}
        {state && state.online !== null && (
          <Pill tone={state.online ? 'bg-sla-ok-bg text-sla-ok' : 'bg-bg-tertiary text-text-muted'}>
            {state.online ? t('assets.online', 'En ligne') : t('assets.offline', 'Hors ligne')}
          </Pill>
        )}
      </div>

      {ci && (
        <dl className="mt-2 flex flex-col gap-1">
          {ci.hardwareUuid && (
            <DeskField
              label={t('assets.hardwareUuid', 'UUID matériel')}
              value={ci.hardwareUuid}
            />
          )}
          <DeskField
            label={t('assets.lastSeen', 'Vu pour la dernière fois')}
            value={formatRelative(ci.lastSeenAt, t)}
            title={formatAbsolute(ci.lastSeenAt)}
          />
          {state?.observedAt && (
            <DeskField
              label={t('assets.stateObserved', 'État observé')}
              value={formatRelative(state.observedAt, t)}
              title={formatAbsolute(state.observedAt)}
            />
          )}
          {typeof ci.openTicketCount === 'number' && (
            <DeskField
              label={t('assets.openTickets', 'Tickets ouverts')}
              value={String(ci.openTicketCount)}
            />
          )}
        </dl>
      )}

      {overlays.length > 0 && (
        <div className="mt-2">
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
            {t('assets.overlays', 'Attributs Oblidesk')}
          </p>
          <dl className="mt-1 flex flex-col gap-1">
            {overlays.slice(0, 8).map((overlay) => (
              <DeskField
                key={overlay.key}
                label={overlay.key}
                value={
                  overlay.value !== null && typeof overlay.value === 'object'
                    ? JSON.stringify(overlay.value)
                    : String(overlay.value ?? '')
                }
              />
            ))}
          </dl>
        </div>
      )}

      {unreadable && (
        <div className="mt-2 flex items-center gap-2 text-[11px] text-text-muted">
          <AlertTriangle size={11} className="shrink-0 text-sla-warn" aria-hidden />
          <span className="min-w-0 flex-1">
            {t('rail.ciFieldsUnreadable', 'Les champs Oblidesk de cet équipement n’ont pas pu être lus.')}
          </span>
          <button
            type="button"
            onClick={onRetry}
            className="rounded-pill p-1 text-text-muted hover:bg-bg-hover hover:text-text-secondary"
            title={t('ci.refresh', 'Relire cette source')}
            aria-label={t('ci.refresh', 'Relire cette source')}
          >
            <RefreshCw size={11} />
          </button>
        </div>
      )}
    </section>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// The rail
// ═════════════════════════════════════════════════════════════════════════════

/** One icon per source, so a technician finds a section by shape, not by reading. */
const CI_SECTION_ICONS: Readonly<Record<CiLiveSection, typeof Server>> = {
  obliance: Server,
  obliview: Activity,
  obliguard: ShieldCheck,
  oblimap: Network,
  obligate: Fingerprint,
};

export interface ContextRailProps {
  ticket: TicketWithRelations;
  onOpenTicket?: (ticketId: number) => void;
  className?: string;
}

export default function ContextRail({
  ticket,
  onOpenTicket,
  className,
}: ContextRailProps): JSX.Element {
  const { t } = useTranslation();

  const ciId = ticket.primaryCiId ?? ticket.cis?.[0]?.id ?? null;
  const orgId = ticket.organizationId ?? null;

  // Bumped by "relire toutes les sources". The live sections own their own
  // state, so this is how a rail-wide refresh reaches them.
  const [pulse, setPulse] = useState(0);

  const [ciDetail, retryCiDetail] = useAfterPaint<Ci>(
    ciId ? () => fetchCi(ciId) : null,
    [ciId, pulse],
  );

  const [contract, retryContract] = useAfterPaint<Contract[]>(
    orgId ? () => fetchContractCoverage(orgId) : null,
    [orgId, pulse],
  );

  const [ciTickets, retryCiTickets] = useAfterPaint<TicketWithRelations[]>(
    ciId ? () => fetchCiTickets(ciId) : null,
    [ciId, pulse],
  );

  const contractDisplay = useMemo(() => refineContract(contract), [contract]);

  const refreshAll = useCallback(() => {
    resetCircuitBreakers();
    setPulse((value) => value + 1);
  }, []);

  const requester = ticket.requesterContact;
  const ticketCi = ticket.cis?.find((entry) => entry.id === ciId) ?? null;

  return (
    <aside
      className={clsx('flex w-full flex-col gap-2 overflow-y-auto p-3', className)}
      aria-label={t('rail.title', 'Contexte')}
    >
      {/* ── OWNED DATA — no spinner, no failure mode ─────────────────────── */}
      <section className="rounded-card bg-bg-secondary p-3 shadow-card">
        <h3 className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
          <UserIcon size={13} aria-hidden />
          {t('rail.requester', 'Demandeur')}
        </h3>

        {requester ? (
          <div className="mt-2">
            <p className="truncate text-[13px] font-medium text-text-primary">
              {requester.displayName ?? requester.email}
            </p>
            <a
              href={`mailto:${requester.email}`}
              className="mt-0.5 flex items-center gap-1.5 truncate font-mono text-[11px] text-text-secondary hover:text-accent"
            >
              <Mail size={11} aria-hidden />
              {requester.email}
            </a>
          </div>
        ) : (
          <p className="mt-2 text-[12px] text-text-muted">
            {t('rail.noRequester', 'Aucun demandeur rattaché.')}
          </p>
        )}

        {ticket.organization && (
          <div className="mt-2.5 flex items-center gap-2">
            <Building2 size={13} className="shrink-0 text-text-muted" aria-hidden />
            <span className="truncate text-[12px] text-text-secondary">
              {ticket.organization.name}
            </span>
            <span className="shrink-0 font-mono text-[10px] text-text-muted">
              {ticket.organization.slug}
            </span>
          </div>
        )}
      </section>

      {/* ── Contract coverage ────────────────────────────────────────────── */}
      {orgId !== null ? (
        <SectionShell
          title={t('rail.contract', 'Couverture contractuelle')}
          icon={FileClock}
          state={contractDisplay}
          onRetry={retryContract}
        >
          {contractDisplay?.status === 'ok' &&
            contractDisplay.data &&
            contractDisplay.data.length > 0 && (
              <div className="flex flex-col gap-1.5">
                {contractDisplay.data.map((entry) => (
                  <ContractChip key={entry.id} contract={entry} />
                ))}
              </div>
            )}
          {contractDisplay?.status === 'empty' && (
            <p className="text-[11px] text-text-muted">
              {t('rail.noContract', 'Aucun contrat actif pour cette organisation.')}
            </p>
          )}
        </SectionShell>
      ) : (
        <section className="rounded-card bg-bg-secondary p-3 text-[11px] text-text-muted shadow-card">
          {t('rail.noOrgForContract', 'Aucune organisation : la couverture ne peut pas être établie.')}
        </section>
      )}

      {/* ── The CI ───────────────────────────────────────────────────────── */}
      {ciId === null ? (
        <section className="rounded-card bg-bg-secondary p-3 shadow-card">
          <h3 className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
            <Server size={13} aria-hidden />
            {t('rail.ci', 'Élément de configuration')}
          </h3>
          <p className="mt-2 text-[12px] text-text-muted">
            {t('rail.noCi', 'Aucun CI lié : les sections des applications sœurs restent vides.')}
          </p>
        </section>
      ) : (
        <>
          <CiCard
            ciId={ciId}
            fallbackName={ticketCi?.displayName ?? null}
            fallbackKind={ticketCi?.kind ?? null}
            fallbackCriticality={ticketCi?.criticality ?? null}
            detail={ciDetail}
            onRetry={retryCiDetail}
          />

          {/* Recent tickets on the same CI — REAL today. */}
          <SectionShell
            title={t('rail.ciTickets', 'Tickets récents sur ce CI')}
            icon={TicketIcon}
            state={ciTickets}
            onRetry={retryCiTickets}
          >
            {ciTickets?.status === 'ok' && ciTickets.data && (
              <ul className="flex flex-col gap-1">
                {ciTickets.data
                  .filter((other) => other.id !== ticket.id)
                  .slice(0, 5)
                  .map((other) => (
                    <li key={other.id}>
                      <button
                        type="button"
                        onClick={() => onOpenTicket?.(other.id)}
                        className="flex w-full items-center gap-2 rounded-card px-1.5 py-1 text-left hover:bg-bg-hover"
                      >
                        <span className="shrink-0 font-mono text-[10px] text-text-muted">
                          {other.number}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[12px] text-text-secondary">
                          {other.subject}
                        </span>
                        <StatusPill
                          statusSlug={other.statusSlug}
                          category={other.statusCategory}
                          label={other.status?.label ?? other.statusSlug}
                          size="sm"
                        />
                      </button>
                    </li>
                  ))}
              </ul>
            )}
            {ciTickets?.status === 'empty' && (
              <p className="text-[11px] text-text-muted">
                {t('rail.noCiTickets', 'Aucun autre ticket sur ce CI.')}
              </p>
            )}
          </SectionShell>

          {/* One section per sibling app — each with its own fate. */}
          {CI_LIVE_SECTIONS.map((app) => (
            <LiveSection key={app} app={app} ciId={ciId} pulse={pulse} />
          ))}
        </>
      )}

      <button
        type="button"
        onClick={refreshAll}
        className="mt-1 inline-flex items-center justify-center gap-1.5 rounded-pill bg-bg-tertiary px-3 py-1.5 text-[11px] text-text-secondary hover:bg-bg-hover"
      >
        <RefreshCw size={11} aria-hidden />
        {t('rail.refreshAll', 'Relire toutes les sources')}
      </button>
    </aside>
  );
}

function LiveSection({
  app,
  ciId,
  pulse,
}: {
  app: CiLiveSection;
  ciId: number;
  pulse: number;
}): JSX.Element {
  const { t } = useTranslation();
  const [state, retry] = useAfterPaint<Record<string, unknown>>(
    () => queueLiveRead(() => fetchCiLiveSection(ciId, app)),
    [ciId, app, pulse],
  );
  const display = useMemo(() => refineLive(state), [state]);
  const label = CI_SECTION_LABELS[app];

  return (
    <SectionShell
      title={t(label.key, label.fallback)}
      icon={CI_SECTION_ICONS[app]}
      state={display}
      onRetry={retry}
    >
      {display?.status === 'ok' && display.data && <PayloadTable payload={display.data} />}
      {display?.status === 'empty' && (
        <p className="text-[11px] text-text-muted">
          {t('ci.nothingHere', 'Cette source ne connaît pas ce CI.')}
        </p>
      )}
    </SectionShell>
  );
}
