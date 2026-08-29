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
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  Building2,
  CircleSlash,
  ExternalLink,
  FileClock,
  Loader2,
  Mail,
  RefreshCw,
  Server,
  ShieldCheck,
  Ticket as TicketIcon,
  TimerOff,
  User as UserIcon,
} from 'lucide-react';
import type { Contract, TicketWithRelations } from '@oblidesk/shared';
import {
  CI_LIVE_SECTIONS,
  CI_SECTION_LABELS,
  fetchCiLiveSection,
  fetchCiTickets,
  fetchContractCoverage,
  resetCircuitBreakers,
  type CiLiveSection,
  type SectionResult,
  type SectionStatus,
} from '@/api/ci.api';
import { formatRelative } from './SlaChip';
import StatusPill from './StatusPill';

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
          <span className="font-mono text-text-muted">
            {t('ci.lastRead', 'dernière lecture')} {formatRelative(state.fetchedAt, t)}
          </span>
        )}

        {state?.stale && (
          <span className="rounded-pill bg-sla-warn-bg px-1.5 py-0.5 text-sla-warn">
            {t('ci.staleData', 'données périmées')}
          </span>
        )}
      </div>

      {state?.reason && state.status !== 'ok' && (
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
    setState(null);

    // The rail must not delay the ticket. Yield a frame first so the owned data
    // is painted before any cross-app socket is opened.
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

// ═════════════════════════════════════════════════════════════════════════════
// Contract coverage
// ═════════════════════════════════════════════════════════════════════════════

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
 * last week. Rendering the keys we were given — flattened one level, skipping
 * the plumbing — is honest about what arrived.
 */
function PayloadTable({ payload }: { payload: Record<string, unknown> }): JSX.Element {
  const rows = useMemo(
    () =>
      Object.entries(payload)
        .filter(([key]) => key !== 'url' && key !== 'externalPath')
        .slice(0, 12)
        .map(([key, value]) => ({
          key,
          value:
            value === null || value === undefined
              ? '—'
              : typeof value === 'object'
                ? JSON.stringify(value)
                : String(value),
        })),
    [payload],
  );

  if (rows.length === 0) return <p className="text-[11px] text-text-muted">—</p>;

  return (
    <dl className="flex flex-col gap-1">
      {rows.map((row) => (
        <div key={row.key} className="flex items-start gap-2 text-[11px]">
          <dt className="w-28 shrink-0 truncate font-mono text-text-muted">{row.key}</dt>
          <dd className="min-w-0 flex-1 truncate text-text-secondary" title={row.value}>
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// The rail
// ═════════════════════════════════════════════════════════════════════════════

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

  const [contract, retryContract] = useAfterPaint<Contract[]>(
    orgId ? () => fetchContractCoverage(orgId) : null,
    [orgId],
  );

  const [ciTickets, retryCiTickets] = useAfterPaint<TicketWithRelations[]>(
    ciId ? () => fetchCiTickets(ciId) : null,
    [ciId],
  );

  const refreshAll = useCallback(() => {
    resetCircuitBreakers();
    retryContract();
    retryCiTickets();
  }, [retryContract, retryCiTickets]);

  const requester = ticket.requesterContact;

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
          state={contract}
          onRetry={retryContract}
        >
          {contract?.status === 'ok' && contract.data && contract.data.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {contract.data.map((entry) => (
                <ContractChip key={entry.id} contract={entry} />
              ))}
            </div>
          )}
          {contract?.status === 'empty' && (
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
          <section className="rounded-card bg-bg-secondary p-3 shadow-card">
            <h3 className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
              <Server size={13} aria-hidden />
              {t('rail.ci', 'Élément de configuration')}
            </h3>
            <p className="mt-2 truncate text-[13px] font-medium text-text-primary">
              {ticket.cis?.find((ci) => ci.id === ciId)?.displayName ?? `CI #${ciId}`}
            </p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {ticket.cis
                ?.filter((ci) => ci.id === ciId)
                .map((ci) => (
                  <span
                    key={ci.id}
                    className="rounded-pill bg-bg-tertiary px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-text-secondary"
                  >
                    {ci.kind}
                    {ci.criticality ? ` · ${ci.criticality}` : ''}
                  </span>
                ))}
            </div>
          </section>

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
            <LiveSection key={app} app={app} ciId={ciId} />
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

function LiveSection({ app, ciId }: { app: CiLiveSection; ciId: number }): JSX.Element {
  const { t } = useTranslation();
  const [state, retry] = useAfterPaint<Record<string, unknown>>(
    () => fetchCiLiveSection(ciId, app),
    [ciId, app],
  );
  const label = CI_SECTION_LABELS[app];

  return (
    <SectionShell title={t(label.key, label.fallback)} icon={Server} state={state} onRetry={retry}>
      {state?.status === 'ok' && state.data && <PayloadTable payload={state.data} />}
      {state?.status === 'empty' && (
        <p className="text-[11px] text-text-muted">
          {t('ci.nothingHere', 'Cette source ne connaît pas ce CI.')}
        </p>
      )}
    </SectionShell>
  );
}
