/**
 * configLinter.service.ts — the config store's conscience.
 *
 * ── Why this ships WITH the store, not after it ──────────────────────────────
 * HARD RULE 3 says every cross-reference inside a `config_objects.body` is a
 * human SLUG. Slugs are what make a bundle portable between tenants — and they
 * are also, precisely because they are not foreign keys, completely
 * unenforced by Postgres. A queue whose `default_sla_policy` names an SLA that
 * was renamed last Tuesday does not fail. It silently stops applying an SLA,
 * and nobody finds out until a P1 quietly has no clock on it.
 *
 * So `publish()` refuses to publish an object whose references do not resolve.
 * That refusal is the whole point of this module; everything else here is the
 * same idea applied to the other things a config object can be wrong about in
 * a way the database cannot see:
 *
 *   • a state graph with a status nothing can reach, or one nothing can leave
 *   • an approval that resolves to zero approvers, or that has no timeout
 *     (both mean "this ticket stops here forever, and no alarm goes off")
 *   • an SLA target carrying BOTH a business calendar and 'outside_hours' in
 *     its pause list — that pauses the clock twice for the same night
 *   • a rule whose condition names a field nobody declares, which does not
 *     error: it evaluates FALSE, forever, in silence
 *
 * ── This module is also the pure-semantics module ────────────────────────────
 * `canonicaliseBody` / `checksumOfBody` / `normalizeConditionTree` live here
 * rather than in configObject.service.ts so the dependency graph stays acyclic:
 * the store imports the linter, never the other way round.
 *
 * ── Two body dialects ────────────────────────────────────────────────────────
 * The shipped baseline (`db/seeds/02_baseline_config.ts`) writes snake_case
 * bodies with `{ op: 'and', children: [...] }` condition trees and `ticket.`
 * prefixed field paths. `shared/src/configKinds.ts` declares camelCase bodies
 * and `shared/src/conditions.ts` declares `{ all: [...] }` trees with bare
 * field paths. BOTH are real and both are in the database right now, so every
 * reader in this file accepts either and normalises to the shared dialect.
 * A linter that only understood one of them would report the entire shipped
 * baseline as broken, which is the fastest possible way to teach an admin to
 * ignore the linter.
 */

import { createHash } from 'crypto';

import {
  CONFIG_BODY_FORMAT_VERSIONS,
  CONFIG_KIND_REFERENCES,
  CONFIG_KINDS,
  isConfigKind,
  isStatusCategory,
  collectFields,
  collectOperators,
  isConditionNode,
  isOperator,
  TICKET_RECORD_TYPES,
  type ConditionNode,
  type ConfigKind,
  type ConfigLintIssue,
  type ConfigStatus,
  type StatusCategory,
} from '@oblidesk/shared';

import { db, scoped } from '../db';

// ═════════════════════════════════════════════════════════════════════════════
// Findings
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `ConfigLintIssue['code']` in @oblidesk/shared is a closed union owned by
 * another module. Rather than squeeze a genuinely different finding into the
 * nearest wrong code — which would make the UI say "unreachable status" about
 * an approval with no timeout — this widens the code and keeps everything else
 * identical. Consumers that need the strict shared type call
 * {@link toConfigLintIssues}, which folds each extra code onto its closest
 * shared neighbour.
 */
export type ConfigLintCode =
  | ConfigLintIssue['code']
  | 'dead_end_status'
  | 'approval_no_approvers'
  | 'approval_no_timeout'
  | 'sla_double_pause'
  | 'draft_reference'
  | 'undeclared_write'
  | 'no_default';

export interface ConfigLintFinding extends Omit<ConfigLintIssue, 'code'> {
  code: ConfigLintCode;
}

const CODE_FALLBACK: Readonly<Record<string, ConfigLintIssue['code']>> = {
  dead_end_status: 'unreachable_status',
  approval_no_approvers: 'dangling_reference',
  approval_no_timeout: 'empty_condition',
  sla_double_pause: 'empty_condition',
  draft_reference: 'dangling_reference',
  undeclared_write: 'unknown_field',
  no_default: 'empty_condition',
};

/** Narrow findings to the shared union for callers typed against it. */
export function toConfigLintIssues(findings: readonly ConfigLintFinding[]): ConfigLintIssue[] {
  return findings.map((finding) => ({
    ...finding,
    code: CODE_FALLBACK[finding.code] ?? (finding.code as ConfigLintIssue['code']),
  }));
}

/** True when at least one finding is severe enough to block a publish. */
export function hasBlockingIssue(findings: readonly ConfigLintFinding[]): boolean {
  return findings.some((finding) => finding.severity === 'error');
}

// ═════════════════════════════════════════════════════════════════════════════
// Canonical JSON + checksum (must match db/seeds/02_baseline_config.ts exactly)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Object keys sorted, array order preserved. The checksum has to survive a
 * re-serialise unchanged, otherwise "has this drifted from the shipped
 * baseline?" stops being answerable by comparing two hex strings.
 */
export function canonicaliseBody(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicaliseBody);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicaliseBody(source[key]);
    return out;
  }
  return value;
}

/**
 * sha256 over (kind, body_format_version, canonical body) — byte-identical to
 * `checksumOf()` in the baseline seed, so a seeded object and the same object
 * exported and re-imported hash the same.
 */
export function checksumOfBody(kind: ConfigKind, body: unknown, bodyFormatVersion?: number): string {
  const formatVersion = bodyFormatVersion ?? CONFIG_BODY_FORMAT_VERSIONS[kind];
  return createHash('sha256')
    .update(`${kind}:${formatVersion}:${JSON.stringify(canonicaliseBody(body))}`)
    .digest('hex');
}

// ═════════════════════════════════════════════════════════════════════════════
// Condition dialect normalisation
// ═════════════════════════════════════════════════════════════════════════════

/** Legacy operator spellings from the baseline seed → the shared vocabulary. */
const OPERATOR_ALIASES: Readonly<Record<string, string>> = {
  ne: 'neq',
  not_equals: 'neq',
  equals: 'eq',
  is: 'eq',
  is_not: 'neq',
};

/**
 * Field paths are written `ticket.status_category` in the shipped baseline and
 * bare `status_category` in `shared/src/conditions.ts`. Everything downstream
 * (SQL compilation, `collectFields`, required-ness) keys off the bare form, so
 * normalise once here and never think about it again.
 *
 * `ticket.data.vendor_ref` → `data.vendor_ref`. Other namespaces
 * (`actor.`, `context.`, `journal.`, …) are engine-supplied and pass through.
 */
export function normalizeFieldPath(field: string): string {
  const trimmed = field.trim();
  return trimmed.startsWith('ticket.') ? trimmed.slice('ticket.'.length) : trimmed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Accept either condition dialect and return the shared one. Returns `null`
 * for "no condition at all" so callers can tell an absent tree from an empty
 * one — `{ all: [] }` matches everything, `null` means the author never set a
 * filter, and those are different things to report.
 */
export function normalizeConditionTree(raw: unknown, depth = 0): ConditionNode | null {
  if (raw === null || raw === undefined || depth > 32 || !isPlainObject(raw)) return null;

  // Already the shared dialect.
  if (Array.isArray(raw.all)) {
    return { all: raw.all.map((c) => normalizeConditionTree(c, depth + 1)).filter(isNode) };
  }
  if (Array.isArray(raw.any)) {
    return { any: raw.any.map((c) => normalizeConditionTree(c, depth + 1)).filter(isNode) };
  }
  if (raw.not !== undefined) {
    const inner = normalizeConditionTree(raw.not, depth + 1);
    return inner ? { not: inner } : null;
  }

  const op = typeof raw.op === 'string' ? raw.op : null;
  if (op === null) return null;

  const children = Array.isArray(raw.children) ? raw.children : [];
  if (op === 'and') {
    return { all: children.map((c) => normalizeConditionTree(c, depth + 1)).filter(isNode) };
  }
  if (op === 'or') {
    return { any: children.map((c) => normalizeConditionTree(c, depth + 1)).filter(isNode) };
  }
  if (op === 'not') {
    const inner = normalizeConditionTree(children[0], depth + 1);
    return inner ? { not: inner } : null;
  }

  if (typeof raw.field !== 'string') return null;
  const mapped = OPERATOR_ALIASES[op] ?? op;
  // An operator we do not know is kept verbatim: `isConditionNode` then
  // rejects the tree and the linter reports it, which is far more useful than
  // silently dropping the leaf and reporting nothing.
  const leaf: Record<string, unknown> = { field: normalizeFieldPath(raw.field), op: mapped };
  if (raw.value !== undefined) leaf.value = raw.value;
  return leaf as unknown as ConditionNode;
}

function isNode(value: ConditionNode | null): value is ConditionNode {
  return value !== null;
}

// ═════════════════════════════════════════════════════════════════════════════
// The field universe a condition may legally name
// ═════════════════════════════════════════════════════════════════════════════

/** Real `tickets` columns (migration 002). Anything else must be a field slug. */
export const TICKET_COLUMNS: readonly string[] = [
  'id', 'record_type', 'number', 'subject', 'description_md', 'description_html',
  'status_slug', 'status_category', 'priority_slug', 'impact', 'urgency',
  'queue_slug', 'assignment_group_id', 'assignee_id', 'requester_contact_id',
  'requester_user_id', 'organization_id', 'primary_ci_id', 'source',
  'occurred_at', 'created_at', 'updated_at', 'first_response_at', 'resolved_at',
  'closed_at', 'due_at', 'reopen_count', 'parent_ticket_id', 'merged_into_id',
  'resolution_code', 'resolution_md', 'csat_score', 'row_version', 'deleted_at',
];

const TICKET_COLUMN_SET = new Set(TICKET_COLUMNS);

/**
 * Namespaces the ENGINES populate at evaluation time. A leaf under one of
 * these is not checkable against configuration — it is checkable only by
 * running the engine — so the linter accepts it rather than crying wolf.
 */
const ENGINE_NAMESPACES: readonly string[] = [
  'context.', 'actor.', 'previous.', 'journal.', 'alert.', 'ci.', 'sla.',
  'approval.', 'requester.', 'assignee.', 'organization.', 'queue.', 'time.',
];

function isEngineNamespace(field: string): boolean {
  return ENGINE_NAMESPACES.some((prefix) => field.startsWith(prefix));
}

/**
 * Classify one normalised field path.
 *   'column'  — a real tickets column
 *   'engine'  — an engine-supplied namespace, unverifiable here
 *   'data'    — `data.<slug>`, must match a published field object
 *   'bare'    — a bare token; treated as a field slug (configKinds convention)
 */
function classifyField(field: string): { kind: 'column' | 'engine' | 'data' | 'bare'; slug?: string } {
  if (isEngineNamespace(field)) return { kind: 'engine' };
  if (field.startsWith('data.')) return { kind: 'data', slug: field.slice('data.'.length) };
  const head = field.split('.')[0];
  if (TICKET_COLUMN_SET.has(head)) return { kind: 'column' };
  if (!field.includes('.')) return { kind: 'bare', slug: field };
  return { kind: 'engine' };
}

// ═════════════════════════════════════════════════════════════════════════════
// Reference extraction
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Body key → the config KIND its string value points at. Keys are matched
 * after lower-casing and stripping `_`/`-`, so `default_calendar`,
 * `defaultCalendar` and `calendarSlug` all land on the same entry — which is
 * exactly what the two body dialects need.
 *
 * This table is deliberately an ALLOW-LIST. A permissive "any key ending in
 * Slug" heuristic would flag `default_assignment_group` (an assignment_groups
 * row, not a config object) and every key of the priority matrix, and a linter
 * with false positives gets switched off.
 */
const REFERENCE_KEYS: Readonly<Record<string, ConfigKind>> = {
  calendar: 'calendar',
  calendarslug: 'calendar',
  defaultcalendar: 'calendar',
  slapolicy: 'sla',
  slapolicyslug: 'sla',
  defaultslapolicy: 'sla',
  form: 'form',
  formslug: 'form',
  defaultform: 'form',
  statemachine: 'state_machine',
  statemachineslug: 'state_machine',
  defaultstatemachine: 'state_machine',
  prioritymatrix: 'priority_matrix',
  prioritymatrixslug: 'priority_matrix',
  defaultprioritymatrix: 'priority_matrix',
  queueslug: 'queue',
  defaultqueue: 'queue',
  escalation: 'escalation',
  escalationslug: 'escalation',
  approval: 'approval',
  approvalslug: 'approval',
  template: 'notification_template',
  templateslug: 'notification_template',
  notificationtemplate: 'notification_template',
  notificationtemplateslug: 'notification_template',
  macro: 'macro',
  macroslug: 'macro',
  view: 'view',
  viewslug: 'view',
  drilltoview: 'view',
  optionssourceslug: 'field',
};

/**
 * Array-valued keys whose every element is a slug of the given kind.
 *
 * Note what is NOT here: a bare `fields`. A rule's
 * `trigger: { on: [...], fields: ['queue_slug'] }` lists the ticket COLUMNS
 * whose change fires the rule, not field config objects — treating it as a
 * reference reports the shipped `auto_assign_by_queue` rule as broken and
 * blocks the baseline from publishing. `fieldSlugs` is the key that actually
 * carries field references (`shared/src/configKinds.ts`), and it is specific
 * enough to be unambiguous.
 */
const REFERENCE_LIST_KEYS: Readonly<Record<string, ConfigKind>> = {
  fieldslugs: 'field',
  viewslugs: 'view',
  macroslugs: 'macro',
};

function normKey(key: string): string {
  return key.toLowerCase().replace(/[_\-\s]/g, '');
}

export interface BodyReference {
  /** Dotted path inside the body, e.g. `targets[0].calendarSlug`. */
  path: string;
  targetKind: ConfigKind;
  slug: string;
}

/**
 * Walk a body and yield every cross-reference it makes. `form` bodies get a
 * dedicated pass because their field references live in
 * `sections[].fields[].ref` alongside a `builtin` flag — a builtin `ref` is a
 * ticket COLUMN, not a field object, and treating it as one would report the
 * shipped incident form as four dangling references.
 */
export function collectBodyReferences(kind: ConfigKind, body: unknown): BodyReference[] {
  const out: BodyReference[] = [];

  const walk = (value: unknown, path: string, depth: number): void => {
    if (depth > 24) return;

    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (!isPlainObject(value)) return;

    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      const normalized = normKey(key);

      const single = REFERENCE_KEYS[normalized];
      if (single && typeof child === 'string' && child.trim() !== '') {
        out.push({ path: childPath, targetKind: single, slug: child.trim() });
        continue;
      }

      const list = REFERENCE_LIST_KEYS[normalized];
      if (list && Array.isArray(child) && child.every((item) => typeof item === 'string')) {
        (child as string[]).forEach((slug, index) => {
          if (slug.trim() === '') return;
          out.push({ path: `${childPath}[${index}]`, targetKind: list, slug: slug.trim() });
        });
        continue;
      }

      walk(child, childPath, depth + 1);
    }
  };

  walk(body, '', 0);

  if (kind === 'form') out.push(...collectFormFieldReferences(body));
  return out;
}

/** `sections[].fields[]` in the shipped dialect: `{ ref, builtin }`. */
function collectFormFieldReferences(body: unknown): BodyReference[] {
  const out: BodyReference[] = [];
  if (!isPlainObject(body) || !Array.isArray(body.sections)) return out;

  body.sections.forEach((section, sectionIndex) => {
    if (!isPlainObject(section) || !Array.isArray(section.fields)) return;
    section.fields.forEach((entry, fieldIndex) => {
      if (!isPlainObject(entry)) return;
      // `builtin: true` means "a tickets column", which is not a config object.
      if (entry.builtin === true) return;
      const ref = entry.ref ?? entry.slug ?? entry.field;
      if (typeof ref !== 'string' || ref.trim() === '') return;
      out.push({
        path: `sections[${sectionIndex}].fields[${fieldIndex}].ref`,
        targetKind: 'field',
        slug: ref.trim(),
      });
    });
  });
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// Lint context
// ═════════════════════════════════════════════════════════════════════════════

export interface LintTarget {
  kind: ConfigKind;
  slug: string;
  name?: string;
  body: unknown;
  bodyFormatVersion: number;
  status?: ConfigStatus;
}

export interface KnownObject {
  status: ConfigStatus;
  body: unknown;
  bodyFormatVersion: number;
}

export interface LintContext {
  tenantId: number;
  /** `${kind}:${slug}` → what the tenant already has. */
  known: Map<string, KnownObject>;
  /** Usernames an approval definition may name. */
  usernames: Set<string>;
  /** Assignment group slug → member count (0 members = unreachable approver). */
  groups: Map<string, number>;
}

const keyOf = (kind: ConfigKind, slug: string): string => `${kind}:${slug.toLowerCase()}`;

/**
 * Load everything the linter needs to resolve a slug, in three queries.
 * `candidates` are objects that are about to exist (an import bundle, or the
 * draft being published) — they resolve each other's references, otherwise
 * importing a queue and its SLA in the same bundle could never succeed.
 */
export async function buildLintContext(
  tenantId: number,
  candidates: readonly LintTarget[] = [],
): Promise<LintContext> {
  const [objects, groupRows, userRows] = await Promise.all([
    scoped('config_objects', tenantId).select('kind', 'slug', 'status', 'body', 'body_format_version'),
    scoped('assignment_groups', tenantId).select('slug', 'member_user_ids'),
    db('users').select('username').where('is_active', true),
  ]);

  const known = new Map<string, KnownObject>();
  for (const row of objects as Array<Record<string, unknown>>) {
    const kind = row.kind as ConfigKind;
    if (!isConfigKind(kind)) continue;
    known.set(keyOf(kind, String(row.slug)), {
      status: (row.status as ConfigStatus) ?? 'draft',
      body: parseJson(row.body),
      bodyFormatVersion: Number(row.body_format_version) || 1,
    });
  }

  // Candidates shadow what is already stored: we are linting the NEW body.
  for (const candidate of candidates) {
    known.set(keyOf(candidate.kind, candidate.slug), {
      status: candidate.status ?? 'published',
      body: candidate.body,
      bodyFormatVersion: candidate.bodyFormatVersion,
    });
  }

  const groups = new Map<string, number>();
  for (const row of groupRows as Array<Record<string, unknown>>) {
    const members = Array.isArray(row.member_user_ids) ? row.member_user_ids.length : 0;
    groups.set(String(row.slug).toLowerCase(), members);
  }

  const usernames = new Set<string>(
    (userRows as Array<Record<string, unknown>>).map((row) => String(row.username).toLowerCase()),
  );

  return { tenantId, known, usernames, groups };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// The checks
// ═════════════════════════════════════════════════════════════════════════════

/** Lint one object against the tenant. Convenience wrapper over `lintObjects`. */
export async function lintOne(tenantId: number, target: LintTarget): Promise<ConfigLintFinding[]> {
  const ctx = await buildLintContext(tenantId, [target]);
  return lintObjects([target], ctx);
}

/** Lint every object the tenant owns — the "Configuration health" screen. */
export async function lintTenant(tenantId: number): Promise<ConfigLintFinding[]> {
  const rows = await scoped('config_objects', tenantId)
    .select('kind', 'slug', 'name', 'status', 'body', 'body_format_version')
    .whereIn('status', ['draft', 'published']);

  const targets: LintTarget[] = (rows as Array<Record<string, unknown>>)
    .filter((row) => isConfigKind(row.kind))
    .map((row) => ({
      kind: row.kind as ConfigKind,
      slug: String(row.slug),
      name: row.name === null || row.name === undefined ? undefined : String(row.name),
      body: parseJson(row.body),
      bodyFormatVersion: Number(row.body_format_version) || 1,
      status: (row.status as ConfigStatus) ?? 'draft',
    }));

  const ctx = await buildLintContext(tenantId);
  return lintObjects(targets, ctx);
}

/** The pure entry point: no I/O, so it is trivially testable and reusable. */
export function lintObjects(
  targets: readonly LintTarget[],
  ctx: LintContext,
): ConfigLintFinding[] {
  const findings: ConfigLintFinding[] = [];

  // ── duplicate slugs within the candidate set ────────────────────────────
  const seen = new Set<string>();
  for (const target of targets) {
    const key = keyOf(target.kind, target.slug);
    if (seen.has(key)) {
      findings.push({
        severity: 'error',
        kind: target.kind,
        slug: target.slug,
        path: 'slug',
        code: 'duplicate_slug',
        message: `Two ${target.kind} objects share the slug "${target.slug}". Slugs are the identity everything else references (HARD RULE 3), so a duplicate makes every reference to it ambiguous.`,
      });
    }
    seen.add(key);
  }

  for (const target of targets) {
    findings.push(...lintTargetBody(target, ctx));
  }

  return findings;
}

function lintTargetBody(target: LintTarget, ctx: LintContext): ConfigLintFinding[] {
  const findings: ConfigLintFinding[] = [];
  const { kind, slug } = target;

  const issue = (
    severity: ConfigLintFinding['severity'],
    path: string,
    code: ConfigLintCode,
    message: string,
  ): void => {
    findings.push({ severity, kind, slug, path, code, message });
  };

  // ── HARD RULE 4: a body from the future must not be evaluated ───────────
  const current = CONFIG_BODY_FORMAT_VERSIONS[kind];
  if (!Number.isInteger(target.bodyFormatVersion) || target.bodyFormatVersion < 1) {
    issue('error', 'bodyFormatVersion', 'body_version_ahead',
      `body_format_version must be a positive integer (HARD RULE 4); got ${String(target.bodyFormatVersion)}.`);
  } else if (target.bodyFormatVersion > current) {
    issue('error', 'bodyFormatVersion', 'body_version_ahead',
      `This ${kind} declares body_format_version ${target.bodyFormatVersion}, but this Oblidesk only understands up to ${current}. It was written by a newer version; refusing to evaluate it rather than guess at its shape.`);
  }

  if (!isPlainObject(target.body)) {
    issue('error', '', 'empty_condition', 'The body is not a JSON object.');
    return findings;
  }
  const body = target.body;

  // ── cross-references (the reason this module exists) ────────────────────
  const declaredTargets = CONFIG_KIND_REFERENCES[kind] ?? [];
  for (const reference of collectBodyReferences(kind, body)) {
    const found = ctx.known.get(keyOf(reference.targetKind, reference.slug));
    if (!found) {
      issue('error', reference.path, 'dangling_reference',
        `No ${reference.targetKind} object has the slug "${reference.slug}". Cross-references are by slug and carry no foreign key, so this would not fail at run time — the engine would simply skip it, silently.`);
      continue;
    }
    if (found.status !== 'published') {
      // Engines read PUBLISHED objects only. Pointing at a draft is a
      // reference that resolves in the editor and vanishes in production.
      issue('error', reference.path, 'draft_reference',
        `The ${reference.targetKind} "${reference.slug}" exists but is ${found.status}. Engines only read published objects, so this reference would resolve in the editor and not at run time.`);
      continue;
    }
    if (!declaredTargets.includes(reference.targetKind)) {
      // Not a defect in the body — a drift between this body and
      // CONFIG_KIND_REFERENCES. Worth surfacing, never worth blocking.
      issue('info', reference.path, 'dangling_reference',
        `A ${kind} referencing a ${reference.targetKind} is not declared in CONFIG_KIND_REFERENCES. The reference resolves; the catalogue in @oblidesk/shared is out of date.`);
    }
  }

  switch (kind) {
    case 'state_machine':
      findings.push(...lintStateMachine(target, body, ctx));
      break;
    case 'approval':
      findings.push(...lintApproval(target, body, ctx));
      break;
    case 'sla':
      findings.push(...lintSla(target, body, ctx));
      break;
    case 'rule':
      findings.push(...lintRule(target, body, ctx));
      break;
    case 'priority_matrix':
      findings.push(...lintPriorityMatrix(target, body));
      break;
    case 'view':
      findings.push(...lintView(target, body, ctx));
      break;
    case 'macro':
      findings.push(...lintMacro(target, body, ctx));
      break;
    case 'field':
      findings.push(...lintField(target, body, ctx));
      break;
    default:
      break;
  }

  return findings;
}

// ── state_machine ────────────────────────────────────────────────────────────

interface NormalizedStatus {
  slug: string;
  category: string | null;
}

interface NormalizedTransition {
  from: string[];
  to: string;
  label: string;
  requiredFields: string[];
  guard: unknown;
}

/** Read a state machine in either dialect. */
export function readStateMachine(body: Record<string, unknown>): {
  initial: string | null;
  statuses: NormalizedStatus[];
  transitions: NormalizedTransition[];
} {
  const initialRaw = body.initial_status ?? body.initialStatusSlug ?? body.initialStatus;
  const initial = typeof initialRaw === 'string' ? initialRaw : null;

  const statuses: NormalizedStatus[] = Array.isArray(body.statuses)
    ? body.statuses.filter(isPlainObject).map((status) => ({
      slug: typeof status.slug === 'string' ? status.slug : '',
      category: typeof status.category === 'string' ? status.category : null,
    }))
    : [];

  const transitions: NormalizedTransition[] = Array.isArray(body.transitions)
    ? body.transitions.filter(isPlainObject).map((transition, index) => {
      const rawFrom = transition.from;
      const from = rawFrom === '*'
        ? statuses.map((s) => s.slug)
        : Array.isArray(rawFrom)
          ? rawFrom.filter((value): value is string => typeof value === 'string')
          : typeof rawFrom === 'string' ? [rawFrom] : [];
      const requiredRaw = transition.required_fields ?? transition.requiredFields;
      return {
        from,
        to: typeof transition.to === 'string' ? transition.to : '',
        label: typeof transition.slug === 'string' ? transition.slug : `transitions[${index}]`,
        requiredFields: Array.isArray(requiredRaw)
          ? requiredRaw.filter((value): value is string => typeof value === 'string')
          : [],
        guard: transition.guard ?? null,
      };
    })
    : [];

  return { initial, statuses, transitions };
}

function lintStateMachine(
  target: LintTarget,
  body: Record<string, unknown>,
  ctx: LintContext,
): ConfigLintFinding[] {
  const out: ConfigLintFinding[] = [];
  const { kind, slug } = target;
  const push = (
    severity: ConfigLintFinding['severity'],
    path: string,
    code: ConfigLintCode,
    message: string,
  ): void => { out.push({ severity, kind, slug, path, code, message }); };

  const { initial, statuses, transitions } = readStateMachine(body);
  const slugs = new Set(statuses.map((status) => status.slug).filter(Boolean));

  if (statuses.length === 0) {
    push('error', 'statuses', 'no_initial_status', 'A state machine with no statuses cannot drive anything.');
    return out;
  }

  // HARD RULE 5 — the category is mandatory and hard-coded. Engines key off it.
  statuses.forEach((status, index) => {
    if (!status.slug) {
      push('error', `statuses[${index}].slug`, 'missing_category', 'Every status needs a slug.');
      return;
    }
    if (status.category === null) {
      push('error', `statuses[${index}].category`, 'missing_category',
        `Status "${status.slug}" declares no category. Every engine — SLA, escalation, reporting — keys off the CATEGORY and never off the slug (HARD RULE 5), so a status without one is invisible to all of them.`);
      return;
    }
    if (!isStatusCategory(status.category)) {
      push('error', `statuses[${index}].category`, 'missing_category',
        `Status "${status.slug}" has category "${status.category}", which is not one of the eight hard-coded categories.`);
    }
  });

  if (!initial) {
    push('error', 'initial_status', 'no_initial_status',
      'No initial status: a newly created ticket would have nowhere to land.');
  } else if (!slugs.has(initial)) {
    push('error', 'initial_status', 'no_initial_status',
      `The initial status "${initial}" is not one of this machine's statuses.`);
  }

  // Transitions must name statuses that exist.
  transitions.forEach((transition, index) => {
    if (!transition.to) {
      push('error', `transitions[${index}].to`, 'dangling_reference', 'A transition with no destination.');
    } else if (!slugs.has(transition.to)) {
      push('error', `transitions[${index}].to`, 'dangling_reference',
        `Transition "${transition.label}" moves to "${transition.to}", which is not a status of this machine.`);
    }
    transition.from.forEach((from, fromIndex) => {
      if (!slugs.has(from)) {
        push('error', `transitions[${index}].from[${fromIndex}]`, 'dangling_reference',
          `Transition "${transition.label}" starts from "${from}", which is not a status of this machine.`);
      }
    });

    // HARD RULE 12 — required_fields is the ONE place required-ness lives, so
    // a required field that does not exist means a transition nobody can ever
    // satisfy, and the button is greyed out with no explanation.
    transition.requiredFields.forEach((field, fieldIndex) => {
      const normalized = normalizeFieldPath(field);
      const classified = classifyField(normalized);
      if (classified.kind === 'column' || classified.kind === 'engine') return;
      const fieldSlug = classified.slug ?? normalized;
      const found = ctx.known.get(keyOf('field', fieldSlug));
      if (!found) {
        push('error', `transitions[${index}].requiredFields[${fieldIndex}]`, 'unknown_field',
          `Transition "${transition.label}" requires "${field}", but no field object declares it and it is not a ticket column. Nobody would ever be able to make this move.`);
      } else if (found.status !== 'published') {
        push('error', `transitions[${index}].requiredFields[${fieldIndex}]`, 'draft_reference',
          `Transition "${transition.label}" requires field "${fieldSlug}", which is only ${found.status}.`);
      }
    });
  });

  // ── reachability: forward from the initial status ───────────────────────
  const reachable = new Set<string>();
  if (initial && slugs.has(initial)) {
    const queue = [initial];
    reachable.add(initial);
    while (queue.length > 0) {
      const at = queue.shift() as string;
      for (const transition of transitions) {
        if (!transition.from.includes(at)) continue;
        if (!transition.to || reachable.has(transition.to)) continue;
        reachable.add(transition.to);
        queue.push(transition.to);
      }
    }
  }

  const terminalCategories = new Set<StatusCategory>(['closed', 'cancelled']);

  for (const status of statuses) {
    if (!status.slug) continue;

    if (initial && slugs.has(initial) && !reachable.has(status.slug)) {
      push('error', `statuses.${status.slug}`, 'unreachable_status',
        `Nothing can reach "${status.slug}": no transition leads to it from "${initial}". It will appear in the status picker and never be used.`);
    }

    const leaves = transitions.some((transition) => transition.from.includes(status.slug) && transition.to);
    if (!leaves) {
      const isTerminal = status.category !== null
        && isStatusCategory(status.category)
        && terminalCategories.has(status.category);
      if (isTerminal) {
        // 'closed' with no exit is a decision, not a bug — but it does mean no
        // reopen, so say so once at warning level.
        push('warning', `statuses.${status.slug}`, 'dead_end_status',
          `No transition leaves "${status.slug}". Its category is terminal so that may be deliberate, but it also means a ticket here can never be reopened.`);
      } else {
        push('error', `statuses.${status.slug}`, 'dead_end_status',
          `No transition leaves "${status.slug}" and its category (${status.category ?? 'none'}) is not terminal. Every ticket that lands here is stuck forever with no way out but a database edit.`);
      }
    }
  }

  const recordTypes = body.applies_to_record_types ?? body.recordTypes;
  if (Array.isArray(recordTypes)) {
    recordTypes.forEach((recordType, index) => {
      if (typeof recordType === 'string' && !(TICKET_RECORD_TYPES as readonly string[]).includes(recordType)) {
        push('warning', `recordTypes[${index}]`, 'unknown_field',
          `"${recordType}" is not a ticket record type.`);
      }
    });
  }

  return out;
}

// ── approval ─────────────────────────────────────────────────────────────────

function lintApproval(
  target: LintTarget,
  body: Record<string, unknown>,
  ctx: LintContext,
): ConfigLintFinding[] {
  const out: ConfigLintFinding[] = [];
  const { kind, slug } = target;
  const push = (
    severity: ConfigLintFinding['severity'],
    path: string,
    code: ConfigLintCode,
    message: string,
  ): void => { out.push({ severity, kind, slug, path, code, message }); };

  const steps = Array.isArray(body.steps) ? body.steps.filter(isPlainObject) : [];
  if (steps.length === 0) {
    push('error', 'steps', 'approval_no_approvers',
      'An approval with no steps blocks the ticket and asks nobody. Every ticket that starts it stops there.');
    return out;
  }

  steps.forEach((step, index) => {
    const approvers = Array.isArray(step.approvers) ? step.approvers.filter(isPlainObject) : [];

    // "Reachable" means a human (or a rule that resolves to one) could
    // actually be asked. An empty group is NOT reachable — that is the classic
    // way an approval silently becomes a dead end.
    let reachable = 0;
    approvers.forEach((approver, approverIndex) => {
      const path = `steps[${index}].approvers[${approverIndex}]`;
      const approverKind = typeof approver.kind === 'string' ? approver.kind : '';
      const ref = typeof approver.ref === 'string' ? approver.ref.trim() : '';

      switch (approverKind) {
        case 'user': {
          if (!ref) {
            push('error', path, 'approval_no_approvers', 'An approver of kind "user" with no username.');
            return;
          }
          if (!ctx.usernames.has(ref.toLowerCase())) {
            push('error', path, 'dangling_reference',
              `No active user is named "${ref}". Approvers are referenced by username, never by id (HARD RULE 3).`);
            return;
          }
          reachable += 1;
          return;
        }
        case 'group': {
          if (!ref) {
            push('error', path, 'approval_no_approvers', 'An approver of kind "group" with no group slug.');
            return;
          }
          const members = ctx.groups.get(ref.toLowerCase());
          if (members === undefined) {
            push('error', path, 'dangling_reference', `No assignment group has the slug "${ref}".`);
            return;
          }
          if (members === 0) {
            push('error', path, 'approval_no_approvers',
              `The assignment group "${ref}" has no members, so this step resolves to zero approvers and the ticket parks here indefinitely.`);
            return;
          }
          reachable += 1;
          return;
        }
        case 'manager_of_requester': {
          // Resolvable only at run time; assume reachable and let the approval
          // engine's own decision_log row explain a miss.
          reachable += 1;
          return;
        }
        case 'field': {
          if (!ref) {
            push('error', path, 'approval_no_approvers', 'An approver of kind "field" with no field slug.');
            return;
          }
          const found = ctx.known.get(keyOf('field', ref));
          if (!found) {
            push('error', path, 'dangling_reference',
              `No field object declares "${ref}", so this approver can never resolve.`);
            return;
          }
          reachable += 1;
          return;
        }
        default:
          push('error', path, 'approval_no_approvers',
            `Unknown approver kind "${approverKind}". Expected user, group, manager_of_requester or field.`);
      }
    });

    if (reachable === 0) {
      push('error', `steps[${index}].approvers`, 'approval_no_approvers',
        `Step ${index + 1} resolves to zero reachable approvers. The ticket would be blocked waiting for a decision that nobody has been asked to make.`);
    }

    const mode = typeof step.mode === 'string' ? step.mode : 'parallel';
    if (mode === 'quorum') {
      const quorum = Number(step.quorum);
      if (!Number.isInteger(quorum) || quorum < 1) {
        push('error', `steps[${index}].quorum`, 'approval_no_approvers',
          'A quorum step needs a quorum of at least 1.');
      } else if (reachable > 0 && quorum > reachable) {
        push('error', `steps[${index}].quorum`, 'approval_no_approvers',
          `Step ${index + 1} needs ${quorum} approvals but only ${reachable} approver${reachable === 1 ? '' : 's'} can be reached. The quorum can never be met.`);
      }
    }

    // A step with no timeout is the other half of the same failure: nobody is
    // asked twice, and nothing escalates. `onTimeout: 'wait'` is an explicit
    // "block forever" and is still required to say how long it waits before
    // reminding, so the absence of a duration is always a defect.
    const dueMinutes = Number(step.dueMinutes ?? step.due_minutes ?? step.timeoutMinutes);
    if (!Number.isFinite(dueMinutes) || dueMinutes <= 0) {
      push('error', `steps[${index}].dueMinutes`, 'approval_no_timeout',
        `Step ${index + 1} has no timeout. An approval nobody answers then waits forever with no reminder and no escalation — the single most common way a change request disappears.`);
    }

    const onTimeout = typeof step.onTimeout === 'string' ? step.onTimeout : '';
    if (onTimeout && !['approve', 'reject', 'escalate', 'wait'].includes(onTimeout)) {
      push('error', `steps[${index}].onTimeout`, 'approval_no_timeout',
        `Unknown onTimeout "${onTimeout}". Expected approve, reject, escalate or wait.`);
    }
  });

  return out;
}

// ── sla ──────────────────────────────────────────────────────────────────────

/** Total minutes a calendar body is open per week; 10080 ⇒ genuinely 24×7. */
export function weeklyOpenMinutes(calendarBody: unknown): number | null {
  if (!isPlainObject(calendarBody)) return null;
  const shifts = calendarBody.shifts;
  if (!Array.isArray(shifts)) return null;

  let total = 0;
  for (const shift of shifts) {
    if (!isPlainObject(shift)) continue;
    const start = Number(shift.start_minute ?? shift.startMinute ?? parseClock(shift.start));
    const end = Number(shift.end_minute ?? shift.endMinute ?? parseClock(shift.end));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    total += end - start;
  }
  return total;
}

function parseClock(value: unknown): number {
  if (typeof value !== 'string') return NaN;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return NaN;
  return Number(match[1]) * 60 + Number(match[2]);
}

const FULL_WEEK_MINUTES = 7 * 24 * 60;

function lintSla(
  target: LintTarget,
  body: Record<string, unknown>,
  ctx: LintContext,
): ConfigLintFinding[] {
  const out: ConfigLintFinding[] = [];
  const { kind, slug } = target;
  const push = (
    severity: ConfigLintFinding['severity'],
    path: string,
    code: ConfigLintCode,
    message: string,
  ): void => { out.push({ severity, kind, slug, path, code, message }); };

  const policyCalendar = firstString(body.calendar, body.calendarSlug);
  const targets = Array.isArray(body.targets) ? body.targets.filter(isPlainObject) : [];

  if (targets.length === 0) {
    push('warning', 'targets', 'empty_condition', 'This SLA policy declares no targets, so it never starts a clock.');
  }

  targets.forEach((slaTarget, index) => {
    const targetSlug = typeof slaTarget.slug === 'string' ? slaTarget.slug : `targets[${index}]`;
    const calendarSlug = firstString(slaTarget.calendar, slaTarget.calendarSlug) ?? policyCalendar;

    const pauseRaw = slaTarget.pause_on_categories
      ?? slaTarget.pauseOnCategories
      ?? slaTarget.pause_on
      ?? slaTarget.pauseOn;
    const pauseOn = Array.isArray(pauseRaw)
      ? pauseRaw.filter((value): value is string => typeof value === 'string')
      : [];

    // ── the double-count ────────────────────────────────────────────────
    // A business calendar ALREADY excludes the night: the clock does not run
    // between 18:00 and 09:00 because those minutes are not business minutes.
    // Adding 'outside_hours' to pause_on subtracts them a second time. The
    // legitimate pairing is a 24×7 calendar plus 'outside_hours', where the
    // calendar counts everything and the pause is the only thing that carves
    // out the night.
    const pausesOutsideHours = pauseOn.some(
      (value) => value === 'outside_hours' || value === 'outside_business_hours',
    );
    if (pausesOutsideHours && calendarSlug) {
      const calendar = ctx.known.get(keyOf('calendar', calendarSlug));
      const openMinutes = calendar ? weeklyOpenMinutes(calendar.body) : null;
      if (openMinutes !== null && openMinutes < FULL_WEEK_MINUTES) {
        push('error', `targets[${index}].pauseOnCategories`, 'sla_double_pause',
          `Target "${targetSlug}" runs on calendar "${calendarSlug}" (${openMinutes} open minutes a week) AND pauses on 'outside_hours'. Those are the same night subtracted twice: the budget silently stretches to roughly double what the label promises. Either drop 'outside_hours', or point the target at a 24×7 calendar — that pairing is the legitimate one.`);
      }
    }

    for (const category of pauseOn) {
      if (category === 'outside_hours' || category === 'outside_business_hours') continue;
      if (!isStatusCategory(category)) {
        push('error', `targets[${index}].pauseOnCategories`, 'missing_category',
          `"${category}" is not a status category. Pause semantics key off the eight hard-coded categories (HARD RULE 5), never off a status slug.`);
      }
    }

    const durations = slaTarget.by_priority ?? slaTarget.durationsByPriority ?? slaTarget.durations;
    if (!isPlainObject(durations) || Object.keys(durations).length === 0) {
      push('error', `targets[${index}].durationsByPriority`, 'empty_condition',
        `Target "${targetSlug}" declares no duration for any priority, so it can never be due.`);
    } else {
      for (const [priority, spec] of Object.entries(durations)) {
        const minutes = isPlainObject(spec) ? Number(spec.minutes) : Number(spec);
        if (!Number.isFinite(minutes) || minutes <= 0) {
          push('error', `targets[${index}].durationsByPriority.${priority}`, 'empty_condition',
            `Target "${targetSlug}" has a non-positive duration for priority "${priority}".`);
        }
      }
    }
  });

  return out;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

// ── rule ─────────────────────────────────────────────────────────────────────

function lintRule(
  target: LintTarget,
  body: Record<string, unknown>,
  ctx: LintContext,
): ConfigLintFinding[] {
  const out: ConfigLintFinding[] = [];
  const { kind, slug } = target;
  const push = (
    severity: ConfigLintFinding['severity'],
    path: string,
    code: ConfigLintCode,
    message: string,
  ): void => { out.push({ severity, kind, slug, path, code, message }); };

  const when = normalizeConditionTree(body.when ?? body.condition ?? null);

  if (when !== null && !isConditionNode(when)) {
    push('error', 'when', 'empty_condition',
      'The condition tree is malformed. A malformed tree evaluates FALSE, so the rule would never fire and never complain.');
  }

  // THE silent failure: a leaf naming a field that nobody declares resolves to
  // "unknown", which evaluates FALSE. The rule is disabled in every way except
  // the one the UI shows.
  for (const field of collectFields(when)) {
    const classified = classifyField(field);
    if (classified.kind === 'column' || classified.kind === 'engine') continue;
    const fieldSlug = classified.slug ?? field;
    const found = ctx.known.get(keyOf('field', fieldSlug));
    if (!found) {
      push('error', 'when', 'unknown_field',
        `The condition reads "${field}", which is neither a ticket column nor a declared field. An unknown field evaluates FALSE, so this rule can never match — it is switched off and says it is on.`);
    } else if (found.status !== 'published') {
      push('error', 'when', 'draft_reference',
        `The condition reads "${field}", whose field object is only ${found.status}. It will not resolve at run time.`);
    }
  }

  // Two passes over the operators, because they answer different questions.
  // `collectRawOperators` reads them AS WRITTEN, before alias mapping, so a
  // typo is reportable — `collectOperators` cannot see one, since a leaf whose
  // `op` is not an operator is not a leaf at all and is skipped.
  for (const operator of collectRawOperators(body.when ?? body.condition ?? null)) {
    if (!isOperator(operator) && !['and', 'or', 'not'].includes(operator)) {
      push('error', 'when', 'unknown_field', `"${operator}" is not a condition operator.`);
    }
  }

  // …and `collectOperators` reads the NORMALISED tree, which is what will
  // actually run. A regex in a rule that fires on every ticket event is a
  // per-event backtracking cost nobody measured, so it is worth naming once.
  if (collectOperators(when).includes('matches')) {
    push('info', 'when', 'empty_condition',
      'This rule matches with a regular expression. It runs on every event the rule listens to, so an expensive pattern is paid per ticket — prefer contains / starts_with where they will do.');
  }

  const triggerRaw = body.trigger ?? body.triggers;
  const triggers = Array.isArray(triggerRaw)
    ? triggerRaw
    : isPlainObject(triggerRaw) && Array.isArray(triggerRaw.on)
      ? triggerRaw.on
      : [];
  const enabled = body.enabled !== false;
  if (enabled && triggers.length === 0) {
    push('error', 'triggers', 'empty_condition',
      'The rule is enabled but answers no trigger, so nothing will ever invoke it.');
  }

  const actions = Array.isArray(body.actions) ? body.actions.filter(isPlainObject) : [];
  if (enabled && actions.length === 0) {
    push('warning', 'actions', 'empty_condition', 'The rule is enabled but has no actions.');
  }

  actions.forEach((action, index) => {
    const field = typeof action.field === 'string' ? normalizeFieldPath(action.field) : null;
    if (!field) return;
    const classified = classifyField(field);
    if (classified.kind !== 'data') return;
    const fieldSlug = classified.slug ?? field;
    if (ctx.known.has(keyOf('field', fieldSlug))) return;
    // Writing a fresh key into the `data` jsonb is legal and sometimes
    // deliberate (a private marker an automation reads back). It is only
    // worth an INFO: the value is real, it is just invisible on every form.
    push('info', `actions[${index}].field`, 'undeclared_write',
      `This rule writes data.${fieldSlug}, which no field object declares. The value will be stored and will never appear on a form or a view.`);
  });

  const scheduleTriggered = triggers.includes('schedule');
  const everyMinutes = isPlainObject(triggerRaw) ? Number(triggerRaw.every_minutes ?? triggerRaw.everyMinutes) : NaN;
  const oncePerTicket = body.once_per_ticket === true || body.runOnce === true;
  const cooldown = Number(body.cooldownMinutes ?? body.cooldown_minutes);
  if (scheduleTriggered && Number.isFinite(everyMinutes) && everyMinutes > 0
    && !oncePerTicket && !(Number.isFinite(cooldown) && cooldown > 0)) {
    // A schedule with no once-per-ticket and no cooldown re-fires on every
    // sweep for as long as the condition holds. That is how an escalation
    // mail becomes the thing everyone filters out.
    push('warning', 'once_per_ticket', 'empty_condition',
      `This rule runs every ${everyMinutes} minutes with neither once_per_ticket nor a cooldown, so it will re-fire on the same ticket every sweep for as long as its condition holds.`);
  }

  return out;
}

/** Operators as WRITTEN (before alias mapping), so a typo is reportable. */
function collectRawOperators(raw: unknown, depth = 0): string[] {
  if (depth > 32 || !isPlainObject(raw)) return [];
  const out: string[] = [];
  for (const key of ['all', 'any', 'children'] as const) {
    const children = raw[key];
    if (Array.isArray(children)) {
      for (const child of children) out.push(...collectRawOperators(child, depth + 1));
    }
  }
  if (raw.not !== undefined) out.push(...collectRawOperators(raw.not, depth + 1));
  if (typeof raw.op === 'string') out.push(OPERATOR_ALIASES[raw.op] ?? raw.op);
  return out;
}

// ── priority_matrix ──────────────────────────────────────────────────────────

const IMPACTS = ['high', 'medium', 'low'] as const;
const URGENCIES = ['high', 'medium', 'low'] as const;

function lintPriorityMatrix(target: LintTarget, body: Record<string, unknown>): ConfigLintFinding[] {
  const out: ConfigLintFinding[] = [];
  const { kind, slug } = target;
  const push = (
    severity: ConfigLintFinding['severity'],
    path: string,
    code: ConfigLintCode,
    message: string,
  ): void => { out.push({ severity, kind, slug, path, code, message }); };

  const priorities = Array.isArray(body.priorities) ? body.priorities.filter(isPlainObject) : [];
  const prioritySlugs = new Set(
    priorities.map((priority) => (typeof priority.slug === 'string' ? priority.slug : '')).filter(Boolean),
  );

  if (prioritySlugs.size === 0) {
    push('error', 'priorities', 'incomplete_matrix', 'The matrix declares no priorities.');
    return out;
  }

  const matrix = isPlainObject(body.matrix) ? body.matrix : {};

  // Both dialects: nested `matrix.high.medium` and flat `matrix['high:medium']`.
  const cellAt = (impact: string, urgency: string): unknown => {
    const nested = matrix[impact];
    if (isPlainObject(nested) && nested[urgency] !== undefined) return nested[urgency];
    return matrix[`${impact}:${urgency}`];
  };

  for (const impact of IMPACTS) {
    for (const urgency of URGENCIES) {
      const cell = cellAt(impact, urgency);
      if (typeof cell !== 'string' || cell.trim() === '') {
        push('error', `matrix.${impact}:${urgency}`, 'incomplete_matrix',
          `No priority for impact=${impact}, urgency=${urgency}. An agent who picks that pair would get no priority at all.`);
        continue;
      }
      if (!prioritySlugs.has(cell)) {
        push('error', `matrix.${impact}:${urgency}`, 'dangling_reference',
          `Cell impact=${impact}, urgency=${urgency} names priority "${cell}", which this matrix does not declare.`);
      }
    }
  }

  const fallback = firstString(body.default_priority, body.defaultPrioritySlug);
  if (!fallback) {
    push('error', 'defaultPrioritySlug', 'incomplete_matrix',
      'No default priority: a ticket whose impact and urgency are unknown would have none.');
  } else if (!prioritySlugs.has(fallback)) {
    push('error', 'defaultPrioritySlug', 'dangling_reference',
      `The default priority "${fallback}" is not one of the declared priorities.`);
  }

  return out;
}

// ── view ─────────────────────────────────────────────────────────────────────

function lintView(
  target: LintTarget,
  body: Record<string, unknown>,
  ctx: LintContext,
): ConfigLintFinding[] {
  const out: ConfigLintFinding[] = [];
  const { kind, slug } = target;
  const push = (
    severity: ConfigLintFinding['severity'],
    path: string,
    code: ConfigLintCode,
    message: string,
  ): void => { out.push({ severity, kind, slug, path, code, message }); };

  const filter = normalizeConditionTree(body.filter ?? null);
  if (filter !== null && !isConditionNode(filter)) {
    push('error', 'filter', 'empty_condition', 'The view filter is malformed and would match nothing.');
  }

  // `{ any: [] }` has no alternative to satisfy, so it matches zero rows — an
  // empty view that looks like a configured one.
  if (filter !== null && isPlainObject(filter) && Array.isArray((filter as { any?: unknown[] }).any)
    && (filter as { any: unknown[] }).any.length === 0) {
    push('warning', 'filter', 'empty_condition',
      'The filter is an empty "any", which matches nothing. An empty "all" is the one that matches everything.');
  }

  for (const field of collectFields(filter)) {
    const classified = classifyField(field);
    if (classified.kind === 'column' || classified.kind === 'engine') continue;
    const fieldSlug = classified.slug ?? field;
    if (!ctx.known.has(keyOf('field', fieldSlug))) {
      push('error', 'filter', 'unknown_field',
        `The filter reads "${field}", which is neither a ticket column nor a declared field, so the view would always be empty.`);
    }
  }

  const columns = Array.isArray(body.columns) ? body.columns : [];
  columns.forEach((column, index) => {
    const field = typeof column === 'string'
      ? column
      : isPlainObject(column) && typeof column.field === 'string' ? column.field : null;
    if (!field) return;
    const classified = classifyField(normalizeFieldPath(field));
    if (classified.kind !== 'data') return;
    const fieldSlug = classified.slug as string;
    if (!ctx.known.has(keyOf('field', fieldSlug))) {
      push('warning', `columns[${index}]`, 'unknown_field',
        `Column "${field}" names a field nobody declares; the column would always be blank.`);
    }
  });

  return out;
}

// ── macro ────────────────────────────────────────────────────────────────────

function lintMacro(
  target: LintTarget,
  body: Record<string, unknown>,
  ctx: LintContext,
): ConfigLintFinding[] {
  const out: ConfigLintFinding[] = [];
  const { kind, slug } = target;

  // A macro that applies a transition must name one that exists on SOME
  // published state machine — otherwise the macro is a button that does
  // nothing, which is worse than no button.
  const transitionSlugs = new Set<string>();
  for (const [key, value] of ctx.known.entries()) {
    if (!key.startsWith('state_machine:') || value.status !== 'published') continue;
    if (!isPlainObject(value.body)) continue;
    for (const transition of readStateMachine(value.body).transitions) {
      transitionSlugs.add(transition.label);
      if (transition.to) transitionSlugs.add(transition.to);
    }
  }

  const actions = Array.isArray(body.actions) ? body.actions.filter(isPlainObject) : [];
  actions.forEach((action, index) => {
    const transition = firstString(action.transition, action.transitionSlug, action.to);
    if (!transition) return;
    if (transitionSlugs.size === 0) return; // no state machine published yet
    if (!transitionSlugs.has(transition)) {
      out.push({
        severity: 'error',
        kind,
        slug,
        path: `actions[${index}].transition`,
        code: 'dangling_reference',
        message: `No published state machine declares a transition "${transition}". The macro would run its other actions and then silently fail to move the ticket.`,
      });
    }
  });

  return out;
}

// ── field ────────────────────────────────────────────────────────────────────

function lintField(
  target: LintTarget,
  body: Record<string, unknown>,
  ctx: LintContext,
): ConfigLintFinding[] {
  const out: ConfigLintFinding[] = [];
  const { kind, slug } = target;
  const push = (
    severity: ConfigLintFinding['severity'],
    path: string,
    code: ConfigLintCode,
    message: string,
  ): void => { out.push({ severity, kind, slug, path, code, message }); };

  const key = firstString(body.key, body.storage);
  if (!key) {
    push('error', 'key', 'unknown_field', 'A field needs a storage key — it is the key inside tickets.data.');
  }

  const type = typeof body.type === 'string' ? body.type : '';
  if ((type === 'select' || type === 'multiselect')) {
    const options = Array.isArray(body.options) ? body.options : [];
    const sourceSlug = firstString(body.optionsSourceSlug, body.options_source_slug);
    if (options.length === 0 && !sourceSlug) {
      push('error', 'options', 'empty_condition',
        `A ${type} field with no options and no options source can never be given a value.`);
    }
  }

  // HARD RULE 12 — required-ness lives on a transition, never on the field.
  // A `required: true` here would be enforced by nothing (inline autosave must
  // not validate it) while telling the author it is enforced by something.
  if (body.required === true || body.isRequired === true) {
    push('error', 'required', 'unknown_field',
      'A field object must not declare required-ness. Required-ness lives only on a state machine transition\'s requiredFields (HARD RULE 12), because inline edits autosave one field at a time and must never block on another one being empty.');
  }

  for (const conditionKey of ['visibleWhen', 'requiredWhen', 'editableWhen'] as const) {
    const tree = normalizeConditionTree(body[conditionKey] ?? null);
    if (tree === null) continue;
    if (!isConditionNode(tree)) {
      push('error', conditionKey, 'empty_condition', `${conditionKey} is a malformed condition tree.`);
      continue;
    }
    for (const field of collectFields(tree)) {
      const classified = classifyField(field);
      if (classified.kind === 'column' || classified.kind === 'engine') continue;
      const fieldSlug = classified.slug ?? field;
      if (fieldSlug === slug) continue; // self-reference is legal
      if (!ctx.known.has(keyOf('field', fieldSlug))) {
        push('error', conditionKey, 'unknown_field',
          `${conditionKey} reads "${field}", which nobody declares — the condition is permanently false.`);
      }
    }
  }

  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// Re-exports the store leans on
// ═════════════════════════════════════════════════════════════════════════════

export const LINTABLE_KINDS: readonly ConfigKind[] = CONFIG_KINDS;
