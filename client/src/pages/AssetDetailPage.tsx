/**
 * AssetDetailPage — `/assets/:id`
 *
 * One machine, and the reason this whole module exists: a ticket that already
 * knows the device. The desk-owned record is on screen at first paint, and the
 * five sibling apps are read THROUGH, live, next to it.
 *
 * ── The rule this page is built around ──────────────────────────────────────
 * Every value that Oblidesk does not own is shown with two things attached:
 * WHICH APP said it, and WHEN it was read. "lu il y a 4m" under the Obliance
 * heading is not decoration; it is the difference between a technician acting
 * on a fact and acting on a memory.
 *
 * Three failure modes are banned on this page, each for a specific reason:
 *
 *   • A spinner that never resolves. Every section has a 4 s budget and a
 *     circuit breaker (`api/ci.api.ts`), so it always lands on an outcome.
 *   • An empty box where a dead source used to be. "Rien à signaler" and "je
 *     n'ai pas pu demander" are opposite facts, and a box that renders the same
 *     for both teaches technicians to distrust every section, including the
 *     ones that work.
 *   • Old values shown as if they were current. When the desk falls back to the
 *     cached payload, the section keeps the values, marks itself stale and ages
 *     the timestamp of the READ THAT PRODUCED THEM (`lastFetchedAt` inside the
 *     record), never the time of the failed attempt.
 *
 * ── Where the data comes from ───────────────────────────────────────────────
 *   GET /api/ci/:id             the desk-owned record: identity, desk fields,
 *                               source links, overlays, open ticket count
 *   GET /api/ci/:id/live/:app   one sibling app, proxied server-side. The
 *                               browser never talks to Obliance directly: the
 *                               cross-app tenant mapping is by SLUG (HARD RULE
 *                               13) and only the server can resolve it.
 *   GET /api/tickets?ciIds=     this machine's tickets, already shipped
 *
 * HARD RULE 11 — no border on any card here. Depth is the background step plus
 * the card shadow.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import {
  AlertTriangle,
  ArrowLeft,
  CircleSlash,
  ExternalLink,
  Loader2,
  RefreshCw,
  Radar,
  ShieldCheck,
  Ticket as TicketIcon,
  TimerOff,
} from 'lucide-react';
import { CAPABILITIES } from '@oblidesk/shared';
import type { Ci, CiOverlay, TicketWithRelations } from '@oblidesk/shared';
import {
  CI_LIVE_SECTIONS,
  CI_SECTION_LABELS,
  fetchCi,
  fetchCiLiveSection,
  fetchCiTickets,
  resetCircuitBreakers,
  type CiLiveSection,
  type SectionResult,
  type SectionStatus,
} from '@/api/ci.api';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { AssetIdentityCard } from '@/components/assets/AssetIdentityCard';
import { AssetOverlayEditor } from '@/components/assets/AssetOverlayEditor';
import { AssetSourceLinks, appDotClass } from '@/components/assets/AssetSourceLinks';
import StatusPill from '@/components/tickets/StatusPill';
import { formatAbsolute, formatRelative } from '@/components/tickets/SlaChip';
import { useAuthStore } from '@/store/authStore';

// ═════════════════════════════════════════════════════════════════════════════
// Section vocabulary
//
// The same six outcomes the context rail renders, reading the same `ci.status.*`
// keys. Two components, one vocabulary: an agent who learned what "appels
// suspendus" means next to a ticket must not meet a different word here.
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

/**
 * Keys the proxy puts in the record for the UI's own use. They are the honesty
 * machinery, not facts about the machine, so they drive the header instead of
 * appearing as rows.
 */
const META_KEYS = new Set(['url', 'externalPath', 'stale', 'lastFetchedAt', 'reason', 'reasonText']);

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
    setState(null);

    // The desk-owned card must be readable before any cross-app socket opens.
    const schedule = window.requestAnimationFrame(() => {
      void load().then((result) => {
        if (alive) setState(result);
      });
    });

    return () => {
      alive = false;
      window.cancelAnimationFrame(schedule);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const retry = useCallback(() => setNonce((value) => value + 1), []);
  return [state, retry];
}

/** A clock that ticks so an old reading LOOKS old without anyone re-fetching. */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

// ═════════════════════════════════════════════════════════════════════════════
// Page
// ═════════════════════════════════════════════════════════════════════════════

export function AssetDetailPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const params = useParams<{ id: string }>();
  const now = useNow();

  const parsed = Number(params.id);
  const ciId = Number.isInteger(parsed) && parsed > 0 ? parsed : null;

  const hasCapability = useAuthStore((state) => state.hasCapability);
  const canEdit = hasCapability(CAPABILITIES.CI_RW);

  // The desk-owned record. Kept in local state rather than re-read after every
  // edit: the PATCH and the overlay PUT both echo the new value back, so the
  // page stays in step without a second round trip.
  const [ci, setCi] = useState<Ci | null>(null);
  const [ciState, retryCi] = useAfterPaint<Ci>(
    ciId === null ? null : () => fetchCi(ciId),
    [ciId],
  );

  useEffect(() => {
    if (ciState?.status === 'ok' && ciState.data) setCi(ciState.data);
  }, [ciState]);

  const [tickets, retryTickets] = useAfterPaint<TicketWithRelations[]>(
    ciId === null ? null : () => fetchCiTickets(ciId, 10),
    [ciId],
  );

  /** One nonce for "tout relire": it re-keys every live section at once. */
  const [allNonce, setAllNonce] = useState(0);

  function retryEverything(): void {
    // Forget the breakers first, or the sections we just asked to retry answer
    // "appels suspendus" without going anywhere near the network.
    resetCircuitBreakers();
    setAllNonce((value) => value + 1);
    retryCi();
    retryTickets();
  }

  if (ciId === null) {
    return (
      <NotFound
        title={t('assets.badId', 'Identifiant d’actif invalide')}
        body={t('assets.badIdBody', 'L’adresse ne contient pas un identifiant d’actif utilisable.')}
      />
    );
  }

  // `/api/ci/:id` ships in this same module, so a 404 here is the id, not a
  // missing route: the CI does not exist in this workspace, or belongs to
  // another tenant, and either way the honest answer is the same one.
  if (ciState && ciState.status === 'unavailable' && ciState.reasonKey === 'ci.section.notDeployed') {
    return (
      <NotFound
        title={t('assets.notFound', 'Actif introuvable')}
        body={t(
          'assets.notFoundBody',
          'Cet actif n’existe pas dans cet espace de travail. Il a peut-être été retiré, ou il appartient à une autre organisation.',
        )}
      />
    );
  }

  return (
    <div className="space-y-4 p-6">
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <Link
          to="/assets"
          className="inline-flex items-center gap-1.5 text-[13px] text-text-muted transition-colors hover:text-text-secondary"
        >
          <ArrowLeft size={14} aria-hidden />
          {t('assets.backToList', 'Tous les actifs')}
        </Link>

        <Button
          size="sm"
          variant="secondary"
          icon={<RefreshCw size={14} />}
          onClick={retryEverything}
        >
          {t('assets.refreshAll', 'Tout relire')}
        </Button>
      </header>

      {ci === null ? (
        <div className="rounded-card bg-bg-secondary py-16 shadow-card">
          {ciState === null ? (
            <div className="flex justify-center">
              <LoadingSpinner label={t('common.loading', 'Chargement…')} />
            </div>
          ) : (
            <div className="mx-auto max-w-md space-y-3 px-6 text-center">
              <p className="text-sm text-text-primary">
                {t('assets.ciUnavailable', 'La fiche de cet actif n’a pas pu être lue.')}
              </p>
              <p className="text-[12px] text-text-muted">
                {ciState.reasonKey ? t(ciState.reasonKey, ciState.reason ?? '') : ciState.reason}
              </p>
              <Button size="sm" variant="secondary" onClick={retryCi}>
                {t('common.retry', 'Réessayer')}
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          {/* ── Owned by the desk ────────────────────────────────────────── */}
          <div className="space-y-4 lg:col-span-2">
            {/* MERGE, never replace: `PATCH /api/ci/:id` echoes the bare `cis`
                row, without the source links, the overlays or the ticket count
                that `GET /api/ci/:id` joined on. Assigning it wholesale would
                blank the two panels next to it. The spread is safe because the
                server omits those keys entirely rather than sending nulls. */}
            <AssetIdentityCard
              ci={ci}
              canEdit={canEdit}
              onSaved={(next) => setCi((current) => (current ? { ...current, ...next } : next))}
            />

            {/* ── Read through, live ────────────────────────────────────── */}
            <section className="space-y-3">
              <div>
                <h2 className="flex items-center gap-2 font-display text-lg font-semibold tracking-wide text-text-primary">
                  <Radar size={17} className="text-accent" aria-hidden />
                  {t('assets.liveTitle', 'Lectures en direct')}
                </h2>
                <p className="mt-0.5 text-[12px] leading-snug text-text-muted">
                  {t(
                    'assets.liveNote',
                    'Ces valeurs appartiennent aux applications sœurs et sont relues à l’ouverture de la fiche. Oblidesk ne les conserve pas : chaque section indique sa source et l’heure de sa lecture, et une correction se fait dans l’application d’origine.',
                  )}
                </p>
              </div>

              <div className="grid gap-3 xl:grid-cols-2">
                {CI_LIVE_SECTIONS.map((app) => (
                  <LiveSection key={app} ciId={ciId} app={app} nonce={allNonce} now={now} />
                ))}
              </div>
            </section>

            <AssetOverlayEditor
              ciId={ci.id}
              overlays={ci.overlays ?? []}
              canEdit={canEdit}
              onChanged={(overlays: CiOverlay[]) =>
                setCi((current) => (current ? { ...current, overlays } : current))
              }
            />
          </div>

          {/* ── Right column ─────────────────────────────────────────────── */}
          <div className="space-y-4">
            <AssetSourceLinks sources={ci.sources ?? []} />

            <section className="rounded-card bg-bg-secondary p-5 shadow-card">
              <header className="flex items-center gap-2">
                <h2 className="flex flex-1 items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
                  <TicketIcon size={12} aria-hidden />
                  {t('assets.linkedTickets', 'Tickets liés')}
                </h2>
                <RetryButton onClick={retryTickets} />
              </header>

              <StatusLine state={tickets} now={now} sourceLabel={null} />

              {tickets?.status === 'ok' && tickets.data && (
                <ul className="mt-3 flex flex-col gap-1.5">
                  {tickets.data.map((ticket) => (
                    <li key={ticket.id}>
                      <button
                        type="button"
                        onClick={() => navigate(`/tickets/${ticket.id}`)}
                        className="w-full rounded-card bg-bg-tertiary p-2.5 text-left transition-colors hover:bg-bg-hover"
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[11px] text-text-muted">
                            {ticket.number}
                          </span>
                          <StatusPill
                            statusSlug={ticket.statusSlug}
                            category={ticket.statusCategory}
                            label={ticket.status?.label}
                            size="sm"
                          />
                        </div>
                        <p className="mt-1 line-clamp-2 text-[12px] text-text-primary">
                          {ticket.subject}
                        </p>
                        <p
                          className="mt-0.5 font-mono text-[10px] text-text-muted"
                          title={formatAbsolute(ticket.updatedAt)}
                        >
                          {formatRelative(ticket.updatedAt, t, now)}
                        </p>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {tickets?.status === 'empty' && (
                <p className="mt-3 text-[12px] text-text-muted">
                  {t('assets.noLinkedTickets', 'Aucun ticket ne mentionne cet actif.')}
                </p>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// One live section
// ═════════════════════════════════════════════════════════════════════════════

function LiveSection({
  ciId,
  app,
  nonce,
  now,
}: {
  ciId: number;
  app: CiLiveSection;
  nonce: number;
  now: number;
}): JSX.Element {
  const { t } = useTranslation();
  const [state, retry] = useAfterPaint<Record<string, unknown>>(
    () => fetchCiLiveSection(ciId, app),
    [ciId, app, nonce],
  );

  const label = CI_SECTION_LABELS[app];
  const record = state?.data ?? null;

  const rows = useMemo(() => (record ? flatten(record) : []), [record]);

  return (
    <section className="rounded-card bg-bg-secondary p-4 shadow-card">
      <header className="flex items-center gap-2">
        <span className={clsx('h-2 w-2 shrink-0 rounded-pill', appDotClass(app))} aria-hidden />
        <h3 className="flex-1 truncate text-[13px] font-medium text-text-primary">
          {t(label.key, label.fallback)}
        </h3>

        {state?.href && (
          <a
            href={state.href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-text-muted transition-colors hover:text-accent"
            title={t('ci.openInSource', 'Ouvrir dans l’application source')}
          >
            <ExternalLink size={12} />
          </a>
        )}

        <RetryButton onClick={retry} />
      </header>

      <StatusLine state={state} now={now} sourceLabel={t(label.key, label.fallback)} />

      {state?.status === 'empty' && (
        <p className="mt-2 text-[11px] leading-snug text-text-muted">
          {t('ci.nothingHere', 'Cette source ne connaît pas ce CI.')}
        </p>
      )}

      {rows.length > 0 && (
        <dl className="mt-2.5 flex flex-col gap-1">
          {rows.map((row) => (
            <div key={row.key} className="flex items-start gap-2 text-[11px]">
              <dt className="w-32 shrink-0 truncate font-mono text-text-muted" title={row.key}>
                {row.key}
              </dt>
              <dd className="min-w-0 flex-1 break-words text-text-secondary" title={row.value}>
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

/**
 * The line that makes the section honest: outcome, source, age, staleness.
 *
 * The age it prints is the age of the VALUES, not of the attempt. When the
 * proxy served the cache it puts the real read time in `lastFetchedAt` inside
 * the record, and that is what gets aged — a section that fell back to a copy
 * from 14:02 must not claim it was read a second ago.
 */
function StatusLine<T>({
  state,
  now,
  sourceLabel,
}: {
  state: SectionResult<T> | null;
  now: number;
  sourceLabel: string | null;
}): JSX.Element {
  const { t } = useTranslation();
  const loading = state === null;
  const StatusIcon = state ? STATUS_ICON[state.status] : Loader2;

  const record = (state?.data ?? null) as unknown as Record<string, unknown> | null;
  const payloadRead =
    record && typeof record.lastFetchedAt === 'string' ? record.lastFetchedAt : null;
  const readAt = payloadRead ?? state?.fetchedAt ?? null;
  const stale = Boolean(state?.stale) || Boolean(record && record.stale === true);

  // The proxy's own sentence, when it sent one. It names the source and the
  // condition ("Cette application ne connait pas cette machine"), which beats
  // the generic transport-level line the client would otherwise show.
  const upstreamReason =
    record && typeof record.reasonText === 'string' && record.reasonText.trim() !== ''
      ? record.reasonText
      : null;

  return (
    <>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
        <span
          className={clsx(
            'inline-flex items-center gap-1',
            loading ? 'text-text-muted' : STATUS_TONE[state.status],
          )}
        >
          <StatusIcon size={11} className={loading ? 'animate-spin' : undefined} aria-hidden />
          {loading
            ? t('ci.loading', 'lecture en cours…')
            : t(STATUS_LABEL[state.status].key, STATUS_LABEL[state.status].fallback)}
        </span>

        {sourceLabel && !loading && (
          <span className="text-text-muted">
            {t('assets.readThrough', 'Lu dans {{app}}', { app: sourceLabel })}
          </span>
        )}

        {readAt && (
          <span className="font-mono text-text-muted" title={formatAbsolute(readAt)}>
            {t('assets.readAgo', 'lu {{age}}', { age: formatRelative(readAt, t, now) })}
          </span>
        )}

        {stale && (
          <span className="rounded-pill bg-sla-warn-bg px-1.5 py-0.5 text-sla-warn">
            {t('ci.staleData', 'données périmées')}
          </span>
        )}
      </div>

      {/* The sentence, whenever there is one to say. `stale` is part of the
          test on purpose: the proxy answers 200 when it serves the cache, so a
          section that fell back would otherwise show an amber pill and no
          explanation of what it fell back FROM. */}
      {state && (state.status !== 'ok' || stale) && (upstreamReason ?? state.reason) && (
        <p className="mt-1.5 text-[11px] leading-snug text-text-muted">
          {upstreamReason ??
            (state.reasonKey ? t(state.reasonKey, state.reason ?? '') : state.reason)}
        </p>
      )}

      {stale && (
        <p className="mt-1 text-[11px] leading-snug text-text-muted">
          {t(
            'assets.staleNote',
            'Les valeurs ci-dessous sont la dernière réponse connue de cette application, pas son état actuel.',
          )}
        </p>
      )}
    </>
  );
}

function RetryButton({ onClick }: { onClick: () => void }): JSX.Element {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-pill p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-secondary"
      title={t('ci.refresh', 'Relire cette source')}
      aria-label={t('ci.refresh', 'Relire cette source')}
    >
      <RefreshCw size={11} />
    </button>
  );
}

function NotFound({ title, body }: { title: string; body: string }): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="p-6">
      <div className="mx-auto max-w-md space-y-3 rounded-card bg-bg-secondary p-8 text-center shadow-card">
        <h1 className="font-display text-xl font-semibold tracking-wide text-text-primary">
          {title}
        </h1>
        <p className="text-[13px] leading-relaxed text-text-muted">{body}</p>
        <Link to="/assets">
          <Button size="sm" variant="secondary" icon={<ArrowLeft size={14} />}>
            {t('assets.backToList', 'Tous les actifs')}
          </Button>
        </Link>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Payload rendering
// ═════════════════════════════════════════════════════════════════════════════

interface PayloadRow {
  key: string;
  value: string;
}

/**
 * The sibling payloads are not typed here on purpose.
 *
 * Oblidesk does not own their shape, and a hard-coded field list would silently
 * drop whatever the source started sending last week. Rendering the keys we
 * were actually given, flattened one level and with the honesty metadata pulled
 * out into the header, is the only version that cannot lie by omission.
 */
function flatten(record: Record<string, unknown>): PayloadRow[] {
  const rows: PayloadRow[] = [];

  for (const [key, value] of Object.entries(record)) {
    if (META_KEYS.has(key)) continue;
    if (value === null || value === undefined) continue;

    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      rows.push({ key, value: value.map(compact).join('  |  ') });
      continue;
    }

    if (typeof value === 'object') {
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        if (childValue === null || childValue === undefined) continue;
        rows.push({ key: `${key}.${childKey}`, value: compact(childValue) });
      }
      continue;
    }

    rows.push({ key, value: String(value) });
  }

  return rows;
}

/** One nested value on one line: readable, and never a wall of JSON braces. */
function compact(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.map(compact).join(', ');
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== null && entry !== undefined && typeof entry !== 'object')
      .map(([entryKey, entry]) => `${entryKey} ${String(entry)}`)
      .join(' · ');
  }
  return String(value);
}

export default AssetDetailPage;
