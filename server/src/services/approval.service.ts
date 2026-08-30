/**
 * approval.service.ts — the approval engine.
 *
 * ── The model ───────────────────────────────────────────────────────────────
 * A published `config_objects` row of `kind = 'approval'` carries an
 * `ApprovalBody`: `requiredWhen`, an ordered list of STAGES, and what to do
 * when the whole thing is approved or rejected. Running it produces one
 * `approvals` row and, per stage, one `approval_steps` row per resolved
 * approver.
 *
 *   stage       an `ApprovalBody.steps[i]`. Stages run in order.
 *   mode        how the approvers WITHIN one stage combine:
 *                 parallel    everyone is asked at once; all must approve
 *                 sequential  they are asked one at a time; all must approve
 *                 quorum      everyone is asked at once; N of them suffice
 *   step row    one `approval_steps` row = one approver of one stage.
 *
 * `approvals.mode` is the approval-level orchestration — `'sequential'` when
 * the definition has more than one stage, otherwise the single stage's own
 * mode — which is what makes the column meaningful next to the per-stage modes.
 *
 * ── Four requirements this file is written around ───────────────────────────
 *
 * 1. A definition MUST resolve to at least one REACHABLE approver and MUST
 *    declare a timeout behaviour, or it cannot be saved. Nothing else in this
 *    file prevents as many incidents as that one check: an approval routed to
 *    an empty group, or with no deadline, is how a change request disappears
 *    for three weeks and is found during the post-mortem.
 *    → `validateApprovalDefinition()`, called by the routes' save path and (see
 *      the TODO at the foot of this file) by `configLinter.service.ts`.
 *
 * 2. A pending approval BLOCKS the transitions its definition names, and the
 *    block surfaces through the transition inspector WITH THE APPROVER'S NAME.
 *    "Forbidden" tells an agent nothing; "waiting on Marie Dupont since
 *    Tuesday, due Thursday 17:00" tells them who to go and ask.
 *    → `transitionBlocks()` / `assertTransitionAllowed()`.
 *
 * 3. Decisions are APPEND-ONLY. A decision is written once, on its own step
 *    row, and the aggregate state is RECOMPUTED from the step rows against the
 *    spec snapshot — never stored independently and patched. Two places that
 *    both believe they know whether an approval passed will eventually
 *    disagree, and the one the UI reads will be the wrong one.
 *    → `recomputeState()`; `approvals.state` is a projection with exactly one
 *      writer.
 *
 * 4. A timeout is an ACTOR. `auto_approve | auto_reject | escalate | hold` each
 *    write a `decision_log` row naming the timeout as what decided, so nobody
 *    ever has to work out why an approval passed at 02:00 with nobody logged in.
 *
 * ── HARD RULE 2 ─────────────────────────────────────────────────────────────
 * Every start, decision, delegation, timeout and cancellation writes its
 * `decision_log` row through `withDecision()`, in the same transaction as the
 * write it explains.
 */

import type { Knex } from 'knex';

import {
  DEFAULT_LOCALE,
  SOCKET_EVENTS,
  buildConditionFields,
  describeCondition,
  evaluateCondition,
  isTerminal,
  normalizeCondition,
  toStatusCategory,
  type Approval,
  type ApprovalMode,
  type ApprovalState,
  type ApprovalStep,
  type ApprovalStepState,
  type ConditionNode,
  type RuleActionSpec,
  type StatusCategory,
} from '@oblidesk/shared';

import { assertTenantId, db, insertScoped, scoped, type Executor } from '../db';
import { logger } from '../utils/logger';
import { AppError } from '../middleware/errorHandler';
import { emitToTicket, emitToUser } from '../socket';
import { withDecision } from './decision.service';
import { loadPublished, loadPublishedOne, type PublishedBody } from './configObject.service';
import { addBusinessMinutesOn, businessMsBetween } from './calendar.service';
import { notificationService } from './notification.service';
import * as journalService from './journal.service';

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Errors
// ═════════════════════════════════════════════════════════════════════════════

export class ApprovalServiceError extends AppError {
  constructor(
    status: number,
    message: string,
    code:
      | 'validation_failed'
      | 'not_found'
      | 'forbidden'
      | 'conflict'
      | 'transition_blocked' = 'validation_failed',
    payload?: Record<string, unknown>,
  ) {
    super(status, message, { code, payload });
    this.name = 'ApprovalServiceError';
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — The normalized definition
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Canonical timeout behaviours.
 *
 * `ApprovalStepSpec.onTimeout` in `@oblidesk/shared` spells them
 * `approve | reject | escalate | wait`. Both spellings are accepted on the way
 * in and normalised to the canonical four, so a body written against either
 * vocabulary runs — and there is exactly one set of names inside the engine.
 */
export type ApprovalTimeoutBehaviour = 'auto_approve' | 'auto_reject' | 'escalate' | 'hold';

const TIMEOUT_ALIASES: Readonly<Record<string, ApprovalTimeoutBehaviour>> = {
  approve: 'auto_approve',
  auto_approve: 'auto_approve',
  autoapprove: 'auto_approve',
  reject: 'auto_reject',
  auto_reject: 'auto_reject',
  autoreject: 'auto_reject',
  escalate: 'escalate',
  wait: 'hold',
  hold: 'hold',
  block: 'hold',
};

export interface ApproverSpec {
  kind: 'user' | 'group' | 'manager_of_requester' | 'field';
  /** Username, group slug or field slug — never a numeric id (HARD RULE 3). */
  ref: string | null;
  /**
   * The `kind` string exactly as the body spelled it. Kept so validation can
   * say `Unknown approver kind "approver_group"` instead of complaining that a
   * user approver has no username — an error message that sends the author to
   * the wrong line is worse than no message.
   */
  rawKind: string;
}

export interface NormalizedApprovalStage {
  index: number;
  label: string | null;
  labelKey: string | null;
  approvers: ApproverSpec[];
  mode: ApprovalMode;
  /** Required approvals when `mode === 'quorum'`. */
  quorum: number | null;
  /** Business minutes before the stage times out. */
  dueMinutes: number | null;
  calendarSlug: string | null;
  onTimeout: ApprovalTimeoutBehaviour | null;
  /** Ladder armed when `onTimeout === 'escalate'` (HARD RULE 3 — a slug). */
  escalationSlug: string | null;
  /** Overrides the definition-wide reminder cadence. */
  reminderMinutes: number | null;
}

export interface NormalizedApprovalDefinition {
  slug: string;
  name: string;
  version: number;
  bodyFormatVersion: number;
  requiredWhen: ConditionNode | null;
  stages: NormalizedApprovalStage[];
  onApproved: RuleActionSpec[];
  onRejected: RuleActionSpec[];
  allowDelegate: boolean;
  reminderMinutes: number | null;
  blocksTransitions: boolean;
  /**
   * Which transitions a pending approval blocks.
   *
   * `ApprovalBody.blocksTransitions` is a boolean, and "blocks transitions"
   * without saying WHICH is not enough to build an inspector on. Two optional
   * extension fields narrow it, and both are read defensively off the raw body:
   *
   *   blockedStatusSlugs      target statuses that are refused
   *   blockedStatusCategories target CATEGORIES that are refused (HARD RULE 5)
   *
   * With neither, the default blocks resolving and closing only — see
   * `blocksThisMove()` for why that is the right conservative reading and why
   * "everything except cancelled" is not.
   */
  blockedStatusSlugs: string[];
  blockedStatusCategories: StatusCategory[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readPositiveInt(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function normalizeConditionOrNull(raw: unknown): ConditionNode | null {
  if (!isPlainObject(raw)) return null;
  const normalized = normalizeCondition(raw as ConditionNode);
  if (
    Array.isArray((normalized as { all?: unknown[] }).all) &&
    (normalized as { all: unknown[] }).all.length === 0
  ) {
    return null;
  }
  return normalized;
}

function normalizeActions(raw: unknown): RuleActionSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: RuleActionSpec[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry) || entry.disabled === true) continue;
    const type = readString(entry.type);
    if (!type) continue;
    out.push({
      type: type as RuleActionSpec['type'],
      params: isPlainObject(entry.params) ? entry.params : {},
    });
  }
  return out;
}

const APPROVER_KINDS: readonly ApproverSpec['kind'][] = [
  'user',
  'group',
  'manager_of_requester',
  'field',
];

const APPROVAL_MODES: readonly ApprovalMode[] = ['sequential', 'parallel', 'quorum'];

/**
 * Read an approval body defensively. Never throws — a body that cannot be read
 * produces an empty definition, and `validateApprovalDefinition()` is what
 * refuses to save it. A normaliser that throws turns a cosmetic body problem
 * into a dead engine.
 */
export function normalizeApprovalBody(
  slug: string,
  name: string,
  version: number,
  bodyFormatVersion: number,
  raw: unknown,
): NormalizedApprovalDefinition {
  const body = isPlainObject(raw) ? raw : {};

  const definitionReminder = readPositiveInt(body.reminderMinutes ?? body.reminder_minutes);
  const definitionCalendar = readString(body.calendarSlug ?? body.calendar_slug);
  const definitionEscalation = readString(body.escalationSlug ?? body.escalation_slug);

  const stagesRaw = Array.isArray(body.steps) ? body.steps.filter(isPlainObject) : [];
  const stages: NormalizedApprovalStage[] = stagesRaw.map((stage, position) => {
    const declaredIndex = readPositiveInt(stage.stepIndex ?? stage.step_index);
    const modeRaw = readString(stage.mode)?.toLowerCase() ?? '';
    const mode = (APPROVAL_MODES as readonly string[]).includes(modeRaw)
      ? (modeRaw as ApprovalMode)
      : 'parallel';
    const timeoutRaw = readString(stage.onTimeout ?? stage.on_timeout)?.toLowerCase() ?? '';

    const approvers: ApproverSpec[] = (Array.isArray(stage.approvers) ? stage.approvers : [])
      .filter(isPlainObject)
      .map((approver) => {
        const rawKind = readString(approver.kind)?.toLowerCase() ?? '';
        return {
          // An unrecognised kind is carried through as 'user' so nothing
          // downstream has to handle a fifth case, and `rawKind` keeps the
          // truth for the error message. It resolves to nobody either way, and
          // validation refuses to save it.
          kind: ((APPROVER_KINDS as readonly string[]).includes(rawKind)
            ? rawKind
            : 'user') as ApproverSpec['kind'],
          ref: readString(approver.ref) ?? readString(approver.slug) ?? readString(approver.username),
          rawKind,
        };
      });

    return {
      // `stepIndex` in the body is 1-based in some shipped bundles and 0-based
      // in others; array position is the only thing that is always right, so it
      // wins and the declared value (`declaredIndex`) is ignored rather than
      // trusted — a stage whose declared index disagrees with its position
      // would otherwise run out of order.
      index: position,
      label: readString(stage.label),
      labelKey: readString(stage.labelKey ?? stage.label_key),
      approvers,
      mode,
      quorum: readPositiveInt(stage.quorum),
      dueMinutes: readPositiveInt(stage.dueMinutes ?? stage.due_minutes ?? stage.timeoutMinutes),
      calendarSlug: readString(stage.calendarSlug ?? stage.calendar_slug) ?? definitionCalendar,
      onTimeout: TIMEOUT_ALIASES[timeoutRaw] ?? null,
      escalationSlug:
        readString(stage.escalationSlug ?? stage.escalation_slug) ?? definitionEscalation,
      reminderMinutes:
        readPositiveInt(stage.reminderMinutes ?? stage.reminder_minutes) ?? definitionReminder,
    };
  });

  const blockedStatusSlugs = (Array.isArray(body.blockedStatusSlugs ?? body.blocked_status_slugs)
    ? (body.blockedStatusSlugs ?? body.blocked_status_slugs)
    : []) as unknown[];
  const blockedCategories = (Array.isArray(body.blockedStatusCategories ?? body.blocked_status_categories)
    ? (body.blockedStatusCategories ?? body.blocked_status_categories)
    : []) as unknown[];

  return {
    slug,
    name,
    version,
    bodyFormatVersion,
    requiredWhen: normalizeConditionOrNull(body.requiredWhen ?? body.required_when),
    stages,
    onApproved: normalizeActions(body.onApproved ?? body.on_approved),
    onRejected: normalizeActions(body.onRejected ?? body.on_rejected),
    allowDelegate: body.allowDelegate === true || body.allow_delegate === true,
    reminderMinutes: definitionReminder,
    blocksTransitions: (body.blocksTransitions ?? body.blocks_transitions) !== false,
    blockedStatusSlugs: blockedStatusSlugs
      .map((value) => readString(value))
      .filter((value): value is string => value !== null)
      .map((value) => value.toLowerCase()),
    blockedStatusCategories: blockedCategories
      .map((value) => readString(value))
      .filter((value): value is string => value !== null)
      .map((value) => toStatusCategory(value, 'open')),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — Validation (requirement 1)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Codes are deliberately the ones `configLinter.service.ts` already declares in
 * `ConfigLintCode`, so a finding maps into a `ConfigLintFinding` with a spread
 * and no translation table.
 */
export type ApprovalFindingCode =
  | 'approval_no_approvers'
  | 'approval_no_timeout'
  | 'dangling_reference';

export interface ApprovalFinding {
  severity: 'error' | 'warning' | 'info';
  path: string;
  code: ApprovalFindingCode;
  message: string;
}

export interface ApprovalLintContext {
  /** Lowercased usernames of ACTIVE users. */
  usernames?: ReadonlySet<string>;
  /** Lowercased assignment-group slug → member count. Zero members is a defect. */
  groups?: ReadonlyMap<string, number>;
  /** Lowercased slugs of published `field` config objects. */
  fieldSlugs?: ReadonlySet<string>;
  /** Lowercased slugs of published `calendar` config objects. */
  calendars?: ReadonlySet<string>;
  /** Lowercased slugs of published `escalation` config objects. */
  escalations?: ReadonlySet<string>;
  /**
   * Whether the tenant has anybody who could answer a `manager_of_requester`
   * approver. False makes that approver unreachable rather than "resolved later".
   */
  hasManagers?: boolean;
}

/**
 * THE validation.
 *
 * Two blocking families, and they are the same two failure modes wearing
 * different hats:
 *
 *   approval_no_approvers  nobody can act. The ticket parks forever because
 *                          the question was never asked of a human.
 *   approval_no_timeout    nothing happens if nobody acts. The ticket parks
 *                          forever because the question was asked and dropped.
 *
 * `hold` is a legitimate answer to "what happens on timeout" — an explicit
 * "keep waiting, but tell somebody" — but it is still an ANSWER, and the stage
 * still has to say how long it waits before saying it. A missing duration is
 * always a defect, never a shorthand for "no deadline".
 *
 * Pure: no I/O, so it is trivially testable and reusable from the linter, from
 * the routes' save path, and from `startApproval()` at run time.
 */
export function validateApprovalDefinition(
  raw: unknown,
  ctx: ApprovalLintContext = {},
): ApprovalFinding[] {
  const out: ApprovalFinding[] = [];
  const push = (
    severity: ApprovalFinding['severity'],
    path: string,
    code: ApprovalFindingCode,
    message: string,
  ): void => { out.push({ severity, path, code, message }); };

  if (!isPlainObject(raw)) {
    push('error', '', 'approval_no_approvers', 'The approval body is not a JSON object.');
    return out;
  }

  const definition = normalizeApprovalBody('(candidate)', '(candidate)', 0, 1, raw);

  if (definition.stages.length === 0) {
    push('error', 'steps', 'approval_no_approvers',
      'An approval with no steps blocks the ticket and asks nobody. Every ticket that starts it stops there.');
    return out;
  }

  definition.stages.forEach((stage, position) => {
    const path = `steps[${position}]`;

    // ── Reachability ────────────────────────────────────────────────────
    let reachable = 0;
    stage.approvers.forEach((approver, approverIndex) => {
      const approverPath = `${path}.approvers[${approverIndex}]`;

      if (!(APPROVER_KINDS as readonly string[]).includes(approver.rawKind)) {
        push('error', approverPath, 'approval_no_approvers',
          `Unknown approver kind "${approver.rawKind}". Expected user, group, manager_of_requester or field.`);
        return;
      }

      switch (approver.kind) {
        case 'user': {
          if (!approver.ref) {
            push('error', approverPath, 'approval_no_approvers', 'An approver of kind "user" with no username.');
            return;
          }
          if (ctx.usernames && !ctx.usernames.has(approver.ref.toLowerCase())) {
            push('error', approverPath, 'dangling_reference',
              `No active user is named "${approver.ref}". Approvers are referenced by username, never by id (HARD RULE 3).`);
            return;
          }
          reachable += 1;
          return;
        }
        case 'group': {
          if (!approver.ref) {
            push('error', approverPath, 'approval_no_approvers', 'An approver of kind "group" with no group slug.');
            return;
          }
          const members = ctx.groups?.get(approver.ref.toLowerCase());
          if (ctx.groups && members === undefined) {
            push('error', approverPath, 'dangling_reference', `No assignment group has the slug "${approver.ref}".`);
            return;
          }
          if (members === 0) {
            push('error', approverPath, 'approval_no_approvers',
              `The assignment group "${approver.ref}" has no members, so this step resolves to zero approvers and the ticket parks here indefinitely.`);
            return;
          }
          reachable += 1;
          return;
        }
        case 'manager_of_requester': {
          if (ctx.hasManagers === false) {
            push('error', approverPath, 'approval_no_approvers',
              'This step asks the requester’s manager, and this tenant has nobody with the manager or admin role to ask.');
            return;
          }
          reachable += 1;
          return;
        }
        case 'field': {
          if (!approver.ref) {
            push('error', approverPath, 'approval_no_approvers', 'An approver of kind "field" with no field slug.');
            return;
          }
          if (ctx.fieldSlugs && !ctx.fieldSlugs.has(approver.ref.toLowerCase())) {
            push('error', approverPath, 'dangling_reference',
              `No field object declares "${approver.ref}", so this approver can never resolve.`);
            return;
          }
          reachable += 1;
          return;
        }
        default:
          push('error', approverPath, 'approval_no_approvers',
            'Unknown approver kind. Expected user, group, manager_of_requester or field.');
      }
    });

    if (reachable === 0) {
      push('error', `${path}.approvers`, 'approval_no_approvers',
        `Step ${position + 1} resolves to zero reachable approvers. The ticket would be blocked waiting for a decision that nobody has been asked to make.`);
    }

    // ── Quorum arithmetic ───────────────────────────────────────────────
    if (stage.mode === 'quorum') {
      if (stage.quorum === null) {
        push('error', `${path}.quorum`, 'approval_no_approvers', 'A quorum step needs a quorum of at least 1.');
      } else if (reachable > 0 && stage.quorum > reachable) {
        push('error', `${path}.quorum`, 'approval_no_approvers',
          `Step ${position + 1} needs ${stage.quorum} approvals but only ${reachable} approver${reachable === 1 ? '' : 's'} can be reached. The quorum can never be met.`);
      }
    }

    // ── Timeout ─────────────────────────────────────────────────────────
    if (stage.dueMinutes === null) {
      push('error', `${path}.dueMinutes`, 'approval_no_timeout',
        `Step ${position + 1} has no timeout. An approval nobody answers then waits forever with no reminder and no escalation — the single most common way a change request disappears.`);
    }
    if (stage.onTimeout === null) {
      push('error', `${path}.onTimeout`, 'approval_no_timeout',
        `Step ${position + 1} does not say what happens when its timeout expires. Expected approve (auto_approve), reject (auto_reject), escalate or wait (hold) — "nothing" is not one of them.`);
    }
    if (stage.onTimeout === 'escalate' && !stage.escalationSlug) {
      push('error', `${path}.escalationSlug`, 'approval_no_timeout',
        `Step ${position + 1} escalates on timeout but names no escalation ladder, so the timeout would notify nobody.`);
    }
    if (
      stage.onTimeout === 'escalate' &&
      stage.escalationSlug &&
      ctx.escalations &&
      !ctx.escalations.has(stage.escalationSlug.toLowerCase())
    ) {
      push('error', `${path}.escalationSlug`, 'dangling_reference',
        `No escalation object has the slug "${stage.escalationSlug}".`);
    }
    if (stage.calendarSlug && ctx.calendars && !ctx.calendars.has(stage.calendarSlug.toLowerCase())) {
      push('error', `${path}.calendarSlug`, 'dangling_reference',
        `No calendar object has the slug "${stage.calendarSlug}". The deadline would silently fall back to the tenant default.`);
    }
  });

  return out;
}

/** Throw unless the body may be saved. This is what "cannot be saved" means. */
export function assertApprovalDefinitionSavable(
  raw: unknown,
  ctx: ApprovalLintContext = {},
): void {
  const findings = validateApprovalDefinition(raw, ctx);
  const blocking = findings.filter((finding) => finding.severity === 'error');
  if (blocking.length > 0) {
    throw new ApprovalServiceError(
      422,
      'This approval definition cannot be saved: it would block a ticket that nobody can unblock.',
      'validation_failed',
      { issues: findings },
    );
  }
}

/**
 * Build a lint context from the database. Used by the routes' save path; the
 * config linter builds an equivalent one of its own and passes it straight in.
 */
export async function buildApprovalLintContext(
  tenantId: number,
  executor: Executor = db,
): Promise<ApprovalLintContext> {
  assertTenantId(tenantId);

  const [users, groups, fields, calendars, escalations, managerRows] = await Promise.all([
    // `users` / `user_tenants` are global tables — db() is correct for them.
    executor('users')
      .join('user_tenants', 'user_tenants.user_id', 'users.id')
      .where('user_tenants.tenant_id', tenantId)
      .where('users.is_active', true)
      .select('users.username') as Promise<Array<{ username: string }>>,
    scoped('assignment_groups', tenantId, executor)
      .where('assignment_groups.is_active', true)
      .select('assignment_groups.slug', 'assignment_groups.member_user_ids') as Promise<
        Array<{ slug: string; member_user_ids: unknown }>
      >,
    loadPublished(tenantId, 'field', executor),
    loadPublished(tenantId, 'calendar', executor),
    loadPublished(tenantId, 'escalation', executor),
    executor('user_tenants')
      .join('users', 'users.id', 'user_tenants.user_id')
      .where('user_tenants.tenant_id', tenantId)
      .whereIn('user_tenants.role', ['manager', 'admin'])
      .where('users.is_active', true)
      .limit(1)
      .select('users.id') as Promise<Array<{ id: number }>>,
  ]);

  return {
    usernames: new Set(users.map((row) => String(row.username).toLowerCase())),
    groups: new Map(
      groups.map((row) => [
        String(row.slug).toLowerCase(),
        Array.isArray(row.member_user_ids) ? row.member_user_ids.length : 0,
      ]),
    ),
    fieldSlugs: new Set([...fields.keys()]),
    calendars: new Set([...calendars.keys()]),
    escalations: new Set([...escalations.keys()]),
    hasManagers: managerRows.length > 0,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — The spec snapshot
// ═════════════════════════════════════════════════════════════════════════════

export interface ResolvedApprover {
  kind: ApproverSpec['kind'];
  /** The configured reference, verbatim, so the snapshot replays. */
  ref: string | null;
  userId: number | null;
  groupId: number | null;
  /** Display name at resolution time — what the inspector shows. */
  label: string;
}

export interface SnapshotStage {
  index: number;
  label: string | null;
  labelKey: string | null;
  mode: ApprovalMode;
  quorum: number | null;
  dueMinutes: number | null;
  calendarSlug: string | null;
  onTimeout: ApprovalTimeoutBehaviour;
  escalationSlug: string | null;
  reminderMinutes: number | null;
  approvers: ResolvedApprover[];
}

/**
 * What gets written to `approvals.spec`.
 *
 * Approvers are resolved to concrete ids ONCE, at start. A definition that is
 * republished mid-flight, a group whose membership changes, a user who is
 * deactivated — none of those may retroactively change the rules of an
 * approval already in progress, because "two of these three people" has to
 * still mean the same three people when the third one answers.
 */
export interface ApprovalSpecSnapshot {
  snapshotVersion: 1;
  definitionSlug: string;
  definitionName: string;
  definitionVersion: number;
  stages: SnapshotStage[];
  onApproved: RuleActionSpec[];
  onRejected: RuleActionSpec[];
  allowDelegate: boolean;
  blocksTransitions: boolean;
  blockedStatusSlugs: string[];
  blockedStatusCategories: StatusCategory[];
}

function emptySnapshot(): ApprovalSpecSnapshot {
  return {
    snapshotVersion: 1,
    definitionSlug: '',
    definitionName: '',
    definitionVersion: 0,
    stages: [],
    onApproved: [],
    onRejected: [],
    allowDelegate: false,
    blocksTransitions: true,
    blockedStatusSlugs: [],
    blockedStatusCategories: [],
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — Rows and mapping
// ═════════════════════════════════════════════════════════════════════════════

interface ApprovalRow {
  id: number;
  tenant_id: number;
  ticket_id: number;
  definition_slug: string;
  definition_version: number | null;
  state: ApprovalState;
  mode: ApprovalMode;
  quorum: number | null;
  due_at: Date | string | null;
  created_at: Date | string;
  decided_at: Date | string | null;
  spec: unknown;
  started_by_user_id: number | null;
  cancel_reason: string | null;
}

interface ApprovalStepRow {
  id: number;
  approval_id: number;
  tenant_id: number;
  step_index: number;
  approver_user_id: number | null;
  approver_group_id: number | null;
  state: ApprovalStepState;
  decided_at: Date | string | null;
  comment: string | null;
  due_at: Date | string | null;
  timed_out_at: Date | string | null;
  reminded_at: Date | string | null;
  notified_at: Date | string | null;
  decided_by_user_id: number | null;
  delegated_from_user_id: number | null;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return value as T;
}

function readSnapshot(row: ApprovalRow): ApprovalSpecSnapshot {
  const parsed = parseJson<Partial<ApprovalSpecSnapshot>>(row.spec, {});
  if (!Array.isArray(parsed.stages)) return emptySnapshot();
  return { ...emptySnapshot(), ...parsed, stages: parsed.stages };
}

/** Enriched approver identity for the inspector and the inbox. */
export interface ApprovalStepWithApprover extends ApprovalStep {
  approverGroupSlug?: string | null;
  approverGroupName?: string | null;
  dueAt?: string | null;
  timedOutAt?: string | null;
  decidedByUserId?: number | null;
  delegatedFromUserId?: number | null;
  /** Who a viewer would name out loud: the person, or the group. */
  approverLabel?: string;
}

export interface ApprovalWithSteps extends Approval {
  steps: ApprovalStepWithApprover[];
  definitionName?: string;
  definitionVersion?: number | null;
  /** The stage currently being asked, or null once the approval is decided. */
  activeStageIndex?: number | null;
  stageCount?: number;
}

function mapApproval(row: ApprovalRow): Approval {
  return {
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    ticketId: Number(row.ticket_id),
    definitionSlug: String(row.definition_slug),
    state: row.state,
    mode: row.mode,
    quorum: row.quorum === null || row.quorum === undefined ? null : Number(row.quorum),
    dueAt: toIso(row.due_at),
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    decidedAt: toIso(row.decided_at),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — Loading definitions
// ═════════════════════════════════════════════════════════════════════════════

function toDefinition(published: PublishedBody): NormalizedApprovalDefinition {
  return normalizeApprovalBody(
    published.slug,
    published.name,
    published.version,
    published.bodyFormatVersion,
    published.body,
  );
}

export async function loadDefinition(
  tenantId: number,
  slug: string,
  executor: Executor = db,
): Promise<NormalizedApprovalDefinition | null> {
  const published = await loadPublishedOne(tenantId, 'approval', slug, executor);
  return published ? toDefinition(published) : null;
}

export async function listDefinitions(
  tenantId: number,
  executor: Executor = db,
): Promise<NormalizedApprovalDefinition[]> {
  const published = await loadPublished(tenantId, 'approval', executor);
  return [...published.values()].map(toDefinition).sort((a, b) => a.slug.localeCompare(b.slug));
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — Approver resolution
// ═════════════════════════════════════════════════════════════════════════════

interface TicketFacts {
  id: number;
  number: string;
  subject: string;
  statusSlug: string;
  statusCategory: StatusCategory;
  prioritySlug: string;
  queueSlug: string;
  assigneeId: number | null;
  assignmentGroupId: number | null;
  requesterUserId: number | null;
  requesterContactId: number | null;
  organizationId: number | null;
  recordType: string;
  createdAt: string;
  updatedAt: string;
  occurredAt: string | null;
  data: Record<string, unknown>;
}

const TICKET_COLUMNS = [
  'tickets.id',
  'tickets.number',
  'tickets.subject',
  'tickets.status_slug',
  'tickets.status_category',
  'tickets.priority_slug',
  'tickets.queue_slug',
  'tickets.assignee_id',
  'tickets.assignment_group_id',
  'tickets.requester_user_id',
  'tickets.requester_contact_id',
  'tickets.organization_id',
  'tickets.record_type',
  'tickets.created_at',
  'tickets.updated_at',
  'tickets.occurred_at',
  'tickets.data',
];

async function loadTicketFacts(
  tenantId: number,
  ticketId: number,
  executor: Executor,
): Promise<TicketFacts | null> {
  const row = (await scoped('tickets', tenantId, executor)
    .where('tickets.id', ticketId)
    .whereNull('tickets.deleted_at')
    .first(...TICKET_COLUMNS)) as Record<string, unknown> | undefined;
  if (!row) return null;

  const asId = (value: unknown): number | null =>
    value === null || value === undefined ? null : Number(value);

  return {
    id: Number(row.id),
    number: String(row.number ?? ''),
    subject: String(row.subject ?? ''),
    statusSlug: String(row.status_slug ?? ''),
    statusCategory: toStatusCategory(row.status_category, 'open'),
    prioritySlug: String(row.priority_slug ?? ''),
    queueSlug: String(row.queue_slug ?? ''),
    assigneeId: asId(row.assignee_id),
    assignmentGroupId: asId(row.assignment_group_id),
    requesterUserId: asId(row.requester_user_id),
    requesterContactId: asId(row.requester_contact_id),
    organizationId: asId(row.organization_id),
    recordType: String(row.record_type ?? 'incident'),
    createdAt: toIso(row.created_at as Date) ?? new Date().toISOString(),
    updatedAt: toIso(row.updated_at as Date) ?? new Date().toISOString(),
    occurredAt: toIso(row.occurred_at as Date),
    data: parseJson<Record<string, unknown>>(row.data, {}),
  };
}

function conditionContextFor(ticket: TicketFacts, now: string): {
  fields: Record<string, unknown>;
  now: string;
} {
  const base: Record<string, unknown> = {
    id: ticket.id,
    number: ticket.number,
    subject: ticket.subject,
    status_slug: ticket.statusSlug,
    status_category: ticket.statusCategory,
    priority_slug: ticket.prioritySlug,
    queue_slug: ticket.queueSlug,
    assignee_id: ticket.assigneeId,
    assignment_group_id: ticket.assignmentGroupId,
    requester_user_id: ticket.requesterUserId,
    organization_id: ticket.organizationId,
    record_type: ticket.recordType,
    created_at: ticket.createdAt,
    updated_at: ticket.updatedAt,
    occurred_at: ticket.occurredAt,
  };

  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    fields[key] = value;
    fields[`ticket.${key}`] = value;
  }
  for (const [key, value] of Object.entries(ticket.data)) {
    fields[`data.${key}`] = value;
    fields[`ticket.data.${key}`] = value;
  }
  return { fields: buildConditionFields(fields), now };
}

interface DirectoryUser {
  id: number;
  username: string;
  display_name: string | null;
  email: string | null;
}

async function userByUsername(username: string, executor: Executor): Promise<DirectoryUser | null> {
  const row = (await executor('users')
    .where('username', username)
    .where('is_active', true)
    .first('id', 'username', 'display_name', 'email')) as DirectoryUser | undefined;
  return row ?? null;
}

async function usersByIds(ids: number[], executor: Executor): Promise<Map<number, DirectoryUser>> {
  const unique = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
  if (unique.length === 0) return new Map();
  const rows = (await executor('users')
    .whereIn('id', unique)
    .select('id', 'username', 'display_name', 'email')) as DirectoryUser[];
  return new Map(rows.map((row) => [Number(row.id), row]));
}

/**
 * `manager_of_requester` — see the same note in `escalation.service.ts`.
 *
 * 001/002 hold no org chart, so "the requester's manager" resolves to the
 * people this tenant has actually named as managers (`user_tenants.role IN
 * ('manager', 'admin')`), excluding the requester so nobody approves their own
 * request. It is a heuristic and it is written down as one.
 */
async function tenantManagers(
  tenantId: number,
  excludeUserId: number | null,
  executor: Executor,
): Promise<number[]> {
  const rows = (await executor('user_tenants')
    .join('users', 'users.id', 'user_tenants.user_id')
    .where('user_tenants.tenant_id', tenantId)
    .whereIn('user_tenants.role', ['manager', 'admin'])
    .where('users.is_active', true)
    .orderByRaw("CASE WHEN user_tenants.role = 'manager' THEN 0 ELSE 1 END")
    .select('users.id')) as Array<{ id: number }>;
  return rows
    .map((row) => Number(row.id))
    .filter((id) => id !== excludeUserId);
}

async function resolveApprovers(
  tenantId: number,
  ticket: TicketFacts,
  stage: NormalizedApprovalStage,
  executor: Executor,
): Promise<ResolvedApprover[]> {
  const out: ResolvedApprover[] = [];
  const seen = new Set<string>();
  const push = (approver: ResolvedApprover): void => {
    const key = approver.userId !== null ? `u:${approver.userId}` : `g:${approver.groupId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(approver);
  };

  const pendingUserIds: Array<{ id: number; kind: ApproverSpec['kind']; ref: string | null }> = [];

  for (const approver of stage.approvers) {
    // An unrecognised kind was coerced to 'user' by the normaliser so the rest
    // of the engine has four cases and not five. It must not resolve to
    // anybody: validation refuses to save it, and a definition that predates
    // the validation should reach zero approvers loudly (see the empty-stage
    // refusal in `startApproval`) rather than silently ask the wrong person.
    if (!(APPROVER_KINDS as readonly string[]).includes(approver.rawKind)) continue;

    switch (approver.kind) {
      case 'user': {
        if (!approver.ref) break;
        const row = await userByUsername(approver.ref, executor);
        if (row) {
          push({
            kind: 'user',
            ref: approver.ref,
            userId: Number(row.id),
            groupId: null,
            label: row.display_name ?? String(row.username),
          });
        }
        break;
      }
      case 'group': {
        if (!approver.ref) break;
        const group = (await scoped('assignment_groups', tenantId, executor)
          .where('assignment_groups.slug', approver.ref)
          .where('assignment_groups.is_active', true)
          .first(
            'assignment_groups.id',
            'assignment_groups.slug',
            'assignment_groups.name',
            'assignment_groups.member_user_ids',
          )) as
          | { id: number; slug: string; name: string; member_user_ids: unknown }
          | undefined;
        if (!group) break;
        const members = Array.isArray(group.member_user_ids) ? group.member_user_ids : [];
        if (members.length === 0) break; // an empty group is not an approver
        // ONE row for the group, not one per member: any member may answer, and
        // a row per member would make a two-person group into a two-approval
        // requirement in `parallel` mode.
        push({
          kind: 'group',
          ref: String(group.slug),
          userId: null,
          groupId: Number(group.id),
          label: String(group.name),
        });
        break;
      }
      case 'manager_of_requester': {
        const managers = await tenantManagers(tenantId, ticket.requesterUserId, executor);
        for (const managerId of managers) {
          pendingUserIds.push({ id: managerId, kind: 'manager_of_requester', ref: approver.ref });
        }
        break;
      }
      case 'field': {
        if (!approver.ref) break;
        // The field holds a username or a numeric user id; both spellings occur
        // in the wild, so both resolve.
        const raw = ticket.data[approver.ref];
        if (typeof raw === 'string') {
          const row = await userByUsername(raw, executor);
          if (row) {
            push({
              kind: 'field',
              ref: approver.ref,
              userId: Number(row.id),
              groupId: null,
              label: row.display_name ?? String(row.username),
            });
          }
        } else if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) {
          pendingUserIds.push({ id: raw, kind: 'field', ref: approver.ref });
        }
        break;
      }
      default:
        break;
    }
  }

  const directory = await usersByIds(pendingUserIds.map((entry) => entry.id), executor);
  for (const entry of pendingUserIds) {
    const row = directory.get(entry.id);
    if (!row) continue;
    push({
      kind: entry.kind,
      ref: entry.ref,
      userId: Number(row.id),
      groupId: null,
      label: row.display_name ?? String(row.username),
    });
  }

  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 8 — Aggregate state (requirement 3)
// ═════════════════════════════════════════════════════════════════════════════

export interface StageOutcome {
  index: number;
  state: 'pending' | 'approved' | 'rejected';
  approved: number;
  rejected: number;
  /** Approvals needed to carry the stage. */
  required: number;
  /** Approvers in the snapshot for this stage. */
  total: number;
  materialized: number;
}

export interface AggregateOutcome {
  state: ApprovalState;
  activeStageIndex: number | null;
  stages: StageOutcome[];
}

/**
 * Derive the approval's state from its step rows.
 *
 * PURE. `approvals.state` is a projection of this and nothing else — there is
 * exactly one writer, `advance()`, and it always writes what this returns. Two
 * independent notions of "did this pass?" is how an approved change request
 * shows as pending on the board it is being reported from.
 *
 * A stage carries when:
 *   quorum      `approved >= quorum`
 *   otherwise   every approver in the SNAPSHOT approved (not every row created
 *               so far — a sequential stage materialises one row at a time, and
 *               counting only materialised rows would pass the stage the moment
 *               the first person said yes)
 *
 * A stage fails when the remaining undecided approvers can no longer reach the
 * requirement. For `parallel` and `sequential` that is one rejection; for
 * `quorum` it is `rejected > total - required`.
 */
export function computeAggregate(
  snapshot: ApprovalSpecSnapshot,
  steps: readonly ApprovalStepRow[],
): AggregateOutcome {
  const stages: StageOutcome[] = [];

  if (snapshot.stages.length === 0) {
    return { state: 'pending', activeStageIndex: null, stages };
  }

  let state: ApprovalState = 'approved';
  let activeStageIndex: number | null = null;

  for (const stage of snapshot.stages) {
    const rows = steps.filter((step) => Number(step.step_index) === stage.index);
    const live = rows.filter((step) => step.state !== 'cancelled' && step.state !== 'skipped');

    const approved = live.filter((step) => step.state === 'approved').length;
    const rejected = live.filter((step) => step.state === 'rejected' || step.state === 'expired').length;
    const total = Math.max(stage.approvers.length, live.length);
    const required =
      stage.mode === 'quorum'
        ? Math.min(Math.max(stage.quorum ?? 1, 1), Math.max(total, 1))
        : total;

    let stageState: StageOutcome['state'];
    if (total === 0) {
      // A stage the snapshot resolved to nobody. It cannot be answered, so it
      // cannot carry — surfaced as pending, which is what makes it visible in
      // the inspector rather than silently skipped.
      stageState = 'pending';
    } else if (approved >= required) {
      stageState = 'approved';
    } else if (rejected > total - required) {
      stageState = 'rejected';
    } else {
      stageState = 'pending';
    }

    stages.push({
      index: stage.index,
      state: stageState,
      approved,
      rejected,
      required,
      total,
      materialized: rows.length,
    });

    if (state !== 'approved') continue; // already settled; keep describing stages

    if (stageState === 'rejected') {
      state = 'rejected';
    } else if (stageState === 'pending') {
      state = 'pending';
      activeStageIndex = stage.index;
    }
  }

  return { state, activeStageIndex, stages };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 9 — Materialising a stage
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Create the `approval_steps` rows that are askable RIGHT NOW.
 *
 * Only the active stage gets rows, and inside a `sequential` stage only the
 * next approver does. The alternative — creating every row up front — would
 * put a stage-three approver's name in the inbox on day one, and there is no
 * `waiting` value in the table's state CHECK to hide it behind. A row that
 * exists is a row somebody has been asked.
 */
async function materializeStage(
  tenantId: number,
  approvalId: number,
  ticket: TicketFacts,
  snapshot: ApprovalSpecSnapshot,
  stageIndex: number,
  existing: readonly ApprovalStepRow[],
  now: Date,
  trx: Executor,
): Promise<ApprovalStepRow[]> {
  const stage = snapshot.stages.find((entry) => entry.index === stageIndex);
  if (!stage || stage.approvers.length === 0) return [];

  const already = existing.filter((step) => Number(step.step_index) === stageIndex);
  const alreadyKeys = new Set(
    already.map((step) =>
      step.approver_user_id !== null ? `u:${step.approver_user_id}` : `g:${step.approver_group_id}`,
    ),
  );

  const wanted = stage.mode === 'sequential'
    ? stage.approvers.slice(0, already.length + 1)
    : stage.approvers;

  const toCreate = wanted.filter((approver) => {
    const key = approver.userId !== null ? `u:${approver.userId}` : `g:${approver.groupId}`;
    return !alreadyKeys.has(key) && (approver.userId !== null || approver.groupId !== null);
  });
  if (toCreate.length === 0) return [];

  const dueAt = stage.dueMinutes === null
    ? null
    : new Date(
      await addBusinessMinutesOn(tenantId, stage.calendarSlug, now, stage.dueMinutes, trx),
    );

  const inserted = (await insertScoped(
    'approval_steps',
    tenantId,
    toCreate.map((approver) => ({
      approval_id: approvalId,
      step_index: stageIndex,
      approver_user_id: approver.userId,
      approver_group_id: approver.groupId,
      state: 'pending',
      due_at: dueAt,
      notified_at: now,
    })),
    trx,
  ).returning('*')) as unknown as ApprovalStepRow[];

  await notifyApprovers(tenantId, approvalId, ticket, snapshot, stage, inserted, trx);
  return inserted;
}

async function notifyApprovers(
  tenantId: number,
  approvalId: number,
  ticket: TicketFacts,
  snapshot: ApprovalSpecSnapshot,
  stage: SnapshotStage,
  rows: readonly ApprovalStepRow[],
  trx: Executor,
  reminder = false,
): Promise<void> {
  if (rows.length === 0) return;

  const now = new Date().toISOString();
  const stageLabel = stage.label ?? `Étape ${stage.index + 1}`;
  const dueAt = toIso(rows[0]?.due_at ?? null);

  const userIds = await approverUserIds(tenantId, rows, trx);

  const title = reminder
    ? `Rappel : approbation en attente — ${ticket.number}`
    : `Approbation demandée — ${ticket.number}`;
  const body = [
    `**${ticket.subject}**`,
    '',
    `${stageLabel} de « ${snapshot.definitionName || snapshot.definitionSlug} ».`,
    dueAt ? `Échéance : ${dueAt}.` : 'Aucune échéance déclarée.',
  ].join('\n');

  emitToTicket(ticket.id, SOCKET_EVENTS.approvalRequested, {
    tenantId,
    at: now,
    approvalId,
    ticketId: ticket.id,
    number: ticket.number,
    stepIndex: stage.index,
    approverUserIds: userIds,
    dueAt,
  });
  for (const userId of userIds) {
    emitToUser(userId, SOCKET_EVENTS.approvalRequested, {
      tenantId,
      at: now,
      approvalId,
      ticketId: ticket.id,
      number: ticket.number,
      stepIndex: stage.index,
      approverUserIds: userIds,
      dueAt,
    });
  }

  // Outbound channels are best-effort: a misconfigured mailbox must never roll
  // back the approval it was announcing, because the rollback would un-ask a
  // question the socket frame has already delivered.
  try {
    await notificationService.dispatch({
      tenantId,
      event: reminder ? 'approval.reminder' : 'approval.requested',
      ticketId: ticket.id,
      trx,
      fields: buildConditionFields({
        'ticket.queue_slug': ticket.queueSlug,
        'ticket.priority_slug': ticket.prioritySlug,
        'ticket.status_category': ticket.statusCategory,
        'approval.definition_slug': snapshot.definitionSlug,
        'approval.step_index': stage.index,
      }),
      payload: {
        event: reminder ? 'approval.reminder' : 'approval.requested',
        title,
        body,
        severity: reminder ? 'warning' : 'info',
        url: `/tickets/${ticket.id}`,
        locale: DEFAULT_LOCALE,
        approval: {
          id: approvalId,
          definitionSlug: snapshot.definitionSlug,
          state: 'pending',
          dueAt,
        },
      },
    });
  } catch (error) {
    logger.warn(
      { err: error, tenantId, approvalId },
      'approval: notification dispatch failed — the approval itself is still pending',
    );
  }
}

/** Everyone who may answer these rows: the named users plus every group member. */
async function approverUserIds(
  tenantId: number,
  rows: readonly ApprovalStepRow[],
  executor: Executor,
): Promise<number[]> {
  const direct = rows
    .map((row) => row.approver_user_id)
    .filter((id): id is number => id !== null && id !== undefined);

  const groupIds = rows
    .map((row) => row.approver_group_id)
    .filter((id): id is number => id !== null && id !== undefined);

  if (groupIds.length === 0) return [...new Set(direct)];

  const groups = (await scoped('assignment_groups', tenantId, executor)
    .whereIn('assignment_groups.id', groupIds)
    .select('assignment_groups.member_user_ids')) as Array<{ member_user_ids: unknown }>;

  const members = groups.flatMap((group) =>
    Array.isArray(group.member_user_ids) ? group.member_user_ids.map((value) => Number(value)) : [],
  );

  return [...new Set([...direct, ...members])].filter((id) => Number.isInteger(id) && id > 0);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 10 — advance(): the single writer of `approvals.state`
// ═════════════════════════════════════════════════════════════════════════════

async function loadSteps(
  tenantId: number,
  approvalId: number,
  executor: Executor,
): Promise<ApprovalStepRow[]> {
  return (await scoped('approval_steps', tenantId, executor)
    .where('approval_steps.approval_id', approvalId)
    .orderBy('approval_steps.step_index', 'asc')
    .orderBy('approval_steps.id', 'asc')
    .select('*')) as unknown as ApprovalStepRow[];
}

/**
 * Recompute, materialise what is now askable, and project the result onto the
 * `approvals` row. Returns the outcome so the caller can log it.
 */
async function advance(
  tenantId: number,
  approval: ApprovalRow,
  ticket: TicketFacts,
  now: Date,
  trx: Executor,
): Promise<AggregateOutcome> {
  const snapshot = readSnapshot(approval);
  let steps = await loadSteps(tenantId, Number(approval.id), trx);
  let outcome = computeAggregate(snapshot, steps);

  // Materialise forward. A stage can carry and the next one open in the same
  // pass (a one-approver stage answered by a timeout, say), so this loops —
  // bounded by the stage count, which is finite by construction.
  for (let guard = 0; guard <= snapshot.stages.length; guard += 1) {
    if (outcome.state !== 'pending' || outcome.activeStageIndex === null) break;
    const created = await materializeStage(
      tenantId,
      Number(approval.id),
      ticket,
      snapshot,
      outcome.activeStageIndex,
      steps,
      now,
      trx,
    );
    if (created.length === 0) break;
    steps = await loadSteps(tenantId, Number(approval.id), trx);
    outcome = computeAggregate(snapshot, steps);
  }

  /**
   * `approvals.mode` / `approvals.quorum` describe the ORCHESTRATION and are
   * derived from the SNAPSHOT, never from whichever stage happens to be active.
   *
   * Deriving them from the active stage was a live bug waiting to happen: a
   * settled single-stage quorum approval has no active stage, so `mode` would
   * have kept the value `'quorum'` while `quorum` went NULL — and
   * `approvals_quorum_ck` (`mode <> 'quorum' OR quorum IS NOT NULL`) would have
   * refused the very UPDATE that recorded the approval as approved.
   */
  const orchestrationMode: ApprovalMode =
    snapshot.stages.length > 1 ? 'sequential' : snapshot.stages[0]?.mode ?? approval.mode;
  const orchestrationQuorum =
    orchestrationMode === 'quorum' ? Math.max(snapshot.stages[0]?.quorum ?? 1, 1) : null;

  const pendingDueDates = steps
    .filter((step) => step.state === 'pending' && step.due_at !== null)
    .map((step) => new Date(step.due_at as string).getTime())
    .filter((value) => Number.isFinite(value));

  const settled = outcome.state === 'approved' || outcome.state === 'rejected';

  await scoped('approvals', tenantId, trx)
    .where('approvals.id', Number(approval.id))
    .update({
      state: outcome.state,
      mode: orchestrationMode,
      quorum: orchestrationQuorum,
      due_at: pendingDueDates.length > 0 ? new Date(Math.min(...pendingDueDates)) : null,
      decided_at: settled ? (approval.decided_at ? approval.decided_at : now) : null,
    });

  // Once the approval settles, nothing else may be asked of the people still
  // holding a pending row — cancel them so they leave every inbox at once.
  if (settled) {
    await scoped('approval_steps', tenantId, trx)
      .where('approval_steps.approval_id', Number(approval.id))
      .where('approval_steps.state', 'pending')
      .update({ state: 'cancelled', decided_at: now, due_at: null });
  }

  return outcome;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 11 — Starting an approval
// ═════════════════════════════════════════════════════════════════════════════

export interface StartApprovalInput {
  tenantId: number;
  ticketId: number;
  /** The definition, by SLUG (HARD RULE 3). */
  definitionSlug: string;
  actorId?: number | null;
  actorType?: string;
  correlationId?: string;
  /** Skip the definition's `requiredWhen`. For a manual "request approval". */
  force?: boolean;
  trx?: Executor;
}

export interface StartApprovalResult {
  started: boolean;
  approval: ApprovalWithSteps | null;
  reason:
    | 'started'
    | 'already_pending'
    | 'definition_missing'
    | 'not_required'
    | 'ticket_missing'
    | 'ticket_terminal';
}

/**
 * Start an approval on a ticket.
 *
 * Refuses loudly rather than parking silently. A definition whose first stage
 * resolves to nobody is NOT started as a pending-forever approval; it throws,
 * naming the definition and the stage, because a ticket that is blocked by an
 * approval nobody was asked to make is the failure this whole module exists to
 * prevent, and it is far better surfaced at the transition that caused it than
 * discovered three weeks later.
 */
export async function startApproval(input: StartApprovalInput): Promise<StartApprovalResult> {
  const { tenantId, ticketId } = input;
  assertTenantId(tenantId);

  const run = async (trx: Executor): Promise<StartApprovalResult> =>
    withDecision<StartApprovalResult>(
      {
        tenantId,
        ticketId,
        subsystem: 'approval',
        ruleSlug: input.definitionSlug,
        actorId: input.actorId ?? null,
        actorType: input.actorType ?? (input.actorId ? 'user' : 'system'),
        correlationId: input.correlationId,
        trx,
      },
      async (recorder) => {
        recorder.input({ definitionSlug: input.definitionSlug, force: input.force === true });

        const definition = await loadDefinition(tenantId, input.definitionSlug, trx);
        if (!definition) {
          recorder
            .decide(`approval "${input.definitionSlug}" not started — no published definition with that slug`)
            .noop('definition_missing');
          return { started: false, approval: null, reason: 'definition_missing' };
        }
        recorder.rule(definition.slug, definition.version);

        const ticket = await loadTicketFacts(tenantId, ticketId, trx);
        if (!ticket) {
          recorder.decide(`approval "${definition.slug}" not started — ticket ${ticketId} is gone`).noop('ticket_missing');
          return { started: false, approval: null, reason: 'ticket_missing' };
        }
        if (isTerminal(ticket.statusCategory)) {
          recorder
            .decide(`approval "${definition.slug}" not started — ${ticket.number} is already ${ticket.statusCategory}`)
            .noop('ticket_terminal');
          return { started: false, approval: null, reason: 'ticket_terminal' };
        }

        if (!input.force && definition.requiredWhen) {
          const evaluation = evaluateCondition(definition.requiredWhen, conditionContextFor(ticket, new Date().toISOString()));
          recorder.evaluation(evaluation);
          if (!evaluation.matched) {
            recorder
              .decide(
                `approval "${definition.slug}" not required on ${ticket.number} — ${describeCondition(definition.requiredWhen)} is false`,
              )
              .noop('not_required');
            return { started: false, approval: null, reason: 'not_required' };
          }
        }

        // One live approval per (ticket, definition). Starting a second while
        // the first is pending would make "is this ticket approved?" ambiguous.
        const existing = (await scoped('approvals', tenantId, trx)
          .where('approvals.ticket_id', ticketId)
          .where('approvals.definition_slug', definition.slug)
          .where('approvals.state', 'pending')
          .first('approvals.id')) as { id: number } | undefined;
        if (existing) {
          recorder
            .decide(`approval "${definition.slug}" already pending on ${ticket.number} — not started twice`)
            .outcome({ result: 'idempotent', approvalId: Number(existing.id) });
          return {
            started: false,
            approval: await getApproval(tenantId, Number(existing.id), trx),
            reason: 'already_pending',
          };
        }

        // ── Resolve every stage ONCE, and snapshot it ────────────────────
        const stages: SnapshotStage[] = [];
        for (const stage of definition.stages) {
          const approvers = await resolveApprovers(tenantId, ticket, stage, trx);
          stages.push({
            index: stage.index,
            label: stage.label,
            labelKey: stage.labelKey,
            mode: stage.mode,
            quorum: stage.quorum,
            dueMinutes: stage.dueMinutes,
            calendarSlug: stage.calendarSlug,
            // A definition that reached this point without a timeout was saved
            // before the validation existed (or imported from a bundle). Hold
            // is the conservative reading — it blocks and reminds rather than
            // approving something nobody looked at.
            onTimeout: stage.onTimeout ?? 'hold',
            escalationSlug: stage.escalationSlug,
            reminderMinutes: stage.reminderMinutes,
            approvers,
          });
        }

        if (stages.length === 0) {
          recorder
            .decide(`approval "${definition.slug}" REFUSED on ${ticket.number} — the definition has no steps`)
            .outcome({ result: 'refused', reason: 'no_stages' });
          throw new ApprovalServiceError(
            422,
            `L’approbation « ${definition.name || definition.slug} » ne comporte aucune étape : ` +
              'elle bloquerait le ticket sans rien demander à personne.',
            'validation_failed',
            { definitionSlug: definition.slug },
          );
        }

        const emptyStage = stages.find((stage) => stage.approvers.length === 0);
        if (emptyStage) {
          recorder
            .decide(
              `approval "${definition.slug}" REFUSED on ${ticket.number} — stage ${emptyStage.index + 1} resolves to zero approvers`,
            )
            .outcome({ result: 'refused', stageIndex: emptyStage.index });
          throw new ApprovalServiceError(
            422,
            `L’approbation « ${definition.name || definition.slug} » ne peut pas démarrer : ` +
              `l’étape ${emptyStage.index + 1} ne désigne aucun approbateur joignable. ` +
              'Corrigez la définition avant de la relancer — sinon ce ticket serait bloqué sans que personne ne puisse le débloquer.',
            'validation_failed',
            { definitionSlug: definition.slug, stageIndex: emptyStage.index },
          );
        }

        const snapshot: ApprovalSpecSnapshot = {
          snapshotVersion: 1,
          definitionSlug: definition.slug,
          definitionName: definition.name,
          definitionVersion: definition.version,
          stages,
          onApproved: definition.onApproved,
          onRejected: definition.onRejected,
          allowDelegate: definition.allowDelegate,
          blocksTransitions: definition.blocksTransitions,
          blockedStatusSlugs: definition.blockedStatusSlugs,
          blockedStatusCategories: definition.blockedStatusCategories,
        };

        const firstStage = stages[0];
        const [created] = (await insertScoped(
          'approvals',
          tenantId,
          {
            ticket_id: ticketId,
            definition_slug: definition.slug,
            definition_version: definition.version,
            state: 'pending',
            mode: stages.length > 1 ? 'sequential' : firstStage.mode,
            quorum:
              stages.length === 1 && firstStage.mode === 'quorum'
                ? Math.max(firstStage.quorum ?? 1, 1)
                : null,
            due_at: null,
            spec: JSON.stringify(snapshot),
            started_by_user_id: input.actorId ?? null,
          },
          trx,
        ).returning('*')) as unknown as ApprovalRow[];

        const now = new Date();
        const outcome = await advance(tenantId, created, ticket, now, trx);

        await journalService.append(
          {
            tenantId,
            ticketId,
            kind: 'approval',
            visibility: 'internal',
            authorId: input.actorId ?? null,
            authorType: input.actorId ? 'user' : 'automation',
            bodyMd:
              `Approbation « ${definition.name || definition.slug} » demandée — ` +
              `${stages.length} étape${stages.length === 1 ? '' : 's'}.`,
            meta: {
              approvalId: Number(created.id),
              approvalState: 'pending',
              definitionSlug: definition.slug,
              definitionVersion: definition.version,
            },
          },
          trx as Knex.Transaction,
        );

        recorder
          .decide(
            `approval "${definition.slug}" started on ${ticket.number}: ` +
              `${stages.length} stage${stages.length === 1 ? '' : 's'}, ` +
              `stage 1 is ${firstStage.mode}${firstStage.mode === 'quorum' ? ` (${firstStage.quorum} of ${firstStage.approvers.length})` : ''}, ` +
              `asking ${firstStage.approvers.map((approver) => approver.label).join(', ')}`,
          )
          .outcome({
            result: 'started',
            approvalId: Number(created.id),
            stageCount: stages.length,
            activeStageIndex: outcome.activeStageIndex,
            approvers: firstStage.approvers.map((approver) => ({
              kind: approver.kind,
              ref: approver.ref,
              userId: approver.userId,
              groupId: approver.groupId,
              label: approver.label,
            })),
          });

        return {
          started: true,
          approval: await getApproval(tenantId, Number(created.id), trx),
          reason: 'started',
        };
      },
    );

  if (input.trx) return run(input.trx);
  return db.transaction((trx) => run(trx));
}

/**
 * Start every definition whose `requiredWhen` matches this ticket.
 *
 * The seam a transition or a rule calls: it does not need to know which
 * definitions exist, only that the ticket has reached a point where approvals
 * apply. Each definition writes its own decision row, including the ones that
 * decline.
 */
export async function startRequiredApprovals(
  tenantId: number,
  ticketId: number,
  options: { actorId?: number | null; correlationId?: string; trx?: Executor } = {},
): Promise<StartApprovalResult[]> {
  const definitions = await listDefinitions(tenantId, options.trx ?? db);
  const results: StartApprovalResult[] = [];
  for (const definition of definitions) {
    if (definition.stages.length === 0) continue;
    if (!definition.requiredWhen) continue; // no condition = never automatic
    results.push(
      await startApproval({
        tenantId,
        ticketId,
        definitionSlug: definition.slug,
        actorId: options.actorId ?? null,
        correlationId: options.correlationId,
        trx: options.trx,
      }),
    );
  }
  return results;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 12 — Reads
// ═════════════════════════════════════════════════════════════════════════════

async function hydrateSteps(
  tenantId: number,
  rows: readonly ApprovalStepRow[],
  executor: Executor,
): Promise<ApprovalStepWithApprover[]> {
  const userIds = rows
    .flatMap((row) => [row.approver_user_id, row.decided_by_user_id, row.delegated_from_user_id])
    .filter((id): id is number => id !== null && id !== undefined);
  const groupIds = rows
    .map((row) => row.approver_group_id)
    .filter((id): id is number => id !== null && id !== undefined);

  const [users, groups] = await Promise.all([
    usersByIds(userIds, executor),
    groupIds.length === 0
      ? Promise.resolve([] as Array<{ id: number; slug: string; name: string }>)
      : (scoped('assignment_groups', tenantId, executor)
        .whereIn('assignment_groups.id', groupIds)
        .select('assignment_groups.id', 'assignment_groups.slug', 'assignment_groups.name') as unknown as Promise<
          Array<{ id: number; slug: string; name: string }>
        >),
  ]);
  const groupById = new Map(groups.map((group) => [Number(group.id), group]));

  return rows.map((row) => {
    const user = row.approver_user_id === null ? null : users.get(Number(row.approver_user_id)) ?? null;
    const group = row.approver_group_id === null ? null : groupById.get(Number(row.approver_group_id)) ?? null;

    return {
      id: Number(row.id),
      approvalId: Number(row.approval_id),
      tenantId: Number(row.tenant_id),
      stepIndex: Number(row.step_index),
      approverUserId: row.approver_user_id === null ? null : Number(row.approver_user_id),
      approverGroupId: row.approver_group_id === null ? null : Number(row.approver_group_id),
      state: row.state,
      decidedAt: toIso(row.decided_at),
      comment: row.comment,
      approver: user
        ? {
          id: Number(user.id),
          username: String(user.username),
          displayName: user.display_name,
          avatar: null,
        }
        : null,
      approverGroupSlug: group ? String(group.slug) : null,
      approverGroupName: group ? String(group.name) : null,
      dueAt: toIso(row.due_at),
      timedOutAt: toIso(row.timed_out_at),
      decidedByUserId: row.decided_by_user_id === null ? null : Number(row.decided_by_user_id),
      delegatedFromUserId:
        row.delegated_from_user_id === null ? null : Number(row.delegated_from_user_id),
      // THE string the transition inspector shows. Never "Forbidden".
      approverLabel: user
        ? user.display_name ?? String(user.username)
        : group
          ? String(group.name)
          : 'approbateur inconnu',
    };
  });
}

export async function getApproval(
  tenantId: number,
  approvalId: number,
  executor: Executor = db,
): Promise<ApprovalWithSteps | null> {
  assertTenantId(tenantId);
  const row = (await scoped('approvals', tenantId, executor)
    .where('approvals.id', approvalId)
    .first('approvals.*')) as ApprovalRow | undefined;
  if (!row) return null;

  const stepRows = await loadSteps(tenantId, approvalId, executor);
  const snapshot = readSnapshot(row);
  const outcome = computeAggregate(snapshot, stepRows);

  return {
    ...mapApproval(row),
    steps: await hydrateSteps(tenantId, stepRows, executor),
    definitionName: snapshot.definitionName || undefined,
    definitionVersion: row.definition_version === null ? null : Number(row.definition_version),
    activeStageIndex: outcome.activeStageIndex,
    stageCount: snapshot.stages.length,
  };
}

export async function listForTicket(
  tenantId: number,
  ticketId: number,
  options: { state?: ApprovalState; executor?: Executor } = {},
): Promise<ApprovalWithSteps[]> {
  assertTenantId(tenantId);
  const executor = options.executor ?? db;

  const qb = scoped('approvals', tenantId, executor).where('approvals.ticket_id', ticketId);
  if (options.state) qb.where('approvals.state', options.state);

  const rows = (await qb.orderBy('approvals.id', 'desc').select('approvals.*')) as ApprovalRow[];
  const out: ApprovalWithSteps[] = [];
  for (const row of rows) {
    const hydrated = await getApproval(tenantId, Number(row.id), executor);
    if (hydrated) out.push(hydrated);
  }
  return out;
}

export interface ApprovalInboxEntry {
  approvalId: number;
  stepId: number;
  stepIndex: number;
  ticketId: number;
  ticketNumber: string;
  ticketSubject: string;
  statusSlug: string;
  prioritySlug: string;
  definitionSlug: string;
  definitionName: string;
  /** Present when the row is addressed to a group the viewer belongs to. */
  viaGroupSlug: string | null;
  dueAt: string | null;
  /** Business minutes remaining, negative once overdue. Null with no deadline. */
  requestedAt: string;
}

/**
 * "What is waiting on ME."
 *
 * Includes rows addressed to a GROUP the user belongs to, because an approval
 * routed to `network-team` is waiting on every one of them and showing it to
 * none of them is how it sits for a week.
 */
export async function inbox(
  tenantId: number,
  userId: number,
  options: { page?: number; limit?: number; executor?: Executor } = {},
): Promise<{ rows: ApprovalInboxEntry[]; total: number; page: number; limit: number }> {
  assertTenantId(tenantId);
  const executor = options.executor ?? db;
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 50), 200));

  const groups = (await scoped('assignment_groups', tenantId, executor)
    .whereRaw('assignment_groups.member_user_ids @> ?::int[]', [`{${userId}}`])
    .select('assignment_groups.id', 'assignment_groups.slug')) as Array<{ id: number; slug: string }>;
  const groupIds = groups.map((group) => Number(group.id));
  const groupSlugById = new Map(groups.map((group) => [Number(group.id), String(group.slug)]));

  const build = (): Knex.QueryBuilder =>
    scoped('approval_steps', tenantId, executor)
      .join('approvals', 'approvals.id', 'approval_steps.approval_id')
      .join('tickets', 'tickets.id', 'approvals.ticket_id')
      .where('approvals.tenant_id', tenantId)
      .where('tickets.tenant_id', tenantId)
      .where('approval_steps.state', 'pending')
      .where('approvals.state', 'pending')
      .whereNull('tickets.deleted_at')
      .where((builder) => {
        builder.where('approval_steps.approver_user_id', userId);
        if (groupIds.length > 0) builder.orWhereIn('approval_steps.approver_group_id', groupIds);
      });

  const [{ count }] = (await build().count<Array<{ count: string }>>(
    'approval_steps.id as count',
  )) as unknown as Array<{ count: string }>;

  const rows = (await build()
    .orderByRaw('approval_steps.due_at ASC NULLS LAST')
    .orderBy('approval_steps.id', 'asc')
    .limit(limit)
    .offset((page - 1) * limit)
    .select(
      'approval_steps.id as step_id',
      'approval_steps.step_index',
      'approval_steps.due_at',
      'approval_steps.approver_group_id',
      'approval_steps.notified_at',
      'approvals.id as approval_id',
      'approvals.definition_slug',
      'approvals.spec',
      'approvals.created_at as approval_created_at',
      'tickets.id as ticket_id',
      'tickets.number as ticket_number',
      'tickets.subject as ticket_subject',
      'tickets.status_slug',
      'tickets.priority_slug',
    )) as Array<Record<string, unknown>>;

  return {
    rows: rows.map((row) => {
      const snapshot = parseJson<Partial<ApprovalSpecSnapshot>>(row.spec, {});
      const groupId = row.approver_group_id === null ? null : Number(row.approver_group_id);
      return {
        approvalId: Number(row.approval_id),
        stepId: Number(row.step_id),
        stepIndex: Number(row.step_index),
        ticketId: Number(row.ticket_id),
        ticketNumber: String(row.ticket_number ?? ''),
        ticketSubject: String(row.ticket_subject ?? ''),
        statusSlug: String(row.status_slug ?? ''),
        prioritySlug: String(row.priority_slug ?? ''),
        definitionSlug: String(row.definition_slug ?? ''),
        definitionName: String(snapshot.definitionName ?? row.definition_slug ?? ''),
        viaGroupSlug: groupId === null ? null : groupSlugById.get(groupId) ?? null,
        dueAt: toIso(row.due_at as Date),
        requestedAt:
          toIso(row.notified_at as Date) ??
          toIso(row.approval_created_at as Date) ??
          new Date().toISOString(),
      };
    }),
    total: Number(count) || 0,
    page,
    limit,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 13 — Transition blocking (requirement 2)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * One reason a transition is refused by a pending approval.
 *
 * Shaped like `BlockedReason` in `stateMachine.service.ts` (code / i18nKey /
 * fallback / params) so the transition inspector renders it through the same
 * path as every other block. Declared structurally rather than imported so
 * that adding an approval code does not require editing that module's closed
 * `BlockedReasonCode` union.
 *
 * HARD RULE 10: the fallback is French, and it NAMES THE APPROVER. "Forbidden"
 * is what this exists to never say.
 */
export interface ApprovalTransitionBlock {
  code: 'approval_pending';
  i18nKey: 'transition.blocked.approvalPending';
  fallback: string;
  params: {
    approvalId: number;
    definitionSlug: string;
    definitionName: string;
    stepIndex: number;
    /** Everyone the move is waiting on, by name. */
    approvers: Array<{
      stepId: number;
      userId: number | null;
      groupId: number | null;
      label: string;
    }>;
    approverNames: string;
    dueAt: string | null;
    ticketId: number;
  };
}

export interface PendingApprovalBlock {
  approval: ApprovalWithSteps;
  snapshot: ApprovalSpecSnapshot;
  pendingSteps: ApprovalStepWithApprover[];
}

/** Every pending approval on a ticket, with the steps that are blocking. */
export async function blockingApprovals(
  tenantId: number,
  ticketId: number,
  executor: Executor = db,
): Promise<PendingApprovalBlock[]> {
  assertTenantId(tenantId);
  const rows = (await scoped('approvals', tenantId, executor)
    .where('approvals.ticket_id', ticketId)
    .where('approvals.state', 'pending')
    .orderBy('approvals.id', 'asc')
    .select('approvals.*')) as ApprovalRow[];

  const out: PendingApprovalBlock[] = [];
  for (const row of rows) {
    const approval = await getApproval(tenantId, Number(row.id), executor);
    if (!approval) continue;
    out.push({
      approval,
      snapshot: readSnapshot(row),
      pendingSteps: approval.steps.filter((step) => step.state === 'pending'),
    });
  }
  return out;
}

function blocksThisMove(
  snapshot: ApprovalSpecSnapshot,
  toStatusSlug: string | null,
  toCategory: StatusCategory | null,
): boolean {
  if (!snapshot.blocksTransitions) return false;

  if (snapshot.blockedStatusSlugs.length > 0 || snapshot.blockedStatusCategories.length > 0) {
    if (toStatusSlug && snapshot.blockedStatusSlugs.includes(toStatusSlug.toLowerCase())) return true;
    if (toCategory && snapshot.blockedStatusCategories.includes(toCategory)) return true;
    return false;
  }

  /**
   * The default, when the definition says `blocksTransitions` but names no
   * transitions: block RESOLVING and CLOSING, and nothing else.
   *
   * Two rejected alternatives, and why:
   *
   *   block nothing — makes `blocksTransitions: true` a lie, and lets a change
   *     request be closed while the CAB is still looking at it. That is the
   *     failure this exists to stop.
   *
   *   block everything but `cancelled` — safe on paper and unusable in
   *     practice: an agent could not move the ticket from `new` to `open` to
   *     start work, so the approval would block the very investigation that
   *     produces the information the approver is waiting for. A control people
   *     route around is not a control.
   *
   * `cancelled` is never blocked. A ticket must always be abandonable — a stuck
   * approval that makes the ticket immortal is worse than an unapproved one.
   *
   * Anything finer — "block moving into `in_implementation`" — is a decision
   * only the definition can make, through `blockedStatusSlugs`.
   */
  return toCategory === 'resolved' || toCategory === 'closed';
}

/**
 * The transition inspector's answer.
 *
 * Empty array = this approval is not in the way. A non-empty array is what the
 * inspector renders, and each entry already carries the approver's NAME.
 */
export async function transitionBlocks(
  tenantId: number,
  ticketId: number,
  toStatusSlug: string | null,
  toCategory: StatusCategory | null,
  executor: Executor = db,
): Promise<ApprovalTransitionBlock[]> {
  const pending = await blockingApprovals(tenantId, ticketId, executor);
  const out: ApprovalTransitionBlock[] = [];

  for (const entry of pending) {
    if (!blocksThisMove(entry.snapshot, toStatusSlug, toCategory)) continue;

    const approvers = entry.pendingSteps.map((step) => ({
      stepId: step.id,
      userId: step.approverUserId,
      groupId: step.approverGroupId,
      label: step.approverLabel ?? 'approbateur inconnu',
    }));
    const approverNames = approvers.map((approver) => approver.label).join(', ') || 'personne';
    const definitionName = entry.snapshot.definitionName || entry.approval.definitionSlug;
    const dueAt = entry.approval.dueAt;

    out.push({
      code: 'approval_pending',
      i18nKey: 'transition.blocked.approvalPending',
      fallback:
        `l’approbation « ${definitionName} » attend ${approverNames}` +
        (dueAt ? ` (échéance ${dueAt})` : ''),
      params: {
        approvalId: entry.approval.id,
        definitionSlug: entry.approval.definitionSlug,
        definitionName,
        stepIndex: entry.approval.activeStageIndex ?? 0,
        approvers,
        approverNames,
        dueAt,
        ticketId,
      },
    });
  }

  return out;
}

/**
 * Throw a 409 carrying the blocks, for a caller that wants to refuse rather
 * than describe. `AppError.payload` is merged into the failure envelope, so
 * the client receives the approver names alongside the message.
 */
export async function assertTransitionAllowed(
  tenantId: number,
  ticketId: number,
  toStatusSlug: string | null,
  toCategory: StatusCategory | null,
  executor: Executor = db,
): Promise<void> {
  const blocks = await transitionBlocks(tenantId, ticketId, toStatusSlug, toCategory, executor);
  if (blocks.length === 0) return;
  throw new ApprovalServiceError(
    409,
    blocks.map((block) => block.fallback).join(' ; '),
    'transition_blocked',
    { blocks },
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 14 — Deciding (requirement 3)
// ═════════════════════════════════════════════════════════════════════════════

export interface DecideInput {
  tenantId: number;
  approvalId: number;
  /** Who is answering. A decision always has a person behind it. */
  userId: number;
  decision: 'approve' | 'reject';
  comment?: string | null;
  /** Hand the step to somebody else instead of deciding it. */
  delegateToUserId?: number | null;
  correlationId?: string;
  trx?: Executor;
}

export interface DecideResult {
  approval: ApprovalWithSteps;
  /** The step row that was written. */
  stepId: number;
  /** True when this decision settled the whole approval. */
  settled: boolean;
  state: ApprovalState;
}

/**
 * Record one decision.
 *
 * Append-only in the sense that matters: a step is decided EXACTLY ONCE and a
 * decided step is never rewritten. Re-deciding is a 409 rather than an
 * overwrite, because an approval trail whose entries can change is not a trail.
 * The aggregate is then recomputed rather than patched.
 */
export async function decide(input: DecideInput): Promise<DecideResult> {
  const { tenantId, approvalId, userId } = input;
  assertTenantId(tenantId);

  const run = async (trx: Executor): Promise<DecideResult> => {
    const approvalRow = (await scoped('approvals', tenantId, trx)
      .where('approvals.id', approvalId)
      .forUpdate()
      .first('approvals.*')) as ApprovalRow | undefined;
    if (!approvalRow) {
      throw new ApprovalServiceError(404, `Aucune approbation n° ${approvalId}.`, 'not_found');
    }
    if (approvalRow.state !== 'pending') {
      throw new ApprovalServiceError(
        409,
        `Cette approbation est déjà ${approvalRow.state} — une décision ne se réécrit pas.`,
        'conflict',
        { state: approvalRow.state },
      );
    }

    const snapshot = readSnapshot(approvalRow);
    const ticket = await loadTicketFacts(tenantId, Number(approvalRow.ticket_id), trx);
    if (!ticket) {
      throw new ApprovalServiceError(404, 'Le ticket de cette approbation n’existe plus.', 'not_found');
    }

    const steps = await loadSteps(tenantId, approvalId, trx);
    const outcome = computeAggregate(snapshot, steps);
    const activeIndex = outcome.activeStageIndex;

    // Which pending row may THIS user answer? Their own, or one addressed to a
    // group they belong to — and only in the stage that is actually being asked.
    const candidates = steps.filter(
      (step) =>
        step.state === 'pending' &&
        (activeIndex === null || Number(step.step_index) === activeIndex),
    );

    let target = candidates.find((step) => Number(step.approver_user_id) === userId) ?? null;
    let viaGroupId: number | null = null;

    if (!target) {
      const groupSteps = candidates.filter((step) => step.approver_group_id !== null);
      if (groupSteps.length > 0) {
        const myGroups = (await scoped('assignment_groups', tenantId, trx)
          .whereIn(
            'assignment_groups.id',
            groupSteps.map((step) => Number(step.approver_group_id)),
          )
          .whereRaw('assignment_groups.member_user_ids @> ?::int[]', [`{${userId}}`])
          .select('assignment_groups.id')) as Array<{ id: number }>;
        const mine = new Set(myGroups.map((group) => Number(group.id)));
        target = groupSteps.find((step) => mine.has(Number(step.approver_group_id))) ?? null;
        if (target) viaGroupId = Number(target.approver_group_id);
      }
    }

    if (!target) {
      // Deliberately specific: an approver who already answered gets a
      // different message from somebody who was never asked.
      const alreadyAnswered = steps.some(
        (step) => Number(step.decided_by_user_id) === userId || Number(step.approver_user_id) === userId,
      );
      throw new ApprovalServiceError(
        403,
        alreadyAnswered
          ? 'Vous avez déjà répondu à cette approbation.'
          : 'Cette approbation ne vous est pas adressée.',
        'forbidden',
      );
    }

    const stepId = Number(target.id);
    const now = new Date();
    const comment = (input.comment ?? '').trim() || null;

    // ── Delegation is not a decision ─────────────────────────────────────
    if (input.delegateToUserId) {
      if (!snapshot.allowDelegate) {
        throw new ApprovalServiceError(
          403,
          'Cette approbation n’autorise pas la délégation.',
          'forbidden',
        );
      }
      const delegate = (await trx('users')
        .where('id', input.delegateToUserId)
        .where('is_active', true)
        .first('id', 'username', 'display_name')) as DirectoryUser | undefined;
      if (!delegate) {
        throw new ApprovalServiceError(404, 'Le délégataire est introuvable ou inactif.', 'not_found');
      }

      return withDecision<DecideResult>(
        {
          tenantId,
          ticketId: ticket.id,
          subsystem: 'approval',
          ruleSlug: snapshot.definitionSlug,
          ruleVersion: snapshot.definitionVersion,
          actorId: userId,
          actorType: 'user',
          correlationId: input.correlationId,
          trx,
        },
        async (recorder) => {
          await scoped('approval_steps', tenantId, trx)
            .where('approval_steps.id', stepId)
            .where('approval_steps.state', 'pending')
            .update({
              approver_user_id: Number(delegate.id),
              approver_group_id: null,
              delegated_from_user_id: userId,
              notified_at: now,
              comment,
            });

          await journalService.append(
            {
              tenantId,
              ticketId: ticket.id,
              kind: 'approval',
              visibility: 'internal',
              authorId: userId,
              authorType: 'user',
              bodyMd:
                `Approbation « ${snapshot.definitionName || snapshot.definitionSlug} » déléguée à ` +
                `${delegate.display_name ?? delegate.username}.` + (comment ? `\n\n${comment}` : ''),
              meta: { approvalId, approvalState: 'pending', stepId, delegatedToUserId: Number(delegate.id) },
            },
            trx as Knex.Transaction,
          );

          recorder
            .decide(
              `approval "${snapshot.definitionSlug}" step ${Number(target.step_index) + 1} on ${ticket.number} ` +
                `delegated to ${delegate.display_name ?? delegate.username}`,
            )
            .input({ approvalId, stepId, delegateToUserId: Number(delegate.id) })
            .outcome({ result: 'delegated', approvalId, stepId });

          const hydrated = await getApproval(tenantId, approvalId, trx);
          return {
            approval: hydrated as ApprovalWithSteps,
            stepId,
            settled: false,
            state: 'pending' as ApprovalState,
          };
        },
      );
    }

    // ── The decision ─────────────────────────────────────────────────────
    return withDecision<DecideResult>(
      {
        tenantId,
        ticketId: ticket.id,
        subsystem: 'approval',
        ruleSlug: snapshot.definitionSlug,
        ruleVersion: snapshot.definitionVersion,
        actorId: userId,
        actorType: 'user',
        correlationId: input.correlationId,
        trx,
      },
      async (recorder) => {
        const nextState: ApprovalStepState = input.decision === 'approve' ? 'approved' : 'rejected';

        // Guarded by `state = 'pending'`: two tabs racing produces one write
        // and one 409, never two decisions on one row.
        const written = (await scoped('approval_steps', tenantId, trx)
          .where('approval_steps.id', stepId)
          .where('approval_steps.state', 'pending')
          .update({
            state: nextState,
            decided_at: now,
            decided_by_user_id: userId,
            comment,
            due_at: null,
          })) as unknown as number;

        if (Number(written) === 0) {
          throw new ApprovalServiceError(
            409,
            'Cette étape a déjà reçu une décision.',
            'conflict',
          );
        }

        const refreshed = (await scoped('approvals', tenantId, trx)
          .where('approvals.id', approvalId)
          .first('approvals.*')) as ApprovalRow;
        const after = await advance(tenantId, refreshed, ticket, now, trx);

        const decider = (await trx('users')
          .where('id', userId)
          .first('username', 'display_name')) as { username: string; display_name: string | null } | undefined;
        const deciderName = decider?.display_name ?? decider?.username ?? `#${userId}`;

        await journalService.append(
          {
            tenantId,
            ticketId: ticket.id,
            kind: 'approval',
            visibility: 'internal',
            authorId: userId,
            authorType: 'user',
            bodyMd:
              `Approbation « ${snapshot.definitionName || snapshot.definitionSlug} » — ` +
              `${input.decision === 'approve' ? 'approuvée' : 'rejetée'} par ${deciderName}` +
              (viaGroupId !== null ? ' (au nom de son groupe)' : '') + '.' +
              (comment ? `\n\n${comment}` : ''),
            meta: {
              approvalId,
              approvalState: after.state,
              stepId,
              decision: input.decision,
              viaGroupId,
            },
          },
          trx as Knex.Transaction,
        );

        emitToTicket(ticket.id, SOCKET_EVENTS.approvalDecided, {
          tenantId,
          at: now.toISOString(),
          approvalId,
          ticketId: ticket.id,
          state: after.state,
          decidedBy: userId,
        });

        if (after.state !== 'pending') {
          await runOutcomeActions(tenantId, ticket, snapshot, after.state, trx);
        }

        // A change latches the window it was approved FOR the moment its last
        // approval settles: approving on Tuesday for Saturday and then quietly
        // moving the window to Sunday is the oldest trick in change management,
        // and the baseline is what makes it visible afterwards.
        //
        // Lazily required for the same reason ticket.service reaches its
        // engines that way: change.service imports this module. Failure is
        // swallowed — an approval decision must stand even if the change module
        // is unavailable, and `onApprovalDecided` is documented never to throw.
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
          const changeEngine = require('./change.service') as typeof import('./change.service');
          await changeEngine.onApprovalDecided({
            tenantId,
            ticketId: Number(approvalRow.ticket_id),
            recordType: ticket.recordType,
            state: after.state,
            actor: null,
            trx: trx as Knex.Transaction,
          });
        } catch (err) {
          logger.warn(
            { err, tenantId, approvalId },
            'approval: change hook failed — the decision stands',
          );
        }

        recorder
          .decide(
            `approval "${snapshot.definitionSlug}" step ${Number(target.step_index) + 1} on ${ticket.number} ` +
              `${input.decision === 'approve' ? 'approved' : 'rejected'} by ${deciderName}` +
              (viaGroupId !== null ? ' (via group)' : '') +
              ` → approval is now ${after.state}`,
          )
          .input({
            approvalId,
            stepId,
            stepIndex: Number(target.step_index),
            decision: input.decision,
            viaGroupId,
            comment,
          })
          .outcome({
            result: after.state,
            approvalId,
            stepId,
            stages: after.stages,
            activeStageIndex: after.activeStageIndex,
          });

        const hydrated = await getApproval(tenantId, approvalId, trx);
        return {
          approval: hydrated as ApprovalWithSteps,
          stepId,
          settled: after.state !== 'pending',
          state: after.state,
        };
      },
    );
  };

  if (input.trx) return run(input.trx);
  return db.transaction((trx) => run(trx));
}

/**
 * `onApproved` / `onRejected` actions.
 *
 * Handed to the rules engine's own action catalogue through the bridge in
 * `escalation.service`, loaded by a specifier held in a variable. The
 * indirection is structural, not stylistic: `ruleActions.ts` statically imports
 * THIS module (its `request_approval` action delegates here), so a static
 * import back would close a module-initialisation cycle.
 *
 * Failures are logged, never thrown. An approval that has been approved has
 * been approved; unwinding that because a follow-up action failed would make
 * the decision disappear.
 */
async function runOutcomeActions(
  tenantId: number,
  ticket: TicketFacts,
  snapshot: ApprovalSpecSnapshot,
  state: ApprovalState,
  trx: Executor,
): Promise<void> {
  const actions = state === 'approved' ? snapshot.onApproved : snapshot.onRejected;
  if (actions.length === 0) return;

  const bridgeSpec = './escalation.service';
  try {
    const loaded = (await import(bridgeSpec)) as {
      runRuleActions?: (input: Record<string, unknown>) => Promise<unknown[]>;
    };
    if (typeof loaded.runRuleActions !== 'function') {
      logger.warn(
        { tenantId, ticketId: ticket.id, definition: snapshot.definitionSlug, state },
        'approval: no action bridge — onApproved/onRejected actions were NOT applied',
      );
      return;
    }
    const results = await loaded.runRuleActions({
      tenantId,
      ticketId: ticket.id,
      actions,
      sourceSlug: snapshot.definitionSlug,
      sourceVersion: snapshot.definitionVersion,
      trigger: `approval.${state}`,
      trx,
    });
    logger.debug(
      { tenantId, ticketId: ticket.id, definition: snapshot.definitionSlug, state, results },
      'approval: outcome actions applied',
    );
  } catch (error) {
    logger.warn(
      { err: (error as Error).message, definition: snapshot.definitionSlug, state },
      'approval: outcome actions failed — the decision itself stands',
    );
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 15 — Cancellation
// ═════════════════════════════════════════════════════════════════════════════

export async function cancelApproval(
  tenantId: number,
  approvalId: number,
  reason: string,
  options: { actorId?: number | null; trx?: Executor } = {},
): Promise<ApprovalWithSteps> {
  assertTenantId(tenantId);

  const run = async (trx: Executor): Promise<ApprovalWithSteps> => {
    const row = (await scoped('approvals', tenantId, trx)
      .where('approvals.id', approvalId)
      .forUpdate()
      .first('approvals.*')) as ApprovalRow | undefined;
    if (!row) throw new ApprovalServiceError(404, `Aucune approbation n° ${approvalId}.`, 'not_found');
    if (row.state !== 'pending') {
      throw new ApprovalServiceError(
        409,
        `Cette approbation est déjà ${row.state}.`,
        'conflict',
      );
    }

    return withDecision<ApprovalWithSteps>(
      {
        tenantId,
        ticketId: Number(row.ticket_id),
        subsystem: 'approval',
        ruleSlug: String(row.definition_slug),
        ruleVersion: row.definition_version,
        actorId: options.actorId ?? null,
        actorType: options.actorId ? 'user' : 'system',
        trx,
      },
      async (recorder) => {
        const now = new Date();
        await scoped('approvals', tenantId, trx)
          .where('approvals.id', approvalId)
          .update({ state: 'cancelled', decided_at: now, due_at: null, cancel_reason: reason });
        await scoped('approval_steps', tenantId, trx)
          .where('approval_steps.approval_id', approvalId)
          .where('approval_steps.state', 'pending')
          .update({ state: 'cancelled', decided_at: now, due_at: null });

        emitToTicket(Number(row.ticket_id), SOCKET_EVENTS.approvalDecided, {
          tenantId,
          at: now.toISOString(),
          approvalId,
          ticketId: Number(row.ticket_id),
          state: 'cancelled',
          decidedBy: options.actorId ?? null,
        });

        recorder
          .decide(`approval "${row.definition_slug}" cancelled (${reason})`)
          .outcome({ result: 'cancelled', approvalId, reason });

        return (await getApproval(tenantId, approvalId, trx)) as ApprovalWithSteps;
      },
    );
  };

  if (options.trx) return run(options.trx);
  return db.transaction((trx) => run(trx));
}

/** Cancel every pending approval on a ticket. Call it when the ticket closes. */
export async function cancelForTicket(
  tenantId: number,
  ticketId: number,
  reason = 'ticket_closed',
  options: { actorId?: number | null; trx?: Executor } = {},
): Promise<number> {
  assertTenantId(tenantId);
  const executor = options.trx ?? db;
  const rows = (await scoped('approvals', tenantId, executor)
    .where('approvals.ticket_id', ticketId)
    .where('approvals.state', 'pending')
    .select('approvals.id')) as Array<{ id: number }>;

  let cancelled = 0;
  for (const row of rows) {
    await cancelApproval(tenantId, Number(row.id), reason, options);
    cancelled += 1;
  }
  return cancelled;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 16 — Timeouts and reminders (requirement 4)
// ═════════════════════════════════════════════════════════════════════════════

export interface ApprovalSweepOptions {
  tenantId?: number;
  now?: Date;
  limit?: number;
  correlationId?: string;
}

export interface ApprovalSweepResult {
  timedOut: number;
  reminded: number;
  errors: number;
}

const TIMEOUT_ACTOR = 'timeout';

/**
 * Apply timeout behaviours and send reminders.
 *
 * Driven by `escalation.service`'s ticker (see `tick()` there), which is
 * already behind the cluster's leader lock. Every branch writes a
 * `decision_log` row whose `inputs.actor` is the string `'timeout'`, so an
 * approval that passed at 02:00 with nobody logged in explains itself.
 *
 * ── A note on the unscoped read below (HARD RULE 1) ──────────────────────────
 * `approval_steps` is a tenant table, and a bare `db(...)` against it would be
 * a defect anywhere reachable from a request. This sweep is the same worker
 * exception `outbox.service.ts` documents: it has no tenant to scope by because
 * it sweeps for every tenant, each row it acts on is re-read through
 * `scoped()` from the row's own `tenant_id` before anything is written, and no
 * user input reaches it. Given a `tenantId` it uses the scoped builder.
 */
export async function sweepApprovalTimeouts(
  options: ApprovalSweepOptions = {},
): Promise<ApprovalSweepResult> {
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(options.limit ?? 200, 1000));
  const result: ApprovalSweepResult = { timedOut: 0, reminded: 0, errors: 0 };

  const base = options.tenantId !== undefined
    ? scoped('approval_steps', options.tenantId)
    : db('approval_steps');

  const due = (await base
    .where('approval_steps.state', 'pending')
    .whereNotNull('approval_steps.due_at')
    .where('approval_steps.due_at', '<=', now)
    .whereNull('approval_steps.timed_out_at')
    .orderBy('approval_steps.due_at', 'asc')
    .limit(limit)
    .select('approval_steps.id', 'approval_steps.tenant_id', 'approval_steps.approval_id')) as Array<{
      id: number;
      tenant_id: number;
      approval_id: number;
    }>;

  for (const row of due) {
    try {
      await applyTimeout(Number(row.tenant_id), Number(row.id), now, options.correlationId);
      result.timedOut += 1;
    } catch (error) {
      result.errors += 1;
      logger.error(
        { err: error, stepId: row.id, tenantId: row.tenant_id },
        'approval: timeout behaviour failed — it will be retried on the next tick',
      );
    }
  }

  try {
    result.reminded = await sweepReminders(options);
  } catch (error) {
    result.errors += 1;
    logger.error({ err: error }, 'approval: reminder sweep failed');
  }

  return result;
}

async function applyTimeout(
  tenantId: number,
  stepId: number,
  now: Date,
  correlationId?: string,
): Promise<void> {
  await db.transaction(async (trx) => {
    const step = (await scoped('approval_steps', tenantId, trx)
      .where('approval_steps.id', stepId)
      .forUpdate()
      .first('approval_steps.*')) as ApprovalStepRow | undefined;
    // Somebody answered between the sweep listing it and this transaction —
    // the human wins, always.
    if (!step || step.state !== 'pending' || step.timed_out_at !== null) return;

    const approvalRow = (await scoped('approvals', tenantId, trx)
      .where('approvals.id', Number(step.approval_id))
      .forUpdate()
      .first('approvals.*')) as ApprovalRow | undefined;
    if (!approvalRow || approvalRow.state !== 'pending') return;

    const snapshot = readSnapshot(approvalRow);
    const stage = snapshot.stages.find((entry) => entry.index === Number(step.step_index));
    const behaviour: ApprovalTimeoutBehaviour = stage?.onTimeout ?? 'hold';

    const ticket = await loadTicketFacts(tenantId, Number(approvalRow.ticket_id), trx);
    if (!ticket) return;

    await withDecision(
      {
        tenantId,
        ticketId: ticket.id,
        subsystem: 'approval',
        ruleSlug: snapshot.definitionSlug,
        ruleVersion: snapshot.definitionVersion,
        // No actorId: nobody did this. `actorType` says who did — the clock.
        actorId: null,
        actorType: TIMEOUT_ACTOR,
        correlationId,
        trx,
      },
      async (recorder) => {
        recorder.input({
          actor: TIMEOUT_ACTOR,
          approvalId: Number(approvalRow.id),
          stepId,
          stepIndex: Number(step.step_index),
          dueAt: toIso(step.due_at),
          behaviour,
          calendarSlug: stage?.calendarSlug ?? null,
          dueMinutes: stage?.dueMinutes ?? null,
        });

        // Every branch stamps `timed_out_at` and clears `due_at`, so the
        // behaviour runs exactly once per step no matter how many ticks pass.
        const patch: Record<string, unknown> = { timed_out_at: now, due_at: null };
        let sentence: string;

        switch (behaviour) {
          case 'auto_approve':
            patch.state = 'approved';
            patch.decided_at = now;
            patch.decided_by_user_id = null;
            patch.comment = 'Approuvé automatiquement : délai dépassé.';
            sentence = 'auto-approved by TIMEOUT';
            break;
          case 'auto_reject':
            patch.state = 'rejected';
            patch.decided_at = now;
            patch.decided_by_user_id = null;
            patch.comment = 'Rejeté automatiquement : délai dépassé.';
            sentence = 'auto-rejected by TIMEOUT';
            break;
          case 'escalate':
            sentence = 'escalated by TIMEOUT (still pending)';
            break;
          default:
            sentence = 'held by TIMEOUT (still pending, no deadline left)';
            break;
        }

        await scoped('approval_steps', tenantId, trx)
          .where('approval_steps.id', stepId)
          .where('approval_steps.state', 'pending')
          .update(patch);

        if (behaviour === 'escalate' && stage?.escalationSlug) {
          // Lazy, by a specifier in a variable: `escalation.service` drives
          // THIS sweep from its ticker, so a static import here would close a
          // module-initialisation cycle. Deferring one side is the fix.
          const escalationSpec = './escalation.service';
          try {
            const loaded = (await import(escalationSpec)) as {
              arm?: (armInput: Record<string, unknown>) => Promise<unknown>;
            };
            if (typeof loaded.arm === 'function') {
              await loaded.arm({
                tenantId,
                ticketId: ticket.id,
                ladderSlug: stage.escalationSlug,
                trigger: 'no_update',
                // One arming per step, forever — the escalation engine's own
                // unique index turns a repeated sweep into a no-op.
                occurrenceKey: `approval:${approvalRow.id}:step:${stepId}`,
                anchorAt: now,
                context: {
                  approvalId: Number(approvalRow.id),
                  approvalStepId: stepId,
                  definitionSlug: snapshot.definitionSlug,
                  reason: 'approval_timeout',
                },
                actorType: TIMEOUT_ACTOR,
                correlationId,
                trx,
              });
            }
          } catch (error) {
            logger.warn(
              { err: (error as Error).message, tenantId, approvalId: approvalRow.id },
              'approval: escalate-on-timeout could not arm its ladder',
            );
          }
        }

        const refreshed = (await scoped('approvals', tenantId, trx)
          .where('approvals.id', Number(approvalRow.id))
          .first('approvals.*')) as ApprovalRow;
        const after = await advance(tenantId, refreshed, ticket, now, trx);

        await journalService.append(
          {
            tenantId,
            ticketId: ticket.id,
            kind: 'approval',
            visibility: 'internal',
            authorType: 'system',
            bodyMd:
              `Approbation « ${snapshot.definitionName || snapshot.definitionSlug} », ` +
              `étape ${Number(step.step_index) + 1} : délai dépassé — ` +
              `${behaviour === 'auto_approve'
                ? 'approuvée automatiquement'
                : behaviour === 'auto_reject'
                  ? 'rejetée automatiquement'
                  : behaviour === 'escalate'
                    ? 'escaladée'
                    : 'maintenue en attente'}.`,
            meta: {
              approvalId: Number(approvalRow.id),
              approvalState: after.state,
              stepId,
              timeoutBehaviour: behaviour,
              actor: TIMEOUT_ACTOR,
            },
          },
          trx as Knex.Transaction,
        );

        if (after.state !== 'pending') {
          emitToTicket(ticket.id, SOCKET_EVENTS.approvalDecided, {
            tenantId,
            at: now.toISOString(),
            approvalId: Number(approvalRow.id),
            ticketId: ticket.id,
            state: after.state,
            // No human decided this. NULL is the honest answer and the client
            // renders it as "the timeout".
            decidedBy: null,
          });
          await runOutcomeActions(tenantId, ticket, snapshot, after.state, trx);
        }

        recorder
          .decide(
            `approval "${snapshot.definitionSlug}" step ${Number(step.step_index) + 1} on ${ticket.number} ` +
              `${sentence} — the deadline ${toIso(step.due_at)} passed with no answer → approval is now ${after.state}`,
          )
          .outcome({
            result: behaviour,
            actor: TIMEOUT_ACTOR,
            approvalId: Number(approvalRow.id),
            stepId,
            state: after.state,
          });
      },
    );
  });
}

/**
 * Nudge approvers who have not answered.
 *
 * The cadence is BUSINESS minutes on the stage's calendar — reminding somebody
 * every four hours through a weekend is how a reminder becomes noise that gets
 * filtered, and a filtered reminder is worse than none. A cheap wall-clock
 * pre-filter narrows the set first (business time elapsed is never more than
 * wall-clock elapsed, so nothing due can be skipped), then the exact business
 * check decides.
 */
export async function sweepReminders(options: ApprovalSweepOptions = {}): Promise<number> {
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(options.limit ?? 200, 1000));

  const base = options.tenantId !== undefined
    ? scoped('approval_steps', options.tenantId)
    : db('approval_steps');

  const candidates = (await base
    .join('approvals', 'approvals.id', 'approval_steps.approval_id')
    .where('approval_steps.state', 'pending')
    .where('approvals.state', 'pending')
    .whereNull('approval_steps.timed_out_at')
    .limit(limit)
    .select(
      'approval_steps.id',
      'approval_steps.tenant_id',
      'approval_steps.approval_id',
      'approval_steps.step_index',
      'approval_steps.reminded_at',
      'approval_steps.notified_at',
      'approvals.spec',
      'approvals.ticket_id',
    )) as Array<Record<string, unknown>>;

  let reminded = 0;

  for (const row of candidates) {
    const snapshot = parseJson<Partial<ApprovalSpecSnapshot>>(row.spec, {});
    const stage = (snapshot.stages ?? []).find(
      (entry) => entry.index === Number(row.step_index),
    );
    const cadence = stage?.reminderMinutes ?? null;
    if (cadence === null || cadence <= 0) continue;

    const since = toIso(row.reminded_at as Date) ?? toIso(row.notified_at as Date);
    if (!since) continue;

    // Cheap first: wall clock can only overstate elapsed business time.
    if (now.getTime() - new Date(since).getTime() < cadence * 60_000) continue;

    const tenantId = Number(row.tenant_id);
    const elapsedMs = await businessMsBetween(tenantId, stage?.calendarSlug ?? null, since, now);
    if (elapsedMs < cadence * 60_000) continue;

    try {
      await db.transaction(async (trx) => {
        const step = (await scoped('approval_steps', tenantId, trx)
          .where('approval_steps.id', Number(row.id))
          .forUpdate()
          .first('approval_steps.*')) as ApprovalStepRow | undefined;
        if (!step || step.state !== 'pending') return;

        const ticket = await loadTicketFacts(tenantId, Number(row.ticket_id), trx);
        if (!ticket || !stage) return;

        await notifyApprovers(
          tenantId,
          Number(row.approval_id),
          ticket,
          { ...emptySnapshot(), ...snapshot, stages: snapshot.stages ?? [] },
          stage,
          [step],
          trx,
          true,
        );

        await scoped('approval_steps', tenantId, trx)
          .where('approval_steps.id', Number(row.id))
          .update({ reminded_at: now });
      });
      reminded += 1;
    } catch (error) {
      logger.warn({ err: error, stepId: row.id }, 'approval: could not send a reminder');
    }
  }

  return reminded;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 17 — The service object
// ═════════════════════════════════════════════════════════════════════════════

export const approvalService = {
  // Definitions
  loadDefinition,
  listDefinitions,
  normalizeApprovalBody,
  validateApprovalDefinition,
  assertApprovalDefinitionSavable,
  buildApprovalLintContext,

  // Lifecycle
  startApproval,
  startRequiredApprovals,
  decide,
  cancelApproval,
  cancelForTicket,

  // Reads
  getApproval,
  listForTicket,
  inbox,

  // Transition inspector
  blockingApprovals,
  transitionBlocks,
  assertTransitionAllowed,

  // Engine internals worth exposing for tests and the Why drawer
  computeAggregate,
  sweepApprovalTimeouts,
  sweepReminders,
};

export default approvalService;

// ═════════════════════════════════════════════════════════════════════════════
// Wiring still owed by files this module does not own
// ═════════════════════════════════════════════════════════════════════════════
//
// TODO(configLinter.service.ts): replace the inline `lintApproval()` with a
//   call to `validateApprovalDefinition()`, so the publish gate and the run-time
//   engine share ONE definition of "savable". The codes above are already
//   `ConfigLintCode` values, so the findings map with a spread:
//     case 'approval':
//       findings.push(...validateApprovalDefinition(body, {
//         usernames: ctx.usernames, groups: ctx.groups,
//         fieldSlugs: publishedSlugs(ctx, 'field'),
//         calendars: publishedSlugs(ctx, 'calendar'),
//         escalations: publishedSlugs(ctx, 'escalation'),
//         hasManagers: ctx.hasManagers,
//       }).map((f) => ({ ...f, kind, slug })));
//   The current inline version does NOT flag a MISSING `onTimeout` (only an
//   unrecognised one), which is the half of the timeout requirement that
//   actually bites.
//
// TODO(stateMachine.service.ts / ticket.service.ts): call `transitionBlocks()`
//   from the transition evaluator and merge the result into
//   `TransitionDecision.blocked`, and add 'approval_pending' to
//   `BlockedReasonCode`. Until then the block is enforced by calling
//   `assertTransitionAllowed()` from `ticket.service.transition()` — which is
//   correct but shows the approver's name only on the 409, not in the inspector
//   preview.
//
// TODO(ticket.service.ts): call `cancelForTicket()` when a ticket transitions
//   into a terminal category, and `startRequiredApprovals()` after a transition
//   so `requiredWhen` gets its chance.
//
// TODO(index.ts): nothing. The timeout sweep rides `escalation.service`'s
//   ticker, which is the one worker that needs starting.
