/**
 * portal.api.ts — the requester-facing half of the API, and nothing else.
 *
 * Every other `*.api.ts` module in this folder talks to the TENANT tier, where
 * `requireAuth` + `requireTenant` have already resolved an agent and a tenant.
 * This one talks to `/api/portal`, which sits in the GLOBAL tier behind
 * `requirePortalSession`. Three consequences shape the whole module:
 *
 *   • NO tenant header. A requester's tenant is pinned in the session by the
 *     burned magic-link token, where the browser cannot change it. Sending
 *     `X-Tenant-Id` would be, at best, ignored — at worst it reads like the
 *     client believes it gets a say. The slug is needed exactly once, when
 *     asking for the link, because at that moment there is no session yet.
 *
 *   • NO `baseRowVersion` anywhere (HARD RULE 7). A requester never UPDATEs a
 *     ticket row: they append a reply, and an append cannot clobber a
 *     concurrent edit. The 409-and-rebase dance belongs to the agent surface.
 *
 *   • NO capability checks to mirror. `req.portal` carries no capabilities
 *     field at all, so there is nothing here for the UI to gate on except the
 *     two facts `/me` actually reports: whether the tenant accepts uploads, and
 *     whether this contact may read their organisation's tickets.
 *
 * ── Enumeration ─────────────────────────────────────────────────────────────
 * `requestLink` ALWAYS resolves the same way — unknown tenant, unknown address,
 * deactivated contact, portal switched off, rate limited. The server is
 * deliberately uniform about this and the client must not undo it by inspecting
 * a status code and saying "no such account": that sentence turns the sign-in
 * form into a free customer list for anybody who can guess at addresses.
 */

import apiClient, { toApiError, unwrap, type Envelope } from './client';
import type { StatusCategory } from '@oblidesk/shared';

// ═════════════════════════════════════════════════════════════════════════════
// Types — mirrors of the service's own, kept narrow on purpose
// ═════════════════════════════════════════════════════════════════════════════

/** What a portal contact may READ. Granted by an agent; never claimed here. */
export type PortalOrgVisibility = 'own' | 'organization';

/** What the list is showing. A preference, not a permission — see `listTickets`. */
export type PortalScope = 'mine' | 'organization';

/** `open` hides the archive, `closed` shows only it, `all` shows everything. */
export type PortalTicketState = 'open' | 'closed' | 'all';

export interface PortalMe {
  email: string;
  displayName: string | null;
  organizationId: number | null;
  locale: string;
  tenantSlug: string;
  /** `portal.allowAttachmentUpload` for this tenant. The uploader hides when false. */
  canAttach: boolean;
  /**
   * OPTIONAL BY NECESSITY, not by design.
   *
   * The right lives on `portal_contacts.org_visibility` (migration 009) and is
   * read into `PortalPrincipal.orgVisibility` on every request, but `GET
   * /api/portal/me` does not yet put it on the wire. Typed optional so this
   * client is honest about that: an absent value means "not told", and the
   * organisation toggle therefore does not render at all.
   *
   * That is the correct failure direction. Assuming the right and showing the
   * toggle would produce a control that silently does nothing — `visibleTickets`
   * narrows an unentitled contact back to their own tickets without saying so —
   * and a switch that flips with no effect is read as a broken portal. Showing
   * nothing until the server says otherwise costs an ungranted contact exactly
   * what they were never entitled to see.
   */
  orgVisibility?: PortalOrgVisibility;
}

export interface PortalTicketSummary {
  id: number;
  number: string;
  subject: string;
  /** The tenant's own status name. Display only. */
  statusSlug: string;
  /** HARD RULE 5 — everything this UI decides keys off the CATEGORY. */
  statusCategory: StatusCategory;
  prioritySlug: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  /** Present only when `portal.showSlaCountdown` is on for the tenant. */
  dueAt?: string | null;
  /** Present on the organisation scope, so a reader knows whose ticket it is. */
  requesterEmail?: string | null;
  /** Filed by the signed-in contact. False for a colleague's, in org scope. */
  mine: boolean;
}

export interface PortalTicketDetail extends PortalTicketSummary {
  /** Sanitised server-side by `utils/markdown.ts`; injected as-is. */
  descriptionHtml: string | null;
  /** PUBLIC entries only — filtered at the SQL, never in a mapper. */
  journal: PortalJournalEntry[];
}

/**
 * One timeline entry as the PORTAL serves it.
 *
 * Deliberately not `TicketJournalEntry`: the server projects an explicit
 * allow-list, because the internal shape carries an open `meta` index every
 * engine writes into, plus the agent's login `username`. Typing this surface
 * with the internal interface is how a field nobody meant to publish ends up
 * rendered.
 */
export interface PortalJournalEntry {
  id: number;
  seq: number;
  kind: string;
  authorType: string;
  /** Display name only. Null when the desk answered without one. */
  authorName: string | null;
  authorAvatar: string | null;
  authorContact: { displayName: string | null; email: string } | null;
  bodyMd: string | null;
  bodyHtml: string | null;
  createdAt: string;
  attachments?: Array<{ id: number; filename: string; byteSize: number; mimeType?: string }>;
  meta: { toStatusSlug?: string; toCategory?: string; mail?: { chip?: string } };
}

export interface PortalContactIdentity {
  email: string;
  displayName: string | null;
  organizationId: number | null;
  locale: string;
}

export interface PortalVerifyResult {
  contact: PortalContactIdentity;
  tenantSlug: string;
  expiresAt: string;
  /** The session id, replayed as `X-Auth-Token` by the cookie-less shell. */
  token?: string;
}

export interface PortalRequestLinkResult {
  accepted: true;
  /**
   */
}

export interface PortalReplyResult {
  journalId: number;
  /**
   * NOT always the ticket that was replied to. Past the reopen window the
   * server files a linked FOLLOW-UP instead of resurrecting a closed ticket,
   * and this is that ticket's id. Callers must navigate to it.
   */
  ticketId: number;
  reopened: boolean;
}

export interface PortalUploadedAttachment {
  id: number;
  filename: string;
  byteSize: number;
}

export interface PortalTicketPage {
  items: PortalTicketSummary[];
  total: number;
}

// ═════════════════════════════════════════════════════════════════════════════
// The remembered workspace
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The tenant slug the last sign-in used.
 *
 * A customer knows their supplier's name, not the desk's tenant slug, and being
 * asked for one twice is how a portal loses a user. The slug normally arrives
 * in the link the supplier sent (`/portal/login?tenant=acme`); this remembers it
 * so the second visit, typed from memory into the address bar, still works.
 *
 * Defined here rather than added to the shared `STORAGE_KEYS`: it is meaningful
 * to this one surface, and it is a CONVENIENCE, never a credential. Nothing is
 * authorised by it — the session comes from a burned token, and a slug typed
 * into this key gets a contact who does not exist there the same silence as
 * everything else.
 */
const PORTAL_TENANT_KEY = 'oblidesk:portalTenant';

export function rememberedTenantSlug(): string {
  try {
    return localStorage.getItem(PORTAL_TENANT_KEY) ?? '';
  } catch {
    // Private mode, blocked site data. The form simply asks.
    return '';
  }
}

export function rememberTenantSlug(slug: string): void {
  try {
    if (slug.trim()) localStorage.setItem(PORTAL_TENANT_KEY, slug.trim().toLowerCase());
  } catch {
    // Nothing to recover: the slug is re-asked next time.
  }
}

export function forgetTenantSlug(): void {
  try {
    localStorage.removeItem(PORTAL_TENANT_KEY);
  } catch {
    /* no-op */
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Sign-in
// ═════════════════════════════════════════════════════════════════════════════

export interface RequestLinkParams {
  tenantSlug: string;
  email: string;
  /** Where the verified link should land — a same-origin PATH, validated server-side. */
  next?: string | null;
}

/**
 * Ask for a sign-in link.
 *
 * Resolves on every reachable-server outcome, including the ones where nothing
 * was sent. Only a transport or 5xx failure rejects, because "we could not even
 * ask" is a different statement from "we asked and are saying nothing", and the
 * screen must be able to tell them apart without leaking the second one.
 */
async function requestLink(params: RequestLinkParams): Promise<PortalRequestLinkResult> {
  try {
    const res = await apiClient.post<Envelope<PortalRequestLinkResult>>('/portal/request-link', {
      tenantSlug: params.tenantSlug.trim().toLowerCase(),
      email: params.email.trim(),
      ...(params.next ? { next: params.next } : {}),
    });
    return unwrap(res.data);
  } catch (error) {
    throw toApiError(error);
  }
}

/**
 * Burn a token and open the session.
 *
 * The 401 here is the ONLY honest one on the whole portal: expired, replayed or
 * forged, all three answered identically by design, so the screen says "ask for
 * a new link" rather than guessing which.
 */
async function verify(token: string): Promise<PortalVerifyResult> {
  try {
    const res = await apiClient.post<Envelope<PortalVerifyResult>>('/portal/verify', { token });
    return unwrap(res.data);
  } catch (error) {
    throw toApiError(error);
  }
}

async function logout(): Promise<void> {
  try {
    await apiClient.post('/portal/logout');
  } catch {
    // The session is being abandoned either way. A failed sign-out that blocks
    // the user on the page they are trying to leave is worse than a stale row
    // the store will expire on its own.
  }
}

async function me(): Promise<PortalMe> {
  try {
    const res = await apiClient.get<Envelope<PortalMe>>('/portal/me');
    return unwrap(res.data);
  } catch (error) {
    throw toApiError(error);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Tickets
// ═════════════════════════════════════════════════════════════════════════════

export interface PortalListParams {
  scope?: PortalScope;
  state?: PortalTicketState;
  limit?: number;
  offset?: number;
}

/**
 * List the tickets this contact may read.
 *
 * `scope` is a REQUEST, not a claim. A contact who has not been granted
 * organisation reading gets their own tickets whatever they send, and is not
 * told the parameter was ignored — refusing loudly would advertise to somebody
 * probing that a wider view exists. So this function never asserts that what
 * came back matches what it asked for, and the UI must not either.
 *
 * Offset paging, not the keyset the agent queue uses: a requester has tens of
 * tickets, not a hundred thousand, and `total` is what lets the screen say how
 * many there are rather than only "there is more".
 */
async function listTickets(params: PortalListParams = {}): Promise<PortalTicketPage> {
  try {
    const res = await apiClient.get<Envelope<PortalTicketSummary[]>>('/portal/tickets', {
      params: {
        scope: params.scope ?? 'mine',
        state: params.state ?? 'open',
        limit: params.limit ?? 25,
        offset: params.offset ?? 0,
      },
    });
    return {
      items: unwrap(res.data),
      // `total` rides on the envelope beside `data`, not inside it.
      total: Number((res.data as { total?: unknown }).total ?? 0),
    };
  } catch (error) {
    throw toApiError(error);
  }
}

async function getTicket(ticketId: number): Promise<PortalTicketDetail> {
  try {
    const res = await apiClient.get<Envelope<PortalTicketDetail>>(`/portal/tickets/${ticketId}`);
    return unwrap(res.data);
  } catch (error) {
    throw toApiError(error);
  }
}

export interface PortalCreateTicketParams {
  subject: string;
  bodyMd: string;
  /**
   * HARD RULE 6 — WHEN IT HAPPENED, not when the form was filled.
   *
   * An ISO instant. It is captured at intake because it can never be
   * reconstructed afterwards: an outage a customer reports at 09:00 that
   * started at 02:14 must carry 02:14, or the detection gap, the SLA arithmetic
   * and Rewind are all quietly wrong. Omitting it makes the server stamp `now`,
   * which is a legitimate answer — but only when the form actually asked.
   */
  occurredAt?: string | null;
}

async function createTicket(
  params: PortalCreateTicketParams,
): Promise<{ id: number; number: string }> {
  try {
    const res = await apiClient.post<Envelope<{ id: number; number: string }>>('/portal/tickets', {
      subject: params.subject,
      bodyMd: params.bodyMd,
      ...(params.occurredAt ? { occurredAt: params.occurredAt } : {}),
    });
    return unwrap(res.data);
  } catch (error) {
    throw toApiError(error);
  }
}

/**
 * Reply, which may reopen.
 *
 * The reopen is the SERVER's decision and it is not cosmetic: inside the reopen
 * window the ticket comes back and a fresh SLA clock starts; outside it, a
 * linked follow-up is filed instead and `ticketId` is that new ticket. Callers
 * must read `ticketId` back rather than assume it is the one they posted to.
 *
 * Attachments must ALREADY be linked to a ticket this contact may read, which
 * in practice means `uploadAttachment` ran a moment ago against this same
 * ticket. Uploading after the reply would leave the files hanging off the
 * ticket but not off the message, so the order is upload → reply, always.
 */
async function reply(
  ticketId: number,
  params: { bodyMd: string; attachmentIds?: number[] },
): Promise<PortalReplyResult> {
  try {
    const res = await apiClient.post<Envelope<PortalReplyResult>>(
      `/portal/tickets/${ticketId}/reply`,
      {
        bodyMd: params.bodyMd,
        ...(params.attachmentIds?.length ? { attachmentIds: params.attachmentIds } : {}),
      },
    );
    return unwrap(res.data);
  } catch (error) {
    throw toApiError(error);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Attachments
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Upload one file against a ticket.
 *
 * The multipart field is `file`, SINGULAR — the portal route is `upload.single('file')`
 * and multer answers anything else with `LIMIT_UNEXPECTED_FILE`, so the agent
 * composer's `files` would 400 here. Files are therefore sent one request each,
 * which is also what lets a partial failure name the file that failed.
 *
 * The `multipart/form-data` header is written for the same reason the agent
 * composer writes it — as an intent marker. Axios strips it for a FormData body
 * in a browser and lets the browser emit its own with the boundary, which is
 * the only version multer can actually parse.
 */
async function uploadAttachment(
  ticketId: number,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<PortalUploadedAttachment> {
  const form = new FormData();
  form.append('file', file);

  try {
    const res = await apiClient.post<Envelope<PortalUploadedAttachment>>(
      `/portal/tickets/${ticketId}/attachments`,
      form,
      {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (event) => {
          if (!onProgress || !event.total) return;
          onProgress(Math.round((event.loaded / event.total) * 100));
        },
      },
    );
    return unwrap(res.data);
  } catch (error) {
    throw toApiError(error);
  }
}

/**
 * The href an inline image in a rendered body already points at.
 *
 * `portalizeAttachmentUrls` rewrites the agent route out of every stored body
 * before it leaves the server, so an `<img>` in a reply resolves here. Exposed
 * for the same reason the rewrite exists: nothing on this surface may link at
 * `/api/attachments/*`, which is guarded by `ticket_read` across the whole
 * tenant and would 401 a requester at best.
 */
function attachmentHref(attachmentId: number): string {
  const base = apiClient.defaults.baseURL ?? '/api';
  return `${base}/portal/attachments/${attachmentId}`;
}

/**
 * Fetch a blob and hand it to the browser as a save.
 *
 * A plain `<a href download>` would be shorter and is wrong twice: it carries
 * only the cookie, so it fails outright in the cookie-less shell where the
 * session id travels in a header, and a refusal renders as a raw JSON page in a
 * new tab instead of a message on the screen the person is looking at. Going
 * through the instance keeps both the auth and the error handling.
 */
async function downloadAttachment(attachmentId: number, filename: string): Promise<void> {
  let objectUrl: string | null = null;
  try {
    const res = await apiClient.get<Blob>(`/portal/attachments/${attachmentId}`, {
      responseType: 'blob',
    });

    objectUrl = URL.createObjectURL(res.data);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename || `attachment-${attachmentId}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } catch (error) {
    throw toApiError(error);
  } finally {
    // Revoked on the next frame: revoking synchronously can race the click on
    // some browsers and produce an empty file with no error anywhere.
    if (objectUrl) {
      const url = objectUrl;
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }
}

export const portalApi = {
  requestLink,
  verify,
  logout,
  me,
  listTickets,
  getTicket,
  createTicket,
  reply,
  uploadAttachment,
  attachmentHref,
  downloadAttachment,
  rememberedTenantSlug,
  rememberTenantSlug,
  forgetTenantSlug,
};

export default portalApi;
