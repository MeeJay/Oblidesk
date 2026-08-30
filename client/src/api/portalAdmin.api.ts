/**
 * portalAdmin.api.ts — the AGENT's two doors onto the portal's records.
 *
 * One module for two routers (`/api/organizations` and `/api/portal-admin`)
 * because they are one screen: the customer directory on the left, that
 * customer's requesters on the right. Splitting them would put the organisation
 * a contact belongs to and the contact itself behind two imports that have to
 * be kept in step by hand.
 *
 * ── The one call that is not CRUD ───────────────────────────────────────────
 * `portalContactsApi.setVisibility` is the only call in the client that can
 * WIDEN a requester's reach. `'organization'` lets that person open — and reply
 * to — every ticket their organisation has ever filed on the portal, their
 * colleagues' included. Everything else here can only NARROW it, and two calls
 * narrow it as a side effect: `update()` with a changed `organizationId`, and
 * `organizationsApi.reassignContacts()`. The server revokes the right on both,
 * because it was granted against the organisation the contact is leaving.
 *
 * That is why every mutation below resolves to the FULL record rather than to
 * void: a caller that patches its local copy from the request it sent will show
 * a reading right the database has just taken away. Adopt the response.
 *
 * ── Why these DTOs are declared here and not imported from shared ───────────
 * `shared/types.ts` has `Organization` and `PortalContact`, and they are NOT
 * what these routes return. `PortalContact` has no `orgVisibility` — the single
 * field this screen exists to edit — and `Organization` carries a `tenantId`
 * the server's record deliberately omits. Importing them would compile and then
 * be wrong at exactly the place that matters, so the shapes below mirror
 * `portal.service.ts`'s `OrganizationRecord` / `PortalContactRecord` instead.
 * Reconciling the two lives in shared and is flagged, not done from here.
 *
 * ── Typed refusals ──────────────────────────────────────────────────────────
 * Three failures on these routes carry a body worth reading rather than a
 * sentence worth toasting, and the helpers at the bottom unwrap them:
 * `organization_not_empty` (with the counts that block a delete),
 * `organization_required` (a grant with no organisation to name) and
 * `slug_taken`. Everything else is an ordinary `ApiError`.
 */

import apiClient, { toApiError, toQuery, unwrap, type Envelope } from './client';

// ═════════════════════════════════════════════════════════════════════════════
// Records
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Migration 009's `portal_contacts.org_visibility`, and the whole permission
 * model of the portal in two words:
 *   • `own`          — the tickets this contact filed themselves.
 *   • `organization` — every ticket their organisation ever filed.
 * The second is only legal on a contact who HAS an organisation; the column has
 * a CHECK saying so and the server answers `organization_required` before it.
 */
export type PortalOrgVisibility = 'own' | 'organization';

export interface OrganizationRecord {
  id: number;
  name: string;
  /**
   * HARD RULE 3 — the human handle other configuration cross-references. SLA
   * policy conditions match on it, so renaming one re-points every policy that
   * named the old value. The server records both sides of the rename.
   */
  slug: string;
  /**
   * Mail domains that attribute an unknown inbound sender to this customer.
   * A public domain here (`gmail.com`) files every consumer address on the
   * internet under this organisation, which is why the editor says so.
   */
  domains: string[];
  externalRef: string | null;
  createdAt: string;
  updatedAt: string;
  contactCount: number;
  openTicketCount: number;
}

/** What stands in the way of deleting an organisation. */
export interface OrganizationUsage {
  contactCount: number;
  /** Contacts whose reading right names THIS organisation. */
  orgReaderCount: number;
  ticketCount: number;
  openTicketCount: number;
  contractCount: number;
}

export interface PortalContactRecord {
  id: number;
  /** Not editable. It is where sign-in links go and what inbound mail threads on. */
  email: string;
  displayName: string | null;
  phone: string | null;
  organizationId: number | null;
  organizationName: string | null;
  organizationSlug: string | null;
  /** Set when this requester also holds an agent login. Read-only here. */
  userId: number | null;
  isActive: boolean;
  orgVisibility: PortalOrgVisibility;
  locale: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReassignContactsResult {
  moved: number;
  /** How many lost `organization` reading in the move. Say this out loud. */
  visibilityRevoked: number;
}

// ═════════════════════════════════════════════════════════════════════════════
// Queries and inputs
// ═════════════════════════════════════════════════════════════════════════════

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

interface PagedEnvelope<T> extends Envelope<T[]> {
  total?: number;
  page?: number;
  limit?: number;
}

function toPaged<T>(body: PagedEnvelope<T>, page: number, limit: number): Paged<T> {
  const items = unwrap<T[]>(body) ?? [];
  return {
    items,
    total: body.total ?? items.length,
    page: body.page ?? page,
    limit: body.limit ?? limit,
  };
}

export type OrganizationSort = 'name' | 'slug' | 'createdAt' | 'updatedAt';

export interface OrganizationListQuery {
  q?: string;
  page?: number;
  limit?: number;
  sort?: OrganizationSort;
  dir?: 'asc' | 'desc';
}

export type PortalContactSort = 'email' | 'displayName' | 'createdAt' | 'updatedAt';

export interface PortalContactListQuery {
  q?: string;
  /**
   * An id, or the literal `'none'` for the contacts that belong to nobody —
   * the ones mail intake created from an address whose domain matched no
   * organisation. That queue is half the reason this screen exists, and those
   * contacts can never hold organisation reading.
   */
  organizationId?: number | 'none';
  isActive?: boolean;
  orgVisibility?: PortalOrgVisibility;
  page?: number;
  limit?: number;
  sort?: PortalContactSort;
  dir?: 'asc' | 'desc';
}

export interface CreateOrganizationInput {
  name: string;
  /** Omit and the server derives one from the name, suffixing it if it collides. */
  slug?: string;
  domains?: string[];
  externalRef?: string | null;
}

/**
 * Every field optional (HARD RULE 12) so the inline editors can autosave one at
 * a time. `domains` REPLACES the list rather than appending to it.
 */
export interface UpdateOrganizationInput {
  name?: string;
  slug?: string;
  domains?: string[];
  /** `null` clears it; omitting the key changes nothing. */
  externalRef?: string | null;
}

export interface CreatePortalContactInput {
  email: string;
  displayName?: string | null;
  phone?: string | null;
  organizationId?: number | null;
  /** Seeded locales only (HARD RULE 10) — it picks the sign-in mail's template. */
  locale?: 'en' | 'fr';
  isActive?: boolean;
}

/**
 * No `email`: the create schema is `.strict()` on the server and so is this
 * shape by omission. Changing an address means "this is a different person",
 * which is a create plus a deactivate.
 *
 * Sending a different `organizationId` REVOKES `orgVisibility`. Read it back
 * off the returned record.
 */
export interface UpdatePortalContactInput {
  displayName?: string | null;
  phone?: string | null;
  organizationId?: number | null;
  locale?: 'en' | 'fr';
}

export interface SetContactVisibilityInput {
  orgVisibility: PortalOrgVisibility;
  /**
   * Optional: assign the organisation and grant the right in ONE request, so
   * the record is never half-changed between two calls. Omitted, the contact's
   * current organisation stands.
   */
  organizationId?: number | null;
}

// ═════════════════════════════════════════════════════════════════════════════
// Organisations — /api/organizations
// ═════════════════════════════════════════════════════════════════════════════

export const organizationsApi = {
  async list(query: OrganizationListQuery = {}): Promise<Paged<OrganizationRecord>> {
    try {
      const res = await apiClient.get<PagedEnvelope<OrganizationRecord>>('/organizations', {
        params: toQuery({ ...query }),
      });
      return toPaged(res.data, query.page ?? 1, query.limit ?? 0);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async get(id: number): Promise<OrganizationRecord> {
    try {
      const res = await apiClient.get<Envelope<OrganizationRecord>>(`/organizations/${id}`);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async create(input: CreateOrganizationInput): Promise<OrganizationRecord> {
    try {
      const res = await apiClient.post<Envelope<OrganizationRecord>>('/organizations', input);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async update(id: number, patch: UpdateOrganizationInput): Promise<OrganizationRecord> {
    try {
      const res = await apiClient.patch<Envelope<OrganizationRecord>>(
        `/organizations/${id}`,
        patch,
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * Succeeds only on an organisation with no contacts, no tickets and no
   * contracts. Anything else is a 409 carrying the counts — see
   * `organizationUsageOf`. There is no cascade and no archive: a delete would
   * take the customer's contracts with it and blank the `organization_id` on
   * every ticket they ever filed.
   */
  async remove(id: number): Promise<void> {
    try {
      await apiClient.delete(`/organizations/${id}`);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** The same counts a refused delete carries, readable BEFORE anyone clicks. */
  async usage(id: number): Promise<OrganizationUsage> {
    try {
      const res = await apiClient.get<Envelope<OrganizationUsage>>(`/organizations/${id}/usage`);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * This customer's requesters. The organisation is forced from the path, so
   * unlike `portalContactsApi.list` a stray query string cannot widen it to
   * another customer.
   */
  async contacts(
    id: number,
    query: Omit<PortalContactListQuery, 'organizationId'> = {},
  ): Promise<Paged<PortalContactRecord>> {
    try {
      const res = await apiClient.get<PagedEnvelope<PortalContactRecord>>(
        `/organizations/${id}/contacts`,
        { params: toQuery({ ...query }) },
      );
      return toPaged(res.data, query.page ?? 1, query.limit ?? 0);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * Move every contact out, in one statement. `null` detaches them entirely,
   * which is the emptying step before a delete.
   *
   * The move REVOKES organisation reading from everyone who held it — the right
   * named the organisation they are leaving — and the result says how many, so
   * the screen can report a permission change nobody explicitly asked for.
   */
  async reassignContacts(
    id: number,
    targetOrganizationId: number | null,
  ): Promise<ReassignContactsResult> {
    try {
      const res = await apiClient.post<Envelope<ReassignContactsResult>>(
        `/organizations/${id}/contacts/reassign`,
        { targetOrganizationId },
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// Portal contacts — /api/portal-admin
// ═════════════════════════════════════════════════════════════════════════════

export const portalContactsApi = {
  async list(query: PortalContactListQuery = {}): Promise<Paged<PortalContactRecord>> {
    try {
      const res = await apiClient.get<PagedEnvelope<PortalContactRecord>>(
        '/portal-admin/contacts',
        { params: toQuery({ ...query }) },
      );
      return toPaged(res.data, query.page ?? 1, query.limit ?? 0);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async get(id: number): Promise<PortalContactRecord> {
    try {
      const res = await apiClient.get<Envelope<PortalContactRecord>>(
        `/portal-admin/contacts/${id}`,
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * A contact is born reading their OWN tickets. `orgVisibility` is not in this
   * shape and the server's schema is `.strict()`, so sending one is a 400 rather
   * than a field that quietly does nothing — widening is `setVisibility`, always.
   */
  async create(input: CreatePortalContactInput): Promise<PortalContactRecord> {
    try {
      const res = await apiClient.post<Envelope<PortalContactRecord>>(
        '/portal-admin/contacts',
        input,
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** Partial and autosave-friendly. A changed organisation revokes the grant. */
  async update(id: number, patch: UpdatePortalContactInput): Promise<PortalContactRecord> {
    try {
      const res = await apiClient.patch<Envelope<PortalContactRecord>>(
        `/portal-admin/contacts/${id}`,
        patch,
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * Deactivation is the only removal the portal offers — there is no delete,
   * because `tickets.requester_contact_id` is `ON DELETE SET NULL` and removing
   * a contact would anonymise every ticket they ever filed.
   *
   * It bites immediately: the portal session guard re-reads `is_active` on every
   * request, so magic links already sitting in a mailbox are dead too.
   */
  async setActive(id: number, isActive: boolean): Promise<PortalContactRecord> {
    try {
      const res = await apiClient.put<Envelope<PortalContactRecord>>(
        `/portal-admin/contacts/${id}/active`,
        { isActive },
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * THE grant, and the only widening call in this client.
   *
   * `'organization'` on a contact who belongs to nobody is refused with
   * `organization_required` rather than a raw constraint violation — a right
   * that names nothing cannot be exercised, and a UI that showed it saved would
   * be lying about what the customer can see.
   *
   * Both directions take effect on the requester's very next request.
   */
  async setVisibility(
    id: number,
    input: SetContactVisibilityInput,
  ): Promise<PortalContactRecord> {
    try {
      const res = await apiClient.put<Envelope<PortalContactRecord>>(
        `/portal-admin/contacts/${id}/visibility`,
        input,
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// Typed refusals
// ═════════════════════════════════════════════════════════════════════════════

function codeOf(error: unknown): string | null {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' ? code : null;
}

function payloadOf(error: unknown): Record<string, unknown> | null {
  const payload = (error as { payload?: unknown })?.payload;
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
}

/**
 * The counts behind a refused delete, or `null` when the failure was something
 * else. Reading them lets the screen name what is in the way instead of saying
 * "could not delete" and leaving an administrator to go looking.
 */
export function organizationUsageOf(error: unknown): OrganizationUsage | null {
  if (codeOf(error) !== 'organization_not_empty') return null;
  const usage = payloadOf(error)?.usage;
  return usage && typeof usage === 'object' ? (usage as OrganizationUsage) : null;
}

/** A grant that named no organisation. The fix is to assign one, not to retry. */
export function isOrganizationRequired(error: unknown): boolean {
  return codeOf(error) === 'organization_required';
}

/**
 * A slug the caller typed is already used by another organisation. Only an
 * EXPLICIT slug produces this — a derived one is suffixed rather than refused.
 */
export function isSlugTaken(error: unknown): boolean {
  return codeOf(error) === 'slug_taken';
}
