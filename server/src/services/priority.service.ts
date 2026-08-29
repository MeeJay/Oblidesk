/**
 * priority.service.ts — impact × urgency, and the reason a human disagreed.
 *
 * Priority is not a field an agent picks; it is a CONSEQUENCE of two questions
 * anybody can answer without training:
 *
 *     impact  — how much of the organisation is affected?
 *     urgency — how fast is it hurting?
 *
 * The `priority_matrix` config object maps the nine combinations onto priority
 * slugs. Deriving it rather than asking for it is what stops every ticket from
 * being P1: the agent is choosing two words about the world, not a number about
 * their own queue.
 *
 * ── The override is the interesting part ─────────────────────────────────────
 * Sometimes the matrix is wrong — a "low impact / low urgency" ticket that is
 * actually the CEO's laptop before a board meeting. So overriding is allowed
 * (`allow_manual_override`), but it is NEVER silent: an override writes a
 * `decision_log` row on the same code path as the change (HARD RULE 2), naming
 * the human, the computed value, the chosen value and the REASON. Without the
 * reason there is no way to tell a justified escalation from a habit, and P1
 * stops meaning anything within a quarter.
 *
 * The reason is therefore mandatory in code, not just in the UI.
 */
import {
  DEFAULT_PRIORITY_SLUG,
  BASELINE_SLUGS,
  type ImpactLevel,
  type UrgencyLevel,
} from '@oblidesk/shared';
import type { Knex } from 'knex';

import { db, type Executor } from '../db';
import { AppError } from '../middleware/errorHandler';
import { withDecision as withDecisionRaw } from './decision.service';
import {
  readPublishedConfigObject,
  type ConfigObjectRow,
  type TransitionActor,
} from './stateMachine.service';

/** The acting user/engine, as every desk service sees it. */
export type ActorContext = TransitionActor;

// ── decision_log plumbing (HARD RULE 2) ──────────────────────────────────────
//
// `decision.service` owns the writer; this is the shape this engine calls it
// with. The binding is re-declared per engine on purpose: each file states the
// contract it depends on, so a signature change surfaces here as a compile
// error rather than as a silently missing audit trail.
export interface DecisionContext {
  tenantId: number;
  ticketId?: number | null;
  subsystem: string;
  /** Short machine key, e.g. 'priority_from_matrix'. */
  decision: string;
  inputs?: Record<string, unknown>;
  /** The config object that decided (HARD RULE 3 — a slug). */
  ruleSlug?: string | null;
  ruleVersion?: number | null;
  actorId?: number | null;
  trx?: Knex.Transaction;
}

export interface DecisionRecorder {
  outcome?: (patch: Record<string, unknown>) => void;
  input?: (patch: Record<string, unknown>) => void;
}

type WithDecision = <T>(
  ctx: DecisionContext,
  run: (recorder?: DecisionRecorder) => Promise<T>,
) => Promise<T>;

const withDecision = withDecisionRaw as unknown as WithDecision;

// ═════════════════════════════════════════════════════════════════════════════
// Normalised matrix
// ═════════════════════════════════════════════════════════════════════════════

export interface PriorityLevel {
  slug: string;
  /** 1 = most urgent. Drives sorting and the P1/P2/P3/P4 chips. */
  rank: number;
  label: { en: string; fr?: string };
  tone?: string;
  color?: string;
  slaPolicySlug?: string | null;
}

export interface NormalizedPriorityMatrix {
  slug: string;
  version: number;
  priorities: PriorityLevel[];
  priorityBySlug: ReadonlyMap<string, PriorityLevel>;
  /** `${impact}:${urgency}` → priority slug. */
  matrix: ReadonlyMap<string, string>;
  defaultPrioritySlug: string;
  defaultImpact: ImpactLevel;
  defaultUrgency: UrgencyLevel;
  allowManualOverride: boolean;
  /** When true, an override without a reason is refused (never just logged). */
  overrideRequiresReason: boolean;
  recomputeOnChange: boolean;
  isFallback: boolean;
}

const LEVELS = ['high', 'medium', 'low'] as const;

export function matrixKey(impact: string, urgency: string): string {
  return `${impact}:${urgency}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pick(body: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = body[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function readLabel(raw: unknown, fallback: string): { en: string; fr?: string } {
  if (typeof raw === 'string' && raw.trim() !== '') return { en: raw };
  if (isRecord(raw)) {
    const en = typeof raw.en === 'string' ? raw.en : fallback;
    const fr = typeof raw.fr === 'string' ? raw.fr : undefined;
    return fr ? { en, fr } : { en };
  }
  return { en: fallback };
}

function coerceLevel<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw)
    ? (raw as T)
    : fallback;
}

/**
 * Read either body dialect into one shape.
 *
 * The shipped baseline nests the matrix — `matrix: { high: { high: 'p1' } }` —
 * while the shared `PriorityMatrixBody` flattens it — `matrix: { 'high:high':
 * 'p1' }`. Both are in the wild (export format vs API DTO); a reader that
 * understands one silently mis-prices every ticket for tenants using the other.
 */
export function normalizePriorityMatrixBody(
  slug: string,
  body: Record<string, unknown>,
  meta: { version?: number } = {},
): NormalizedPriorityMatrix {
  const rawPriorities = Array.isArray(body.priorities) ? body.priorities : [];
  const priorities: PriorityLevel[] = rawPriorities
    .map((raw, index): PriorityLevel | null => {
      if (!isRecord(raw) || typeof raw.slug !== 'string') return null;
      const orderValue = Number(pick(raw, 'rank', 'order', 'sortOrder', 'sort_order'));
      return {
        slug: raw.slug,
        rank: Number.isFinite(orderValue) ? orderValue : (index + 1) * 10,
        label: readLabel(raw.label, raw.slug),
        tone: typeof raw.tone === 'string' ? raw.tone : undefined,
        color: typeof raw.color === 'string' ? raw.color : undefined,
        slaPolicySlug:
          (pick(raw, 'slaPolicySlug', 'sla_policy') as string | undefined) ?? null,
      };
    })
    .filter((p): p is PriorityLevel => p !== null)
    .sort((a, b) => a.rank - b.rank);

  const matrix = new Map<string, string>();
  const rawMatrix = body.matrix;
  if (isRecord(rawMatrix)) {
    for (const [key, value] of Object.entries(rawMatrix)) {
      if (typeof value === 'string') {
        // Flat dialect: 'high:high' → 'p1'.
        matrix.set(key.toLowerCase(), value);
        continue;
      }
      if (isRecord(value)) {
        // Nested dialect: matrix[impact][urgency] → slug.
        for (const [urgency, slugValue] of Object.entries(value)) {
          if (typeof slugValue === 'string') {
            matrix.set(matrixKey(key.toLowerCase(), urgency.toLowerCase()), slugValue);
          }
        }
      }
    }
  }

  const defaultPriority =
    (pick(body, 'defaultPrioritySlug', 'default_priority') as string | undefined) ??
    priorities[0]?.slug ??
    DEFAULT_PRIORITY_SLUG;

  const allowOverride = pick(body, 'allowManualOverride', 'allow_manual_override');
  const requiresReason = pick(body, 'overrideRequiresReason', 'override_requires_reason');
  const recompute = pick(body, 'recomputeOnChange', 'recompute_on_change');

  return {
    slug,
    version: meta.version ?? 1,
    priorities,
    priorityBySlug: new Map(priorities.map((p) => [p.slug, p])),
    matrix,
    defaultPrioritySlug: defaultPriority,
    defaultImpact: coerceLevel(pick(body, 'defaultImpact', 'default_impact'), LEVELS, 'medium'),
    defaultUrgency: coerceLevel(pick(body, 'defaultUrgency', 'default_urgency'), LEVELS, 'medium'),
    // Absent means "allowed": a desk that cannot escalate by hand is unusable.
    allowManualOverride: allowOverride !== false,
    // Absent means "required": HARD RULE 2 is the default, not the opt-in.
    overrideRequiresReason: requiresReason !== false,
    recomputeOnChange: recompute !== false,
    isFallback: false,
  };
}

/**
 * The matrix used when a tenant has no published `priority_matrix`. Mirrors the
 * baseline so behaviour does not change shape when an admin archives it.
 */
function fallbackMatrix(slug: string): NormalizedPriorityMatrix {
  const priorities: PriorityLevel[] = [
    { slug: 'p1', rank: 10, label: { en: 'P1 — Critical', fr: 'P1 — Critique' } },
    { slug: 'p2', rank: 20, label: { en: 'P2 — High', fr: 'P2 — Élevée' } },
    { slug: 'p3', rank: 30, label: { en: 'P3 — Normal', fr: 'P3 — Normale' } },
    { slug: 'p4', rank: 40, label: { en: 'P4 — Low', fr: 'P4 — Faible' } },
  ];
  const matrix = new Map<string, string>([
    ['high:high', 'p1'], ['high:medium', 'p2'], ['high:low', 'p3'],
    ['medium:high', 'p2'], ['medium:medium', 'p3'], ['medium:low', 'p4'],
    ['low:high', 'p3'], ['low:medium', 'p4'], ['low:low', 'p4'],
  ]);
  return {
    slug,
    version: 0,
    priorities,
    priorityBySlug: new Map(priorities.map((p) => [p.slug, p])),
    matrix,
    defaultPrioritySlug: DEFAULT_PRIORITY_SLUG,
    defaultImpact: 'medium',
    defaultUrgency: 'medium',
    allowManualOverride: true,
    overrideRequiresReason: true,
    recomputeOnChange: true,
    isFallback: true,
  };
}

// ── Cache ────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { value: NormalizedPriorityMatrix; expiresAt: number }>();

export function invalidatePriorityCache(tenantId?: number, slug?: string): void {
  if (tenantId === undefined) {
    cache.clear();
    return;
  }
  if (slug !== undefined) {
    cache.delete(`${tenantId}::${slug}`);
    return;
  }
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${tenantId}::`)) cache.delete(key);
  }
}

export async function loadPriorityMatrix(
  tenantId: number,
  slug: string = BASELINE_SLUGS.priorityMatrix,
  executor: Executor = db,
): Promise<NormalizedPriorityMatrix> {
  const key = `${tenantId}::${slug}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const row: ConfigObjectRow | null = await readPublishedConfigObject(
    tenantId,
    'priority_matrix',
    slug,
    executor,
  );
  const value = row
    ? normalizePriorityMatrixBody(row.slug, row.body, { version: row.version })
    : fallbackMatrix(slug);

  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

// ═════════════════════════════════════════════════════════════════════════════
// Derivation
// ═════════════════════════════════════════════════════════════════════════════

export interface PriorityComputation {
  prioritySlug: string;
  impact: ImpactLevel;
  urgency: UrgencyLevel;
  /** `matrix` when the pair was found, `default` when it fell through. */
  source: 'matrix' | 'default';
  matrixSlug: string;
  matrixVersion: number;
}

/**
 * Pure function: (impact, urgency) → priority slug. No I/O, so the client can
 * run the identical computation from the same body and preview the answer while
 * the agent is still choosing.
 */
export function computePriority(
  matrix: NormalizedPriorityMatrix,
  impact?: string | null,
  urgency?: string | null,
): PriorityComputation {
  const resolvedImpact = coerceLevel(impact, LEVELS, matrix.defaultImpact);
  const resolvedUrgency = coerceLevel(urgency, LEVELS, matrix.defaultUrgency);
  const hit = matrix.matrix.get(matrixKey(resolvedImpact, resolvedUrgency));

  return {
    prioritySlug: hit ?? matrix.defaultPrioritySlug,
    impact: resolvedImpact,
    urgency: resolvedUrgency,
    source: hit ? 'matrix' : 'default',
    matrixSlug: matrix.slug,
    matrixVersion: matrix.version,
  };
}

/** Rank of a priority slug — 1 is most urgent. Unknown slugs sort last. */
export function priorityRank(matrix: NormalizedPriorityMatrix, slug: string): number {
  return matrix.priorityBySlug.get(slug)?.rank ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Derive a priority for a ticket that is being created or whose impact/urgency
 * just changed, writing the decision on the same code path (HARD RULE 2).
 */
export async function derivePriority(input: {
  tenantId: number;
  ticketId?: number | null;
  impact?: string | null;
  urgency?: string | null;
  matrixSlug?: string;
  trx?: Knex.Transaction;
  actor?: ActorContext;
  /** Why the derivation ran, e.g. 'ticket_created' | 'impact_changed'. */
  trigger?: string;
}): Promise<PriorityComputation> {
  const matrix = await loadPriorityMatrix(
    input.tenantId,
    input.matrixSlug ?? BASELINE_SLUGS.priorityMatrix,
    input.trx ?? db,
  );
  const computation = computePriority(matrix, input.impact, input.urgency);

  const ctx: DecisionContext = {
    tenantId: input.tenantId,
    ticketId: input.ticketId ?? null,
    subsystem: 'priority',
    decision: 'priority_from_matrix',
    ruleSlug: matrix.slug,
    ruleVersion: matrix.version,
    actorId: input.actor?.userId ?? null,
    trx: input.trx,
    inputs: {
      fields: {
        impact: computation.impact,
        urgency: computation.urgency,
        trigger: input.trigger ?? 'derive',
      },
    },
  };

  return withDecision(ctx, async (recorder?: DecisionRecorder) => {
    recorder?.outcome?.({
      prioritySlug: computation.prioritySlug,
      source: computation.source,
      matrixIsFallback: matrix.isFallback,
    });
    return computation;
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// The override
// ═════════════════════════════════════════════════════════════════════════════

export interface PriorityOverrideInput {
  tenantId: number;
  /** Null while the ticket is still being inserted — the decision row is still
   *  written, on the same code path, and the ticket id lands in its outcome. */
  ticketId: number | null;
  actor: ActorContext;
  /** What the matrix says right now. */
  computedSlug: string;
  /** What the human wants instead. */
  chosenSlug: string;
  /** MANDATORY when the matrix says so — and it says so by default. */
  reason?: string | null;
  impact?: string | null;
  urgency?: string | null;
  matrixSlug?: string;
  trx?: Knex.Transaction;
}

export interface PriorityOverrideResult {
  prioritySlug: string;
  overridden: boolean;
  reason: string | null;
}

/**
 * Validate and record a manual priority override.
 *
 * Refuses (400) when the matrix forbids overrides, when the slug is not a
 * priority the matrix defines, or when the reason is missing. The
 * `decision_log` row is written here, on the same code path as the change —
 * never reconstructed later from the timeline (HARD RULE 2).
 *
 * The CALLER performs the actual UPDATE, inside the same transaction, so this
 * function is usable from ticket create, ticket update and the rules engine
 * without any of them having to know how a priority column is written.
 */
export async function applyPriorityOverride(
  input: PriorityOverrideInput,
): Promise<PriorityOverrideResult> {
  const matrix = await loadPriorityMatrix(
    input.tenantId,
    input.matrixSlug ?? BASELINE_SLUGS.priorityMatrix,
    input.trx ?? db,
  );

  if (input.chosenSlug === input.computedSlug) {
    return { prioritySlug: input.chosenSlug, overridden: false, reason: null };
  }

  if (!matrix.allowManualOverride) {
    throw new AppError(
      400,
      'This tenant derives priority from impact × urgency and does not allow manual overrides',
    );
  }

  if (matrix.priorities.length > 0 && !matrix.priorityBySlug.has(input.chosenSlug)) {
    throw new AppError(400, `Unknown priority "${input.chosenSlug}"`);
  }

  const reason = (input.reason ?? '').trim();

  // "MANDATORY override reason when a HUMAN overrides the computed priority."
  // An engine's reason is its slug — already in `ruleSlug` and in the row this
  // call writes — so demanding prose from an alert binder would only produce a
  // hard-coded sentence that explains nothing.
  const isHuman = input.actor.actorType === 'user';
  if (matrix.overrideRequiresReason && isHuman && reason === '') {
    // Not a soft warning. A P1 nobody can explain is indistinguishable from a
    // P1 nobody should have raised, and the difference is the whole metric.
    throw new AppError(400, 'A reason is required to override the computed priority', {
      code: 'validation_failed',
      fieldErrors: { priorityOverrideReason: 'required' },
    });
  }
  const effectiveReason =
    reason !== '' ? reason : `${input.actor.actorType}:${input.matrixSlug ?? matrix.slug}`;

  const ctx: DecisionContext = {
    tenantId: input.tenantId,
    ticketId: input.ticketId,
    subsystem: 'priority',
    decision: 'priority_overridden_by_human',
    ruleSlug: matrix.slug,
    ruleVersion: matrix.version,
    actorId: input.actor.userId ?? null,
    trx: input.trx,
    inputs: {
      fields: {
        impact: input.impact ?? null,
        urgency: input.urgency ?? null,
        computedPrioritySlug: input.computedSlug,
        requestedPrioritySlug: input.chosenSlug,
        actorId: input.actor.userId ?? null,
        actorType: input.actor.actorType,
      },
      reason: effectiveReason,
    },
  };

  return withDecision(ctx, async (recorder?: DecisionRecorder) => {
    recorder?.outcome?.({
      prioritySlug: input.chosenSlug,
      overrodeComputed: input.computedSlug,
      reason: effectiveReason,
      byHuman: isHuman,
    });
    return {
      prioritySlug: input.chosenSlug,
      overridden: true,
      reason: effectiveReason,
    };
  });
}
