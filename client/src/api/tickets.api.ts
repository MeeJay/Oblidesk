/**
 * tickets.api.ts — the queue and one ticket.
 *
 * Two things here are not the usual CRUD and are worth stating:
 *
 *   • The list is KEYSET-paginated. There is no `page` parameter — the queue is
 *     a virtualised window over ~100k rows, and offset paging on a table that
 *     is being written to shows duplicates and holes. `cursor` is opaque; hand
 *     back exactly what the last page returned.
 *
 *   • Every mutation carries `baseRowVersion` (HARD RULE 7). A mismatch is a
 *     409 with the CURRENT row in the body, which arrives here as an `ApiError`
 *     whose `payload.current` is the row to diff against. Callers must handle
 *     it; swallowing it is how one agent's edit erases another's.
 */

import apiClient, {
  rowVersionHeader,
  toApiError,
  toQuery,
  unwrap,
  type Envelope,
} from './client';
import type {
  BulkTicketResult,
  ConditionNode,
  CreateTicketLinkRequest,
  CreateTicketRequest,
  MergeTicketsRequest,
  StatusCategory,
  Ticket,
  TicketConflict,
  TicketJournalEntry,
  TicketLink,
  TicketRecordType,
  TicketSearchHit,
  TicketSource,
  TicketWatcher,
  TicketWithRelations,
  TransitionEvaluation,
  TransitionTicketRequest,
  UpdateTicketRequest,
  WatcherReason,
} from '@oblidesk/shared';

// ═════════════════════════════════════════════════════════════════════════════
// Queries
// ═════════════════════════════════════════════════════════════════════════════

/** Sort columns the server accepts. Anything else is rejected by its zod enum. */
export const TICKET_SORT_FIELDS = [
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

export type TicketSortField = (typeof TICKET_SORT_FIELDS)[number];

export interface TicketListParams {
  limit?: number;
  /** Opaque keyset cursor from the previous page. Never construct one. */
  cursor?: string | null;
  /** Ask for a total. Costly above the exact-count threshold; off by default. */
  withTotal?: boolean;

  viewSlug?: string;
  filter?: ConditionNode | null;
  q?: string;

  statusCategories?: StatusCategory[];
  queueSlugs?: string[];
  prioritySlugs?: string[];
  recordTypes?: TicketRecordType[];
  sources?: TicketSource[];
  /** `0` is the "unassigned" sentinel the server understands. */
  assigneeIds?: number[];
  assignmentGroupIds?: number[];
  organizationIds?: number[];
  ciIds?: number[];

  /** Filters `occurred_at` — when it HAPPENED, not when we heard (RULE 6). */
  occurredFrom?: string;
  occurredTo?: string;
  createdFrom?: string;
  createdTo?: string;
  updatedFrom?: string;
  updatedTo?: string;

  breachingWithinMinutes?: number;
  includeDeleted?: boolean;
  sortBy?: TicketSortField;
  sortDir?: 'asc' | 'desc';
}

export interface TicketPage {
  items: TicketWithRelations[];
  /** Null when this was the last page. */
  nextCursor: string | null;
  hasMore: boolean;
  total?: number;
  totalIsApproximate?: boolean;
  /**
   * Predicates the compiler could not honour. The list is NARROWER than the
   * caller asked for whenever this is non-empty, and the UI has to say so —
   * a silently narrowed queue is how a ticket goes unseen.
   */
  unsupportedFilters?: string[];
  limit?: number;
}

interface TicketPageEnvelope extends Envelope<TicketWithRelations[]> {
  nextCursor?: string | null;
  hasMore?: boolean;
  total?: number;
  totalIsApproximate?: boolean;
  unsupportedFilters?: string[];
  limit?: number;
}

// ═════════════════════════════════════════════════════════════════════════════
// Mutation payloads that are not in @oblidesk/shared
// ═════════════════════════════════════════════════════════════════════════════

export interface SplitTicketRequest {
  subject: string;
  descriptionMd?: string | null;
  /** Entries QUOTED into the child. They are never moved off this ticket. */
  quoteJournalIds?: number[];
  queueSlug?: string | null;
  assigneeId?: number | null;
  assignmentGroupId?: number | null;
  recordType?: TicketRecordType;
}

export interface ReopenTicketRequest {
  reason?: string | null;
  comment?: string | null;
  viaJournalId?: number | null;
}

export type BulkPatch = Pick<
  UpdateTicketRequest,
  'prioritySlug' | 'queueSlug' | 'assigneeId' | 'assignmentGroupId' | 'impact' | 'urgency'
>;

export interface BulkPreview {
  ticketIds: number[];
  /** What each ticket would become — rendered as the three-column diff. */
  changes: Array<{ ticketId: number; number: string; from: Record<string, unknown>; to: Record<string, unknown> }>;
  blocked: Array<{ ticketId: number; reason: string }>;
}

export interface BulkApplyResult extends BulkTicketResult {
  /** Feed this to `bulkUndo` inside the undo window. */
  undoToken: string | null;
}

export interface MergeResult {
  targetTicketId: number;
  mergedTicketIds: number[];
  /** The `merge` journal entry carrying the manifest that reverses it. */
  manifestJournalId: number;
}

export interface TicketTransitions {
  ticketId: number;
  /** One entry per reachable status, allowed or not, with the reason why not. */
  transitions: TransitionEvaluation[];
}

/** The 409 body, already unwrapped from the `ApiError` payload. */
export function conflictOf(error: unknown): TicketConflict | null {
  const payload = (error as { payload?: Record<string, unknown> })?.payload;
  if (!payload) return null;
  const current = payload.current as TicketWithRelations | undefined;
  if (!current) return null;
  return {
    code: 'version_conflict',
    current,
    conflictingFields: (payload.conflictingFields as string[] | undefined) ?? [],
  };
}

/** The 422 body of a refused transition, for the "what's missing" panel. */
export function evaluationOf(error: unknown): TransitionEvaluation | null {
  const payload = (error as { payload?: Record<string, unknown> })?.payload;
  return (payload?.evaluation as TransitionEvaluation | undefined) ?? null;
}

// ═════════════════════════════════════════════════════════════════════════════
// API
// ═════════════════════════════════════════════════════════════════════════════

export const ticketsApi = {
  async list(params: TicketListParams = {}): Promise<TicketPage> {
    try {
      const res = await apiClient.get<TicketPageEnvelope>('/tickets', { params: toQuery({ ...params }) });
      const body = res.data;
      return {
        items: unwrap<TicketWithRelations[]>(body) ?? [],
        nextCursor: body.nextCursor ?? null,
        hasMore: body.hasMore ?? false,
        total: body.total,
        totalIsApproximate: body.totalIsApproximate,
        unsupportedFilters: body.unsupportedFilters,
        limit: body.limit,
      };
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** Full-text search: `to_tsvector('simple')` + unaccent + trigram. */
  async search(q: string, limit?: number): Promise<TicketSearchHit[]> {
    try {
      const res = await apiClient.get<Envelope<TicketSearchHit[]>>('/tickets/search', {
        params: toQuery({ q, limit }),
      });
      return unwrap(res.data) ?? [];
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** Typeahead for the command palette and the "link a ticket" picker. */
  async suggest(q: string, limit = 8): Promise<Array<Pick<Ticket, 'id' | 'number' | 'subject' | 'statusCategory'>>> {
    try {
      const res = await apiClient.get<Envelope<Array<Pick<Ticket, 'id' | 'number' | 'subject' | 'statusCategory'>>>>(
        '/tickets/suggest',
        { params: toQuery({ q, limit }) },
      );
      return unwrap(res.data) ?? [];
    } catch {
      // A failed typeahead shows nothing; it never interrupts what is typed.
      return [];
    }
  },

  async get(id: number): Promise<TicketWithRelations> {
    try {
      const res = await apiClient.get<Envelope<TicketWithRelations>>(`/tickets/${id}`);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async create(payload: CreateTicketRequest): Promise<TicketWithRelations> {
    try {
      const res = await apiClient.post<Envelope<TicketWithRelations>>('/tickets', payload);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * One field at a time, autosaved. HARD RULE 12: this never validates
   * required-ness — a half-filled ticket is legal all day. Completeness is the
   * transition's business, and only the transition's.
   */
  async update(id: number, payload: UpdateTicketRequest): Promise<TicketWithRelations> {
    try {
      const res = await apiClient.patch<Envelope<TicketWithRelations>>(`/tickets/${id}`, payload, {
        headers: rowVersionHeader(payload.baseRowVersion),
      });
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async remove(id: number, baseRowVersion: number): Promise<void> {
    try {
      await apiClient.delete(`/tickets/${id}`, {
        data: { baseRowVersion },
        headers: rowVersionHeader(baseRowVersion),
      });
    } catch (error) {
      throw toApiError(error);
    }
  },

  async restore(id: number): Promise<TicketWithRelations> {
    try {
      const res = await apiClient.post<Envelope<TicketWithRelations>>(`/tickets/${id}/restore`);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  // ── Transitions ───────────────────────────────────────────────────────────

  /**
   * What the state machine allows from here, with the missing fields and
   * capabilities for the ones it does not. The SAME evaluator runs server-side
   * on the actual move, so the button's tooltip and the refusal always agree.
   */
  async transitions(id: number): Promise<TicketTransitions> {
    try {
      const res = await apiClient.get<Envelope<TicketTransitions>>(`/tickets/${id}/transitions`);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async transition(id: number, payload: TransitionTicketRequest): Promise<TicketWithRelations> {
    try {
      const res = await apiClient.post<Envelope<TicketWithRelations>>(`/tickets/${id}/transition`, payload, {
        headers: rowVersionHeader(payload.baseRowVersion),
      });
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async split(id: number, payload: SplitTicketRequest): Promise<TicketWithRelations> {
    try {
      const res = await apiClient.post<Envelope<TicketWithRelations>>(`/tickets/${id}/split`, payload);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async reopen(id: number, payload: ReopenTicketRequest = {}): Promise<TicketWithRelations> {
    try {
      const res = await apiClient.post<Envelope<TicketWithRelations>>(`/tickets/${id}/reopen`, payload);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  // ── Links and watchers ────────────────────────────────────────────────────

  async listLinks(id: number): Promise<TicketLink[]> {
    const res = await apiClient.get<Envelope<TicketLink[]>>(`/tickets/${id}/links`);
    return unwrap(res.data) ?? [];
  },

  async createLink(id: number, payload: CreateTicketLinkRequest): Promise<TicketLink> {
    try {
      const res = await apiClient.post<Envelope<TicketLink>>(`/tickets/${id}/links`, payload);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async deleteLink(id: number, linkId: number): Promise<void> {
    try {
      await apiClient.delete(`/tickets/${id}/links/${linkId}`);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async listWatchers(id: number): Promise<TicketWatcher[]> {
    const res = await apiClient.get<Envelope<TicketWatcher[]>>(`/tickets/${id}/watchers`);
    return unwrap(res.data) ?? [];
  },

  async addWatcher(
    id: number,
    watcher: { userId?: number; contactId?: number; reason?: WatcherReason },
  ): Promise<TicketWatcher> {
    try {
      const res = await apiClient.post<Envelope<TicketWatcher>>(`/tickets/${id}/watchers`, watcher);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async removeWatcher(id: number, watcher: { userId?: number; contactId?: number }): Promise<void> {
    try {
      await apiClient.delete(`/tickets/${id}/watchers`, { data: watcher });
    } catch (error) {
      throw toApiError(error);
    }
  },

  // ── Bulk ──────────────────────────────────────────────────────────────────

  /** Always preview before applying: the diff is what the confirm dialog shows. */
  async bulkPreview(ticketIds: number[], set: BulkPatch): Promise<BulkPreview> {
    try {
      const res = await apiClient.post<Envelope<BulkPreview>>('/tickets/bulk/preview', { ticketIds, set });
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * `baseRowVersions` is per ticket, not one version for the batch: a bulk edit
   * that clobbers a row somebody changed a second ago is exactly the failure
   * HARD RULE 7 exists to prevent.
   */
  async bulkApply(
    ticketIds: number[],
    baseRowVersions: Record<number, number>,
    set: BulkPatch,
  ): Promise<BulkApplyResult> {
    try {
      const res = await apiClient.post<Envelope<BulkApplyResult>>('/tickets/bulk/apply', {
        ticketIds,
        baseRowVersions,
        set,
      });
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async bulkUndo(undoToken: string): Promise<BulkTicketResult> {
    try {
      const res = await apiClient.post<Envelope<BulkTicketResult>>('/tickets/bulk/undo', { undoToken });
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  // ── Merge ─────────────────────────────────────────────────────────────────

  async merge(payload: MergeTicketsRequest): Promise<MergeResult> {
    try {
      const res = await apiClient.post<Envelope<MergeResult>>('/tickets/merge', payload);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** Reversible while the manifest entry is inside the revert window. */
  async revertMerge(manifestJournalId: number): Promise<{ restoredTicketIds: number[] }> {
    try {
      const res = await apiClient.post<Envelope<{ restoredTicketIds: number[] }>>('/tickets/merge/revert', {
        manifestJournalId,
      });
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },
};

/** Re-exported so a ticket page imports one module, not two. */
export type { TicketJournalEntry };

export default ticketsApi;
