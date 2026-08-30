/**
 * change.validators.ts — the HTTP boundary for `/api/changes`.
 *
 * Six things this file is careful about, and every one of them is a hard rule
 * or a trap the Problems module already fell into once.
 *
 * 1. `baseRowVersion` is REQUIRED on every mutation (HARD RULE 7), and it is
 *    `changes.row_version`, NOT `tickets.row_version`. Two concurrency domains
 *    on purpose: the change manager rewriting a backout plan must not 409 the
 *    team lead who reassigned the ticket in the same minute. Making the field
 *    optional "for convenience" turns optimistic concurrency into
 *    last-write-wins for whichever client forgot it.
 *
 * 2. NOTHING HERE VALIDATES COMPLETENESS (HARD RULE 12). `updateChangeSchema`
 *    is optional to the last field, on purpose: a change with no window, no
 *    backout plan and no test plan is a legitimate draft that autosaves all
 *    afternoon. It simply cannot be SCHEDULED, and that refusal comes from
 *    `evaluateChangeSchedule` in `@oblidesk/shared` — the same function the
 *    client runs to grey the button out and list what is missing. One
 *    implementation, two callers. The same reasoning is why
 *    `completeChangeReviewSchema` accepts a review with blank findings: the
 *    refusal is `evaluateChangeReview`'s to make, with a blocker code the UI
 *    can render, not a 400 that says `pirFindingsMd: Required`.
 *
 * 3. A CHANGE HAS NO `occurred_at` (HARD RULE 6). A change is not something
 *    that happened to you, it is something you intend to do; what it has is a
 *    PLANNED window, which is a third kind of time and lives in its own
 *    columns. `changeTicketDraftSchema` therefore REFUSES the field by name
 *    rather than stripping it, so a client that sends one learns why instead of
 *    watching it vanish.
 *
 * 4. EVERY FIELD WITH ITS OWN DOOR IS ABSENT FROM THE PATCH, AND THE PATCH IS
 *    `.strict()`. The planned window, the risk band, the outcome, the PIR
 *    answers, the conflict acknowledgement, the freeze override and the
 *    implementation stamps each have a route that carries a capability, writes
 *    a `decision_log` row and, in three cases, runs a shared gate first. If
 *    inline autosave also accepted them it would be a fifth door around four
 *    locked ones. `.strict()` is what makes that a 400 naming the offending key
 *    instead of a silent no-op nobody notices for a release.
 *
 * 5. THE VOCABULARIES COME FROM SHARED. `CHANGE_TYPES`, `CHANGE_RISKS`,
 *    `CHANGE_OUTCOMES` and the two conflict tuples are the same literals
 *    migration 011's CHECK constraints were written from and the same ones the
 *    client's dropdowns render, so a mismatch is a compile error in one file
 *    rather than a 23514 at runtime. Two of them —`FAILURE_LIKELIHOODS` and
 *    `IMPACT_LEVELS` — are exported as widened `readonly T[]` rather than
 *    literal tuples, which `z.enum` cannot consume, so they are restated below
 *    behind a compile-time exhaustiveness assertion that breaks the build if
 *    the union ever gains a member.
 *
 * 6. SHAPE IS MIRRORED FROM THE CHECK CONSTRAINTS, JUDGEMENT IS NOT. The window
 *    schema enforces `changes_planned_pair_ck` and `changes_planned_order_ck`
 *    because the alternative refusal is a raw 23514 the client cannot render.
 *    It does NOT enforce lead time, freeze windows or conflict acknowledgement:
 *    those are the gate's to judge, they answer 422 with blocker codes, and a
 *    zod schema quietly holding a second opinion about them is exactly the
 *    divergence HARD RULE 12 exists to prevent.
 */
import { z } from 'zod';
import {
  CHANGE_CONFLICT_KINDS,
  CHANGE_CONFLICT_SEVERITIES,
  CHANGE_OUTCOMES,
  CHANGE_RISKS,
  CHANGE_TYPES,
  LIMITS,
  PAGINATION,
  STATUS_CATEGORIES,
  type FailureLikelihood,
  type ImpactLevel,
} from '@oblidesk/shared';

// A change IS a ticket, so its ids, its slugs and its intake payload are the
// ticket vocabulary. Importing the three primitives rather than restating them
// means a change to what the desk calls a slug reaches this router too.
import { createTicketSchema, idSchema, slugSchema } from './ticket.validators';

// The generic ZodError → 400 translation lives in the validate middleware and
// is owned by no slice. Re-exported so `changes.routes.ts` imports one
// validators module, exactly as `problem.validators.ts` does.
export { parseOrThrow } from '../middleware/validate';

export { idSchema, slugSchema };

// ═════════════════════════════════════════════════════════════════════════════
// Vocabularies shared exports as widened arrays
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `FAILURE_LIKELIHOODS` and `IMPACT_LEVELS` are declared in shared as
 * `readonly FailureLikelihood[]` / `readonly ImpactLevel[]`, which erases the
 * literal tuple `z.enum` needs. Restating them here is the only way to build
 * the enum — so the restatement carries a tooth: `_AssertFailureLikelihoods`
 * and `_AssertImpactLevels` resolve to `never` (and fail the build in this
 * file, loudly, on the line below) the moment either union gains a member that
 * this tuple does not list.
 */
const FAILURE_LIKELIHOOD_VALUES = ['high', 'medium', 'low'] as const;
type _AssertFailureLikelihoods = Exclude<
  FailureLikelihood,
  (typeof FAILURE_LIKELIHOOD_VALUES)[number]
> extends never
  ? true
  : never;
const _failureLikelihoodsAreExhaustive: _AssertFailureLikelihoods = true;
void _failureLikelihoodsAreExhaustive;

const IMPACT_LEVEL_VALUES = ['high', 'medium', 'low'] as const;
type _AssertImpactLevels = Exclude<
  ImpactLevel,
  (typeof IMPACT_LEVEL_VALUES)[number]
> extends never
  ? true
  : never;
const _impactLevelsAreExhaustive: _AssertImpactLevels = true;
void _impactLevelsAreExhaustive;

export const failureLikelihoodSchema = z.enum(FAILURE_LIKELIHOOD_VALUES);
export const impactLevelSchema = z.enum(IMPACT_LEVEL_VALUES);

// ═════════════════════════════════════════════════════════════════════════════
// Primitives
// ═════════════════════════════════════════════════════════════════════════════

const isoDate = z
  .string()
  .trim()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Expected an ISO-8601 timestamp');

/** HARD RULE 7 — `changes.row_version`, and never optional. */
const baseRowVersion = z.coerce.number().int().min(1);

/** Body text, capped where the column is capped. */
const markdown = z.string().max(LIMITS.bodyMaxBytes);

/**
 * A reason a human types to justify overriding an engine.
 *
 * `min(3)` after trimming, because three of the CHECK constraints in migration
 * 011 (`changes_risk_override_ck`, `changes_freeze_override_ck`,
 * `changes_conflict_ack_ck`) demand `btrim(reason) <> ''` and a single
 * character is not a reason. Refusing here answers 400 with `fieldErrors.reason`
 * pointing at the box; letting it through answers 23514, which no client can
 * render and no operator can act on.
 */
const overrideReason = z.string().trim().min(3).max(2000);

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
 * `true`, so `?implementing=false` would ask for the opposite of what it says.
 * Parse the words people actually type instead.
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

/**
 * `conflictDigest()` and `changeConflictRowDigest()` in shared return four
 * 32-bit FNV lanes rendered as 32 lowercase hex characters. Pinning the shape
 * here means a client that sends a truncated or upper-cased digest gets a 400
 * naming the field rather than a 409 that reads like somebody else edited the
 * change.
 */
const conflictDigestSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[0-9a-f]{32}$/, 'Expected a 32-character conflict digest');

// ═════════════════════════════════════════════════════════════════════════════
// Path parameters
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `:ticketId`, not `:id` — the primary key of `changes` IS the change's ticket
 * id, and naming it after the ticket is what stops somebody passing a
 * `change_conflicts.id` and getting a plausible-looking 404.
 */
export const changeParamsSchema = z.object({ ticketId: idSchema });

// ═════════════════════════════════════════════════════════════════════════════
// The board
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `GET /api/changes`.
 *
 * Offset paged rather than keyset, like the problem board and unlike the ticket
 * queue: a change calendar is tens of rows a human reads top to bottom, not a
 * virtualised list of a hundred thousand.
 *
 * `statusCategory` filters on the TICKET's category, never on a status slug
 * (HARD RULE 5) — a tenant renaming "Scheduled" to "Booked in" must not
 * silently empty this board.
 *
 * `implementing` is the DERIVED state: an actual window that is open above.
 * There is no ninth status category for it and there must never be one.
 */
export const listChangesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(PAGINATION.maxLimit).optional(),

  changeType: csv(z.enum(CHANGE_TYPES)),
  risk: csv(z.enum(CHANGE_RISKS)),
  outcome: csv(z.enum(CHANGE_OUTCOMES)),
  statusCategory: csv(z.enum(STATUS_CATEGORIES)),

  queueSlug: slugSchema.optional(),
  assigneeId: idSchema.optional(),
  ciId: idSchema.optional(),
  major: boolParam,

  /** Only changes whose planned window intersects [from, to]. */
  windowFrom: isoDate.optional(),
  windowTo: isoDate.optional(),

  implementing: boolParam,
  pirOutstanding: boolParam,
  minConflictSeverity: z.enum(CHANGE_CONFLICT_SEVERITIES).optional(),

  /** Free text against `changes.search_tsv` plus the ticket subject trigram. */
  q: z.string().trim().max(512).optional(),

  sort: z.enum(['planned_start_at', 'created_at', 'risk', 'pir_due_at']).optional(),
  direction: z.enum(['asc', 'desc']).optional(),
});

/**
 * `GET /api/changes/schedule` — the forward calendar off `changes_board`.
 *
 * Both bounds are REQUIRED, and they are the pagination: a scheduler asks for a
 * week or a month, and an unbounded forward schedule is a full-table scan
 * rendered as an infinite scroll. `to > from` is refused here rather than
 * returned empty, because an inverted range is a caller bug and answering it
 * with a clean board is how a caller bug survives to production.
 */
export const changeScheduleQuerySchema = z
  .object({
    from: isoDate,
    to: isoDate,
    queueSlug: slugSchema.optional(),
  })
  .strict()
  .refine((value) => Date.parse(value.to) > Date.parse(value.from), {
    message: 'The end of the range must be after its start',
    path: ['to'],
  });

// ═════════════════════════════════════════════════════════════════════════════
// Creation — a THIN record, deliberately
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The ticket half of `POST /api/changes`, when the caller is opening a new
 * ticket rather than attaching a change record to one that exists.
 *
 * Derived from `createTicketSchema` rather than restated, so the intake fields
 * a change accepts stay in step with the ones a ticket accepts. Two keys are
 * taken away and one is given back as a refusal:
 *
 *   `recordType` is REMOVED. This route creates changes; letting the body ask
 *   for `incident` would make `POST /api/changes` a second, unguarded door onto
 *   ticket creation. The service stamps `'change'` itself.
 *
 *   `occurredAt` is REFUSED BY NAME (HARD RULE 6). It is not merely stripped:
 *   `tickets.occurred_at` is the column Rewind rests on, it means "when did
 *   this happen to us", and a change has not happened yet. A client that sends
 *   the planned start here gets a message saying which field it wanted, rather
 *   than a change that silently claims to have occurred next Tuesday.
 *
 * `.strict()` closes the rest: an unknown key in an intake payload is a client
 * that thinks it is configuring something.
 */
export const changeTicketDraftSchema = createTicketSchema
  .omit({ recordType: true, occurredAt: true })
  .extend({
    occurredAt: z
      .undefined({
        invalid_type_error:
          'A change has no occurred_at. Use plannedStartAt / plannedEndAt on the window route (HARD RULE 6).',
      })
      .optional(),
  })
  .strict();

/**
 * `POST /api/changes` — bring a change record into existence.
 *
 * THIN ON PURPOSE, and this is the trap the Problems module fell into: a create
 * form that posts an empty field the schema refuses answers 400 on every click.
 * Nothing here is required but the target ticket. No plan, no window, no risk,
 * no likelihood — a change is created as an intention and filled in afterwards
 * (HARD RULE 12).
 *
 * `changeType` is optional even though it is the one field that structurally
 * matters (an emergency MUST be inserted with `pir_required = true` or
 * `changes_emergency_pir_ck` fires). Its default lives in the column and in the
 * service, and a zod `.default('normal')` here would be a second copy of that
 * default in a file that has no business holding one.
 *
 * Exactly one of `ticketId` and `ticket`: attach to a ticket that exists, or
 * open one. Accepting both would leave the service guessing which the caller
 * meant, and guessing is how a change gets attached to the wrong ticket.
 */
export const createChangeSchema = z
  .object({
    /** Attach to an existing ticket. Its `record_type` must already be `change`. */
    ticketId: idSchema.optional(),
    /** Or open a new one. */
    ticket: changeTicketDraftSchema.optional(),

    changeType: z.enum(CHANGE_TYPES).optional(),
    /** A template to copy plans from. `POST /from-model` is the explicit door. */
    modelSlug: slugSchema.optional(),
  })
  .strict()
  .refine((value) => (value.ticketId === undefined) !== (value.ticket === undefined), {
    message: 'Provide exactly one of ticketId or ticket',
    path: ['ticketId'],
  });

/**
 * `POST /api/changes/from-model` — a change built from a published
 * `change_model`.
 *
 * `changeType` is absent from the wire because the MODEL carries it. Letting
 * the caller send one would mean a "standard, pre-approved" template could be
 * instantiated as an emergency by whoever wrote the request body.
 *
 * The plans are COPIED into the row and the model is stamped by slug and
 * version (HARD RULE 3 / 4); the row never references the template afterwards,
 * so editing the template does not rewrite plans that are already executing.
 *
 * The window is optional here even though a model may carry
 * `defaultDurationMinutes`: sending only `plannedStartAt` lets the service
 * derive the end from the model, which is the whole point of a model.
 */
export const createChangeFromModelSchema = z
  .object({
    modelSlug: slugSchema,

    ticketId: idSchema.optional(),
    ticket: changeTicketDraftSchema.optional(),

    plannedStartAt: isoDate.optional(),
    plannedEndAt: isoDate.optional(),
  })
  .strict()
  .refine((value) => (value.ticketId === undefined) !== (value.ticket === undefined), {
    message: 'Provide exactly one of ticketId or ticket',
    path: ['ticketId'],
  })
  .refine((value) => value.plannedEndAt === undefined || value.plannedStartAt !== undefined, {
    message: 'plannedEndAt needs a plannedStartAt',
    path: ['plannedStartAt'],
  })
  .refine(
    (value) =>
      value.plannedStartAt === undefined ||
      value.plannedEndAt === undefined ||
      Date.parse(value.plannedEndAt) > Date.parse(value.plannedStartAt),
    { message: 'The window must end after it starts', path: ['plannedEndAt'] },
  );

/** `GET /api/changes/models` — what the "start from a template" picker reads. */
export const listChangeModelsQuerySchema = z
  .object({
    /** Retired templates, for an administrator auditing what changed. */
    includeInactive: boolParam,
  })
  .strict();

// ═════════════════════════════════════════════════════════════════════════════
// Inline autosave
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `PATCH /api/changes/:ticketId` — inline autosave, one field at a time.
 *
 * Validates SHAPE and nothing else (HARD RULE 12). A backout plan that says
 * "TODO" saves happily; the change simply cannot be scheduled, and the refusal
 * comes from `evaluateChangeSchedule`, which the client runs too.
 *
 * WHAT IS DELIBERATELY NOT HERE, AND WHY — this list is the reason the schema
 * is `.strict()`:
 *
 *   `plannedStartAt` / `plannedEndAt` → `PUT /:ticketId/window` [change_schedule].
 *      Setting a window must recompute conflicts synchronously and return them
 *      while the date picker is still open. Autosaving a window would be a
 *      scheduling decision taken with no conflict scan and no decision row.
 *   `risk` → `POST /:ticketId/risk/override` [change_rw], which demands a
 *      reason `changes_risk_override_ck` will not let it forget.
 *   `outcome` → `POST /:ticketId/outcome`, which arms the PIR on the same path.
 *   `pirFindingsMd` / `pirCausedIncident` / `pirCompletedAt` →
 *      `POST /:ticketId/review`, behind `evaluateChangeReview`.
 *   `conflictAck*` → `POST /:ticketId/conflicts/acknowledge` [change_schedule].
 *   `freezeOverride*` → `POST /:ticketId/freeze/override`
 *      [change_freeze_override], the one capability no preset grants.
 *   `implementationStartedAt` / `implementationEndedAt` → the two implementation
 *      routes, which record `source: 'observed'` because somebody watched it.
 *   `riskComputed`, `baseline*`, `policy*`, `model*` → engine columns. A human
 *      typing into `baseline_start_at` would be editing the yardstick on-time
 *      delivery is measured with.
 *
 * `changeType` IS here, because it is a dropdown on the form. The service must
 * arm `pir_required` in the SAME UPDATE when it moves to `emergency`, or
 * `changes_emergency_pir_ck` fires (23514).
 */
export const updateChangeSchema = z
  .object({
    baseRowVersion,

    changeType: z.enum(CHANGE_TYPES).optional(),
    /** The likelihood axis of the risk matrix. Impact lives on the ticket. */
    failureLikelihood: failureLikelihoodSchema.nullish(),

    implementationMd: markdown.nullish(),
    backoutMd: markdown.nullish(),
    testMd: markdown.nullish(),

    /**
     * "There is nothing to back out." Legal, and expensive: `canWaiveBackout`
     * reads the MATRIX band, so a human override of `risk` cannot unlock it,
     * and `changes_backout_waiver_ck` refuses the flag without a reason. Both
     * of those refusals are the service's and the gate's; this schema only
     * insists the reason is text.
     */
    backoutNotApplicable: z.boolean().optional(),
    backoutWaiverReason: z.string().trim().max(2000).nullish(),

    major: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== 'baseRowVersion'), {
    message: 'Nothing to update',
  });

// ═════════════════════════════════════════════════════════════════════════════
// The window
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `PUT /api/changes/:ticketId/window` — when the work is planned to happen.
 *
 * A PUT because the window is a PAIR: `changes_planned_pair_ck` says
 * `(start IS NULL) = (end IS NULL)`, so there is no such thing as patching one
 * half. Both null unschedules the change.
 *
 * The two refinements mirror `changes_planned_pair_ck` and
 * `changes_planned_order_ck` exactly. They are shape, not judgement: without
 * them the only refusal for `end <= start` is a raw 23514 that reaches the
 * client as an opaque 500. Everything the gate judges — lead time, freezes,
 * unacknowledged conflicts — is deliberately absent, because the client renders
 * those from `evaluateChangeSchedule` live as the operator drags the date, and
 * a second opinion here would disagree with it on the day one of them is fixed.
 *
 * HARD RULE 6: this is the THIRD kind of time on the record. `occurred_at` is
 * when something happened to you (NULL forever on a change), `created_at` is
 * when the row appeared, and this is when the work is INTENDED. The actual
 * window is a fourth, and only the two implementation routes write it.
 */
export const setChangeWindowSchema = z
  .object({
    baseRowVersion,
    plannedStartAt: isoDate.nullable(),
    plannedEndAt: isoDate.nullable(),
  })
  .strict()
  .refine((value) => (value.plannedStartAt === null) === (value.plannedEndAt === null), {
    message: 'A planned window needs both ends, or neither',
    path: ['plannedEndAt'],
  })
  .refine(
    (value) =>
      value.plannedStartAt === null ||
      value.plannedEndAt === null ||
      Date.parse(value.plannedEndAt) > Date.parse(value.plannedStartAt),
    { message: 'The window must end after it starts', path: ['plannedEndAt'] },
  );

// ═════════════════════════════════════════════════════════════════════════════
// Risk
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `POST /api/changes/:ticketId/risk/override` — a human disagrees with the
 * matrix.
 *
 * The override writes `changes.risk` and leaves `changes.risk_computed` alone
 * forever: the matrix's answer is evidence and is never edited. After it, a
 * recompute that lands somewhere else writes a `change_risk_drifted` row with
 * `outcome: noop` instead of quietly taking the band back — the human stays in
 * charge until another human says otherwise.
 *
 * The reason is mandatory here rather than at the gate, and answers 400 with
 * `fieldErrors.reason` rather than 422: a blank justification is a malformed
 * body, not a refused decision. `changes_risk_override_ck` is the backstop
 * behind it, and a backstop that fires is a bug in this line.
 */
export const overrideChangeRiskSchema = z
  .object({
    baseRowVersion,
    risk: z.enum(CHANGE_RISKS),
    reason: overrideReason,
  })
  .strict();

// ═════════════════════════════════════════════════════════════════════════════
// Approvals
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `POST /api/changes/:ticketId/approvals/request` — send it to the CAB.
 *
 * The body carries nothing but the row version, and that is the design: WHICH
 * approvals are needed is `selectChangeApprovals`'s answer, read off the
 * `change_policy` from the change's own type, band, worst CI criticality and
 * queue. A caller naming its own approver list would be a caller choosing its
 * own reviewers.
 *
 * The route runs `evaluateChangeSchedule` before starting anything, so an
 * incomplete change cannot occupy a CAB agenda slot.
 */
export const requestChangeApprovalsSchema = z.object({ baseRowVersion }).strict();

// ═════════════════════════════════════════════════════════════════════════════
// Conflicts
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `GET /api/changes/:ticketId/conflicts` — the cached panel.
 *
 * `includeCleared` shows the history: a conflict that cleared because the
 * neighbour moved is worth seeing next to one that is live, and the row is
 * cleared rather than deleted precisely so it can be.
 */
export const listChangeConflictsQuerySchema = z
  .object({
    includeCleared: boolParam,
    kind: csv(z.enum(CHANGE_CONFLICT_KINDS)),
    severity: csv(z.enum(CHANGE_CONFLICT_SEVERITIES)),
  })
  .strict();

/**
 * `POST /api/changes/:ticketId/conflicts/acknowledge` — "I have seen these".
 *
 * The digest is REQUIRED and is not decoration. Acknowledging is not a
 * permanent state; it is a statement about a specific SET of conflicts, and the
 * service answers 409 when the digest does not match
 * `conflictDigest(acknowledgeableConflicts(live))` recomputed at that instant.
 * Without it, one click at 09:00 buys immunity from everything discovered at
 * 16:00 — a rubber stamp with a database column behind it.
 *
 * Note `acknowledgeableConflicts`: freezes are stored as conflict rows so the
 * operator reads one panel, but a freeze is OVERRIDDEN behind a different
 * capability and is never acknowledged. Both sides compute the digest over the
 * same filtered set.
 */
export const acknowledgeChangeConflictsSchema = z
  .object({
    baseRowVersion,
    reason: overrideReason,
    digest: conflictDigestSchema,
  })
  .strict();

// ═════════════════════════════════════════════════════════════════════════════
// Freeze
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `POST /api/changes/:ticketId/freeze/override` — go through a change freeze.
 *
 * `slugs` is REQUIRED and non-empty. An override that names nothing would
 * bypass every freeze in force at once and store `[]` in
 * `freeze_override_slugs`, leaving "which freeze did you go through?" with no
 * answer in the one column that exists to hold it (HARD RULE 3). Naming them
 * also means a freeze that comes into force AFTER the override still blocks,
 * which is the behaviour anyone reading the audit trail would assume.
 *
 * This is the only route in the module behind `change_freeze_override`, a
 * capability deliberately granted by no permission preset. The gate it runs is
 * `evaluateChangeFreezeOverride`, NOT `isChangeFrozen` — the latter is a read
 * predicate that paints a banner, and a read predicate must never authorise a
 * write.
 */
export const overrideChangeFreezeSchema = z
  .object({
    baseRowVersion,
    reason: overrideReason,
    slugs: z.array(slugSchema).min(1).max(32),
  })
  .strict();

// ═════════════════════════════════════════════════════════════════════════════
// Implementation, outcome and the review
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `POST /api/changes/:ticketId/implementation/start` and `/finish`.
 *
 * Explicit acts, not side effects of a status transition, and they record
 * `source: 'observed'` because somebody was there. The row version is the whole
 * body: "we started" carries no options.
 *
 * The asymmetry worth knowing: when a change is RESOLVED with the actual window
 * still open, `onChangeResolved` stamps the end and records it as
 * `source: 'inferred'` under a different decision key. A row that claims
 * somebody watched the work finish, when all we saw was a status change, is
 * worse than no row at all.
 */
export const changeImplementationSchema = z.object({ baseRowVersion }).strict();

/**
 * `POST /api/changes/:ticketId/outcome` — how it actually went.
 *
 * The outcome is what arms the PIR: `isPirOwed` reads it together with the
 * change type, `major`, and the policy's `pirRequired`, and `pir_due_at` is
 * computed on the policy's calendar in the same transaction.
 * `changes_outcome_pair_ck` keeps the outcome and its timestamp together.
 */
export const recordChangeOutcomeSchema = z
  .object({
    baseRowVersion,
    outcome: z.enum(CHANGE_OUTCOMES),
  })
  .strict();

/**
 * `POST /api/changes/:ticketId/review` — complete the post-implementation
 * review.
 *
 * EVERY FIELD BUT THE ROW VERSION IS OPTIONAL, ON PURPOSE, and this is not
 * laxity. `evaluateChangeReview` refuses a review with blank findings
 * (`change_pir_findings_missing`), with no explicit answer to "did this cause
 * an incident?" (`change_pir_incident_answer_missing`), and with a `true`
 * answer and no incident linked (`change_pir_incident_link_missing`). Those
 * refusals arrive as 422 with blocker codes the UI already renders, because the
 * client runs the same evaluator to grey the button out.
 *
 * Restating them as zod requirements would put a second, divergent
 * implementation in the one place nobody would think to look, and would answer
 * `pirFindingsMd: Required` where the shared evaluator answers "a review that
 * says nothing is not a review" in the operator's language.
 *
 * `pirCompletedBy` is the session's user and is never on the wire —
 * `changes_pir_completed_ck` demands it alongside `pir_completed_at`.
 */
export const completeChangeReviewSchema = z
  .object({
    baseRowVersion,
    pirFindingsMd: markdown.nullish(),
    pirCausedIncident: z.boolean().nullish(),
    /** The incidents this change caused. Required by the gate when the answer is yes. */
    incidentTicketIds: z.array(idSchema).max(LIMITS.bulkMaxTickets).optional(),
  })
  .strict();

// ═════════════════════════════════════════════════════════════════════════════
// Inferred body types, so the service layer and the routes agree by compiler
// ═════════════════════════════════════════════════════════════════════════════

export type ListChangesQuery = z.infer<typeof listChangesQuerySchema>;
export type ChangeScheduleQuery = z.infer<typeof changeScheduleQuerySchema>;
export type CreateChangeBody = z.infer<typeof createChangeSchema>;
export type CreateChangeFromModelBody = z.infer<typeof createChangeFromModelSchema>;
export type ListChangeModelsQuery = z.infer<typeof listChangeModelsQuerySchema>;
export type UpdateChangeBody = z.infer<typeof updateChangeSchema>;
export type SetChangeWindowBody = z.infer<typeof setChangeWindowSchema>;
export type OverrideChangeRiskBody = z.infer<typeof overrideChangeRiskSchema>;
export type RequestChangeApprovalsBody = z.infer<typeof requestChangeApprovalsSchema>;
export type ListChangeConflictsQuery = z.infer<typeof listChangeConflictsQuerySchema>;
export type AcknowledgeChangeConflictsBody = z.infer<typeof acknowledgeChangeConflictsSchema>;
export type OverrideChangeFreezeBody = z.infer<typeof overrideChangeFreezeSchema>;
export type ChangeImplementationBody = z.infer<typeof changeImplementationSchema>;
export type RecordChangeOutcomeBody = z.infer<typeof recordChangeOutcomeSchema>;
export type CompleteChangeReviewBody = z.infer<typeof completeChangeReviewSchema>;
export type ChangeTicketDraft = z.infer<typeof changeTicketDraftSchema>;
