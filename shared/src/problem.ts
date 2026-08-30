// ─────────────────────────────────────────────────────────────────────────────
// Problem management — vocabulary, DTOs and the evaluators BOTH sides run.
//
// HARD RULE 12 is the reason this file exists rather than living in the server.
// Every gate in this module is one function with two callers: the client calls
// it to grey out a button and list what is missing; the server calls the same
// function to refuse the request. A second implementation on the client is a
// second opinion, and a second opinion is a bug that only shows up in front of
// a customer.
//
// What is NOT here, deliberately:
//   • a `problem_status` enum. A problem's lifecycle IS `tickets.status_category`
//     (HARD RULE 5). `KnownErrorState` is an ORTHOGONAL axis answering "is there
//     a workaround the desk can apply right now?", which is why a problem can be
//     `open` and a published known error at the same time.
//   • the SQL of the six detection signals. The queries belong to the server;
//     what crosses is the READING each query produced, so the score is computed
//     by one function and the client can explain a card without re-querying.
//   • any zod schema. This package has no zod dependency and the repo keeps its
//     request schemas in `server/src/validators/*`. The literal tuples below are
//     what those schemas must mirror, so a drift is a compile error in one file
//     instead of a 23514 at runtime.
// ─────────────────────────────────────────────────────────────────────────────

import { type Capability, CAPABILITIES, hasCapability } from './capabilities';
import type { ProblemDetectionBody, ProblemDetectionSignal, ProblemSignalSpec } from './configKinds';
import { PROBLEM_EXACT_SIGNALS } from './configKinds';
import type { StatusCategory } from './statusCategories';
import { isTerminal } from './statusCategories';

// ═════════════════════════════════════════════════════════════════════════════
// Vocabulary — every tuple mirrors a CHECK constraint in migration 006
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `problems.known_error_state`. Orthogonal to `status_category`, never a
 * substitute for it.
 *
 *   none       no documented workaround
 *   candidate  an analysis is concluded, the workaround is being written
 *   published  the desk may apply it, and the intake banner offers it
 *   retired    the permanent fix shipped. Kept readable: an incident closed six
 *              months ago still references it.
 */
export const KNOWN_ERROR_STATES = ['none', 'candidate', 'published', 'retired'] as const;
export type KnownErrorState = (typeof KNOWN_ERROR_STATES)[number];

/** How dangerous the workaround is to apply. Without it, N1 applies everything blind. */
export const WORKAROUND_RISKS = ['low', 'medium', 'high'] as const;
export type WorkaroundRisk = (typeof WORKAROUND_RISKS)[number];

/** `problems.detected_by` — what makes the detector's usefulness measurable. */
export const PROBLEM_DETECTION_ORIGINS = ['manual', 'promotion', 'recurrence', 'alert'] as const;
export type ProblemDetectedBy = (typeof PROBLEM_DETECTION_ORIGINS)[number];

/**
 * What the closure cascade is allowed to do to the linked incidents, decided
 * once, visibly, on the problem itself.
 */
export const PROBLEM_CLOSURE_POLICIES = [
  /** Post an automation note on every live incident. Change nothing. */
  'notify_only',
  /** Additionally resolve the incidents no human ever worked. */
  'resolve_untouched',
  /** Additionally resolve the worked incidents where nobody is waiting. */
  'resolve_all_pending_confirmation',
] as const;
export type ProblemClosurePolicy = (typeof PROBLEM_CLOSURE_POLICIES)[number];

/**
 * Five whys is a degenerate tree, Ishikawa a depth-2 tree. One table, one
 * editor, one evaluator; `mixed` is the normal case, not the exotic one.
 */
export const RCA_METHODS = ['five_whys', 'ishikawa', 'mixed'] as const;
export type RcaMethod = (typeof RCA_METHODS)[number];

export const PROBLEM_ANALYSIS_STATES = [
  'draft',
  'in_review',
  'concluded',
  'superseded',
  'abandoned',
] as const;
export type ProblemAnalysisState = (typeof PROBLEM_ANALYSIS_STATES)[number];

/**
 * The category of a cause node. NOT NULL on EVERY node, five-whys chains
 * included: that is what makes "40% of our root causes are process causes"
 * comparable across the two methods. A category that only existed on fishbones
 * would make the statistic wrong by construction.
 *
 * The classic 6M are replaced by this set because in IT half of real root
 * causes are a supplier or an internal policy, and none of the 6M names either.
 */
export const CAUSE_CATEGORIES = [
  'people',
  'process',
  'technology',
  'environment',
  'measurement',
  'supplier',
  'policy',
  'unknown',
] as const;
export type CauseCategory = (typeof CAUSE_CATEGORIES)[number];

/**
 * `non_cause` earns its slot: "we checked the firewall, it was not the
 * firewall" is a RESULT, and a team that cannot record a ruled-out branch
 * re-investigates it next quarter.
 */
export const CAUSE_KINDS = ['cause', 'contributing', 'trigger', 'non_cause'] as const;
export type CauseKind = (typeof CAUSE_KINDS)[number];

export const CAUSE_CONFIDENCES = ['suspected', 'probable', 'confirmed', 'refuted'] as const;
export type CauseConfidence = (typeof CAUSE_CONFIDENCES)[number];

/**
 * The name of the method states the strength of the proof: `fix_verified` (we
 * fixed it and it stopped) outranks `expert_review` (someone senior agreed),
 * and a report that blends the two lies.
 */
export const CAUSE_CONFIRMATION_METHODS = [
  'evidence',
  'reproduction',
  'vendor_confirmation',
  'fix_verified',
  'expert_review',
] as const;
export type CauseConfirmationMethod = (typeof CAUSE_CONFIRMATION_METHODS)[number];

/** Which artefact a piece of evidence points at. Exactly one target per row. */
export const PROBLEM_EVIDENCE_TYPES = [
  'ticket_evidence',
  'ci',
  'alert',
  'ticket',
  'journal',
  'kb_article',
  'external',
] as const;
export type ProblemEvidenceType = (typeof PROBLEM_EVIDENCE_TYPES)[number];

export const PROBLEM_CANDIDATE_STATES = [
  'proposed',
  'accepted',
  'rejected',
  'expired',
  'merged',
] as const;
export type ProblemCandidateState = (typeof PROBLEM_CANDIDATE_STATES)[number];

/** Where an incident got its link to a problem. Written into the decision row. */
export const PROBLEM_LINK_SOURCES = ['manual', 'promotion', 'candidate', 'alert', 'rule'] as const;
export type ProblemLinkSource = (typeof PROBLEM_LINK_SOURCES)[number];

// ── Closure cascade ──────────────────────────────────────────────────────────

/**
 * One pass, four buckets, every linked incident in exactly one of them.
 *
 *   skipped_terminal        already resolved / closed / cancelled. Nothing to do.
 *   blocked_human_waiting   THE hard guard. Never resolved automatically.
 *   auto_resolved           no agent journal entry, no logged time.
 *   worked_not_waiting      a human worked it, but nobody is waiting on us.
 */
export const CASCADE_BUCKETS = [
  'skipped_terminal',
  'blocked_human_waiting',
  'auto_resolved',
  'worked_not_waiting',
] as const;
export type CascadeBucket = (typeof CASCADE_BUCKETS)[number];

/**
 * Why an incident is in `blocked_human_waiting`.
 *
 * The last two are NEVER returned by `classifyCascadeIncident`: they are not
 * properties of the incident, they are outcomes the pass discovers while acting
 * (a `row_version` moved under it, the state machine refused the move). The
 * pass assigns them, and they are members of this union so the census row and
 * the "needs a human" list speak one vocabulary.
 */
export const CASCADE_BLOCK_REASONS = [
  'no_first_response',
  'pending_requester',
  'requester_spoke_last',
  'open_approval',
  'scheduled_future',
  'concurrent_edit',
  'transition_refused',
] as const;
export type CascadeBlockReason = (typeof CASCADE_BLOCK_REASONS)[number];

/**
 * THE cascade invariant. It resolves; it never closes.
 *
 * `closed` is terminal and, in some configurations, not reopenable. `resolved`
 * stays reopenable for `LIMITS.reopenWindowDays`, the CSAT goes out, and the
 * requester can object. An automation is allowed to be wrong; it is not allowed
 * to be irreversible. Closing stays with the existing auto-close sweeper and
 * its own guards.
 */
export const CASCADE_TARGET_CATEGORY: StatusCategory = 'resolved';

/**
 * Stamped on every incident the cascade resolves, so MTTR reporting can tell
 * "we repaired it" apart from "it stopped hurting because the problem was
 * fixed". Seeded as a resolution code by the baseline config.
 */
export const CASCADE_RESOLUTION_CODE = 'resolved_by_problem';

/**
 * The `ticket_link.kind` that binds an incident to its problem. It already
 * exists in 002 and reads in the right direction: the INCIDENT is caused_by the
 * PROBLEM. Promotion never flips `record_type` in place, because the number is
 * printed in the requester's mail and the incident's SLA, CSAT and public
 * thread would be orphaned by the mutation.
 */
export const PROBLEM_LINK_KIND = 'caused_by';

/** Record types a cascade or a link may touch. A problem never cascades onto a problem. */
export const CASCADE_ELIGIBLE_RECORD_TYPES = ['incident', 'request'] as const;
export type CascadeEligibleRecordType = (typeof CASCADE_ELIGIBLE_RECORD_TYPES)[number];

// ═════════════════════════════════════════════════════════════════════════════
// Labels — HARD RULE 10: every one is a `t(key, fallback)` pair
// ═════════════════════════════════════════════════════════════════════════════

export interface ProblemLabel {
  key: string;
  /** Inline English fallback, so a missing key degrades to readable English. */
  fallback: string;
}

export const KNOWN_ERROR_STATE_LABELS: Readonly<Record<KnownErrorState, ProblemLabel>> = {
  none: { key: 'problem.knownError.none', fallback: 'Not a known error' },
  candidate: { key: 'problem.knownError.candidate', fallback: 'Known error candidate' },
  published: { key: 'problem.knownError.published', fallback: 'Published known error' },
  retired: { key: 'problem.knownError.retired', fallback: 'Retired known error' },
};

export const WORKAROUND_RISK_LABELS: Readonly<Record<WorkaroundRisk, ProblemLabel>> = {
  low: { key: 'problem.workaroundRisk.low', fallback: 'Low risk' },
  medium: { key: 'problem.workaroundRisk.medium', fallback: 'Medium risk' },
  high: { key: 'problem.workaroundRisk.high', fallback: 'High risk' },
};

export const PROBLEM_DETECTED_BY_LABELS: Readonly<Record<ProblemDetectedBy, ProblemLabel>> = {
  manual: { key: 'problem.detectedBy.manual', fallback: 'Raised by hand' },
  promotion: { key: 'problem.detectedBy.promotion', fallback: 'Promoted from an incident' },
  recurrence: { key: 'problem.detectedBy.recurrence', fallback: 'Found by the recurrence detector' },
  alert: { key: 'problem.detectedBy.alert', fallback: 'Raised from a suite alert' },
};

export const PROBLEM_CLOSURE_POLICY_LABELS: Readonly<Record<ProblemClosurePolicy, ProblemLabel>> = {
  notify_only: { key: 'problem.closurePolicy.notifyOnly', fallback: 'Notify only, resolve nothing' },
  resolve_untouched: {
    key: 'problem.closurePolicy.resolveUntouched',
    fallback: 'Resolve the incidents nobody worked',
  },
  resolve_all_pending_confirmation: {
    key: 'problem.closurePolicy.resolveAllPendingConfirmation',
    fallback: 'Resolve every incident where nobody is waiting on us',
  },
};

export const RCA_METHOD_LABELS: Readonly<Record<RcaMethod, ProblemLabel>> = {
  five_whys: { key: 'problem.rcaMethod.fiveWhys', fallback: 'Five whys' },
  ishikawa: { key: 'problem.rcaMethod.ishikawa', fallback: 'Ishikawa' },
  mixed: { key: 'problem.rcaMethod.mixed', fallback: 'Mixed' },
};

export const PROBLEM_ANALYSIS_STATE_LABELS: Readonly<Record<ProblemAnalysisState, ProblemLabel>> = {
  draft: { key: 'problem.analysisState.draft', fallback: 'Draft' },
  in_review: { key: 'problem.analysisState.inReview', fallback: 'In review' },
  concluded: { key: 'problem.analysisState.concluded', fallback: 'Concluded' },
  superseded: { key: 'problem.analysisState.superseded', fallback: 'Superseded' },
  abandoned: { key: 'problem.analysisState.abandoned', fallback: 'Abandoned' },
};

export const CAUSE_CATEGORY_LABELS: Readonly<Record<CauseCategory, ProblemLabel>> = {
  people: { key: 'problem.causeCategory.people', fallback: 'People' },
  process: { key: 'problem.causeCategory.process', fallback: 'Process' },
  technology: { key: 'problem.causeCategory.technology', fallback: 'Technology' },
  environment: { key: 'problem.causeCategory.environment', fallback: 'Environment' },
  measurement: { key: 'problem.causeCategory.measurement', fallback: 'Measurement' },
  supplier: { key: 'problem.causeCategory.supplier', fallback: 'Supplier' },
  policy: { key: 'problem.causeCategory.policy', fallback: 'Policy' },
  unknown: { key: 'problem.causeCategory.unknown', fallback: 'Not categorised' },
};

export const CAUSE_KIND_LABELS: Readonly<Record<CauseKind, ProblemLabel>> = {
  cause: { key: 'problem.causeKind.cause', fallback: 'Cause' },
  contributing: { key: 'problem.causeKind.contributing', fallback: 'Contributing factor' },
  trigger: { key: 'problem.causeKind.trigger', fallback: 'Trigger' },
  non_cause: { key: 'problem.causeKind.nonCause', fallback: 'Ruled out' },
};

export const CAUSE_CONFIDENCE_LABELS: Readonly<Record<CauseConfidence, ProblemLabel>> = {
  suspected: { key: 'problem.causeConfidence.suspected', fallback: 'Suspected' },
  probable: { key: 'problem.causeConfidence.probable', fallback: 'Probable' },
  confirmed: { key: 'problem.causeConfidence.confirmed', fallback: 'Confirmed' },
  refuted: { key: 'problem.causeConfidence.refuted', fallback: 'Refuted' },
};

export const CAUSE_CONFIRMATION_METHOD_LABELS: Readonly<
  Record<CauseConfirmationMethod, ProblemLabel>
> = {
  evidence: { key: 'problem.confirmationMethod.evidence', fallback: 'Evidence on file' },
  reproduction: { key: 'problem.confirmationMethod.reproduction', fallback: 'Reproduced' },
  vendor_confirmation: {
    key: 'problem.confirmationMethod.vendorConfirmation',
    fallback: 'Confirmed by the vendor',
  },
  fix_verified: { key: 'problem.confirmationMethod.fixVerified', fallback: 'Fix verified' },
  expert_review: { key: 'problem.confirmationMethod.expertReview', fallback: 'Expert review' },
};

export const PROBLEM_CANDIDATE_STATE_LABELS: Readonly<
  Record<ProblemCandidateState, ProblemLabel>
> = {
  proposed: { key: 'problem.candidateState.proposed', fallback: 'Proposed' },
  accepted: { key: 'problem.candidateState.accepted', fallback: 'Accepted' },
  rejected: { key: 'problem.candidateState.rejected', fallback: 'Rejected' },
  expired: { key: 'problem.candidateState.expired', fallback: 'Expired' },
  merged: { key: 'problem.candidateState.merged', fallback: 'Merged' },
};

export const CASCADE_BUCKET_LABELS: Readonly<Record<CascadeBucket, ProblemLabel>> = {
  skipped_terminal: { key: 'problem.cascadeBucket.skippedTerminal', fallback: 'Already closed' },
  blocked_human_waiting: {
    key: 'problem.cascadeBucket.blockedHumanWaiting',
    fallback: 'Needs a human',
  },
  auto_resolved: { key: 'problem.cascadeBucket.autoResolved', fallback: 'Nobody worked it' },
  worked_not_waiting: {
    key: 'problem.cascadeBucket.workedNotWaiting',
    fallback: 'Worked, nobody waiting',
  },
};

export const CASCADE_BLOCK_REASON_LABELS: Readonly<Record<CascadeBlockReason, ProblemLabel>> = {
  no_first_response: {
    key: 'problem.cascadeBlocked.noFirstResponse',
    fallback: 'Nobody has answered this ticket yet',
  },
  pending_requester: {
    key: 'problem.cascadeBlocked.pendingRequester',
    fallback: 'We asked the requester a question',
  },
  requester_spoke_last: {
    key: 'problem.cascadeBlocked.requesterSpokeLast',
    fallback: 'The requester replied last and is owed an answer',
  },
  open_approval: {
    key: 'problem.cascadeBlocked.openApproval',
    fallback: 'An approval is still pending',
  },
  scheduled_future: {
    key: 'problem.cascadeBlocked.scheduledFuture',
    fallback: 'A scheduled intervention is still due',
  },
  concurrent_edit: {
    key: 'problem.cascadeBlocked.concurrentEdit',
    fallback: 'Someone was editing this ticket',
  },
  transition_refused: {
    key: 'problem.cascadeBlocked.transitionRefused',
    fallback: 'The workflow refused the move',
  },
};

export const PROBLEM_SIGNAL_LABELS: Readonly<Record<ProblemDetectionSignal, ProblemLabel>> = {
  ci_repetition: {
    key: 'problem.signal.ciRepetition',
    fallback: 'The same configuration item keeps breaking',
  },
  alert_flapping: {
    key: 'problem.signal.alertFlapping',
    fallback: 'The same alert clears and comes back',
  },
  subject_cluster: {
    key: 'problem.signal.subjectCluster',
    fallback: 'Several tickets describe the same thing',
  },
  reopen_pressure: {
    key: 'problem.signal.reopenPressure',
    fallback: 'Tickets keep being reopened',
  },
  queue_spike: { key: 'problem.signal.queueSpike', fallback: 'This queue is above its usual load' },
  known_error_miss: {
    key: 'problem.signal.knownErrorMiss',
    fallback: 'A published workaround is no longer holding',
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// Guards
// ═════════════════════════════════════════════════════════════════════════════

function isMember<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

export const isKnownErrorState = (v: unknown): v is KnownErrorState =>
  isMember(KNOWN_ERROR_STATES, v);
export const isWorkaroundRisk = (v: unknown): v is WorkaroundRisk => isMember(WORKAROUND_RISKS, v);
export const isProblemClosurePolicy = (v: unknown): v is ProblemClosurePolicy =>
  isMember(PROBLEM_CLOSURE_POLICIES, v);
export const isRcaMethod = (v: unknown): v is RcaMethod => isMember(RCA_METHODS, v);
export const isProblemAnalysisState = (v: unknown): v is ProblemAnalysisState =>
  isMember(PROBLEM_ANALYSIS_STATES, v);
export const isCauseCategory = (v: unknown): v is CauseCategory => isMember(CAUSE_CATEGORIES, v);
export const isCauseKind = (v: unknown): v is CauseKind => isMember(CAUSE_KINDS, v);
export const isCauseConfidence = (v: unknown): v is CauseConfidence =>
  isMember(CAUSE_CONFIDENCES, v);
export const isCauseConfirmationMethod = (v: unknown): v is CauseConfirmationMethod =>
  isMember(CAUSE_CONFIRMATION_METHODS, v);
export const isProblemEvidenceType = (v: unknown): v is ProblemEvidenceType =>
  isMember(PROBLEM_EVIDENCE_TYPES, v);
export const isProblemCandidateState = (v: unknown): v is ProblemCandidateState =>
  isMember(PROBLEM_CANDIDATE_STATES, v);

/** A known error the intake banner may offer. `retired` stays readable but is not offered. */
export function isKnownErrorOfferable(state: KnownErrorState): boolean {
  return state === 'published';
}

// ═════════════════════════════════════════════════════════════════════════════
// DTOs
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The 1:1 extension of a `record_type = 'problem'` ticket.
 *
 * `rowVersion` here is `problems.row_version` and is NOT `tickets.row_version`
 * (HARD RULE 7, two concurrency domains). Sending one where the other is
 * expected is the mistake this comment exists to prevent: an autosave in the
 * RCA workshop must not 409 the team lead editing the ticket header.
 */
export interface Problem {
  ticketId: number;
  tenantId: number;

  knownErrorState: KnownErrorState;
  knownErrorPublishedAt: string | null;
  knownErrorPublishedBy: number | null;

  /** The requester-facing phrasing. This is what the intake matcher indexes. */
  symptomsMd: string | null;

  workaroundMd: string | null;
  workaroundHtml: string | null;
  workaroundRisk: WorkaroundRisk | null;
  workaroundVerifiedAt: string | null;
  workaroundVerifiedBy: number | null;

  /** Rollups maintained in the same transaction as the `ticket_link` write. */
  firstIncidentAt: string | null;
  lastIncidentAt: string | null;
  incidentCount: number;

  detectedBy: ProblemDetectedBy;
  candidateId: number | null;

  rcaRequired: boolean;
  closurePolicy: ProblemClosurePolicy;

  major: boolean;
  majorReviewDueAt: string | null;

  kbArticleId: number | null;

  rowVersion: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * The slice of the problem's TICKET the problem surfaces need. Declared here
 * rather than imported from `./types` so this module stays a leaf of the
 * dependency graph and the barrel keeps its top-to-bottom order.
 */
export interface ProblemTicketHeader {
  ticketId: number;
  number: string;
  subject: string;
  statusSlug: string;
  /** HARD RULE 5 — every engine keys off this, never off `statusSlug`. */
  statusCategory: StatusCategory;
  prioritySlug: string;
  queueSlug: string;
  assigneeId: number | null;
  /** HARD RULE 6 — the instant the condition first appeared, not the intake. */
  occurredAt: string;
  createdAt: string;
  resolvedAt: string | null;
  closedAt: string | null;
  /** `tickets.row_version`. Distinct from `Problem.rowVersion`. */
  rowVersion: number;
}

export interface ProblemWithRelations extends Problem {
  ticket?: ProblemTicketHeader;
  currentAnalysis?: ProblemAnalysisWithCauses | null;
  analysisCount?: number;
  alertSignatures?: ProblemAlertSignature[];
  /** CI ids reached through `ticket_cis` OR `tickets.primary_ci_id`. Both are real. */
  ciIds?: number[];
  linkedIncidentCount?: number;
  /** Precomputed by the same evaluator the publish route runs. */
  knownErrorPublication?: KnownErrorPublicationEvaluation;
}

export interface ProblemAnalysis {
  id: number;
  tenantId: number;
  problemTicketId: number;
  title: string | null;
  method: RcaMethod;
  state: ProblemAnalysisState;
  facilitatorId: number | null;
  /** The elected root among this analysis's causes. */
  rootCauseId: number | null;
  conclusionMd: string | null;
  isCurrent: boolean;
  startedAt: string;
  concludedAt: string | null;
  concludedBy: number | null;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProblemAnalysisWithCauses extends ProblemAnalysis {
  /** Flat, in `(parentCauseId, sortOrder)` order. The client builds the tree. */
  causes: ProblemCause[];
}

export interface ProblemCause {
  id: number;
  tenantId: number;
  analysisId: number;
  parentCauseId: number | null;
  /** The number of the "why". 0 is a fishbone category head or the first why. */
  depth: number;
  sortOrder: number;
  category: CauseCategory;
  statement: string;
  detailMd: string | null;
  kind: CauseKind;
  confidence: CauseConfidence;
  confirmationMethod: CauseConfirmationMethod | null;
  confirmedAt: string | null;
  confirmedBy: number | null;
  createdBy: number | null;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
  evidence?: ProblemCauseEvidence[];
  evidenceCount?: number;
}

export interface ProblemCauseEvidence {
  id: number;
  tenantId: number;
  causeId: number;
  evidenceType: ProblemEvidenceType;
  ticketEvidenceId: number | null;
  ciId: number | null;
  alertId: number | null;
  ticketId: number | null;
  journalId: number | null;
  kbArticleId: number | null;
  externalUrl: string | null;
  /** WHY this artefact proves the cause. Without it the evidence is an ornament. */
  note: string | null;
  addedBy: number | null;
  capturedAt: string;
}

export interface ProblemAlertSignature {
  id: number;
  tenantId: number;
  problemTicketId: number;
  sourceApp: string;
  dedupeKey: string;
  addedBy: number | null;
  createdAt: string;
}

/** One signal's reading, as the detector's SQL produced it. */
export interface ProblemSignalReading {
  /** n_i — what was observed. */
  observed: number;
  /** t_i — the threshold in force for this pass. */
  threshold: number;
  /** w_i — the weight in force for this pass. */
  weight: number;
  /** s_i in 0..1, from `signalSaturation`. */
  saturation: number;
  /** The incidents this signal retained, when it retains any. */
  ticketIds?: number[];
  /** Signal-specific extras: peak occurrences, similarity, sigma, and so on. */
  detail?: Record<string, unknown>;
}

export type ProblemSignalReadings = Partial<
  Record<ProblemDetectionSignal, ProblemSignalReading>
>;

export interface ProblemCandidate {
  id: number;
  tenantId: number;
  /** Stable identity per signal family. See `problemCandidateSignature`. */
  signature: string;
  state: ProblemCandidateState;
  score: number;
  signals: ProblemSignalReadings;
  title: string;
  ciId: number | null;
  dedupeKey: string | null;
  queueSlug: string | null;
  incidentCount: number;
  windowStart: string;
  windowEnd: string;
  /** HARD RULES 3 and 4 — which published config proposed it. */
  detectorSlug: string;
  detectorVersion: number;
  occurrenceCount: number;
  proposedAt: string;
  lastSeenAt: string;
  decidedAt: string | null;
  decidedBy: number | null;
  decisionNote: string | null;
  problemTicketId: number | null;
  suppressedUntil: string | null;
  supersededCandidateId: number | null;
}

export interface ProblemCandidateTicket {
  candidateId: number;
  ticketId: number;
  tenantId: number;
  signal: ProblemDetectionSignal;
  contribution: number | null;
}

export interface ProblemCandidateWithTickets extends ProblemCandidate {
  tickets: ProblemCandidateTicket[];
  /** The rejected card this one escalates, when it escalates one. */
  supersedes?: ProblemCandidate | null;
}

// ── The known-error suggester ────────────────────────────────────────────────

/**
 * Ranked by DECREASING certainty. A CI and a dedupe key are facts; text is a
 * resemblance, which is why its weight is capped: a wrong textual suggestion
 * teaches agents to ignore the banner, and an ignored banner is worth less than
 * no banner.
 */
export type KnownErrorMatchWeapon = 'ci' | 'dedupe_key' | 'text';

export const KNOWN_ERROR_WEAPON_WEIGHTS: Readonly<Record<KnownErrorMatchWeapon, number>> = {
  ci: 1.0,
  dedupe_key: 1.0,
  text: 0.5,
};

export interface KnownErrorSuggestion {
  problemTicketId: number;
  number: string;
  subject: string;
  symptomsMd: string | null;
  workaroundMd: string | null;
  workaroundRisk: WorkaroundRisk | null;
  workaroundVerifiedAt: string | null;
  knownErrorPublishedAt: string | null;
  incidentCount: number;
  weapon: KnownErrorMatchWeapon;
  /** Weapon weight times the raw match strength, in 0..1. */
  score: number;
  matchedCiId?: number | null;
  matchedDedupeKey?: string | null;
}

// ═════════════════════════════════════════════════════════════════════════════
// Requests. Every mutation carries the base row version it read (HARD RULE 7);
// nothing here validates completeness (HARD RULE 12) — that is the evaluators'
// job, and only at a transition.
// ═════════════════════════════════════════════════════════════════════════════

export interface PromoteIncidentRequest {
  incidentId: number;
  /** Defaults to the incident's subject. */
  subject?: string;
  descriptionMd?: string | null;
  symptomsMd?: string | null;
  queueSlug?: string | null;
  prioritySlug?: string | null;
  assigneeId?: number | null;
  major?: boolean;
  rcaRequired?: boolean;
  closurePolicy?: ProblemClosurePolicy;
  /** Further incidents to link in the SAME transaction as the promotion. */
  alsoLinkIncidentIds?: number[];
}

export interface UpdateProblemRequest {
  /** `problems.row_version`, NOT `tickets.row_version`. */
  baseRowVersion: number;
  symptomsMd?: string | null;
  workaroundMd?: string | null;
  workaroundRisk?: WorkaroundRisk | null;
  rcaRequired?: boolean;
  closurePolicy?: ProblemClosurePolicy;
  major?: boolean;
  majorReviewDueAt?: string | null;
}

/** Body of the 409 on a `problems.row_version` mismatch. */
export interface ProblemConflict {
  code: 'version_conflict';
  current: ProblemWithRelations;
  conflictingFields: string[];
}

export interface LinkIncidentsRequest {
  incidentIds: number[];
  source?: ProblemLinkSource;
}

export interface UnlinkIncidentsRequest {
  incidentIds: number[];
}

export interface VerifyWorkaroundRequest {
  baseRowVersion: number;
  /** Defaults to now. Set it when replaying a verification done offline. */
  verifiedAt?: string;
}

export interface PublishKnownErrorRequest {
  baseRowVersion: number;
}

export interface RetireKnownErrorRequest {
  baseRowVersion: number;
  reason?: string;
}

/**
 * Publishing to the KB CREATES an article seeded from the problem and links it.
 * The two then live independently and are never synchronised: an internal
 * workaround naming a host and an admin console, pushed verbatim to the portal,
 * is a data leak wearing a feature badge. Rewriting for the public is an
 * editorial act by a human.
 */
export interface PublishKnownErrorToKbRequest {
  baseRowVersion: number;
  slug?: string;
  locale?: string;
  title?: string;
  bodyMd?: string;
}

export interface CreateProblemAnalysisRequest {
  title?: string | null;
  method?: RcaMethod;
  facilitatorId?: number | null;
}

export interface UpdateProblemAnalysisRequest {
  baseRowVersion: number;
  title?: string | null;
  method?: RcaMethod;
  conclusionMd?: string | null;
  rootCauseId?: number | null;
}

export interface ChangeProblemAnalysisStateRequest {
  baseRowVersion: number;
  toState: ProblemAnalysisState;
  /** Supplied with the transition when the dialog collects them. */
  rootCauseId?: number | null;
  conclusionMd?: string | null;
}

export interface CreateProblemCauseRequest {
  parentCauseId?: number | null;
  category?: CauseCategory;
  statement: string;
  detailMd?: string | null;
  kind?: CauseKind;
  sortOrder?: number;
}

export interface UpdateProblemCauseRequest {
  baseRowVersion: number;
  parentCauseId?: number | null;
  category?: CauseCategory;
  statement?: string;
  detailMd?: string | null;
  kind?: CauseKind;
  sortOrder?: number;
}

export interface ConfirmProblemCauseRequest {
  baseRowVersion: number;
  confidence: CauseConfidence;
  confirmationMethod?: CauseConfirmationMethod | null;
}

export interface AddProblemCauseEvidenceRequest {
  evidenceType: ProblemEvidenceType;
  ticketEvidenceId?: number | null;
  ciId?: number | null;
  alertId?: number | null;
  ticketId?: number | null;
  journalId?: number | null;
  kbArticleId?: number | null;
  externalUrl?: string | null;
  note?: string | null;
}

export interface AddProblemAlertSignatureRequest {
  sourceApp: string;
  dedupeKey: string;
}

export interface AcceptProblemCandidateRequest {
  subject?: string;
  symptomsMd?: string | null;
  queueSlug?: string | null;
  prioritySlug?: string | null;
  assigneeId?: number | null;
  note?: string | null;
}

export interface RejectProblemCandidateRequest {
  /** Required: the note is what the escalation banner shows back months later. */
  note: string;
  /** Overrides the detector body's `rejection.cooldownDays`. */
  cooldownDays?: number;
}

/** Keyset-free list query for the problem board. Mirrors `TicketListQuery` habits. */
export interface ProblemListQuery {
  page?: number;
  limit?: number;
  knownErrorState?: KnownErrorState | KnownErrorState[];
  /** HARD RULE 5 — filter on the TICKET's category, never on a status slug. */
  statusCategory?: StatusCategory | StatusCategory[];
  queueSlug?: string;
  assigneeId?: number;
  ciId?: number;
  major?: boolean;
  detectedBy?: ProblemDetectedBy;
  /** Free text against `problems.search_tsv` plus the ticket subject trigram. */
  q?: string;
  sort?: 'last_incident_at' | 'incident_count' | 'created_at' | 'major_review_due_at';
  direction?: 'asc' | 'desc';
}

export interface ProblemCascadeRequest {
  /** `problems.row_version`. */
  baseRowVersion: number;
  /** Overrides `problems.closure_policy` for this pass only. */
  policy?: ProblemClosurePolicy;
  /** Preview without acting. The client uses this to render the plan. */
  dryRun?: boolean;
}

// ═════════════════════════════════════════════════════════════════════════════
// Evaluators — ONE implementation, TWO callers (HARD RULE 12)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A single thing standing between the actor and the action, already carrying
 * its `t(key, fallback)` pair so the client renders it and the server puts the
 * same words in the 422 body and in `decision_log`.
 */
export interface ProblemRequirement {
  /** Stable machine code. Never shown to a user. */
  code: string;
  key: string;
  fallback: string;
  /** Rows the UI can jump to: cause ids, incident ids. */
  refs?: number[];
}

export interface ProblemGateEvaluation {
  allowed: boolean;
  /** Empty when allowed. Ordered most actionable first. */
  blockers: ProblemRequirement[];
  missingCapabilities: Capability[];
}

/** What the evaluators need to know about the actor. Omit to skip the check. */
export interface ProblemActorContext {
  capabilities?: readonly Capability[] | null;
  isAdmin?: boolean;
}

function requirement(code: string, key: string, fallback: string, refs?: number[]): ProblemRequirement {
  return refs && refs.length > 0 ? { code, key, fallback, refs } : { code, key, fallback };
}

function capabilityGate(actor: ProblemActorContext | undefined, needed: Capability): Capability[] {
  // No actor supplied means "not asking about permissions" — the server always
  // supplies one, the client may not have loaded them yet, and answering
  // "forbidden" to an unknown actor would grey out buttons on first paint.
  if (!actor || actor.capabilities === undefined) return [];
  return hasCapability(actor.capabilities, needed, actor.isAdmin ?? false) ? [] : [needed];
}

function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim().length === 0;
}

// ── 1. The RCA analysis state machine ────────────────────────────────────────

/** What the evaluator needs about one cause node. */
export interface AnalysisCauseSnapshot {
  id: number;
  kind: CauseKind;
  category: CauseCategory;
  confidence: CauseConfidence;
  confirmationMethod: CauseConfirmationMethod | null;
  confirmedBy: number | null;
  /** Rows in `problem_cause_evidence` for this node. */
  evidenceCount: number;
}

export interface AnalysisTransitionInput {
  analysis: Pick<ProblemAnalysis, 'state' | 'rootCauseId'>;
  causes: readonly AnalysisCauseSnapshot[];
  toState: ProblemAnalysisState;
  /** Overrides `analysis.rootCauseId` when the conclude dialog supplies one. */
  rootCauseId?: number | null;
  actor?: ProblemActorContext;
}

export interface AnalysisTransitionEvaluation extends ProblemGateEvaluation {
  toState: ProblemAnalysisState;
}

/**
 * Which states each state may move to.
 *
 *   draft ──▶ in_review ──▶ concluded ──▶ superseded
 *     └───────────┴──▶ abandoned
 *
 * `superseded` is reached only when a NEW analysis becomes current, which is
 * why nothing leaves it: the wrong conclusion stays exactly as it was
 * concluded, and it is the most valuable row in a post-mortem.
 */
export const PROBLEM_ANALYSIS_TRANSITIONS: Readonly<
  Record<ProblemAnalysisState, readonly ProblemAnalysisState[]>
> = {
  draft: ['in_review', 'abandoned'],
  in_review: ['draft', 'concluded', 'abandoned'],
  concluded: ['superseded'],
  superseded: [],
  abandoned: [],
};

/**
 * The gate on an RCA state change.
 *
 * HARD RULE 12 in one sentence: typing into a cause node autosaves field by
 * field and validates nothing, so an analysis can sit half filled for three
 * weeks. Completeness is demanded HERE and only here, by this function, called
 * by the button (to grey it out and list what is missing) and by the route (to
 * refuse). The CHECK in migration 006 is the last line behind it, not the first.
 */
export function evaluateAnalysisTransition(
  input: AnalysisTransitionInput,
): AnalysisTransitionEvaluation {
  const blockers: ProblemRequirement[] = [];
  const missingCapabilities = capabilityGate(input.actor, CAPABILITIES.PROBLEM_RW);

  const { toState } = input;
  const allowedTargets = PROBLEM_ANALYSIS_TRANSITIONS[input.analysis.state] ?? [];

  if (!allowedTargets.includes(toState)) {
    blockers.push(
      requirement(
        'analysis_transition_not_allowed',
        'problem.analysisBlocked.notAllowed',
        'This analysis cannot move to that state from where it is.',
      ),
    );
  }

  if (toState === 'in_review' && input.causes.length === 0) {
    blockers.push(
      requirement(
        'analysis_needs_cause',
        'problem.analysisBlocked.needsCause',
        'Add at least one cause before sending the analysis for review.',
      ),
    );
  }

  if (toState === 'concluded') {
    const rootCauseId = input.rootCauseId ?? input.analysis.rootCauseId ?? null;
    if (rootCauseId === null) {
      blockers.push(
        requirement(
          'analysis_needs_root_cause',
          'problem.analysisBlocked.needsRootCause',
          'Elect the root cause before concluding.',
        ),
      );
    } else {
      const root = input.causes.find((cause) => cause.id === rootCauseId);
      if (!root) {
        blockers.push(
          requirement(
            'analysis_root_cause_missing',
            'problem.analysisBlocked.rootCauseMissing',
            'The elected root cause is not part of this analysis.',
            [rootCauseId],
          ),
        );
      } else {
        // A ruled-out branch or a trigger is a result, not the root cause.
        if (root.kind !== 'cause') {
          blockers.push(
            requirement(
              'analysis_root_cause_not_a_cause',
              'problem.analysisBlocked.rootCauseNotACause',
              'The elected node is not marked as a cause.',
              [root.id],
            ),
          );
        }
        if (root.confidence !== 'confirmed') {
          blockers.push(
            requirement(
              'analysis_root_cause_unconfirmed',
              'problem.analysisBlocked.rootCauseUnconfirmed',
              'The root cause has to be confirmed, not suspected.',
              [root.id],
            ),
          );
        }
        // 'unknown' is the default on every node, so concluding on it would
        // mean concluding on a node nobody categorised, and the category report
        // is the one output that ever justifies problem management.
        if (root.category === 'unknown') {
          blockers.push(
            requirement(
              'analysis_root_cause_uncategorised',
              'problem.analysisBlocked.rootCauseUncategorised',
              'Give the root cause a category so it counts in the cause report.',
              [root.id],
            ),
          );
        }
        if (root.evidenceCount < 1) {
          blockers.push(
            requirement(
              'analysis_root_cause_without_evidence',
              'problem.analysisBlocked.rootCauseWithoutEvidence',
              'Attach at least one piece of evidence to the root cause.',
              [root.id],
            ),
          );
        }
      }
    }
  }

  return {
    toState,
    allowed: blockers.length === 0 && missingCapabilities.length === 0,
    blockers,
    missingCapabilities,
  };
}

// ── 2. Confirming (or refuting) a cause ──────────────────────────────────────

export interface CauseConfirmationInput {
  cause: Pick<AnalysisCauseSnapshot, 'kind' | 'evidenceCount'>;
  toConfidence: CauseConfidence;
  confirmationMethod: CauseConfirmationMethod | null;
  /**
   * The user id doing it. An automation actor MUST pass null: a machine may
   * propose a cause, it may never confirm one.
   */
  confirmedBy: number | null;
  actor?: ProblemActorContext;
}

/**
 * `confirmed` and `refuted` cost three things, and the third is the one that
 * matters: without a real artefact on file the value degenerates into a
 * checkbox inside a week and `confidence` stops being information.
 *
 * Requirements 2 and 3 (a named method, a named human) are also a CHECK in
 * migration 006. Requirement 1 (at least one evidence row) is carried HERE and
 * not by a trigger: a trigger refusing the UPDATE until the evidence exists
 * imposes an insertion order on the API and breaks on the first bundle import.
 *
 * `suspected` and `probable` are always allowed. Typing autosaves (HARD RULE 12).
 */
export function evaluateCauseConfirmation(input: CauseConfirmationInput): ProblemGateEvaluation {
  const blockers: ProblemRequirement[] = [];
  const missingCapabilities = capabilityGate(input.actor, CAPABILITIES.PROBLEM_RW);

  if (input.toConfidence === 'confirmed' || input.toConfidence === 'refuted') {
    if (input.cause.evidenceCount < 1) {
      blockers.push(
        requirement(
          'cause_needs_evidence',
          'problem.causeBlocked.needsEvidence',
          'Attach at least one piece of evidence before confirming this cause.',
        ),
      );
    }
    if (input.confirmationMethod === null) {
      blockers.push(
        requirement(
          'cause_needs_confirmation_method',
          'problem.causeBlocked.needsMethod',
          'Say how the cause was confirmed.',
        ),
      );
    }
    if (!Number.isInteger(input.confirmedBy) || (input.confirmedBy ?? 0) <= 0) {
      blockers.push(
        requirement(
          'cause_needs_human',
          'problem.causeBlocked.needsHuman',
          'A person has to confirm a cause. An automation can only propose one.',
        ),
      );
    }
  }

  return {
    allowed: blockers.length === 0 && missingCapabilities.length === 0,
    blockers,
    missingCapabilities,
  };
}

// ── 3. Publishing a known error ──────────────────────────────────────────────

export interface KnownErrorPublicationInput {
  problem: Pick<
    Problem,
    'knownErrorState' | 'workaroundMd' | 'workaroundRisk' | 'symptomsMd'
  >;
  /** The analysis marked `is_current`, or null when the problem has none. */
  currentAnalysis: Pick<ProblemAnalysis, 'state' | 'rootCauseId'> | null;
  /** CIs reached through `ticket_cis` OR `tickets.primary_ci_id`. Both count. */
  linkedCiCount: number;
  actor?: ProblemActorContext;
}

export type KnownErrorPublicationEvaluation = ProblemGateEvaluation;

/**
 * A known error is a problem whose analysis is CONCLUDED and which carries a
 * non-empty workaround. Publishing is never automatic on a confirmed cause: a
 * workaround nobody has re-read, pushed to the desk, is a support incident of
 * its own.
 *
 * The findability clause is the one people skip. An object with neither a CI
 * nor symptoms cannot be retrieved by any of the three weapons, so publishing
 * it is a lie: the banner will never show it and the desk will never find it.
 */
export function evaluateKnownErrorPublication(
  input: KnownErrorPublicationInput,
): KnownErrorPublicationEvaluation {
  const blockers: ProblemRequirement[] = [];
  const missingCapabilities = capabilityGate(input.actor, CAPABILITIES.PROBLEM_RW);

  if (input.problem.knownErrorState === 'published') {
    blockers.push(
      requirement(
        'known_error_already_published',
        'problem.knownErrorBlocked.alreadyPublished',
        'This known error is already published.',
      ),
    );
  }

  const analysis = input.currentAnalysis;
  if (!analysis || analysis.state !== 'concluded' || analysis.rootCauseId === null) {
    blockers.push(
      requirement(
        'known_error_needs_conclusion',
        'problem.knownErrorBlocked.needsConclusion',
        'Conclude the root-cause analysis first.',
      ),
    );
  }

  if (isBlank(input.problem.workaroundMd)) {
    blockers.push(
      requirement(
        'known_error_needs_workaround',
        'problem.knownErrorBlocked.needsWorkaround',
        'Write the workaround. It is the only thing the desk reads at 09:00.',
      ),
    );
  }

  if (input.problem.workaroundRisk === null || input.problem.workaroundRisk === undefined) {
    blockers.push(
      requirement(
        'known_error_needs_risk',
        'problem.knownErrorBlocked.needsRisk',
        'Say how risky the workaround is to apply.',
      ),
    );
  }

  if (input.linkedCiCount < 1 && isBlank(input.problem.symptomsMd)) {
    blockers.push(
      requirement(
        'known_error_needs_findability',
        'problem.knownErrorBlocked.needsFindability',
        'Link a configuration item or describe the symptoms, otherwise nobody will ever find this.',
      ),
    );
  }

  return {
    allowed: blockers.length === 0 && missingCapabilities.length === 0,
    blockers,
    missingCapabilities,
  };
}

// ── 4. The closure cascade ───────────────────────────────────────────────────

/**
 * Everything the classifier needs about one linked incident. The caller reduces
 * the journal to `lastPublicReplyBy` and `humanTouched` rather than shipping the
 * whole thread: those are the two domain facts, and reducing them at the source
 * keeps this module free of journal types.
 */
export interface CascadeIncidentSnapshot {
  ticketId: number;
  number: string;
  /** HARD RULE 5 — the classifier keys off the category, never off a slug. */
  statusCategory: StatusCategory;
  rowVersion: number;
  firstResponseAt: string | null;
  /** Who wrote the last PUBLIC reply. null when there is none. */
  lastPublicReplyBy: 'agent' | 'requester' | null;
  hasOpenApproval: boolean;
  /** The planned intervention instant, when `statusCategory` is 'scheduled'. */
  scheduledFor: string | null;
  /** Any agent journal entry or logged time. False means nobody ever worked it. */
  humanTouched: boolean;
}

export interface CascadeClassification {
  ticketId: number;
  bucket: CascadeBucket;
  /** Only on `blocked_human_waiting`. */
  blockReason: CascadeBlockReason | null;
  /** The pass must call `ticketService.transition()` for this incident. */
  resolves: boolean;
  /** The incident gets an `automation` journal note and no transition. */
  notifies: boolean;
}

export interface CascadeClassificationInput {
  incident: CascadeIncidentSnapshot;
  policy: ProblemClosurePolicy;
  /** Evaluation instant, ISO-8601. Defaults to now. */
  now?: string;
}

/**
 * Put one incident in exactly one bucket.
 *
 * The block reasons are tested in DECREASING order of how damning the mistake
 * would be, so the reason the agent sees is the most actionable one:
 *
 *   1. no_first_response     never closing a ticket nobody has answered is the
 *                            single worst failure this module could commit, and
 *                            it is an absolute block, not a weighting.
 *   2. pending_requester     we asked a question; resolving is hanging up.
 *   3. requester_spoke_last  they replied and are owed an answer.
 *   4. open_approval         somebody still has to decide.
 *   5. scheduled_future      the planned intervention still has to happen.
 *
 * `concurrent_edit` and `transition_refused` are never returned here: they are
 * discovered while acting, not read off the incident.
 */
export function classifyCascadeIncident(
  input: CascadeClassificationInput,
): CascadeClassification {
  const { incident, policy } = input;
  const ticketId = incident.ticketId;

  if (isTerminal(incident.statusCategory)) {
    return { ticketId, bucket: 'skipped_terminal', blockReason: null, resolves: false, notifies: false };
  }

  const blockReason = cascadeBlockReasonFor(incident, input.now);
  if (blockReason !== null) {
    return {
      ticketId,
      bucket: 'blocked_human_waiting',
      blockReason,
      // A blocked incident is told its problem was fixed and shows up in the
      // "needs a human" list. That is the whole point of blocking rather than
      // silently skipping.
      resolves: false,
      notifies: true,
    };
  }

  const bucket: CascadeBucket = incident.humanTouched ? 'worked_not_waiting' : 'auto_resolved';
  const resolves =
    bucket === 'auto_resolved'
      ? policy === 'resolve_untouched' || policy === 'resolve_all_pending_confirmation'
      : policy === 'resolve_all_pending_confirmation';

  return { ticketId, bucket, blockReason: null, resolves, notifies: !resolves };
}

/** The block test on its own, so a caller can explain one incident in isolation. */
export function cascadeBlockReasonFor(
  incident: CascadeIncidentSnapshot,
  now?: string,
): CascadeBlockReason | null {
  if (incident.firstResponseAt === null) return 'no_first_response';
  if (incident.statusCategory === 'pending_requester') return 'pending_requester';
  if (incident.lastPublicReplyBy === 'requester') return 'requester_spoke_last';
  if (incident.hasOpenApproval) return 'open_approval';
  if (incident.statusCategory === 'scheduled' && incident.scheduledFor !== null) {
    const at = Date.parse(incident.scheduledFor);
    const reference = now === undefined ? Date.now() : Date.parse(now);
    // An unparseable instant blocks rather than resolves: when the data is
    // unreadable, the safe answer is to leave it to a human.
    if (Number.isNaN(at) || at > reference) return 'scheduled_future';
  }
  return null;
}

export interface CascadePlan {
  policy: ProblemClosurePolicy;
  total: number;
  /** Every incident, in the order supplied. */
  classifications: CascadeClassification[];
  /** The prefix the pass will actually act on, capped by `maxIncidents`. */
  actionable: CascadeClassification[];
  skippedTerminal: number;
  autoResolved: number;
  workedNotWaiting: number;
  blocked: number;
  blockedByReason: Partial<Record<CascadeBlockReason, number>>;
  willResolve: number;
  willNotify: number;
  /** True when the cap bit. The caller MUST surface this. */
  truncated: boolean;
  remaining: number;
}

/**
 * The whole pass, decided before anything is written.
 *
 * This is the function that lets the problem page say "12 will be resolved, 4
 * need a human" BEFORE the agent clicks, using the same code the server runs
 * afterwards. A preview computed differently from the action is a preview that
 * lies exactly when it matters.
 *
 * Volume: the pass acts on at most `maxIncidents` (default
 * `LIMITS.problemCascadeMaxIncidents`) and reports the remainder. A truncation
 * that looks like a completion is the failure nobody catches.
 */
export function planClosureCascade(
  incidents: readonly CascadeIncidentSnapshot[],
  policy: ProblemClosurePolicy,
  options?: { now?: string; maxIncidents?: number },
): CascadePlan {
  const cap = options?.maxIncidents ?? PROBLEM_CASCADE_MAX_INCIDENTS;
  const classifications = incidents.map((incident) =>
    classifyCascadeIncident({ incident, policy, now: options?.now }),
  );
  const actionable = cap > 0 ? classifications.slice(0, cap) : [];

  const blockedByReason: Partial<Record<CascadeBlockReason, number>> = {};
  let skippedTerminal = 0;
  let autoResolved = 0;
  let workedNotWaiting = 0;
  let blocked = 0;
  let willResolve = 0;
  let willNotify = 0;

  for (const entry of actionable) {
    switch (entry.bucket) {
      case 'skipped_terminal':
        skippedTerminal += 1;
        break;
      case 'auto_resolved':
        autoResolved += 1;
        break;
      case 'worked_not_waiting':
        workedNotWaiting += 1;
        break;
      case 'blocked_human_waiting': {
        blocked += 1;
        if (entry.blockReason !== null) {
          blockedByReason[entry.blockReason] = (blockedByReason[entry.blockReason] ?? 0) + 1;
        }
        break;
      }
    }
    if (entry.resolves) willResolve += 1;
    if (entry.notifies) willNotify += 1;
  }

  return {
    policy,
    total: classifications.length,
    classifications,
    actionable,
    skippedTerminal,
    autoResolved,
    workedNotWaiting,
    blocked,
    blockedByReason,
    willResolve,
    willNotify,
    truncated: classifications.length > actionable.length,
    remaining: classifications.length - actionable.length,
  };
}

/**
 * Duplicated from `LIMITS.problemCascadeMaxIncidents` on purpose: importing
 * `./constants` here would put a value edge into a module every evaluator
 * imports, and this file is deliberately a leaf. The two numbers agreeing is
 * checked by `assertProblemLimitsAgree` below, which the server calls at boot.
 */
const PROBLEM_CASCADE_MAX_INCIDENTS = 1_000;

/** Throws when this module and `LIMITS` have drifted. Call it once at boot. */
export function assertProblemLimitsAgree(cascadeMaxIncidents: number): void {
  if (cascadeMaxIncidents !== PROBLEM_CASCADE_MAX_INCIDENTS) {
    throw new Error(
      `Problem cascade cap disagrees: LIMITS says ${cascadeMaxIncidents}, ` +
        `shared/problem says ${PROBLEM_CASCADE_MAX_INCIDENTS}.`,
    );
  }
}

// ── 5. Scoring a recurrence candidate ────────────────────────────────────────

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * s_i = min(1, (n_i - t_i + 1) / t_i), clamped to 0 below the threshold.
 *
 * The shape matters: the signal is worth nothing one observation below its
 * threshold, something at it, and everything at `2t - 1`. That is what lets a
 * single strong signal carry a candidate on its own while a barely-met one does
 * not.
 */
export function signalSaturation(observed: number, threshold: number): number {
  if (!Number.isFinite(observed) || !Number.isFinite(threshold)) return 0;
  if (threshold <= 0) return observed > 0 ? 1 : 0;
  return clamp01((observed - threshold + 1) / threshold);
}

export interface CandidateScoreInput {
  signals: ProblemSignalReadings;
  body: Pick<ProblemDetectionBody, 'signals' | 'scoreThreshold' | 'requireExactSignal'>;
}

export interface CandidateScore {
  /** Noisy-OR over the enabled signals, in 0..1. */
  score: number;
  /** w_i * s_i per signal, so the card can show what carried it. */
  contributions: Partial<Record<ProblemDetectionSignal, number>>;
  /** True when at least one of `PROBLEM_EXACT_SIGNALS` actually fired. */
  exactSignalFired: boolean;
  meetsThreshold: boolean;
  /** The final answer: raise a card or not. */
  qualifies: boolean;
}

/**
 * Noisy-OR: `score = 1 - Π (1 - w_i · s_i)`.
 *
 * NOT a weighted sum. A sum lets three weak signals add up over a threshold;
 * noisy-OR saturates, never exceeds 1, and keeps the shipped weights honest:
 *
 *   subject_cluster alone, saturated            0.35  < 0.60  no card
 *   subject_cluster + queue_spike, saturated    0.545 < 0.60  still no card
 *   ci_repetition alone, saturated              0.75  >= 0.60 a card
 *   alert_flapping alone, saturated             0.80  >= 0.60 a card
 *
 * Text similarity therefore CANNOT raise a candidate on its own, by
 * arithmetic. `requireExactSignal` keeps that true even after a tenant edits
 * the weights: a card raised because two tickets share the word "printer"
 * teaches agents to reject without reading.
 */
export function scoreProblemCandidate(input: CandidateScoreInput): CandidateScore {
  const contributions: Partial<Record<ProblemDetectionSignal, number>> = {};
  let inverse = 1;
  let exactSignalFired = false;

  for (const [name, reading] of Object.entries(input.signals) as Array<
    [ProblemDetectionSignal, ProblemSignalReading | undefined]
  >) {
    if (!reading) continue;
    const spec: ProblemSignalSpec | undefined = input.body.signals[name];
    if (!spec || !spec.enabled) continue;

    const saturation = clamp01(reading.saturation);
    if (saturation <= 0) continue;

    const contribution = clamp01(spec.weight) * saturation;
    if (contribution <= 0) continue;

    contributions[name] = contribution;
    inverse *= 1 - contribution;
    if (PROBLEM_EXACT_SIGNALS.includes(name)) exactSignalFired = true;
  }

  const score = clamp01(1 - inverse);
  const meetsThreshold = score >= input.body.scoreThreshold;
  const qualifies = meetsThreshold && (!input.body.requireExactSignal || exactSignalFired);

  return { score, contributions, exactSignalFired, meetsThreshold, qualifies };
}

// ── 6. Suppression, and the way out of it ────────────────────────────────────

export interface CandidateSuppressionInput {
  /** The most recent decided card for this signature, or null when there is none. */
  headstone: Pick<
    ProblemCandidate,
    'id' | 'state' | 'score' | 'incidentCount' | 'suppressedUntil'
  > | null;
  newScore: number;
  newIncidentCount: number;
  /** `ProblemDetectionBody.rejection.escalationFactor`. */
  escalationFactor: number;
  now?: string;
}

export type CandidateSuppressionVerdict =
  | { action: 'propose'; supersedes: null }
  | { action: 'suppress'; suppressedUntil: string; supersedes: number }
  | { action: 'escalate'; reason: 'score' | 'incidents'; supersedes: number };

/**
 * A rejected signature is not forgotten and not obeyed for ever.
 *
 * The headstone (the rejected row itself, never deleted) is consulted before
 * anything is created. Inside the cooldown the signature stays down UNLESS the
 * evidence has materially worsened, numerically:
 *
 *     newScore >= rejectedScore * escalationFactor
 *   OR newIncidentCount >= 2 * incidentCountAtRejection
 *
 * That is the difference between a system that respects a human "no" and one
 * that forgets it. A suppression with no way out turns a refusal into amnesia:
 * the day it truly gets worse, the system goes quiet.
 */
export function evaluateCandidateSuppression(
  input: CandidateSuppressionInput,
): CandidateSuppressionVerdict {
  const headstone = input.headstone;
  if (!headstone || headstone.suppressedUntil === null) return { action: 'propose', supersedes: null };

  const until = Date.parse(headstone.suppressedUntil);
  const reference = input.now === undefined ? Date.now() : Date.parse(input.now);
  if (Number.isNaN(until) || until <= reference) return { action: 'propose', supersedes: null };

  const factor = Number.isFinite(input.escalationFactor) && input.escalationFactor > 0
    ? input.escalationFactor
    : 1.5;

  if (input.newScore >= headstone.score * factor) {
    return { action: 'escalate', reason: 'score', supersedes: headstone.id };
  }
  if (headstone.incidentCount > 0 && input.newIncidentCount >= headstone.incidentCount * 2) {
    return { action: 'escalate', reason: 'incidents', supersedes: headstone.id };
  }

  return { action: 'suppress', suppressedUntil: headstone.suppressedUntil, supersedes: headstone.id };
}

// ── 7. Candidate signatures ──────────────────────────────────────────────────

/**
 * The stable identity of a candidate, one deterministic form per signal family.
 * A partial unique index on `(tenant_id, signature) WHERE state IN
 * ('proposed','accepted')` turns it into the anti-spam guarantee: a
 * re-detection bumps `occurrence_count`, it never inserts a second card.
 */
export const PROBLEM_SIGNATURE_PREFIXES = {
  ci: 'ci',
  alert: 'alert',
  text: 'text',
  reopen: 'reopen',
  queue: 'queue',
  knownErrorMiss: 'kemiss',
} as const;

export function ciCandidateSignature(ciId: number): string {
  return `${PROBLEM_SIGNATURE_PREFIXES.ci}:${ciId}`;
}

export function alertCandidateSignature(sourceApp: string, dedupeKey: string): string {
  return `${PROBLEM_SIGNATURE_PREFIXES.alert}:${sourceApp.trim().toLowerCase()}:${dedupeKey.trim().toLowerCase()}`;
}

export function queueCandidateSignature(queueSlug: string): string {
  return `${PROBLEM_SIGNATURE_PREFIXES.queue}:${queueSlug.trim().toLowerCase()}`;
}

export function reopenCandidateSignature(anchor: {
  ciId?: number | null;
  queueSlug?: string | null;
}): string {
  const key =
    anchor.ciId !== null && anchor.ciId !== undefined
      ? `ci:${anchor.ciId}`
      : `queue:${(anchor.queueSlug ?? '').trim().toLowerCase()}`;
  return `${PROBLEM_SIGNATURE_PREFIXES.reopen}:${key}`;
}

export function knownErrorMissCandidateSignature(problemTicketId: number): string {
  return `${PROBLEM_SIGNATURE_PREFIXES.knownErrorMiss}:${problemTicketId}`;
}

/**
 * The text family needs a hash, and hashing is host-specific (node:crypto on
 * the server, SubtleCrypto in the browser). This module produces the TOKENS —
 * deterministically, so both hosts hash the same input — and takes the hex
 * digest back.
 */
export function subjectSignatureTokens(subject: string, take = 8): string[] {
  const normalised = subject
    .normalize('NFD')
    // U+0300..U+036F: the combining marks NFD has just split off.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const tokens = normalised
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
  return [...new Set(tokens)].sort().slice(0, take);
}

export function textCandidateSignature(hashHex: string): string {
  return `${PROBLEM_SIGNATURE_PREFIXES.text}:${hashHex.trim().toLowerCase()}`;
}

// ═════════════════════════════════════════════════════════════════════════════
// decision_log catalogue (HARD RULE 2)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Every automated decision this module takes, written by `decisionService`
 * with `subsystem: 'problem'` on the SAME code path and in the SAME transaction
 * as the action. Never reconstructed from the journal afterwards.
 *
 * The one volumetric ruling worth stating: the cascade writes ONE census row on
 * the problem (`closureCascade`) plus one row per incident actually touched or
 * notified. Incidents already terminal get no row of their own, because
 * `decision_log.ticket_id` serves a given ticket's Why drawer and an incident
 * we looked at without touching has nothing to explain on its page. The fact is
 * not lost: it is in the census row's `outcome.skippedTerminal`.
 */
export const PROBLEM_DECISIONS = {
  promotedFromIncident: 'problem_promoted_from_incident',
  incidentLinked: 'incident_linked_to_problem',
  incidentUnlinked: 'incident_unlinked_from_problem',
  analysisConcluded: 'problem_analysis_concluded',
  causeConfirmed: 'problem_cause_confirmed',
  knownErrorPublished: 'known_error_published',
  knownErrorRetired: 'known_error_retired',
  knownErrorSuggested: 'known_error_suggested',
  knownErrorMatchedOnAlert: 'known_error_matched_on_alert',
  closureCascade: 'problem_closure_cascade',
  incidentAutoResolved: 'incident_auto_resolved_by_problem',
  incidentCascadeBlocked: 'incident_cascade_blocked',
  cascadeReopened: 'problem_cascade_reopened',
  detectionRun: 'problem_detection_run',
  candidateProposed: 'problem_candidate_proposed',
  candidateSuppressed: 'problem_candidate_suppressed',
  candidateEscalated: 'problem_candidate_escalated',
  candidateAccepted: 'problem_candidate_accepted',
  candidateRejected: 'problem_candidate_rejected',
  kbArticleCreated: 'problem_kb_article_created',
} as const;

export type ProblemDecision = (typeof PROBLEM_DECISIONS)[keyof typeof PROBLEM_DECISIONS];

/** Shape of the census row's `outcome`, so the Why drawer can render it. */
export interface ProblemCascadeOutcome {
  total: number;
  skippedTerminal: number;
  blocked: Partial<Record<CascadeBlockReason, number>>;
  autoResolved: number;
  workedNotWaiting: number;
  truncated: boolean;
  remaining: number;
}

/**
 * What `problemService.cascadeOnResolve()` returns, and what the dry run
 * returns unchanged. One shape for the preview and the result, so the page
 * that said "12 will be resolved" renders the same component afterwards
 * saying "12 were resolved".
 */
export interface ProblemCascadeResult {
  problemTicketId: number;
  policy: ProblemClosurePolicy;
  dryRun: boolean;
  /** Decided before anything was written, by `planClosureCascade`. */
  plan: CascadePlan;
  /** The census written to `decision_log`. Identical to the plan on a dry run. */
  outcome: ProblemCascadeOutcome;
  /** Incidents actually transitioned. Empty on a dry run. */
  resolvedTicketIds: number[];
  /**
   * Incidents left to a human, INCLUDING the two reasons the plan cannot
   * predict: `concurrent_edit` (a row_version moved under the pass) and
   * `transition_refused` (a guard wanted a field the cascade cannot supply).
   */
  blocked: Array<{ ticketId: number; number: string; reason: CascadeBlockReason }>;
}

/** Shape of the detection pass's `outcome`. */
export interface ProblemDetectionRunOutcome {
  evaluated: number;
  proposed: number;
  bumped: number;
  /** Qualified but above `maxNewCandidatesPerRun`, so not created. */
  withheld: number;
  suppressed: number;
  escalated: number;
  durationMs: number;
}

// ═════════════════════════════════════════════════════════════════════════════
// The shipped detector body
// ═════════════════════════════════════════════════════════════════════════════

/** Slug of the seeded `problem_detection` config object (`is_system`). */
export const PROBLEM_DETECTION_DEFAULT_SLUG = 'default';

/**
 * The baseline the seed writes and the detector falls back to when the tenant
 * archived its object. Weights are chosen so the arithmetic in
 * `scoreProblemCandidate` holds; changing one changes which cards appear, so
 * change it there and re-read the four worked numbers in that comment.
 */
export const DEFAULT_PROBLEM_DETECTION_BODY: ProblemDetectionBody = {
  enabled: true,
  windowDays: 14,
  scoreThreshold: 0.6,
  maxNewCandidatesPerRun: 5,
  requireExactSignal: true,
  signals: {
    // Same CI, several live incidents. A CI is a fact, not a resemblance.
    ci_repetition: { enabled: true, weight: 0.75, threshold: 3 },
    // A condition that clears and comes back is the textbook problem: every
    // cycle is a closed incident and nobody sees the pattern.
    alert_flapping: { enabled: true, weight: 0.8, threshold: 3, secondary: 10 },
    // Seeded by a recent incident, never a global nightly clustering pass:
    // O(n^2) over 50 000 subjects is the number one technical reason these
    // features end up switched off.
    subject_cluster: { enabled: true, weight: 0.35, threshold: 4, secondary: 0.45 },
    // A ticket reopened twice was never fixed.
    reopen_pressure: { enabled: true, weight: 0.5, threshold: 2 },
    // Daily count above the 28-day rolling mean by N sigma, off the existing
    // metric_daily_rollup. Free: the aggregate is already maintained.
    queue_spike: { enabled: true, weight: 0.3, threshold: 2 },
    // New incidents landing on an already published known error. The
    // workaround no longer suffices: a candidate for a NEW problem (the
    // permanent fix), not a duplicate of the old one.
    known_error_miss: { enabled: true, weight: 0.45, threshold: 3 },
  },
  rejection: {
    cooldownDays: 90,
    escalationFactor: 1.5,
  },
  defaultQueueSlug: null,
  defaultPrioritySlug: null,
};
