/**
 * journal.api.ts — the ticket timeline.
 *
 * The journal is append-only and ordered by `seq`, which is monotonic per
 * ticket with no gaps. That is what makes paging here a SEQ cursor rather than
 * an offset: `afterSeq` walks forward into new entries as they arrive over the
 * socket, `beforeSeq` walks backward into history, and neither can duplicate or
 * skip a row while somebody is typing at the other end.
 *
 * Only `public_reply` and `work_note` may be POSTed. `system`, `state_change`,
 * `automation` and the rest are written by the engine that took the action, on
 * the same code path — a client able to forge one would make the timeline
 * unfalsifiable, and the timeline is the record of what happened.
 */

import apiClient, { toApiError, toQuery, unwrap, type Envelope } from './client';
import type {
  CreateJournalEntryRequest,
  JournalKind,
  JournalVisibility,
  TicketJournalEntry,
} from '@oblidesk/shared';

export interface JournalListParams {
  limit?: number;
  /** Entries strictly after this seq — the "load newer" / catch-up direction. */
  afterSeq?: number;
  /** Entries strictly before this seq — the "load older" direction. */
  beforeSeq?: number;
  direction?: 'asc' | 'desc';
  visibility?: JournalVisibility;
  kinds?: JournalKind[];
}

export interface JournalPage {
  entries: TicketJournalEntry[];
  hasMore: boolean;
  /** Feed back as `beforeSeq` (desc) or `afterSeq` (asc) for the next page. */
  nextSeq: number | null;
}

interface JournalEnvelope extends Envelope<TicketJournalEntry[]> {
  hasMore?: boolean;
  nextSeq?: number | null;
}

export const journalApi = {
  async list(ticketId: number, params: JournalListParams = {}): Promise<JournalPage> {
    try {
      const res = await apiClient.get<JournalEnvelope>(`/tickets/${ticketId}/journal`, {
        params: toQuery({ ...params }),
      });
      return {
        entries: unwrap<TicketJournalEntry[]>(res.data) ?? [],
        hasMore: res.data.hasMore ?? false,
        nextSeq: res.data.nextSeq ?? null,
      };
    } catch (error) {
      throw toApiError(error);
    }
  },

  async getEntry(ticketId: number, entryId: number): Promise<TicketJournalEntry> {
    try {
      const res = await apiClient.get<Envelope<TicketJournalEntry>>(`/tickets/${ticketId}/journal/${entryId}`);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * `visibility` is sent explicitly rather than inferred from `kind`: an
   * internal note on a public thread and a public reply are two different
   * decisions, and conflating them is how an internal note reaches a customer.
   */
  async append(ticketId: number, payload: CreateJournalEntryRequest): Promise<TicketJournalEntry> {
    try {
      const res = await apiClient.post<Envelope<TicketJournalEntry>>(`/tickets/${ticketId}/journal`, payload);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** Convenience wrappers — the composer's two buttons. */
  reply(
    ticketId: number,
    bodyMd: string,
    options: { attachmentIds?: number[]; ccEmails?: string[]; macroSlug?: string | null } = {},
  ): Promise<TicketJournalEntry> {
    return journalApi.append(ticketId, {
      kind: 'public_reply',
      visibility: 'public',
      bodyMd,
      ...options,
    });
  },

  note(
    ticketId: number,
    bodyMd: string,
    options: { attachmentIds?: number[]; macroSlug?: string | null } = {},
  ): Promise<TicketJournalEntry> {
    return journalApi.append(ticketId, {
      kind: 'work_note',
      visibility: 'internal',
      bodyMd,
      ...options,
    });
  },
};

export default journalApi;
