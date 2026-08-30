/**
 * changes.api.ts — the change record, its window, its conflicts, its freezes
 * and its post-implementation review.
 *
 * Five things here are not ordinary CRUD and are worth reading before editing:
 *
 *   • THERE ARE TWO ROW VERSIONS AND THEY ARE NOT INTERCHANGEABLE.
 *     `Change.rowVersion` is `changes.row_version`; the ticket header carries
 *     `tickets.row_version` under `ChangeWithRelations.ticket.rowVersion`. They
 *     are separate concurrency domains on purpose (HARD RULE 7): the scheduler
 *     rewriting a backout plan must not 409 the team lead editing the subject,
 *     and a transition must not 409 because somebody typed into the test plan.
 *     Every mutation below states which one it wants; sending the wrong one
 *     looks like it works until two people open the page.
 *
 *   • CREATION TAKES A THIN RECORD. `create()` prunes empty keys before it
 *     posts, because the one thing that kills a module like this is a form that
 *     sends `queueSlug: ""` and gets a 400 on every click. HARD RULE 12: a
 *     change is raised as a one-line idea and fleshed out over a week;
 *     completeness is demanded at the transition, by the shared evaluators, and
 *     nowhere else.
 *
 *   • A REFUSAL IS NOT AN ERROR MESSAGE. The gated routes answer 422 with
 *     `blockers`, produced by the SAME shared evaluator the client already ran
 *     to grey the button out (HARD RULE 12). `changeBlockersOf()` unwraps them
 *     so the panel lists what is missing instead of showing a stack trace.
 *
 *   • THE WINDOW MUTATION RETURNS ITS CONFLICTS SYNCHRONOUSLY. `setWindow()`
 *     answers with the change, the live conflicts and the schedule gate in one
 *     body, so the date picker can say "this collides with CHG-0042 on the core
 *     switch" while it is still open. A conflict discovered at approval time is
 *     a conflict discovered after somebody promised a customer a date.
 *
 *   • APPROVALS ARE READ THROUGH THE SHIPPED `/approvals` ROUTE, not through a
 *     change-shaped copy of it. `approval.service` already owns starting,
 *     deciding, delegating and the inbox; the CAB is a `config_objects`
 *     approval definition plus that engine. All this module adds is WHICH
 *     definition applies to WHICH change, and that answer lives on the change
 *     itself as `selectedApprovals`.
 */

import apiClient, {
  rowVersionHeader,
  toApiError,
  toQuery,
  unwrap,
  type Envelope,
} from './client';
import { configApi } from './config.api';
import { CHANGE_POLICY_DEFAULT_SLUG } from '@oblidesk/shared';
import type {
  Approval,
  ChangeApprovalSelection,
  ChangeConflictClassification,
  ChangeConflictView,
  ChangeFreezeVerdict,
  ChangeGateEvaluation,
  ChangeListQuery,
  ChangeModelBody,
  ChangeOutcome,
  ChangePolicyBody,
  ChangeRequirement,
  ChangeRisk,
  ChangeType,
  ChangeWithRelations,
  FailureLikelihood,
  ImpactLevel,
} from '@oblidesk/shared';

// ═════════════════════════════════════════════════════════════════════════════
// Page shapes
// ═════════════════════════════════════════════════════════════════════════════

export interface ChangePage {
  items: ChangeWithRelations[];
  total: number;
  page: number;
  limit: number;
}

interface ChangePageEnvelope extends Envelope<ChangeWithRelations[]> {
  total?: number;
  page?: number;
  limit?: number;
}

/** One published `change_model`, as the "new change" picker needs it. */
export interface ChangeModelSummary {
  slug: string;
  name: string;
  /** `config_objects.version` — stamped into `changes.model_version` (HARD RULE 4). */
  version: number;
  body: ChangeModelBody;
}

/** What `PUT /changes/:id/window` answers: the row, its conflicts, its gate. */
export interface ChangeWindowResult {
  change: ChangeWithRelations;
  conflicts: ChangeConflictView[];
  gate: ChangeGateEvaluation;
}

/** What `GET /changes/:id/freeze` answers. `frozen` is `isChangeFrozen`. */
export interface ChangeFreezeStatus {
  verdicts: ChangeFreezeVerdict[];
  frozen: boolean;
}

/** What `POST /changes/:id/approvals/request` answers. */
export interface RequestApprovalsResult {
  started: ChangeApprovalSelection[];
  approvals: Approval[];
}

/** The resolved policy body, with the identity a decision row would name. */
export interface ChangePolicySource {
  /** Null when no `change_policy` is published: the SHIPPED baseline decides. */
  body: ChangePolicyBody | null;
  slug: string;
  /** 0 ⇒ the baseline. Mirrors what `resolveChangePolicy` stamps. */
  version: number;
}

// ═════════════════════════════════════════════════════════════════════════════
// Requests
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A THIN change. Everything but `changeType` is optional, and everything blank
 * is dropped before the request leaves (see `prune`).
 *
 * `ticketId` binds a `changes` row onto a ticket that already carries
 * `record_type = 'change'`; without it the route raises the ticket too, from
 * `subject` and whatever routing hints are set.
 */
/**
 * The ticket half of a change, NESTED.
 *
 * The server takes exactly one of `ticketId` (attach to an existing ticket) or
 * `ticket` (open a new one), and `createChangeSchema` is `.strict()`. A flat
 * body carrying `subject` at the top level is therefore not "close enough": it
 * is a 400 naming an unknown key, on every single click. This type is shaped
 * like the wire so the compiler catches that instead of the user.
 *
 * `occurredAt` is deliberately absent and the server refuses it BY NAME: a
 * change has a planned window, not a moment it happened (HARD RULE 6).
 */
export interface ChangeTicketDraft {
  subject: string;
  descriptionMd?: string | null;
  queueSlug?: string | null;
  prioritySlug?: string | null;
  impact?: ImpactLevel;
}

export interface CreateChangeRequest {
  /** Exactly one of these two. */
  ticketId?: number;
  ticket?: ChangeTicketDraft;
  changeType?: ChangeType;
  modelSlug?: string | null;
}

export interface CreateChangeFromModelRequest {
  modelSlug: string;
  /** Exactly one of these two. */
  ticketId?: number;
  ticket?: ChangeTicketDraft;
  plannedStartAt?: string;
  plannedEndAt?: string;
}

/**
 * Inline autosave — ONE field per call, validating nothing (HARD RULE 12).
 * `baseRowVersion` is `changes.row_version`.
 */
export interface UpdateChangeRequest {
  baseRowVersion: number;
  changeType?: ChangeType;
  failureLikelihood?: FailureLikelihood | null;
  implementationMd?: string | null;
  backoutMd?: string | null;
  testMd?: string | null;
  backoutNotApplicable?: boolean;
  backoutWaiverReason?: string | null;
  major?: boolean;
  modelSlug?: string | null;
}

export interface SetChangeWindowRequest {
  baseRowVersion: number;
  plannedStartAt: string;
  plannedEndAt: string;
}

export interface OverrideChangeRiskRequest {
  baseRowVersion: number;
  risk: ChangeRisk;
  /** `changes_risk_override_ck` refuses a blank one — so does the route, 422. */
  reason: string;
}

export interface AcknowledgeConflictsRequest {
  baseRowVersion: number;
  reason: string;
  /**
   * `conflictDigest(acknowledgeableConflicts(live))` as the CLIENT computed it.
   * The server recomputes it over its own live set and answers 409 when the two
   * disagree — which is the whole point: acknowledging is "I have seen THESE
   * conflicts", not a permanent state.
   */
  digest: string;
}

export interface OverrideChangeFreezeRequest {
  baseRowVersion: number;
  reason: string;
  /** WHICH freezes are being bypassed, by slug (HARD RULE 3). */
  slugs: string[];
}

export interface RecordChangeOutcomeRequest {
  baseRowVersion: number;
  outcome: ChangeOutcome;
}

export interface CompleteChangeReviewRequest {
  baseRowVersion: number;
  pirFindingsMd: string;
  pirCausedIncident: boolean;
  /** Incidents this change caused, linked as `caused_by` in the same call. */
  incidentTicketIds?: number[];
}

export interface ChangeScheduleQuery {
  from: string;
  to: string;
  queueSlug?: string;
}

// ═════════════════════════════════════════════════════════════════════════════
// Typed failures
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The 409 body on a `changes.row_version` mismatch, already unwrapped.
 *
 * The caller MUST rebase on this row. Swallowing it is not cosmetic: the stale
 * version stays in state, so the NEXT save sends a base version that has
 * already lost, and the panel silently stops saving until a full reload.
 */
export function changeConflictOf(error: unknown): ChangeWithRelations | null {
  const payload = (error as { payload?: Record<string, unknown> })?.payload;
  const current = payload?.current as ChangeWithRelations | undefined;
  return current ?? null;
}

/**
 * The 422 body of a refused gate.
 *
 * These are the very requirements the client already computed with the shared
 * evaluator, so the two normally agree word for word. Reading them back matters
 * exactly when the server saw something the client could not: a business-hours
 * lead time it has no calendar for, a conflict raised by the sweeper thirty
 * seconds ago, a capability that changed under the session.
 */
export function changeBlockersOf(error: unknown): ChangeRequirement[] | null {
  const payload = (error as { payload?: Record<string, unknown> })?.payload;
  const blockers = payload?.blockers as ChangeRequirement[] | undefined;
  return Array.isArray(blockers) ? blockers : null;
}

// ═════════════════════════════════════════════════════════════════════════════
// Shaping helpers
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A cached conflict ROW as the shared gates want to read it.
 *
 * `ChangeConflictView` is what the cache table stores; `ChangeConflictClassification`
 * is what `evaluateChangeSchedule` and `conflictDigest` consume. Every field the
 * digest keys off — kind, counterpart, shared CIs, freeze slug and version — is
 * carried by both, so this is a projection and not an interpretation.
 * `worstCiCriticality` is the one field the row does not store: the SEVERITY it
 * produced is stored instead, and severity is what the gate reads, so re-deriving
 * a criticality here would be inventing a fact the server never sent.
 */
export function toConflictClassification(
  conflict: ChangeConflictView,
): ChangeConflictClassification {
  return {
    kind: conflict.kind,
    severity: conflict.severity,
    otherTicketId: conflict.otherTicketId,
    freezeSlug: conflict.freezeSlug,
    freezeVersion: conflict.freezeVersion,
    queueSlug: conflict.queueSlug,
    ciIds: conflict.ciIds ?? [],
    worstCiCriticality: null,
    overlapStartAt: conflict.overlapStartAt,
    overlapEndAt: conflict.overlapEndAt,
    digest: conflict.digest,
  };
}

/**
 * Drop the keys a THIN creation must not send.
 *
 * Used ONLY on creation payloads. A PATCH is the opposite case — there `null`
 * is the instruction to clear a column and pruning it would silently turn
 * "erase the backout plan" into "change nothing".
 */
function prune<T extends object>(payload: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    out[key] = value;
  }
  return out as Partial<T>;
}

// ═════════════════════════════════════════════════════════════════════════════
// API
// ═════════════════════════════════════════════════════════════════════════════

export const changesApi = {
  // ── The board ─────────────────────────────────────────────────────────────

  async list(query: ChangeListQuery = {}): Promise<ChangePage> {
    try {
      const res = await apiClient.get<ChangePageEnvelope>('/changes', {
        params: toQuery({ ...query }),
      });
      const body = res.data;
      const items = unwrap<ChangeWithRelations[]>(body) ?? [];
      return {
        items,
        total: body.total ?? items.length,
        page: body.page ?? query.page ?? 1,
        limit: body.limit ?? query.limit ?? items.length,
      };
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * The forward schedule the calendar draws.
   *
   * A separate route from `list()` and not a filter on it, because the calendar
   * asks a different question: not "the next 25 rows of a filtered board" but
   * "every change whose planned window touches this range", however many that
   * is. A paginated calendar silently hides the collision on the 26th row.
   */
  async schedule(query: ChangeScheduleQuery): Promise<ChangeWithRelations[]> {
    try {
      const res = await apiClient.get<Envelope<ChangeWithRelations[]>>('/changes/schedule', {
        params: toQuery({ ...query }),
      });
      return unwrap(res.data) ?? [];
    } catch (error) {
      throw toApiError(error);
    }
  },

  async get(ticketId: number): Promise<ChangeWithRelations> {
    try {
      const res = await apiClient.get<Envelope<ChangeWithRelations>>(`/changes/${ticketId}`);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** A THIN record. See `CreateChangeRequest` and `prune`. */
  async create(payload: CreateChangeRequest): Promise<ChangeWithRelations> {
    try {
      const res = await apiClient.post<Envelope<ChangeWithRelations>>('/changes', prune(payload));
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** Copies the model's three plans into the row and stamps slug + version. */
  async createFromModel(payload: CreateChangeFromModelRequest): Promise<ChangeWithRelations> {
    try {
      const res = await apiClient.post<Envelope<ChangeWithRelations>>(
        '/changes/from-model',
        prune(payload),
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** Published `change_model` bodies, for the picker. */
  async listModels(): Promise<ChangeModelSummary[]> {
    try {
      const res = await apiClient.get<Envelope<ChangeModelSummary[]>>('/changes/models');
      return unwrap(res.data) ?? [];
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * One field, autosaved, validating nothing (HARD RULE 12).
   * `baseRowVersion` is `changes.row_version`.
   */
  async update(ticketId: number, payload: UpdateChangeRequest): Promise<ChangeWithRelations> {
    try {
      const res = await apiClient.patch<Envelope<ChangeWithRelations>>(
        `/changes/${ticketId}`,
        payload,
        { headers: rowVersionHeader(payload.baseRowVersion) },
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  // ── The window ────────────────────────────────────────────────────────────

  /**
   * Commit to a maintenance window and learn what it collides with, in one
   * round trip. Capability `change_schedule`.
   */
  async setWindow(ticketId: number, payload: SetChangeWindowRequest): Promise<ChangeWindowResult> {
    try {
      const res = await apiClient.put<Envelope<ChangeWindowResult>>(
        `/changes/${ticketId}/window`,
        payload,
        { headers: rowVersionHeader(payload.baseRowVersion) },
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  // ── Risk ──────────────────────────────────────────────────────────────────

  /**
   * Disagree with the matrix, in writing.
   *
   * The override moves `changes.risk` and NEVER `changes.risk_computed`: what
   * the matrix said stays readable beside what the human decided, which is the
   * only way "why was this low risk?" has an answer a year later.
   */
  async overrideRisk(
    ticketId: number,
    payload: OverrideChangeRiskRequest,
  ): Promise<ChangeWithRelations> {
    try {
      const res = await apiClient.post<Envelope<ChangeWithRelations>>(
        `/changes/${ticketId}/risk/override`,
        payload,
        { headers: rowVersionHeader(payload.baseRowVersion) },
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  // ── Approvals ─────────────────────────────────────────────────────────────

  /**
   * Ask the policy's selection to start. Runs the SCHEDULE gate first — the CAB
   * reads the plans, so the plans must exist when the approval is requested, not
   * when it is answered. 422 carries `blockers`.
   */
  async requestApprovals(ticketId: number, baseRowVersion: number): Promise<RequestApprovalsResult> {
    try {
      const res = await apiClient.post<Envelope<RequestApprovalsResult>>(
        `/changes/${ticketId}/approvals/request`,
        { baseRowVersion },
        { headers: rowVersionHeader(baseRowVersion) },
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * Every approval on the change's ticket, with its step rows — who was asked,
   * who answered and who is still owed.
   *
   * This is the SHIPPED `/approvals` route, deliberately: `approval.service`
   * owns approvals for every record type, and a change-shaped copy of a read it
   * already serves is a second opinion waiting to drift.
   */
  async approvals(ticketId: number): Promise<Approval[]> {
    try {
      const res = await apiClient.get<Envelope<Approval[]>>('/approvals', {
        params: toQuery({ ticketId }),
      });
      return unwrap(res.data) ?? [];
    } catch (error) {
      throw toApiError(error);
    }
  },

  // ── Conflicts ─────────────────────────────────────────────────────────────

  /**
   * The cached conflict rows. A READ — deliberately NOT what the transition
   * gate consults, which reads the conflicts carried on the change itself so
   * the verdict and the panel can never be one refresh apart.
   */
  async conflicts(ticketId: number, includeCleared = false): Promise<ChangeConflictView[]> {
    try {
      const res = await apiClient.get<Envelope<ChangeConflictView[]>>(
        `/changes/${ticketId}/conflicts`,
        { params: toQuery({ includeCleared: includeCleared ? true : undefined }) },
      );
      return unwrap(res.data) ?? [];
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * "I have seen these conflicts, and here is why we are going anyway."
   * Capability `change_schedule`. 409 when the digest no longer matches the live
   * set — a new conflict appeared while the dialog was open.
   */
  async acknowledgeConflicts(
    ticketId: number,
    payload: AcknowledgeConflictsRequest,
  ): Promise<ChangeWithRelations> {
    try {
      const res = await apiClient.post<Envelope<ChangeWithRelations>>(
        `/changes/${ticketId}/conflicts/acknowledge`,
        payload,
        { headers: rowVersionHeader(payload.baseRowVersion) },
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  // ── Freezes ───────────────────────────────────────────────────────────────

  /** Which freezes fire on the planned window. A read: it paints the banner. */
  async freeze(ticketId: number): Promise<ChangeFreezeStatus> {
    try {
      const res = await apiClient.get<Envelope<ChangeFreezeStatus>>(`/changes/${ticketId}/freeze`);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * Bypass them. Capability `change_freeze_override`, which is in NO permission
   * preset by design. Four traces land in one transaction server-side: the
   * columns, a `decision_log` row, an `audit_log` row and a work note.
   */
  async overrideFreeze(
    ticketId: number,
    payload: OverrideChangeFreezeRequest,
  ): Promise<ChangeWithRelations> {
    try {
      const res = await apiClient.post<Envelope<ChangeWithRelations>>(
        `/changes/${ticketId}/freeze/override`,
        payload,
        { headers: rowVersionHeader(payload.baseRowVersion) },
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  // ── Implementation, outcome, review ───────────────────────────────────────

  /**
   * Explicit acts, never side effects of a transition. The pair is what makes
   * the ACTUAL window real, and the actual window is the derived `implementing`
   * state — there is no ninth status category (HARD RULE 5).
   */
  async startImplementation(ticketId: number, baseRowVersion: number): Promise<ChangeWithRelations> {
    return implementationCall(ticketId, 'start', baseRowVersion);
  },

  async finishImplementation(
    ticketId: number,
    baseRowVersion: number,
  ): Promise<ChangeWithRelations> {
    return implementationCall(ticketId, 'finish', baseRowVersion);
  },

  /** Records the outcome AND arms the review on the same code path. */
  async recordOutcome(
    ticketId: number,
    payload: RecordChangeOutcomeRequest,
  ): Promise<ChangeWithRelations> {
    try {
      const res = await apiClient.post<Envelope<ChangeWithRelations>>(
        `/changes/${ticketId}/outcome`,
        payload,
        { headers: rowVersionHeader(payload.baseRowVersion) },
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** The PIR. 422 with `blockers` when the review gate refuses "went fine". */
  async completeReview(
    ticketId: number,
    payload: CompleteChangeReviewRequest,
  ): Promise<ChangeWithRelations> {
    try {
      const res = await apiClient.post<Envelope<ChangeWithRelations>>(
        `/changes/${ticketId}/review`,
        payload,
        { headers: rowVersionHeader(payload.baseRowVersion) },
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  // ── The policy the client runs its own gates on ───────────────────────────

  /**
   * The published `change_policy` body, or null.
   *
   * The client needs it because HARD RULE 12 makes it run `resolveChangePolicy`
   * and `evaluateChangeSchedule` itself — the same functions, the same body, the
   * same answer as the server. A NULL body is not a failure and must not be
   * treated as one: `resolveChangePolicy(null, …)` resolves on the SHIPPED
   * baseline and stamps version 0, which is exactly how a tenant that has never
   * opened the configuration screen still gets risk banding and gates.
   *
   * `config_objects` reads are open to any member of the tenant, so this is not
   * an admin-only call; a 404 (nothing published) and a 403 (a hardened
   * deployment) both land on the baseline, which is the safe direction.
   */
  async policy(slug: string = CHANGE_POLICY_DEFAULT_SLUG): Promise<ChangePolicySource> {
    try {
      const object = await configApi.get('change_policy', slug);
      return { body: object.body, slug: object.slug, version: object.version };
    } catch {
      return { body: null, slug, version: 0 };
    }
  },
};

/**
 * Both implementation stamps go through one function: they differ by a path
 * segment and by nothing else, and two copies of the same four lines is two
 * places to forget the row-version header.
 */
async function implementationCall(
  ticketId: number,
  action: 'start' | 'finish',
  baseRowVersion: number,
): Promise<ChangeWithRelations> {
  try {
    const res = await apiClient.post<Envelope<ChangeWithRelations>>(
      `/changes/${ticketId}/implementation/${action}`,
      { baseRowVersion },
      { headers: rowVersionHeader(baseRowVersion) },
    );
    return unwrap(res.data);
  } catch (error) {
    throw toApiError(error);
  }
}

export default changesApi;
