/**
 * TransitionInspector.tsx — why the button is grey.
 *
 * ── The sentence this file exists to produce ─────────────────────────────────
 *     « Résoudre — bloqué : les notes de résolution sont vides ;
 *       vous n’êtes pas dans le groupe N2 »
 *
 * Not "action non autorisée". Not a disabled button with no tooltip. The exact
 * list of things that are false, in the order the evaluator found them, each
 * one actionable.
 *
 * ── Where the reasons come from ──────────────────────────────────────────────
 * `GET /api/tickets/:id/transitions` returns EVERY edge the state machine
 * declares out of the current status, blocked ones included, each carrying a
 * structured `BlockedReason[]`. The client renders those; it does not compute
 * them. There is exactly one transition evaluator (HARD RULE 12) and it runs on
 * the server — a second copy here would be a second answer, and the day they
 * disagreed the UI would confidently enable a button the API then refuses.
 *
 * Every reason arrives as `{ code, i18nKey, fallback, params }` so the string
 * goes through `t(key, fallback, params)` (HARD RULE 10) and a missing key
 * degrades to a readable French sentence rather than a raw key.
 *
 * ── Deep links ───────────────────────────────────────────────────────────────
 * A missing field links to the field on the ticket. A guard that failed links
 * to the state machine config object that declares it. "Blocked" without a way
 * to reach the thing that blocks you is just a nicer refusal.
 */
import { useMemo } from 'react';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight,
  ExternalLink,
  KeyRound,
  ListChecks,
  ShieldAlert,
  SquarePen,
  XCircle,
} from 'lucide-react';
import type { ConditionTrace, StatusCategory, TransitionEvaluation } from '@oblidesk/shared';
import StatusPill from './StatusPill';

// ═════════════════════════════════════════════════════════════════════════════
// The wire shape (server: services/stateMachine.service.ts)
// ═════════════════════════════════════════════════════════════════════════════

export type BlockedReasonCode =
  | 'unknown_status'
  | 'no_transition'
  | 'terminal_status'
  | 'missing_field'
  | 'missing_capability'
  | 'role_not_allowed'
  | 'actor_type_not_allowed'
  | 'guard_failed';

export interface BlockedReason {
  code: BlockedReasonCode | string;
  /** HARD RULE 10 — `t(i18nKey, fallback, params)`. */
  i18nKey: string;
  fallback: string;
  params?: Record<string, unknown>;
}

export interface LocalizedLabel {
  en: string;
  fr?: string;
}

/** One row of `GET /api/tickets/:id/transitions`. */
export interface TransitionOption extends TransitionEvaluation {
  transitionSlug: string | null;
  label: LocalizedLabel;
  toCategory: StatusCategory | null;
  blocked: BlockedReason[];
  /** Fields the transition dialog should collect before firing. */
  promptFor: string[];
  confirm: boolean;
  effects: unknown[];
}

export interface AvailableTransitions {
  machineSlug: string;
  currentStatusSlug: string;
  currentCategory: StatusCategory;
  transitions: TransitionOption[];
}

// ═════════════════════════════════════════════════════════════════════════════
// Rendering helpers — exported, because the header button needs the same words
// ═════════════════════════════════════════════════════════════════════════════

type Translate = (key: string, fallback: string, opts?: Record<string, unknown>) => string;

/** The label a tenant configured, French first, English as the fallback. */
export function transitionLabel(option: TransitionOption, fallbackSlug?: string): string {
  return option.label?.fr?.trim() || option.label?.en?.trim() || fallbackSlug || option.toStatusSlug;
}

/**
 * The one-line refusal, joined with "; " — exactly what goes in the button's
 * `title` so a keyboard user gets the reason without opening anything.
 */
export function describeBlocked(blocked: readonly BlockedReason[], t: Translate): string {
  return blocked
    .map((reason) => t(reason.i18nKey, reason.fallback, reason.params))
    .join(' ; ');
}

/** "Résoudre — bloqué : …" — the full sentence from the brief. */
export function describeBlockedTransition(
  option: TransitionOption,
  t: Translate,
): string {
  const label = transitionLabel(option);
  if (option.allowed) return label;
  return `${label} (${t('transition.blockedPrefix', 'bloqué')}) : ${describeBlocked(option.blocked, t)}`;
}

const REASON_ICON: Record<string, typeof XCircle> = {
  missing_field: SquarePen,
  missing_capability: KeyRound,
  role_not_allowed: KeyRound,
  actor_type_not_allowed: KeyRound,
  guard_failed: ShieldAlert,
  terminal_status: XCircle,
  no_transition: XCircle,
  unknown_status: XCircle,
};

// ═════════════════════════════════════════════════════════════════════════════
// Guard trace
// ═════════════════════════════════════════════════════════════════════════════

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '∅';
  if (Array.isArray(value)) return `[${value.map(formatValue).join(', ')}]`;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * The guard, node by node.
 *
 * A guard that failed is a boolean expression, and "the guard failed" is not an
 * explanation of a boolean expression. Showing which leaf was false — with the
 * value it actually read — is the difference between a refusal an agent can fix
 * and one they escalate.
 */
function TraceNode({ trace, depth }: { trace: ConditionTrace; depth: number }): JSX.Element {
  const { t } = useTranslation();
  const mark = trace.matched ? '✓' : '✗';
  const tone = trace.matched ? 'text-sla-ok' : 'text-sla-breach';

  if (trace.type === 'invalid') {
    return (
      <div className="flex gap-2 font-mono text-[11px]" style={{ paddingLeft: depth * 14 }}>
        <span className="text-sla-breach">✗</span>
        <span className="text-text-muted">
          {t('transition.trace.invalid', 'nœud invalide')} : {trace.detail}
        </span>
      </div>
    );
  }

  if (trace.type === 'leaf') {
    return (
      <div className="flex gap-2 font-mono text-[11px]" style={{ paddingLeft: depth * 14 }}>
        <span className={tone}>{mark}</span>
        <span className="text-text-secondary">
          <span className="text-text-primary">{trace.field}</span> {trace.op}{' '}
          <span className="text-accent">{formatValue(trace.value)}</span>
          <span className="text-text-muted">
            {' '}
            ({t('transition.trace.actual', 'valeur lue')} : {formatValue(trace.actual)})
          </span>
          {trace.issue ? <span className="text-sla-warn"> · {trace.issue}</span> : null}
        </span>
      </div>
    );
  }

  const header = trace.type === 'not' ? 'NON' : trace.type === 'all' ? 'TOUTES' : 'AU MOINS UNE';
  return (
    <div>
      <div className="flex gap-2 font-mono text-[11px]" style={{ paddingLeft: depth * 14 }}>
        <span className={tone}>{mark}</span>
        <span className="uppercase tracking-[0.08em] text-text-muted">{header}</span>
      </div>
      {trace.children.map((child, index) => (
        <TraceNode key={index} trace={child} depth={depth + 1} />
      ))}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// The inspector
// ═════════════════════════════════════════════════════════════════════════════

export interface TransitionInspectorProps {
  option: TransitionOption;
  /** State machine that declares the edge — deep-linked from the footer. */
  machineSlug: string;
  currentStatusSlug: string;
  /** HARD RULE 5 — the pill paints from this, never from the slug. */
  currentCategory: StatusCategory;
  /** Focus the named field on the ticket so the agent can fill it. */
  onGoToField?: (field: string) => void;
  /** Open the config object that made this decision. */
  onOpenConfig?: (kind: string, slug: string) => void;
  className?: string;
}

export default function TransitionInspector({
  option,
  machineSlug,
  currentStatusSlug,
  currentCategory,
  onGoToField,
  onOpenConfig,
  className,
}: TransitionInspectorProps): JSX.Element {
  const { t } = useTranslation();

  // The evaluator can report a missing field twice — once as a structured
  // reason, once in `missingRequiredFields`. Render each field once.
  const missingFromReasons = useMemo(
    () =>
      new Set(
        option.blocked
          .filter((reason) => reason.code === 'missing_field')
          .map((reason) => String(reason.params?.field ?? '')),
      ),
    [option.blocked],
  );

  const extraMissing = option.missingRequiredFields.filter(
    (field) => !missingFromReasons.has(field),
  );

  return (
    <div
      className={clsx(
        'w-[min(30rem,90vw)] rounded-modal bg-bg-secondary p-4 shadow-card',
        className,
      )}
      role="dialog"
      aria-label={t('transition.inspector', 'Détail de la transition')}
    >
      {/* ── Heading: from → to, with both categories visible ─────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill
          statusSlug={currentStatusSlug}
          category={currentCategory}
          size="sm"
          label={currentStatusSlug}
        />
        <ArrowRight size={13} className="text-text-muted" aria-hidden />
        <StatusPill
          statusSlug={option.toStatusSlug}
          category={option.toCategory ?? 'open'}
          label={transitionLabel(option)}
          size="sm"
          showCategory
        />
      </div>

      {option.allowed ? (
        <p className="mt-3 text-[13px] text-sla-ok">
          {t('transition.allowed', 'Cette transition est possible.')}
        </p>
      ) : (
        <p className="mt-3 text-[13px] font-medium text-text-primary">
          {t('transition.blockedTitle', 'Cette transition est bloquée par :')}
        </p>
      )}

      {/* ── The reasons, one row each ────────────────────────────────────── */}
      {option.blocked.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1.5">
          {option.blocked.map((reason, index) => {
            const Icon = REASON_ICON[reason.code] ?? XCircle;
            const field =
              reason.code === 'missing_field' ? String(reason.params?.field ?? '') : null;

            return (
              <li
                key={`${reason.code}-${index}`}
                className="flex items-start gap-2 rounded-card bg-bg-tertiary px-2.5 py-2 text-[12px] text-text-secondary"
              >
                <Icon size={14} className="mt-0.5 shrink-0 text-sla-breach" aria-hidden />
                <span className="flex-1 leading-snug">
                  {t(reason.i18nKey, reason.fallback, reason.params)}
                </span>
                {field && onGoToField && (
                  <button
                    type="button"
                    onClick={() => onGoToField(field)}
                    className="shrink-0 rounded-pill bg-bg-hover px-2 py-0.5 text-[11px] text-accent hover:bg-bg-active"
                  >
                    {t('transition.fillField', 'Remplir')}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* ── Fields the evaluator wants that no reason spelled out ────────── */}
      {extraMissing.length > 0 && (
        <div className="mt-3">
          <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
            <ListChecks size={11} aria-hidden />
            {t('transition.missingFields', 'Champs manquants')}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {extraMissing.map((field) => (
              <button
                key={field}
                type="button"
                onClick={() => onGoToField?.(field)}
                className="rounded-pill bg-bg-tertiary px-2 py-1 font-mono text-[11px] text-text-secondary hover:bg-bg-hover"
              >
                {field}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Capabilities ─────────────────────────────────────────────────── */}
      {option.missingCapabilities.length > 0 && (
        <div className="mt-3">
          <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
            <KeyRound size={11} aria-hidden />
            {t('transition.missingCapabilities', 'Permissions manquantes')}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {option.missingCapabilities.map((capability) => (
              <span
                key={capability}
                className="rounded-pill bg-bg-tertiary px-2 py-1 font-mono text-[11px] text-text-secondary"
              >
                {capability}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ── The guard, expanded ──────────────────────────────────────────── */}
      {option.guardTrace && (
        <details className="mt-3 rounded-card bg-bg-tertiary px-2.5 py-2" open={!option.allowed}>
          <summary className="cursor-pointer select-none font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
            {t('transition.guard', 'Condition de garde')}
          </summary>
          <div className="mt-2 flex flex-col gap-0.5 overflow-x-auto">
            <TraceNode trace={option.guardTrace} depth={0} />
          </div>
        </details>
      )}

      {/* ── Prompted fields — what the dialog will ask for ───────────────── */}
      {option.promptFor.length > 0 && (
        <p className="mt-3 text-[11px] leading-snug text-text-muted">
          {t(
            'transition.willPrompt',
            'Cette transition demandera : {{fields}}.',
            { fields: option.promptFor.join(', ') },
          )}
        </p>
      )}

      {/* ── Provenance: which config object decided ──────────────────────── */}
      <div className="mt-3 flex items-center justify-between gap-2 text-[11px] text-text-muted">
        <span className="font-mono">
          {t('transition.machine', 'Automate')} : {machineSlug}
          {option.transitionSlug ? ` · ${option.transitionSlug}` : ''}
        </span>
        {onOpenConfig && (
          <button
            type="button"
            onClick={() => onOpenConfig('state_machine', machineSlug)}
            className="inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-accent hover:bg-bg-hover"
          >
            {t('transition.openConfig', 'Ouvrir la configuration')}
            <ExternalLink size={11} aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}
