/**
 * ticket.validators.ts — the shape of everything the desk accepts.
 *
 * Two things this file is careful about:
 *
 * 1. IT NEVER VALIDATES REQUIRED-NESS OF TICKET FIELDS (HARD RULE 12). Every
 *    field on `updateTicketSchema` is optional, on purpose. Required-ness is a
 *    property of a STATE TRANSITION, evaluated by the shared evaluator, and a
 *    zod schema that quietly enforced it here would put a second, divergent
 *    implementation in the one place nobody would think to look.
 *
 * 2. `baseRowVersion` is REQUIRED on every mutation (HARD RULE 7). Making it
 *    optional "for convenience" would silently turn optimistic concurrency into
 *    last-write-wins for whichever client forgot it.
 *
 * Query parameters arrive as strings, so list filters go through `csv()` and
 * `z.coerce`; the schema is the only place that conversion happens.
 */
import { z } from 'zod';
import {
  JOURNAL_KINDS,
  LIMITS,
  PAGINATION,
  STATUS_CATEGORIES,
  TICKET_RECORD_TYPES,
  TICKET_SOURCES,
} from '@oblidesk/shared';

// ═════════════════════════════════════════════════════════════════════════════
// Primitives
// ═════════════════════════════════════════════════════════════════════════════

/** A configuration slug (HARD RULE 3 — cross-references are slugs, never ids). */
export const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, 'Slugs are letters, digits, dot, dash and underscore');

export const idSchema = z.coerce.number().int().positive();

export const idParamSchema = z.object({ id: idSchema });
export const ticketIdParamSchema = z.object({ ticketId: idSchema });

const isoDate = z
  .string()
  .trim()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Expected an ISO-8601 timestamp');

const levelSchema = z.enum(['high', 'medium', 'low']);
const visibilitySchema = z.enum(['public', 'internal']);

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
 * `true`, so `?includeDeleted=false` would delete-include everything. Parse the
 * words people actually type instead.
 */
const boolParam = z.preprocess((value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(lowered)) return true;
    if (['0', 'false', 'no', 'off', ''].includes(lowered)) return false;
  }
  return undefined;
}, z.boolean().optional());

/** A filter tree may arrive as JSON in a query string. */
const jsonObject = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}, z.unknown());

// ═════════════════════════════════════════════════════════════════════════════
// Conditions
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Accepts BOTH stored dialects — `{ all: [...] }` (the shared DTO) and
 * `{ op: 'and', children: [...] }` (the export/seed format) — because both are
 * genuinely in the database. `stateMachine.service#toConditionNode` normalises
 * them; this only checks the tree is well-formed and not absurdly deep.
 */
export const conditionNodeSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(conditionNodeSchema).max(64) }),
    z.object({ any: z.array(conditionNodeSchema).max(64) }),
    z.object({ not: conditionNodeSchema }),
    z.object({
      op: z.string().trim().min(1).max(32),
      field: z.string().trim().min(1).max(200).optional(),
      value: z.unknown().optional(),
      children: z.array(conditionNodeSchema).max(64).optional(),
    }),
    z.object({
      field: z.string().trim().min(1).max(200),
      op: z.string().trim().min(1).max(32),
      value: z.unknown().optional(),
    }),
  ]),
);

// ═════════════════════════════════════════════════════════════════════════════
// Create
// ═════════════════════════════════════════════════════════════════════════════

export const createTicketSchema = z.object({
  subject: z.string().trim().min(1).max(LIMITS.subjectMaxLength),
  descriptionMd: z.string().max(LIMITS.bodyMaxBytes).nullish(),
  recordType: z.enum(TICKET_RECORD_TYPES).optional(),
  source: z.enum(TICKET_SOURCES).optional(),

  /**
   * HARD RULE 6 — when it actually HAPPENED. Optional on the wire because a
   * portal form may not ask, and defaulted to `now` server-side; it is never
   * derived from `created_at` afterwards, because by then the answer is lost.
   */
  occurredAt: isoDate.optional(),

  statusSlug: slugSchema.optional(),
  prioritySlug: slugSchema.optional(),
  /** Required when `prioritySlug` disagrees with the impact × urgency matrix. */
  priorityOverrideReason: z.string().trim().min(3).max(500).nullish(),
  impact: levelSchema.optional(),
  urgency: levelSchema.optional(),

  queueSlug: slugSchema.optional(),
  assignmentGroupId: idSchema.nullish(),
  assigneeId: idSchema.nullish(),
  requesterContactId: idSchema.nullish(),
  requesterUserId: idSchema.nullish(),
  organizationId: idSchema.nullish(),
  primaryCiId: idSchema.nullish(),
  parentTicketId: idSchema.nullish(),

  data: z.record(z.unknown()).optional(),
  attachmentIds: z.array(idSchema).max(LIMITS.attachmentsPerMessage).optional(),
  catalogItemSlug: slugSchema.nullish(),
});

export type CreateTicketBody = z.infer<typeof createTicketSchema>;

// ═════════════════════════════════════════════════════════════════════════════
// Update — every field optional, none of them required-checked
// ═════════════════════════════════════════════════════════════════════════════

export const updateTicketSchema = z
  .object({
    // HARD RULE 7 — not optional, ever.
    baseRowVersion: z.coerce.number().int().min(1),

    subject: z.string().trim().min(1).max(LIMITS.subjectMaxLength).optional(),
    descriptionMd: z.string().max(LIMITS.bodyMaxBytes).nullish(),
    prioritySlug: slugSchema.optional(),
    priorityOverrideReason: z.string().trim().min(3).max(500).nullish(),
    impact: levelSchema.optional(),
    urgency: levelSchema.optional(),
    queueSlug: slugSchema.optional(),
    assignmentGroupId: idSchema.nullish(),
    assigneeId: idSchema.nullish(),
    requesterContactId: idSchema.nullish(),
    organizationId: idSchema.nullish(),
    primaryCiId: idSchema.nullish(),
    occurredAt: isoDate.optional(),
    dueAt: isoDate.nullish(),
    resolutionCode: z.string().trim().max(64).nullish(),
    resolutionMd: z.string().max(LIMITS.bodyMaxBytes).nullish(),
    /** Partial patch of the custom-field bag — MERGED server-side, not replaced. */
    data: z.record(z.unknown()).optional(),
  })
  .refine(
    (value) => Object.keys(value).some((key) => key !== 'baseRowVersion'),
    { message: 'Nothing to update' },
  );

export type UpdateTicketBody = z.infer<typeof updateTicketSchema>;

// ═════════════════════════════════════════════════════════════════════════════
// Transition — the one place required-ness is enforced (by the evaluator)
// ═════════════════════════════════════════════════════════════════════════════

export const transitionSchema = z.object({
  baseRowVersion: z.coerce.number().int().min(1),
  toStatusSlug: slugSchema,
  /**
   * Values the transition dialog collected. NOT validated for completeness
   * here — `stateMachine.service` runs the shared evaluator against the
   * machine's `required_fields`, which is the only definition of "complete".
   */
  fields: z.record(z.unknown()).optional(),
  comment: z
    .object({
      bodyMd: z.string().trim().min(1).max(LIMITS.bodyMaxBytes),
      visibility: visibilitySchema,
    })
    .nullish(),
  resolutionCode: z.string().trim().max(64).nullish(),
  resolutionMd: z.string().max(LIMITS.bodyMaxBytes).nullish(),
});

export type TransitionBody = z.infer<typeof transitionSchema>;

// ═════════════════════════════════════════════════════════════════════════════
// List / search
// ═════════════════════════════════════════════════════════════════════════════

/** Mirrors `SORTABLE` in ticket.service — an unlisted value is refused there too. */
export const SORT_FIELDS = [
  'updated_at',
  'created_at',
  'occurred_at',
  'due_at',
  'first_response_at',
  'resolved_at',
  'closed_at',
  'number',
  'subject',
  'priority_slug',
  'status_category',
  'queue_slug',
  'reopen_count',
  'id',
] as const;

export const listTicketsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(PAGINATION.maxLimit).optional(),
  /** Opaque keyset cursor. There is no `page` — the queue never pages. */
  cursor: z.string().trim().max(512).optional(),
  withTotal: boolParam,

  viewSlug: slugSchema.optional(),
  filter: jsonObject.optional(),
  q: z.string().trim().max(512).optional(),

  statusCategories: csv(z.enum(STATUS_CATEGORIES)),
  queueSlugs: csv(slugSchema),
  prioritySlugs: csv(slugSchema),
  recordTypes: csv(z.enum(TICKET_RECORD_TYPES)),
  sources: csv(z.enum(TICKET_SOURCES)),
  // `0` is the UI's "unassigned" sentinel, so this one allows non-positive ids.
  assigneeIds: csv(z.coerce.number().int()),
  assignmentGroupIds: csv(idSchema),
  organizationIds: csv(idSchema),
  ciIds: csv(idSchema),

  occurredFrom: isoDate.optional(),
  occurredTo: isoDate.optional(),
  createdFrom: isoDate.optional(),
  createdTo: isoDate.optional(),
  updatedFrom: isoDate.optional(),
  updatedTo: isoDate.optional(),

  breachingWithinMinutes: z.coerce.number().int().min(0).max(60 * 24 * 30).optional(),
  includeDeleted: boolParam,

  sortBy: z.enum(SORT_FIELDS).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
});

export type ListTicketsQueryBody = z.infer<typeof listTicketsQuerySchema>;

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(512),
  limit: z.coerce.number().int().min(1).max(PAGINATION.maxLimit).optional(),
});

export const suggestQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(25).optional(),
});

// ═════════════════════════════════════════════════════════════════════════════
// Journal
// ═════════════════════════════════════════════════════════════════════════════

export const createJournalEntrySchema = z.object({
  /**
   * Only a human-authored kind may be posted through the API. `system`,
   * `automation` and friends are written by the engines that took the action —
   * letting a client forge one would make the timeline unfalsifiable.
   */
  kind: z.enum(['public_reply', 'work_note']),
  /** The visibility COLUMN, sent explicitly rather than inferred from `kind`. */
  visibility: visibilitySchema,
  bodyMd: z.string().trim().min(1).max(LIMITS.bodyMaxBytes),
  attachmentIds: z.array(idSchema).max(LIMITS.attachmentsPerMessage).optional(),
  ccEmails: z.array(z.string().trim().email()).max(50).optional(),
  macroSlug: slugSchema.nullish(),
});

export type CreateJournalEntryBody = z.infer<typeof createJournalEntrySchema>;

export const listJournalQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(PAGINATION.maxLimit).optional(),
  afterSeq: z.coerce.number().int().min(0).optional(),
  beforeSeq: z.coerce.number().int().min(1).optional(),
  direction: z.enum(['asc', 'desc']).optional(),
  visibility: visibilitySchema.optional(),
  kinds: csv(z.enum(JOURNAL_KINDS)),
});

// ═════════════════════════════════════════════════════════════════════════════
// Merge / split / reopen
// ═════════════════════════════════════════════════════════════════════════════

export const mergeTicketsSchema = z.object({
  sourceTicketIds: z.array(idSchema).min(1).max(50),
  targetTicketId: idSchema,
  comment: z.string().trim().max(LIMITS.bodyMaxBytes).nullish(),
});

export const revertMergeSchema = z.object({
  /** The `merge` journal entry that carries the manifest. */
  manifestJournalId: idSchema,
});

export const splitTicketSchema = z.object({
  subject: z.string().trim().min(1).max(LIMITS.subjectMaxLength),
  descriptionMd: z.string().max(LIMITS.bodyMaxBytes).nullish(),
  /** Entries to QUOTE into the child. They are never moved off this ticket. */
  quoteJournalIds: z.array(idSchema).max(100).optional(),
  queueSlug: slugSchema.nullish(),
  assigneeId: idSchema.nullish(),
  assignmentGroupId: idSchema.nullish(),
  recordType: z.enum(TICKET_RECORD_TYPES).optional(),
});

export const reopenTicketSchema = z.object({
  reason: z.string().trim().max(500).nullish(),
  comment: z.string().trim().max(LIMITS.bodyMaxBytes).nullish(),
  viaJournalId: idSchema.nullish(),
});

// ═════════════════════════════════════════════════════════════════════════════
// Bulk
// ═════════════════════════════════════════════════════════════════════════════

const bulkPatchSchema = z
  .object({
    prioritySlug: slugSchema.optional(),
    queueSlug: slugSchema.optional(),
    assigneeId: idSchema.nullish(),
    assignmentGroupId: idSchema.nullish(),
    impact: levelSchema.optional(),
    urgency: levelSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to set' });

export const bulkPreviewSchema = z.object({
  ticketIds: z.array(idSchema).min(1).max(LIMITS.bulkMaxTickets),
  set: bulkPatchSchema,
});

export const bulkApplySchema = z.object({
  ticketIds: z.array(idSchema).min(1).max(LIMITS.bulkMaxTickets),
  /** Every ticket is checked against ITS OWN row version (HARD RULE 7). */
  baseRowVersions: z.record(z.coerce.number().int().min(1)).default({}),
  set: bulkPatchSchema,
});

export const bulkUndoSchema = z.object({
  undoToken: z.string().trim().uuid(),
});

// ═════════════════════════════════════════════════════════════════════════════
// Links, watchers, attachments
// ═════════════════════════════════════════════════════════════════════════════

export const createTicketLinkSchema = z.object({
  toTicketId: idSchema,
  // `merged_from` is absent on purpose: merge links are written by merge(),
  // together with the manifest that makes them reversible. `caused_by` is
  // absent for the same shape of reason: an incident to problem link carries
  // rollups, a decision row and an anti-double-link guard, and only
  // `POST /api/problems/:ticketId/incidents` supplies them. Refusing it here
  // makes it a readable field error instead of a 400 from three frames down.
  kind: z.enum(['related', 'duplicate', 'blocks', 'child']),
});

export const watcherSchema = z
  .object({
    userId: idSchema.optional(),
    contactId: idSchema.optional(),
    reason: z.enum(['manual', 'assignee', 'requester', 'mentioned', 'group', 'rule']).optional(),
  })
  .refine(
    (value) => Boolean(value.userId) !== Boolean(value.contactId),
    { message: 'Provide exactly one of userId or contactId' },
  );

export const attachmentEntitySchema = z.object({
  entityType: z.enum(['ticket', 'journal', 'kb_article', 'mail_message', 'catalog_request']),
  entityId: idSchema,
});

export const linkAttachmentSchema = attachmentEntitySchema.extend({
  inlineCid: z.string().trim().max(191).nullish(),
});

export const listAttachmentsQuerySchema = attachmentEntitySchema;

export const uploadAttachmentSchema = z.object({
  entityType: z
    .enum(['ticket', 'journal', 'kb_article', 'mail_message', 'catalog_request'])
    .optional(),
  entityId: idSchema.optional(),
  inlineCid: z.string().trim().max(191).nullish(),
});

export const deleteTicketSchema = z.object({
  baseRowVersion: z.coerce.number().int().min(1),
});
