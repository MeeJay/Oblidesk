/**
 * problem.validators.ts — the HTTP boundary for `/api/problems`.
 *
 * Three things this file is careful about, and each of them is a hard rule:
 *
 * 1. `baseRowVersion` is REQUIRED on every mutation (HARD RULE 7), and it is
 *    `problems.row_version`, NOT `tickets.row_version`. Those are two different
 *    concurrency domains on purpose: the RCA workshop must not 409 the team
 *    lead who is editing the ticket header at the same moment. Making the field
 *    optional "for convenience" would turn optimistic concurrency into
 *    last-write-wins for whichever client forgot it.
 *
 * 2. NOTHING HERE VALIDATES COMPLETENESS (HARD RULE 12). Every field on
 *    `updateProblemSchema`, `updateProblemAnalysisSchema` and
 *    `updateProblemCauseSchema` is optional, on purpose — a half-written
 *    analysis is a legitimate state and autosave has to be able to store it.
 *    Completeness is a property of a TRANSITION (concluding an analysis,
 *    confirming a cause, publishing a known error) and it is decided by the
 *    shared evaluators in `@oblidesk/shared`, which the client runs too. A zod
 *    schema that quietly enforced it here would put a second, divergent
 *    implementation in the one place nobody would think to look.
 *
 * 3. THE VOCABULARIES ARE IMPORTED, NOT RETYPED. `KNOWN_ERROR_STATES`,
 *    `CAUSE_CATEGORIES` and the rest are the same literal tuples the migration
 *    006 CHECK constraints were written from and the same ones the client's
 *    dropdowns render. Copying them into this file the way `ci.validators.ts`
 *    copies the CI vocabulary would buy nothing here: shared already IS the
 *    single mirror of the CHECKs, so importing keeps a mismatch a compile error
 *    in one file rather than a 23514 at runtime.
 *
 * Query parameters arrive as strings, so the list filters go through `csv()`
 * and the boolean preprocessor below; this is the only place that conversion
 * happens.
 */
import { z } from 'zod';
import {
  CAUSE_CATEGORIES,
  CAUSE_CONFIDENCES,
  CAUSE_CONFIRMATION_METHODS,
  CAUSE_KINDS,
  KNOWN_ERROR_STATES,
  LIMITS,
  PAGINATION,
  PROBLEM_ANALYSIS_STATES,
  PROBLEM_CANDIDATE_STATES,
  PROBLEM_CLOSURE_POLICIES,
  PROBLEM_DETECTION_ORIGINS,
  PROBLEM_EVIDENCE_TYPES,
  PROBLEM_LINK_SOURCES,
  RCA_METHODS,
  STATUS_CATEGORIES,
  WORKAROUND_RISKS,
} from '@oblidesk/shared';

// A problem IS a ticket, so its ids and its queue / priority slugs are the
// ticket vocabulary. Importing the two primitives rather than restating them
// means a change to what the desk calls a slug reaches this router too.
import { idSchema, slugSchema } from './ticket.validators';

// The generic ZodError → 400 translation already exists in the validate
// middleware and is not owned by any slice. Re-exported so `problems.routes.ts`
// imports one validators module, the way `sla.validators.ts` re-exports the
// config helpers, instead of this directory growing a third copy.
export { parseOrThrow } from '../middleware/validate';

export { idSchema, slugSchema };

// ═════════════════════════════════════════════════════════════════════════════
// Primitives
// ═════════════════════════════════════════════════════════════════════════════

const isoDate = z
  .string()
  .trim()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Expected an ISO-8601 timestamp');

/** HARD RULE 7 — `problems.row_version`, and never optional. */
const baseRowVersion = z.coerce.number().int().min(1);

/** Query arrays arrive as `a,b,c`, as repeated params, or not at all. */
function csv<T extends z.ZodTypeAny>(item: T) {
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === '') return undefined;
    if (Array.isArray(value)) return value;
    return String(value)
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');
  }, z.array(item).optional());
}

/**
 * `z.coerce.boolean()` is a trap for query strings: `Boolean('false')` is
 * `true`, so `?major=false` would ask for the opposite of what it says. Parse
 * the words people actually type instead.
 */
const boolParam = z.preprocess((value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(lowered)) return true;
    if (['0', 'false', 'no', 'off'].includes(lowered)) return false;
  }
  return undefined;
}, z.boolean().optional());

/** Body text, capped where the column is capped. */
const markdown = z.string().max(LIMITS.bodyMaxBytes);

/**
 * A batch of incidents. The ceiling is the bulk ceiling rather than a number of
 * its own: linking 4 000 incidents in one request is the same act as a bulk
 * edit of 4 000 tickets, and giving it a second, larger limit would be a bulk
 * action that escaped the bulk limit.
 */
const incidentIdList = z.array(idSchema).min(1).max(LIMITS.bulkMaxTickets);

// ═════════════════════════════════════════════════════════════════════════════
// Path parameters
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `:ticketId`, not `:id` — the primary key of `problems` IS the problem's
 * ticket id, and naming it after the ticket is what stops somebody passing an
 * analysis id or a `problems` surrogate that does not exist.
 */
export const problemParamsSchema = z.object({ ticketId: idSchema });

export const analysisParamsSchema = z.object({ ticketId: idSchema, analysisId: idSchema });
export const causeParamsSchema = z.object({ ticketId: idSchema, causeId: idSchema });
export const causeEvidenceParamsSchema = z.object({
  ticketId: idSchema,
  causeId: idSchema,
  evidenceId: idSchema,
});
export const signatureParamsSchema = z.object({ ticketId: idSchema, signatureId: idSchema });
export const candidateParamsSchema = z.object({ candidateId: idSchema });

// ═════════════════════════════════════════════════════════════════════════════
// The board
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `GET /api/problems`.
 *
 * Offset paged, unlike the ticket queue: a problem board is tens of rows that a
 * human reads top to bottom, not a virtualised list of a hundred thousand, and
 * `page`/`limit` is what `ProblemListQuery` declares.
 *
 * `statusCategory` filters on the TICKET's category, never on a status slug
 * (HARD RULE 5) — a tenant renaming "Under investigation" must not silently
 * empty this board.
 */
export const listProblemsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(PAGINATION.maxLimit).optional(),

  knownErrorState: csv(z.enum(KNOWN_ERROR_STATES)),
  statusCategory: csv(z.enum(STATUS_CATEGORIES)),
  queueSlug: slugSchema.optional(),
  assigneeId: idSchema.optional(),
  ciId: idSchema.optional(),
  major: boolParam,
  detectedBy: z.enum(PROBLEM_DETECTION_ORIGINS).optional(),

  /** Free text against `problems.search_tsv` plus the ticket subject trigram. */
  q: z.string().trim().max(512).optional(),

  sort: z
    .enum(['last_incident_at', 'incident_count', 'created_at', 'major_review_due_at'])
    .optional(),
  direction: z.enum(['asc', 'desc']).optional(),
});

// ═════════════════════════════════════════════════════════════════════════════
// Promotion and the problem record
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `POST /api/problems/promote`.
 *
 * Promotion CREATES a new problem ticket beside the incident; it never flips
 * the incident's `record_type`. The incident keeps its own state, assignee and
 * SLA clock, because the person who reported the outage is still waiting on an
 * answer whether or not the desk has decided to investigate the cause.
 */
export const promoteIncidentSchema = z.object({
  incidentId: idSchema,
  /** Defaults server-side to the incident's subject. */
  subject: z.string().trim().min(1).max(LIMITS.subjectMaxLength).optional(),
  descriptionMd: markdown.nullish(),
  symptomsMd: markdown.nullish(),
  queueSlug: slugSchema.nullish(),
  prioritySlug: slugSchema.nullish(),
  assigneeId: idSchema.nullish(),
  major: z.boolean().optional(),
  rcaRequired: z.boolean().optional(),
  closurePolicy: z.enum(PROBLEM_CLOSURE_POLICIES).optional(),
  /** Further incidents to link in the SAME transaction as the promotion. */
  alsoLinkIncidentIds: z.array(idSchema).max(LIMITS.bulkMaxTickets).optional(),
});

/**
 * `PATCH /api/problems/:ticketId` — inline autosave, one field at a time.
 *
 * Everything except the row version is optional and nothing is checked for
 * completeness (HARD RULE 12). A workaround with no risk rating is a perfectly
 * good draft; it simply cannot be PUBLISHED, and that refusal comes from
 * `evaluateKnownErrorPublication`, not from here.
 */
export const updateProblemSchema = z
  .object({
    baseRowVersion,

    symptomsMd: markdown.nullish(),
    workaroundMd: markdown.nullish(),
    workaroundRisk: z.enum(WORKAROUND_RISKS).nullish(),
    rcaRequired: z.boolean().optional(),
    closurePolicy: z.enum(PROBLEM_CLOSURE_POLICIES).optional(),
    major: z.boolean().optional(),
    majorReviewDueAt: isoDate.nullish(),
  })
  .refine((value) => Object.keys(value).some((key) => key !== 'baseRowVersion'), {
    message: 'Nothing to update',
  });

// ═════════════════════════════════════════════════════════════════════════════
// Incidents under the problem
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `POST /api/problems/:ticketId/incidents`.
 *
 * `source` records HOW the link came to be — a human said so, a promotion
 * carried it, a detector proposed it, an alert signature matched, a rule fired.
 * It is what the acceptance-rate report reads months later to decide whether
 * the detector is worth its noise, so it is on the wire rather than assumed.
 */
export const linkIncidentsSchema = z.object({
  incidentIds: incidentIdList,
  source: z.enum(PROBLEM_LINK_SOURCES).optional(),
});

export const unlinkIncidentsSchema = z.object({
  incidentIds: incidentIdList,
});

/** `GET /api/problems/:ticketId/incidents` — the cascade-relevant facts. */
export const listLinkedIncidentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(PAGINATION.maxLimit).optional(),
});

// ═════════════════════════════════════════════════════════════════════════════
// Workaround and known error
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `POST /api/problems/:ticketId/workaround/verify`.
 *
 * `verifiedAt` is settable because a verification often happens at the keyboard
 * of the affected machine and gets recorded afterwards. It is the moment the
 * workaround was actually replayed, in the spirit of HARD RULE 6, and a
 * workaround nobody has replayed is a hypothesis.
 */
export const verifyWorkaroundSchema = z.object({
  baseRowVersion,
  verifiedAt: isoDate.optional(),
});

export const publishKnownErrorSchema = z.object({
  baseRowVersion,
});

export const retireKnownErrorSchema = z.object({
  baseRowVersion,
  /** Kept in the decision row, so "why did this stop being offered?" survives. */
  reason: z.string().trim().max(500).optional(),
});

/**
 * `POST /api/problems/:ticketId/known-error/kb`.
 *
 * Every field but the row version is optional: the service seeds the article
 * from the problem when they are absent. They exist because an internal
 * workaround naming a host and an admin console, pushed verbatim to the portal,
 * is a data leak wearing a feature badge — so the editor gets to rewrite it for
 * the public before it is created.
 */
export const publishKnownErrorToKbSchema = z.object({
  baseRowVersion,
  slug: slugSchema.optional(),
  locale: z.string().trim().min(2).max(10).optional(),
  title: z.string().trim().min(1).max(512).optional(),
  bodyMd: markdown.optional(),
});

/**
 * `GET /api/problems/known-errors/suggest` — the intake banner's question.
 *
 * The three weapons in decreasing certainty are CI match, alert dedupe key and
 * free text. All three inputs are optional except the subject, because intake
 * often knows nothing but what was typed.
 */
export const suggestKnownErrorsQuerySchema = z.object({
  subject: z.string().trim().min(1).max(LIMITS.subjectMaxLength),
  primaryCiId: idSchema.optional(),
  ciIds: csv(idSchema),
  sourceApp: z.string().trim().min(1).max(32).optional(),
  dedupeKey: z.string().trim().min(1).max(255).optional(),
  excludeTicketId: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(25).optional(),
});

// ═════════════════════════════════════════════════════════════════════════════
// Alert signatures
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `POST /api/problems/:ticketId/signatures`.
 *
 * `suite_alerts.ticket_id` cannot replace this table and this route: that
 * column names the ticket ONE alert happened to open, while a signature is an
 * engineer declaring that a key means this known error whenever it arrives.
 *
 * `dedupeKey` is trimmed and non-empty here because the column is `citext` with
 * a `btrim(...) <> ''` CHECK — a blank key would match every future alert.
 */
export const addAlertSignatureSchema = z.object({
  sourceApp: z.string().trim().min(1).max(32),
  dedupeKey: z.string().trim().min(1).max(255),
});

// ═════════════════════════════════════════════════════════════════════════════
// Analyses
// ═════════════════════════════════════════════════════════════════════════════

export const createProblemAnalysisSchema = z.object({
  title: z.string().trim().min(1).max(255).nullish(),
  method: z.enum(RCA_METHODS).optional(),
  facilitatorId: idSchema.nullish(),
});

/** Autosave on `problem_analyses.row_version`. Validates nothing else. */
export const updateProblemAnalysisSchema = z
  .object({
    baseRowVersion,
    title: z.string().trim().min(1).max(255).nullish(),
    method: z.enum(RCA_METHODS).optional(),
    conclusionMd: markdown.nullish(),
    rootCauseId: idSchema.nullish(),
  })
  .refine((value) => Object.keys(value).some((key) => key !== 'baseRowVersion'), {
    message: 'Nothing to update',
  });

/**
 * `POST /api/problems/:ticketId/analyses/:analysisId/state` — THE gate.
 *
 * `rootCauseId` and `conclusionMd` ride along because the conclude dialog
 * collects them in the same breath as the state change. They are NOT required
 * here even for `concluded`: `evaluateAnalysisTransition` decides that, on both
 * sides of the wire, and it answers with a list of blockers the UI can render
 * instead of a flat refusal.
 */
export const changeProblemAnalysisStateSchema = z.object({
  baseRowVersion,
  toState: z.enum(PROBLEM_ANALYSIS_STATES),
  rootCauseId: idSchema.nullish(),
  conclusionMd: markdown.nullish(),
});

// ═════════════════════════════════════════════════════════════════════════════
// Causes
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `POST /api/problems/:ticketId/analyses/:analysisId/causes`.
 *
 * There is no `depth` on the wire. It is derived server-side from the parent,
 * because a client that can name its own depth can build a tree whose depths
 * disagree with its edges, and the ladder of five whys then renders in an order
 * nobody chose.
 */
export const createProblemCauseSchema = z.object({
  parentCauseId: idSchema.nullish(),
  category: z.enum(CAUSE_CATEGORIES).optional(),
  /**
   * `problem_causes.statement` is varchar(512) — a why, not an essay.
   *
   * OPTIONAL at creation, and that is the point: the canvas creates the node on
   * click and the agent types into it afterwards, so demanding the sentence up
   * front made every "add a why" button a 400. Required-ness is collected by
   * `evaluateCauseConfirmation` when the cause is confirmed (HARD RULE 12).
   */
  statement: z.string().trim().max(512).optional(),
  detailMd: markdown.nullish(),
  kind: z.enum(CAUSE_KINDS).optional(),
  sortOrder: z.coerce.number().int().min(0).max(100_000).optional(),
});

/**
 * Autosave on `problem_causes.row_version`.
 *
 * `statement` is OPTIONAL here although it is mandatory at creation: this is an
 * inline edit of one field at a time (HARD RULE 12), and requiring the whole
 * row to be resent to change a category is how autosave starts clobbering.
 */
export const updateProblemCauseSchema = z
  .object({
    baseRowVersion,
    parentCauseId: idSchema.nullish(),
    category: z.enum(CAUSE_CATEGORIES).optional(),
    /** May be cleared: an inline autosave passes through empty (HARD RULE 12). */
    statement: z.string().trim().max(512).optional(),
    detailMd: markdown.nullish(),
    kind: z.enum(CAUSE_KINDS).optional(),
    sortOrder: z.coerce.number().int().min(0).max(100_000).optional(),
  })
  .refine((value) => Object.keys(value).some((key) => key !== 'baseRowVersion'), {
    message: 'Nothing to update',
  });

/**
 * `POST /api/problems/:ticketId/causes/:causeId/confirm`.
 *
 * `confirmedBy` is NOT on the wire: it is the session's user, filled in by the
 * service. A confirmation is a person putting their name to a claim, and an
 * endpoint that let the caller nominate who confirmed would make the RCA a
 * record of who had access rather than of who was convinced.
 *
 * Whether the method and the evidence are sufficient is `evaluateCauseConfirmation`'s
 * answer, not this schema's.
 */
export const confirmProblemCauseSchema = z.object({
  baseRowVersion,
  confidence: z.enum(CAUSE_CONFIDENCES),
  confirmationMethod: z.enum(CAUSE_CONFIRMATION_METHODS).nullish(),
});

/**
 * `POST /api/problems/:ticketId/causes/:causeId/evidence`.
 *
 * EXACTLY ONE target, mirroring `problem_cause_evidence_target_ck` the same way
 * `watcherSchema` mirrors `ticket_watcher_who_ck`: the refusal arrives as a 400
 * with a field error the dialog can point at, instead of a 23514 the client can
 * only render as "something went wrong".
 *
 * A screenshot is deliberately NOT a target here. It is an `attachment_links`
 * row with `entity_type = 'problem_cause'` (HARD RULE 9), so the blob is
 * refcounted and dies with its last link like every other attachment.
 *
 * `externalUrl` is not URL-parsed: an external pointer is as often a vendor
 * case number or a KB reference from another suite as it is an http address,
 * and the column is free text.
 */
export const addProblemCauseEvidenceSchema = z
  .object({
    evidenceType: z.enum(PROBLEM_EVIDENCE_TYPES),
    ticketEvidenceId: idSchema.nullish(),
    ciId: idSchema.nullish(),
    alertId: idSchema.nullish(),
    ticketId: idSchema.nullish(),
    journalId: idSchema.nullish(),
    kbArticleId: idSchema.nullish(),
    externalUrl: z.string().trim().min(1).max(2048).nullish(),
    note: z.string().trim().max(512).nullish(),
  })
  .refine(
    (value) =>
      [
        value.ticketEvidenceId,
        value.ciId,
        value.alertId,
        value.ticketId,
        value.journalId,
        value.kbArticleId,
        value.externalUrl,
      ].filter((target) => target !== undefined && target !== null).length === 1,
    {
      message:
        'Provide exactly one of ticketEvidenceId, ciId, alertId, ticketId, journalId, kbArticleId or externalUrl',
    },
  );

// ═════════════════════════════════════════════════════════════════════════════
// Detection candidates
// ═════════════════════════════════════════════════════════════════════════════

/** `GET /api/problems/candidates` — the review board, score first. */
export const listCandidatesQuerySchema = z.object({
  state: csv(z.enum(PROBLEM_CANDIDATE_STATES)),
  minScore: z.coerce.number().min(0).max(1).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(PAGINATION.maxLimit).optional(),
});

/**
 * `POST /api/problems/candidates/:candidateId/accept`.
 *
 * No `occurredAt`: the promoted problem inherits the earliest moment among the
 * incidents the detector grouped (HARD RULE 6), and letting a reviewer type a
 * different one would erase the only fact Rewind can reconstruct from.
 */
export const acceptProblemCandidateSchema = z.object({
  subject: z.string().trim().min(1).max(LIMITS.subjectMaxLength).optional(),
  symptomsMd: markdown.nullish(),
  queueSlug: slugSchema.nullish(),
  prioritySlug: slugSchema.nullish(),
  assigneeId: idSchema.nullish(),
  note: z.string().trim().max(512).nullish(),
});

/**
 * `POST /api/problems/candidates/:candidateId/reject`.
 *
 * The note is REQUIRED, and it is the one required free-text field in this
 * file. The rejected card becomes the headstone the detector consults before
 * proposing that signature again; when the pattern comes back worse and the
 * card escalates, this sentence is what the banner shows the next reviewer.
 * "Rejected, no reason given" restarts the argument from zero every quarter.
 */
export const rejectProblemCandidateSchema = z.object({
  note: z.string().trim().min(1).max(512),
  /** Overrides the detector body's `rejection.cooldownDays`. */
  cooldownDays: z.coerce.number().int().min(0).max(3650).optional(),
});

/** `POST /api/problems/candidates/run` — one manual detection pass. */
export const runDetectionSchema = z.object({
  dryRun: z.boolean().optional(),
});

// ═════════════════════════════════════════════════════════════════════════════
// Closure cascade
// ═════════════════════════════════════════════════════════════════════════════

/** `GET /api/problems/:ticketId/cascade` — the dry run. Writes nothing. */
export const cascadePreviewQuerySchema = z.object({
  policy: z.enum(PROBLEM_CLOSURE_POLICIES).optional(),
});

/**
 * `POST /api/problems/:ticketId/cascade`.
 *
 * `policy` overrides `problems.closure_policy` for this pass only, so a team
 * can resolve one wave conservatively without editing the record. `dryRun`
 * exists on the body as well as on the GET because the confirm dialog re-plans
 * with the policy the operator just picked, immediately before acting on it.
 */
export const problemCascadeSchema = z.object({
  baseRowVersion,
  policy: z.enum(PROBLEM_CLOSURE_POLICIES).optional(),
  dryRun: z.boolean().optional(),
});
