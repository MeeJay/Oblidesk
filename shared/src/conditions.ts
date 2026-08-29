// ─────────────────────────────────────────────────────────────────────────────
// THE condition tree — one model, one evaluator, shared by client and server.
//
// Design decisions this file encodes:
//
//  • ONE condition builder. Rules, SLA `appliesWhen`, transition guards, field
//    visibility/required-ness, view filters, alert bindings, macros, escalations
//    and approvals ALL use `ConditionNode`. There is no second mini-language.
//
//  • HARD RULE 12 — inline field edits autosave individually and NEVER validate
//    required-ness. Required-ness is enforced only at a state transition, by
//    THIS evaluator, running the SAME `ConditionNode` on both sides. If the
//    client says "you may save" and the server says "you may not", it is a bug
//    in the CONTEXT that was built, never in two divergent implementations.
//
//  • `evaluateCondition` is PURE and TOTAL. It never throws — not on a null
//    node, not on a malformed operator, not on a catastrophic regex, not on a
//    field nobody declared. Anything it cannot answer is reported as an issue
//    and evaluates FALSE. An automation engine must never be able to crash a
//    ticket save.
//
//  • The returned `trace` is what the "Why?" drawer renders and what every
//    engine writes into `decision_log.inputs` on the SAME code path as the
//    action (HARD RULE 2). Never reconstruct a decision afterwards — pass the
//    trace along with the action.
//
//  • Determinism: pass `ctx.now`. The default (`Date.now()`) exists only so a
//    UI preview cannot forget it; every engine MUST pass an explicit instant so
//    the decision_log row can be replayed.
// ─────────────────────────────────────────────────────────────────────────────

// ── Operators ────────────────────────────────────────────────────────────────

export const CONDITION_OPERATORS = [
  'eq',
  'neq',
  'in',
  'not_in',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'is_empty',
  'is_not_empty',
  'changed',
  'changed_to',
  'changed_from',
  'older_than',
  'newer_than',
  'matches',
] as const;

export type Operator = (typeof CONDITION_OPERATORS)[number];

/** Operators that ignore `value` entirely. */
export const UNARY_OPERATORS: readonly Operator[] = ['is_empty', 'is_not_empty', 'changed'];

/** Operators that need the "before" snapshot (`ctx.previous`). */
export const DIFF_OPERATORS: readonly Operator[] = ['changed', 'changed_to', 'changed_from'];

/** Operators whose `value` is a duration, not a comparand. */
export const DURATION_OPERATORS: readonly Operator[] = ['older_than', 'newer_than'];

/** Operators whose `value` must be an array. */
export const LIST_OPERATORS: readonly Operator[] = ['in', 'not_in'];

export function isOperator(value: unknown): value is Operator {
  return typeof value === 'string' && (CONDITION_OPERATORS as readonly string[]).includes(value);
}

// ── The tree ─────────────────────────────────────────────────────────────────

export interface ConditionLeaf {
  /**
   * Dot path into the evaluation context. By convention:
   *   `subject`, `status_category`, `priority_slug`, `queue_slug`, …  (ticket columns)
   *   `data.<field_slug>`                                            (custom fields)
   *   `requester.organization_slug`, `assignee.username`, …          (joined refs)
   *   `journal.last.kind`, `alert.severity`, `ci.criticality`        (engine extras)
   *
   * HARD RULE 3 — cross-references are by human SLUG. A leaf must never carry
   * a numeric id of a configuration object.
   */
  field: string;
  op: Operator;
  value?: unknown;
}

export type ConditionNode =
  | { all: ConditionNode[] }
  | { any: ConditionNode[] }
  | { not: ConditionNode }
  | ConditionLeaf;

// ── Narrowing helpers ────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Same runtime check as isRecord, but WITHOUT a type predicate.
 *
 * Narrowing a ConditionNode with `value is Record<string, unknown>` silently
 * deletes ConditionLeaf from the union: an *interface* has no implicit index
 * signature, so it is not assignable to Record<string, unknown>, while the
 * anonymous {all}/{any}/{not} members are. The union then narrows to `never`
 * and every leaf access fails to compile. Use this one to reject malformed
 * input without narrowing the node type.
 */
function isObjectLike(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isAllNode(node: ConditionNode): node is { all: ConditionNode[] } {
  return isRecord(node) && Array.isArray((node as { all?: unknown }).all);
}

export function isAnyNode(node: ConditionNode): node is { any: ConditionNode[] } {
  return isRecord(node) && Array.isArray((node as { any?: unknown }).any);
}

export function isNotNode(node: ConditionNode): node is { not: ConditionNode } {
  const candidate = node as { not?: unknown };
  return isRecord(node) && candidate.not !== undefined && isRecord(candidate.not);
}

export function isConditionLeaf(node: ConditionNode): node is ConditionLeaf {
  const candidate = node as { field?: unknown; op?: unknown };
  return isRecord(node) && typeof candidate.field === 'string' && isOperator(candidate.op);
}

/** Total structural validator — safe on parsed JSON of unknown provenance. */
export function isConditionNode(value: unknown): value is ConditionNode {
  if (!isRecord(value)) return false;
  const node = value as Record<string, unknown>;
  if (Array.isArray(node.all)) return node.all.every(isConditionNode);
  if (Array.isArray(node.any)) return node.any.every(isConditionNode);
  if (node.not !== undefined) return isConditionNode(node.not);
  return typeof node.field === 'string' && isOperator(node.op);
}

// ── Evaluation context ───────────────────────────────────────────────────────

export interface ConditionContext {
  /**
   * The current values. Build it with `buildConditionFields()` so that every
   * DECLARED field is present (with `null` when empty) — a key that is present
   * but null is "known and empty"; a key that is absent is "unknown" and is
   * reported. That distinction is what makes `is_empty` trustworthy for
   * required-ness at a state transition.
   */
  fields: Readonly<Record<string, unknown>>;
  /**
   * The "before" snapshot, for `changed` / `changed_to` / `changed_from`.
   * Absent (or null) means "no diff available" — those operators then evaluate
   * FALSE and report `no_previous_snapshot`.
   */
  previous?: Readonly<Record<string, unknown>> | null;
  /**
   * Extra field paths that exist but may legitimately hold `undefined`
   * (declared custom fields whose column was never written). Treated as known.
   */
  declaredFields?: readonly string[];
  /**
   * Evaluation instant — ISO-8601 string or epoch milliseconds. ENGINES MUST
   * PASS THIS so the decision_log row is replayable. Defaults to `Date.now()`.
   */
  now?: string | number;
  /** String comparisons are case-insensitive by default. */
  caseSensitive?: boolean;
}

// ── Result ───────────────────────────────────────────────────────────────────

export type ConditionIssueReason =
  | 'unknown_field'
  | 'no_previous_snapshot'
  | 'missing_value'
  | 'bad_value'
  | 'bad_duration'
  | 'bad_regex'
  | 'not_comparable'
  | 'unknown_operator'
  | 'malformed_node';

export interface ConditionIssue {
  field: string;
  op: Operator | null;
  reason: ConditionIssueReason;
  detail?: string;
}

export type ConditionTrace =
  | { type: 'all' | 'any'; matched: boolean; children: ConditionTrace[] }
  | { type: 'not'; matched: boolean; children: ConditionTrace[] }
  | {
      type: 'leaf';
      matched: boolean;
      field: string;
      op: Operator;
      value?: unknown;
      actual?: unknown;
      issue?: ConditionIssueReason;
    }
  | { type: 'invalid'; matched: false; detail: string };

export interface ConditionEvaluation {
  /** The answer. Always a boolean — an unanswerable tree evaluates false. */
  matched: boolean;
  /** Everything the evaluator could not answer. Empty on a clean evaluation. */
  issues: ConditionIssue[];
  /** Node-by-node explanation. Feed it to the Why drawer / decision_log. */
  trace: ConditionTrace;
}

/**
 * An empty tree is "no restriction": `null`, `undefined` and `{ all: [] }` all
 * match. `{ any: [] }` matches nothing (there is no alternative to satisfy).
 */
export const EMPTY_CONDITION: ConditionNode = { all: [] };

// ── Field resolution ─────────────────────────────────────────────────────────

type Resolved = { known: true; value: unknown } | { known: false };

const UNKNOWN: Resolved = { known: false };

function walkPath(source: Readonly<Record<string, unknown>>, path: string): Resolved {
  const segments = path.split('.');
  let cursor: unknown = source;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (Array.isArray(cursor)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) return UNKNOWN;
      cursor = cursor[index];
      continue;
    }
    if (!isRecord(cursor)) return UNKNOWN;
    if (!Object.prototype.hasOwnProperty.call(cursor, segment)) return UNKNOWN;
    cursor = cursor[segment];
  }
  return { known: true, value: cursor };
}

/**
 * Resolve a leaf field against a context bag.
 *   1. exact key (flat contexts win — `{'data.severity': 'high'}`)
 *   2. declared field (known, possibly undefined)
 *   3. dot-path walk
 * Anything else is unknown and gets reported.
 */
export function resolveConditionField(
  source: Readonly<Record<string, unknown>>,
  field: string,
  declaredFields?: readonly string[],
): Resolved {
  if (Object.prototype.hasOwnProperty.call(source, field)) {
    return { known: true, value: source[field] };
  }
  const walked = walkPath(source, field);
  if (walked.known) return walked;
  if (declaredFields && declaredFields.includes(field)) {
    return { known: true, value: undefined };
  }
  return UNKNOWN;
}

/**
 * Flatten a nested object into dotted keys, keeping the nested form too.
 * Use it to build `ctx.fields` from a ticket row + its `data` jsonb, then
 * overlay every DECLARED custom field with `null` so `is_empty` is meaningful.
 */
export function buildConditionFields(
  base: Readonly<Record<string, unknown>>,
  declaredFields: readonly string[] = [],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const field of declaredFields) {
    if (!Object.prototype.hasOwnProperty.call(out, field) && !walkPath(base, field).known) {
      out[field] = null;
    }
  }
  return out;
}

// ── Value helpers ────────────────────────────────────────────────────────────

function normalizeString(value: string, caseSensitive: boolean): string {
  return caseSensitive ? value : value.toLowerCase();
}

function toComparableString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return value.toISOString();
  return null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Timestamp coercion. Plain numbers are epoch MILLISECONDS (never seconds — the
 * suite serialises every instant as an ISO string, a bare number is only ever
 * produced by `Date.now()`).
 */
export function toTimestampMs(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const ms = Date.parse(trimmed);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

const DURATION_PATTERN = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)/gi;
const DURATION_UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Parse a duration. A bare number is MINUTES (the unit every SLA target uses).
 * Strings accept compound expressions: `'15m'`, `'4h'`, `'2d'`, `'1h30m'`,
 * `'90s'`, `'1w'`. Returns null on anything else — never throws.
 */
export function parseDurationMs(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value * 60_000 : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed) * 60_000;

  DURATION_PATTERN.lastIndex = 0;
  let total = 0;
  let matchedChars = 0;
  let match: RegExpExecArray | null = DURATION_PATTERN.exec(trimmed);
  while (match !== null) {
    const amount = Number(match[1]);
    const unit = DURATION_UNIT_MS[match[2].toLowerCase()];
    if (!Number.isFinite(amount) || unit === undefined) return null;
    total += amount * unit;
    matchedChars += match[0].length;
    match = DURATION_PATTERN.exec(trimmed);
  }
  // Reject partial parses like "4 bananas" (which would otherwise be 0).
  if (matchedChars === 0) return null;
  const stripped = trimmed.replace(/\s+/g, '');
  const consumed = stripped.replace(/(\d+(?:\.\d+)?)(ms|s|m|h|d|w)/gi, '');
  if (consumed !== '') return null;
  return total;
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (value instanceof Date) return !Number.isFinite(value.getTime());
  if (isRecord(value)) return Object.keys(value).length === 0;
  return false;
}

function scalarEquals(a: unknown, b: unknown, caseSensitive: boolean): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) {
    return isEmptyValue(a) && isEmptyValue(b);
  }
  const aNum = toFiniteNumber(a);
  const bNum = toFiniteNumber(b);
  if (aNum !== null && bNum !== null && (typeof a === 'number' || typeof b === 'number')) {
    return aNum === bNum;
  }
  const aStr = toComparableString(a);
  const bStr = toComparableString(b);
  if (aStr !== null && bStr !== null) {
    return normalizeString(aStr, caseSensitive) === normalizeString(bStr, caseSensitive);
  }
  return false;
}

/** Set-aware equality: an array actual matches when it CONTAINS the comparand. */
function valueEquals(actual: unknown, comparand: unknown, caseSensitive: boolean): boolean {
  if (Array.isArray(actual) && !Array.isArray(comparand)) {
    return actual.some((entry) => scalarEquals(entry, comparand, caseSensitive));
  }
  if (Array.isArray(actual) && Array.isArray(comparand)) {
    if (actual.length !== comparand.length) return false;
    return actual.every((entry, index) => scalarEquals(entry, comparand[index], caseSensitive));
  }
  return scalarEquals(actual, comparand, caseSensitive);
}

/** -1 / 0 / 1, or null when the two values are not ordered comparably. */
function compareValues(a: unknown, b: unknown, caseSensitive: boolean): number | null {
  const aNum = toFiniteNumber(a);
  const bNum = toFiniteNumber(b);
  if (aNum !== null && bNum !== null) return aNum === bNum ? 0 : aNum < bNum ? -1 : 1;

  const aTime = toTimestampMs(a);
  const bTime = toTimestampMs(b);
  if (aTime !== null && bTime !== null) return aTime === bTime ? 0 : aTime < bTime ? -1 : 1;

  const aStr = toComparableString(a);
  const bStr = toComparableString(b);
  if (aStr !== null && bStr !== null) {
    const left = normalizeString(aStr, caseSensitive);
    const right = normalizeString(bStr, caseSensitive);
    return left === right ? 0 : left < right ? -1 : 1;
  }
  return null;
}

const MAX_REGEX_SOURCE_LENGTH = 512;

function safeRegex(value: unknown, caseSensitive: boolean): RegExp | null {
  let source: string | null = null;
  let flags = caseSensitive ? '' : 'i';
  if (typeof value === 'string') {
    source = value;
  } else if (isRecord(value) && typeof value.pattern === 'string') {
    source = value.pattern;
    if (typeof value.flags === 'string' && /^[gimsuy]*$/.test(value.flags)) flags = value.flags;
  }
  if (source === null || source.length === 0 || source.length > MAX_REGEX_SOURCE_LENGTH) return null;
  try {
    return new RegExp(source, flags.replace(/g/g, ''));
  } catch {
    return null;
  }
}

// ── Leaf evaluation ──────────────────────────────────────────────────────────

interface LeafOutcome {
  matched: boolean;
  issue?: ConditionIssue;
  actual?: unknown;
}

function evaluateLeaf(leaf: ConditionLeaf, ctx: ConditionContext, nowMs: number): LeafOutcome {
  const caseSensitive = ctx.caseSensitive === true;
  const { field, op, value } = leaf;

  const resolved = resolveConditionField(ctx.fields, field, ctx.declaredFields);
  if (!resolved.known) {
    return {
      matched: false,
      issue: { field, op, reason: 'unknown_field', detail: `No value for "${field}" in the evaluation context` },
    };
  }
  const actual = resolved.value;

  // Operators that need the before-snapshot.
  if ((DIFF_OPERATORS as readonly string[]).includes(op)) {
    const previous = ctx.previous;
    if (!previous) {
      return { matched: false, actual, issue: { field, op, reason: 'no_previous_snapshot' } };
    }
    const before = resolveConditionField(previous, field, ctx.declaredFields);
    const beforeValue = before.known ? before.value : undefined;
    switch (op) {
      case 'changed':
        return { matched: !valueEquals(beforeValue, actual, caseSensitive), actual };
      case 'changed_to':
        return {
          matched:
            valueEquals(actual, value, caseSensitive) && !valueEquals(beforeValue, value, caseSensitive),
          actual,
        };
      case 'changed_from':
        return {
          matched:
            valueEquals(beforeValue, value, caseSensitive) && !valueEquals(actual, value, caseSensitive),
          actual,
        };
      default:
        break;
    }
  }

  switch (op) {
    case 'eq':
      return { matched: valueEquals(actual, value, caseSensitive), actual };

    case 'neq':
      return { matched: !valueEquals(actual, value, caseSensitive), actual };

    case 'in':
    case 'not_in': {
      if (!Array.isArray(value)) {
        return {
          matched: false,
          actual,
          issue: { field, op, reason: 'bad_value', detail: `"${op}" requires an array value` },
        };
      }
      const hit = Array.isArray(actual)
        ? actual.some((entry) => value.some((candidate) => scalarEquals(entry, candidate, caseSensitive)))
        : value.some((candidate) => scalarEquals(actual, candidate, caseSensitive));
      return { matched: op === 'in' ? hit : !hit, actual };
    }

    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (value === undefined) {
        return { matched: false, actual, issue: { field, op, reason: 'missing_value' } };
      }
      const cmp = compareValues(actual, value, caseSensitive);
      if (cmp === null) {
        return { matched: false, actual, issue: { field, op, reason: 'not_comparable' } };
      }
      if (op === 'gt') return { matched: cmp > 0, actual };
      if (op === 'gte') return { matched: cmp >= 0, actual };
      if (op === 'lt') return { matched: cmp < 0, actual };
      return { matched: cmp <= 0, actual };
    }

    case 'contains':
    case 'not_contains': {
      let hit = false;
      if (Array.isArray(actual)) {
        hit = actual.some((entry) => scalarEquals(entry, value, caseSensitive));
      } else {
        const haystack = toComparableString(actual);
        const needle = toComparableString(value);
        if (haystack === null || needle === null) {
          return { matched: false, actual, issue: { field, op, reason: 'not_comparable' } };
        }
        hit = normalizeString(haystack, caseSensitive).includes(normalizeString(needle, caseSensitive));
      }
      return { matched: op === 'contains' ? hit : !hit, actual };
    }

    case 'starts_with':
    case 'ends_with': {
      const haystack = toComparableString(actual);
      const needle = toComparableString(value);
      if (haystack === null || needle === null) {
        return { matched: false, actual, issue: { field, op, reason: 'not_comparable' } };
      }
      const left = normalizeString(haystack, caseSensitive);
      const right = normalizeString(needle, caseSensitive);
      return { matched: op === 'starts_with' ? left.startsWith(right) : left.endsWith(right), actual };
    }

    case 'is_empty':
      return { matched: isEmptyValue(actual), actual };

    case 'is_not_empty':
      return { matched: !isEmptyValue(actual), actual };

    case 'older_than':
    case 'newer_than': {
      const durationMs = parseDurationMs(value);
      if (durationMs === null) {
        return {
          matched: false,
          actual,
          issue: { field, op, reason: 'bad_duration', detail: `Cannot parse duration ${JSON.stringify(value)}` },
        };
      }
      const at = toTimestampMs(actual);
      if (at === null) {
        return { matched: false, actual, issue: { field, op, reason: 'not_comparable' } };
      }
      const age = nowMs - at;
      // `older_than` = the instant is at least `duration` in the past.
      // `newer_than` = the instant is less than `duration` old (future counts).
      return { matched: op === 'older_than' ? age >= durationMs : age < durationMs, actual };
    }

    case 'matches': {
      const regex = safeRegex(value, caseSensitive);
      if (regex === null) {
        return { matched: false, actual, issue: { field, op, reason: 'bad_regex' } };
      }
      const haystack = toComparableString(actual);
      if (haystack === null) {
        return { matched: false, actual, issue: { field, op, reason: 'not_comparable' } };
      }
      try {
        return { matched: regex.test(haystack), actual };
      } catch {
        return { matched: false, actual, issue: { field, op, reason: 'bad_regex' } };
      }
    }

    default:
      return { matched: false, actual, issue: { field, op, reason: 'unknown_operator' } };
  }
}

// ── Tree evaluation ──────────────────────────────────────────────────────────

const MAX_CONDITION_DEPTH = 32;

function evaluateNode(
  node: ConditionNode | null | undefined,
  ctx: ConditionContext,
  nowMs: number,
  issues: ConditionIssue[],
  depth: number,
): ConditionTrace {
  if (node === null || node === undefined) {
    return { type: 'all', matched: true, children: [] };
  }
  if (depth > MAX_CONDITION_DEPTH) {
    issues.push({ field: '', op: null, reason: 'malformed_node', detail: 'Condition tree nested too deeply' });
    return { type: 'invalid', matched: false, detail: 'max depth exceeded' };
  }
  if (!isObjectLike(node)) {
    issues.push({ field: '', op: null, reason: 'malformed_node', detail: 'Node is not an object' });
    return { type: 'invalid', matched: false, detail: 'not an object' };
  }

  if (isAllNode(node)) {
    const children = node.all.map((child) => evaluateNode(child, ctx, nowMs, issues, depth + 1));
    return { type: 'all', matched: children.every((child) => child.matched), children };
  }

  if (isAnyNode(node)) {
    const children = node.any.map((child) => evaluateNode(child, ctx, nowMs, issues, depth + 1));
    return { type: 'any', matched: children.some((child) => child.matched), children };
  }

  if (isNotNode(node)) {
    const child = evaluateNode(node.not, ctx, nowMs, issues, depth + 1);
    return { type: 'not', matched: !child.matched, children: [child] };
  }

  if (isConditionLeaf(node)) {
    const outcome = evaluateLeaf(node, ctx, nowMs);
    if (outcome.issue) issues.push(outcome.issue);
    return {
      type: 'leaf',
      matched: outcome.matched,
      field: node.field,
      op: node.op,
      value: node.value,
      actual: outcome.actual,
      issue: outcome.issue ? outcome.issue.reason : undefined,
    };
  }

  issues.push({
    field: '',
    op: null,
    reason: 'malformed_node',
    detail: 'Node is neither all/any/not nor a valid leaf',
  });
  return { type: 'invalid', matched: false, detail: 'unrecognised node' };
}

/**
 * PURE + TOTAL condition evaluation. Never throws.
 *
 * Semantics:
 *   • `null` / `undefined` / `{ all: [] }` → matched: true  ("no restriction")
 *   • `{ any: [] }`                        → matched: false ("no alternative")
 *   • unknown field                        → leaf is FALSE and reported
 *   • malformed node                       → subtree is FALSE and reported
 *   • `not` of a false subtree             → true (even if the subtree had issues,
 *                                            which is why `issues` must be shown
 *                                            in the Why drawer, not swallowed)
 *
 * Pass `ctx.now` from the caller so decision_log rows replay identically.
 */
export function evaluateCondition(
  node: ConditionNode | null | undefined,
  ctx: ConditionContext,
): ConditionEvaluation {
  const issues: ConditionIssue[] = [];
  const nowMs = toTimestampMs(ctx.now ?? Date.now()) ?? Date.now();
  const trace = evaluateNode(node, ctx, nowMs, issues, 0);
  return { matched: trace.matched, issues, trace };
}

/** Convenience wrapper when only the boolean matters. Never throws. */
export function conditionMatches(
  node: ConditionNode | null | undefined,
  ctx: ConditionContext,
): boolean {
  return evaluateCondition(node, ctx).matched;
}

// ── Field collection (config linter) ─────────────────────────────────────────

function collectInto(node: ConditionNode | null | undefined, out: Set<string>, depth: number): void {
  if (node === null || node === undefined || depth > MAX_CONDITION_DEPTH || !isObjectLike(node)) return;
  if (isAllNode(node)) {
    node.all.forEach((child) => collectInto(child, out, depth + 1));
    return;
  }
  if (isAnyNode(node)) {
    node.any.forEach((child) => collectInto(child, out, depth + 1));
    return;
  }
  if (isNotNode(node)) {
    collectInto(node.not, out, depth + 1);
    return;
  }
  if (isConditionLeaf(node)) out.add(node.field);
}

/**
 * Every field path the tree touches, sorted and de-duplicated. The config
 * linter cross-checks these against the published `field` config objects and
 * the ticket column list, and flags a rule that references a field nobody
 * declares (a silent always-false rule is the worst kind of automation bug).
 */
export function collectFields(node: ConditionNode | null | undefined): string[] {
  const out = new Set<string>();
  collectInto(node, out, 0);
  return [...out].sort();
}

/** Operators used anywhere in the tree — lets the linter warn about `matches`. */
export function collectOperators(node: ConditionNode | null | undefined): Operator[] {
  const out = new Set<Operator>();
  const walk = (current: ConditionNode | null | undefined, depth: number): void => {
    if (current === null || current === undefined || depth > MAX_CONDITION_DEPTH || !isObjectLike(current)) return;
    if (isAllNode(current)) return current.all.forEach((child) => walk(child, depth + 1));
    if (isAnyNode(current)) return current.any.forEach((child) => walk(child, depth + 1));
    if (isNotNode(current)) return walk(current.not, depth + 1);
    if (isConditionLeaf(current)) out.add(current.op);
    return;
  };
  walk(node, 0);
  return [...out].sort();
}

// ── Description (Why drawer / audit text) ────────────────────────────────────

export interface DescribeOptions {
  /** Turn a field path into the label the user configured. */
  fieldLabel?: (field: string) => string;
  /** Turn a comparand into display text (slug → name lookups live here). */
  formatValue?: (value: unknown, field: string, op: Operator) => string;
  /** Wrap the whole expression in parentheses even at the top level. */
  alwaysParenthesise?: boolean;
}

const OPERATOR_PHRASE: Readonly<Record<Operator, string>> = {
  eq: 'is',
  neq: 'is not',
  in: 'is one of',
  not_in: 'is none of',
  gt: 'is greater than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  contains: 'contains',
  not_contains: 'does not contain',
  starts_with: 'starts with',
  ends_with: 'ends with',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
  changed: 'changed',
  changed_to: 'changed to',
  changed_from: 'changed from',
  older_than: 'is older than',
  newer_than: 'is newer than',
  matches: 'matches',
};

/** English phrase for an operator — the inline fallback for `t()`. */
export function operatorPhrase(op: Operator): string {
  return OPERATOR_PHRASE[op] ?? op;
}

/** i18n key for an operator, paired with `operatorPhrase()` as the fallback. */
export function operatorLabelKey(op: Operator): string {
  return `conditions.op.${op}`;
}

function defaultFormatValue(value: unknown): string {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => defaultFormatValue(entry)).join(', ')}]`;
  if (typeof value === 'string') return `"${value}"`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[object]';
  }
}

function describeNode(node: ConditionNode | null | undefined, opts: DescribeOptions, depth: number): string {
  if (node === null || node === undefined) return 'always';
  if (depth > MAX_CONDITION_DEPTH || !isObjectLike(node)) return 'invalid condition';

  const label = opts.fieldLabel ?? ((field: string) => field);
  const format = opts.formatValue ?? ((value: unknown) => defaultFormatValue(value));

  if (isAllNode(node)) {
    if (node.all.length === 0) return 'always';
    const parts = node.all.map((child) => describeNode(child, opts, depth + 1));
    const joined = parts.join(' AND ');
    return node.all.length > 1 || opts.alwaysParenthesise ? `(${joined})` : joined;
  }

  if (isAnyNode(node)) {
    if (node.any.length === 0) return 'never';
    const parts = node.any.map((child) => describeNode(child, opts, depth + 1));
    const joined = parts.join(' OR ');
    return node.any.length > 1 || opts.alwaysParenthesise ? `(${joined})` : joined;
  }

  if (isNotNode(node)) {
    return `NOT ${describeNode(node.not, { ...opts, alwaysParenthesise: true }, depth + 1)}`;
  }

  if (isConditionLeaf(node)) {
    const phrase = operatorPhrase(node.op);
    if ((UNARY_OPERATORS as readonly string[]).includes(node.op)) {
      return `${label(node.field)} ${phrase}`;
    }
    return `${label(node.field)} ${phrase} ${format(node.value, node.field, node.op)}`.trimEnd();
  }

  return 'invalid condition';
}

/**
 * One-line English rendering of a tree, e.g.
 *   `(priority_slug is "p1" AND status_category is one of ["new", "open"])`
 *
 * Used as the inline `t()` fallback in the Why drawer, in the rule list, and in
 * the human-readable half of a `decision_log` row. Pass `fieldLabel` /
 * `formatValue` to resolve slugs to the names the tenant configured.
 */
export function describeCondition(node: ConditionNode | null | undefined, opts: DescribeOptions = {}): string {
  return describeNode(node, opts, 0);
}

/**
 * Render an evaluation trace as indented lines — one per node, each prefixed
 * with ✓ / ✗ — for the Why drawer's expanded view.
 */
export function describeTrace(trace: ConditionTrace, opts: DescribeOptions = {}, indent = 0): string[] {
  const pad = '  '.repeat(indent);
  const mark = trace.matched ? '✓' : '✗';
  const label = opts.fieldLabel ?? ((field: string) => field);
  const format = opts.formatValue ?? ((value: unknown) => defaultFormatValue(value));

  if (trace.type === 'invalid') return [`${pad}${mark} invalid node (${trace.detail})`];

  if (trace.type === 'leaf') {
    const phrase = operatorPhrase(trace.op);
    const comparand = (UNARY_OPERATORS as readonly string[]).includes(trace.op)
      ? ''
      : ` ${format(trace.value, trace.field, trace.op)}`;
    const actual = trace.issue ? ` — ${trace.issue}` : ` (actual: ${defaultFormatValue(trace.actual)})`;
    return [`${pad}${mark} ${label(trace.field)} ${phrase}${comparand}${actual}`];
  }

  const header = trace.type === 'not' ? 'NOT' : trace.type === 'all' ? 'ALL of' : 'ANY of';
  const lines = [`${pad}${mark} ${header}`];
  for (const child of trace.children) lines.push(...describeTrace(child, opts, indent + 1));
  return lines;
}

// ── Normalisation ────────────────────────────────────────────────────────────

/**
 * Collapse redundant wrappers so two logically identical trees checksum the
 * same (`config_objects.checksum`) and diff cleanly in the version history.
 * Total: an unrecognised node is returned untouched.
 */
export function normalizeCondition(node: ConditionNode | null | undefined): ConditionNode {
  if (node === null || node === undefined || !isObjectLike(node)) return { all: [] };

  if (isAllNode(node)) {
    const children = node.all.map(normalizeCondition).filter((child) => !isEmptyAll(child));
    if (children.length === 1) return children[0];
    return { all: children };
  }
  if (isAnyNode(node)) {
    const children = node.any.map(normalizeCondition);
    if (children.length === 1) return children[0];
    return { any: children };
  }
  if (isNotNode(node)) {
    const inner = normalizeCondition(node.not);
    if (isNotNode(inner)) return normalizeCondition(inner.not);
    return { not: inner };
  }
  if (isConditionLeaf(node)) {
    const leaf: ConditionLeaf = { field: node.field, op: node.op };
    if (!(UNARY_OPERATORS as readonly string[]).includes(node.op) && node.value !== undefined) {
      leaf.value = node.value;
    }
    return leaf;
  }
  return node;
}

function isEmptyAll(node: ConditionNode): boolean {
  return isAllNode(node) && node.all.length === 0;
}

/** True when the tree imposes no restriction at all. */
export function isEmptyCondition(node: ConditionNode | null | undefined): boolean {
  if (node === null || node === undefined) return true;
  return isEmptyAll(normalizeCondition(node));
}
