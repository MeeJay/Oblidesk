/**
 * portal.service.ts — the requester portal.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 *  A PORTAL CONTACT IS NOT A USER. This is the file that keeps it that way.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * The obvious implementation of "let requesters sign in" is to create a `users`
 * row with a weak role and be done. Do not do that, and this module is
 * structured so that it cannot happen by accident.
 *
 * Obligate is the suite's identity authority. Every `users` row in Oblidesk is
 * either provisioned by Obligate or is a local account an operator explicitly
 * created, and an Obligate administrator's picture of "who can sign in to the
 * desk" is the `users` table. Minting a user for every requester who clicks a
 * link in an e-mail would put thousands of principals into that picture that
 * Obligate never issued, never governs, and cannot revoke — and an auditor
 * looking at it would read that, correctly, as an SSO bypass. It would also
 * drag every requester through `resolveUserCapabilities()`, where a
 * misconfigured default permission set is one line away from handing a customer
 * `ticket_read` across the whole tenant.
 *
 * So a requester is a `portal_contacts` row and nothing else:
 *
 *   • no row in `users`, ever — nothing here writes that table;
 *   • no capability resolution — `req.portal` carries no `capabilities` field,
 *     so `requireCapability()` cannot be pointed at it even by mistake;
 *   • a session with `userId` UNSET, so `requireAuth` (which reads exactly
 *     that) refuses every agent route with a portal session attached. The two
 *     principal types share a cookie jar and share nothing else.
 *
 * ── Magic links ─────────────────────────────────────────────────────────────
 *
 * Passwords for requesters are a liability nobody wants to own: they get
 * reused, they need a reset flow, and they turn "somebody left the company"
 * into a support ticket. A magic link is the right primitive — but only with
 * all four of these, and each one is load-bearing:
 *
 *   SINGLE USE   burned by an atomic `UPDATE … WHERE used_at IS NULL`, so two
 *                concurrent clicks cannot both succeed. Without it the link is
 *                a bearer credential that lives in a mailbox for ever.
 *   SHORT TTL    fifteen minutes. A link forwarded, quoted in a reply or picked
 *                up from a backup months later is already dead.
 *   HASHED       only sha256 of the verifier is stored. A leaked database
 *                yields no usable links.
 *   RATE LIMITED per ADDRESS, not per IP. Per-IP limiting is what an attacker
 *                behind a botnet ignores and what a whole office behind one NAT
 *                trips over; the resource being protected is somebody's inbox,
 *                so the address is the thing to count.
 *
 * And the request endpoint answers identically whether or not the address is
 * known. A portal that says "no such contact" is a free customer-list oracle
 * for anyone who can guess at addresses.
 *
 * ── What a requester may read ───────────────────────────────────────────────
 *
 * Their own tickets, always. Their ORGANISATION's tickets only when they ask
 * for them explicitly (`scope=organization`) — the default is the narrow one,
 * because "everyone at ACME can read every ACME ticket" is a policy some
 * tenants want and others would consider a breach, and a wide default is the
 * kind of thing nobody discovers until it matters. Journal entries are filtered
 * to `visibility = 'public'` at the query, never in the mapper: a filter in a
 * mapper is one refactor away from being skipped by a new code path.
 */
import type { Knex } from 'knex';
import type { NextFunction, Request, Response } from 'express';
import type { StatusCategory, TicketJournalEntry } from '@oblidesk/shared';

import { db, scoped, assertTenantId, type Executor } from '../db';
import { config } from '../config';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { generateUrlToken, hmacSha256Base64, safeEqual, sha256Hex } from '../utils/crypto';
import * as journalService from './journal.service';
import { ticketService } from './ticket.service';
import { settingsService } from './settings.service';
import * as attachmentService from './attachment.service';
import { mailboxService } from './mail/mailbox.service';
import { outboundService } from './mail/outbound.service';

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — The principal, and the session that carries it
// ═════════════════════════════════════════════════════════════════════════════

export interface PortalPrincipal {
  tenantId: number;
  /** HARD RULE 13 — the cross-app tenant identity. */
  tenantSlug: string;
  contactId: number;
  email: string;
  displayName: string | null;
  organizationId: number | null;
  locale: string;
}

/**
 * NOTE the absence of `capabilities`, `role` and `userId`. That absence is the
 * security control: `requireCapability()` and `requireAuth()` both read fields
 * that do not exist here, so no amount of copy-pasting an agent route can give
 * a requester an agent's reach.
 */
interface PortalSessionData {
  tenantId: number;
  tenantSlug: string;
  contactId: number;
  email: string;
  issuedAt: number;
  expiresAt: number;
}

declare module 'express-session' {
  interface SessionData {
    /**
     * A PORTAL principal. Never set alongside `userId` — `verify()` regenerates
     * the session first, so signing in to the portal on a browser that also had
     * an agent session replaces it rather than merging the two.
     */
    portal?: PortalSessionData;
  }
}

declare global {
  namespace Express {
    interface Request {
      /** Set by `requirePortalSession`. Absent on every agent route. */
      portal?: PortalPrincipal;
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — Tenant scoping for a table db/index.ts does not know yet
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `portal_login_tokens` is created by migration `003_mail_portal_runtime.ts`
 * and is TENANT SCOPED — it must be added to `TENANT_SCOPED_TABLES` in
 * `server/src/db/index.ts` so `scoped()` accepts it. That file is owned
 * elsewhere; until the entry lands, `scoped()` would throw "unknown table"
 * here rather than doing its job.
 *
 * This helper is the stand-in, and it is deliberately narrower than `scoped()`
 * rather than a general escape hatch: the table name is a CLOSED literal union,
 * so nothing else can be routed through it, and it enforces the identical
 * invariant — `assertTenantId()` plus a table-qualified `tenant_id` predicate
 * that a later `.join()` cannot make ambiguous. When `db/index.ts` grows the
 * entry, delete this and use `scoped()`.
 */
type PortalOwnedTable = 'portal_login_tokens';

function scopedPortal(
  table: PortalOwnedTable,
  tenantId: number,
  executor: Executor = db,
): Knex.QueryBuilder {
  assertTenantId(tenantId);
  return executor(table).where(`${table}.tenant_id`, tenantId);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — Token minting
// ═════════════════════════════════════════════════════════════════════════════

/** Fifteen minutes. Long enough for a mail to arrive, short enough to be dead by lunch. */
export const MAGIC_LINK_TTL_MS = 15 * 60_000;
/** How long a verified portal session lives. */
export const PORTAL_SESSION_TTL_MS = 12 * 3600_000;

/** Per address, per window. Both are deliberately low: this sends e-mail. */
const RATE_WINDOW_MS = 15 * 60_000;
const RATE_MAX_REQUESTS = 5;
const RATE_MAX_LIVE_TOKENS = 3;

function tokenSecret(): string {
  return config.encryptionKey ?? config.sessionSecret;
}

interface MintedToken {
  /** What goes in the e-mail. */
  token: string;
  /** What goes in the database. */
  hash: string;
  expiresAt: Date;
}

/**
 * `od1.<b64u(slug)>.<verifier>.<sig>`
 *
 * The tenant slug rides along so `verify()` can resolve the tenant and SCOPE
 * the lookup before it touches a row — a token lookup that had to scan every
 * tenant's tokens would be both slow and a cross-tenant query waiting to
 * happen.
 *
 * The trailing HMAC is a cheap pre-filter, not the authority: it lets a public,
 * unauthenticated endpoint reject scanner traffic without a database round
 * trip, while the 256-bit verifier hashed in the table remains the thing that
 * actually proves anything.
 */
function mintToken(tenantSlug: string): MintedToken {
  const verifier = generateUrlToken(32);
  const slug = Buffer.from(tenantSlug, 'utf8').toString('base64url');
  const signature = hmacSha256Base64(`${slug}.${verifier}`, tokenSecret());
  return {
    token: `od1.${slug}.${verifier}.${signature}`,
    hash: sha256Hex(verifier),
    expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS),
  };
}

interface DecodedToken {
  tenantSlug: string;
  hash: string;
}

function decodeToken(raw: string): DecodedToken | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.trim().split('.');
  if (parts.length !== 4 || parts[0] !== 'od1') return null;

  const [, slugPart, verifier, signature] = parts;
  if (verifier.length < 32) return null;

  const expected = hmacSha256Base64(`${slugPart}.${verifier}`, tokenSecret());
  if (!safeEqual(signature, expected)) return null;

  let tenantSlug: string;
  try {
    tenantSlug = Buffer.from(slugPart, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (tenantSlug.trim() === '') return null;

  return { tenantSlug, hash: sha256Hex(verifier) };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — Request a link
// ═════════════════════════════════════════════════════════════════════════════

export interface RequestLinkInput {
  tenantSlug: string;
  email: string;
  ip?: string | null;
  userAgent?: string | null;
  /** Where the verified link should land. Validated against APP_URL. */
  redirectPath?: string | null;
}

export interface RequestLinkResult {
  /** Always true. See the note about enumeration below. */
  accepted: true;
  /** Populated only in a non-production environment, for the dev flow and tests. */
  devToken?: string;
}

/**
 * Only same-origin, path-only redirects. An `open redirect` on the one endpoint
 * that hands out a session is how a phishing mail turns a legitimate desk
 * domain into the bait.
 */
function safeRedirectPath(candidate: string | null | undefined): string {
  if (typeof candidate !== 'string' || candidate.trim() === '') return '/portal';
  const value = candidate.trim();
  if (!value.startsWith('/') || value.startsWith('//')) return '/portal';
  if (value.includes('\\') || /[\r\n]/.test(value)) return '/portal';
  return value.slice(0, 512);
}

/**
 * Send a sign-in link, or quietly do nothing.
 *
 * The response is IDENTICAL in every branch — unknown tenant, unknown address,
 * inactive contact, portal disabled, rate limited. Anything else turns this
 * endpoint into a customer-list oracle: an attacker submits addresses and reads
 * the difference between "sent" and "no such contact". The log line records
 * which branch was taken, because an operator debugging "my customer never got
 * the mail" needs the truth and an attacker cannot read the log.
 */
export async function requestMagicLink(input: RequestLinkInput): Promise<RequestLinkResult> {
  const generic: RequestLinkResult = { accepted: true };
  const email = (input.email ?? '').trim().toLowerCase();
  if (email === '' || !email.includes('@') || email.length > 254) return generic;

  const tenant = await mailboxService.tenantBySlug(input.tenantSlug);
  if (!tenant) {
    logger.info({ tenantSlug: input.tenantSlug }, 'portal: link requested for an unknown tenant');
    return generic;
  }

  const enabled = await settingsService
    .get<boolean>(tenant.id, 'portal.enabled')
    .catch(() => true);
  if (!enabled) {
    logger.info({ tenantId: tenant.id }, 'portal: link requested but the portal is disabled');
    return generic;
  }

  const contact = (await scoped('portal_contacts', tenant.id)
    .where('portal_contacts.email', email)
    .first(
      'portal_contacts.id',
      'portal_contacts.email',
      'portal_contacts.display_name',
      'portal_contacts.organization_id',
      'portal_contacts.locale',
      'portal_contacts.is_active',
    )) as
    | {
        id: number;
        email: string;
        display_name: string | null;
        organization_id: number | null;
        locale: string;
        is_active: boolean;
      }
    | undefined;

  if (!contact || !contact.is_active) {
    logger.info({ tenantId: tenant.id, email }, 'portal: link requested for an unknown contact');
    return generic;
  }

  // ── Rate limit, per address ──────────────────────────────────────────────
  const since = new Date(Date.now() - RATE_WINDOW_MS);
  const recent = (await scopedPortal('portal_login_tokens', tenant.id)
    .where('portal_login_tokens.email', email)
    .where('portal_login_tokens.created_at', '>=', since)
    .count({ total: '*' })) as unknown as Array<{ total: string | number }>;

  if (Number(recent?.[0]?.total ?? 0) >= RATE_MAX_REQUESTS) {
    logger.warn({ tenantId: tenant.id, email }, 'portal: magic-link rate limit hit for an address');
    return generic;
  }

  const live = (await scopedPortal('portal_login_tokens', tenant.id)
    .where('portal_login_tokens.email', email)
    .whereNull('portal_login_tokens.used_at')
    .where('portal_login_tokens.expires_at', '>', new Date())
    .count({ total: '*' })) as unknown as Array<{ total: string | number }>;

  if (Number(live?.[0]?.total ?? 0) >= RATE_MAX_LIVE_TOKENS) {
    logger.warn({ tenantId: tenant.id, email }, 'portal: too many live links outstanding');
    return generic;
  }

  const minted = mintToken(tenant.slug);
  const redirect = safeRedirectPath(input.redirectPath);

  await db('portal_login_tokens').insert({
    tenant_id: tenant.id,
    contact_id: contact.id,
    token_hash: minted.hash,
    email,
    expires_at: minted.expiresAt,
    requested_ip: input.ip ? String(input.ip).slice(0, 64) : null,
    user_agent: input.userAgent ? String(input.userAgent).slice(0, 255) : null,
  });

  const url =
    `${config.appUrl.replace(/\/+$/, '')}/portal/verify` +
    `?token=${encodeURIComponent(minted.token)}&next=${encodeURIComponent(redirect)}`;

  const french = (contact.locale ?? 'en').toLowerCase().startsWith('fr');
  const subject = french
    ? `Votre lien de connexion — ${tenant.name}`
    : `Your sign-in link — ${tenant.name}`;
  const body = french
    ? [
        `Bonjour ${contact.display_name ?? ''}`.trim(),
        '',
        'Voici votre lien de connexion au portail. Il expire dans 15 minutes et ne peut servir qu’une seule fois.',
        '',
        url,
        '',
        'Si vous n’avez pas demandé ce lien, vous pouvez ignorer ce message.',
      ].join('\n')
    : [
        `Hello ${contact.display_name ?? ''}`.trim(),
        '',
        'Here is your sign-in link for the support portal. It expires in 15 minutes and can only be used once.',
        '',
        url,
        '',
        'If you did not request this link, you can ignore this message.',
      ].join('\n');

  await outboundService.sendMail({
    tenantId: tenant.id,
    to: [email],
    subject,
    text: body,
    // RFC 3834 — a machine composed this, so an out-of-office responder must
    // not answer it and start the loop the outbound loop breaker then has to
    // catch.
    automated: true,
    // A human asked for it, so the loop breaker must not swallow the one
    // message they are waiting for. The per-address rate limit above is the
    // control that applies here.
    humanInitiated: true,
  });

  logger.info({ tenantId: tenant.id, contactId: contact.id }, 'portal: magic link sent');

  return config.isProd ? generic : { accepted: true, devToken: minted.token };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — Verify
// ═════════════════════════════════════════════════════════════════════════════

export interface VerifyResult {
  principal: PortalPrincipal;
  expiresAt: string;
}

/**
 * Burn a token and return the principal it proves.
 *
 * The burn is ONE statement: `UPDATE … SET used_at = now() WHERE id = ? AND
 * used_at IS NULL`, and the row count is the answer. Reading the row, checking
 * `used_at` in Node and then updating would give two concurrent clicks — a
 * mail client's link prefetcher racing the human, which happens constantly —
 * two valid sessions from one single-use token.
 */
export async function verifyMagicLink(rawToken: string): Promise<VerifyResult> {
  const refusal = new AppError(401, 'This sign-in link is invalid or has expired');

  const decoded = decodeToken(rawToken);
  if (!decoded) throw refusal;

  const tenant = await mailboxService.tenantBySlug(decoded.tenantSlug);
  if (!tenant) throw refusal;

  const token = (await scopedPortal('portal_login_tokens', tenant.id)
    .where('portal_login_tokens.token_hash', decoded.hash)
    .first(
      'portal_login_tokens.id',
      'portal_login_tokens.contact_id',
      'portal_login_tokens.expires_at',
      'portal_login_tokens.used_at',
    )) as
    | { id: number; contact_id: number; expires_at: Date | string; used_at: Date | string | null }
    | undefined;

  if (!token) throw refusal;
  if (token.used_at) {
    logger.warn(
      { tenantId: tenant.id, tokenId: token.id },
      'portal: a magic link was presented twice — refusing the replay',
    );
    throw refusal;
  }
  if (new Date(token.expires_at).getTime() <= Date.now()) throw refusal;

  const burned = await scopedPortal('portal_login_tokens', tenant.id)
    .where('portal_login_tokens.id', token.id)
    .whereNull('portal_login_tokens.used_at')
    .update({ used_at: new Date() });

  if (burned !== 1) throw refusal;

  const contact = (await scoped('portal_contacts', tenant.id)
    .where('portal_contacts.id', token.contact_id)
    .first(
      'portal_contacts.id',
      'portal_contacts.email',
      'portal_contacts.display_name',
      'portal_contacts.organization_id',
      'portal_contacts.locale',
      'portal_contacts.is_active',
    )) as
    | {
        id: number;
        email: string;
        display_name: string | null;
        organization_id: number | null;
        locale: string;
        is_active: boolean;
      }
    | undefined;

  if (!contact || !contact.is_active) throw refusal;

  return {
    principal: {
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      contactId: contact.id,
      email: contact.email,
      displayName: contact.display_name,
      organizationId: contact.organization_id,
      locale: contact.locale ?? 'en',
    },
    expiresAt: new Date(Date.now() + PORTAL_SESSION_TTL_MS).toISOString(),
  };
}

/** Housekeeping: used and expired tokens are evidence for a day, litter after. */
export async function pruneTokens(olderThanMs = 24 * 3600_000): Promise<number> {
  return db('portal_login_tokens')
    .where('expires_at', '<', new Date(Date.now() - olderThanMs))
    .del();
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — The session guard
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Re-read the contact on every request rather than trusting the cookie.
 *
 * A contact deactivated at 09:00 must lose access at 09:00, not when their
 * twelve-hour session happens to expire. The read is one indexed lookup, and it
 * also keeps `organizationId` current — a contact moved to a different customer
 * must not keep reading their old employer's tickets out of a stale session.
 */
export async function requirePortalSession(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const session = req.session?.portal;
  if (!session) {
    res.status(401).json({ success: false, error: 'Portal sign-in required' });
    return;
  }
  if (session.expiresAt <= Date.now()) {
    delete req.session.portal;
    res.status(401).json({ success: false, error: 'Your portal session has expired' });
    return;
  }

  try {
    const contact = (await scoped('portal_contacts', session.tenantId)
      .where('portal_contacts.id', session.contactId)
      .first(
        'portal_contacts.id',
        'portal_contacts.email',
        'portal_contacts.display_name',
        'portal_contacts.organization_id',
        'portal_contacts.locale',
        'portal_contacts.is_active',
      )) as
      | {
          id: number;
          email: string;
          display_name: string | null;
          organization_id: number | null;
          locale: string;
          is_active: boolean;
        }
      | undefined;

    if (!contact || !contact.is_active) {
      delete req.session.portal;
      res.status(401).json({ success: false, error: 'Portal sign-in required' });
      return;
    }

    req.portal = {
      tenantId: session.tenantId,
      tenantSlug: session.tenantSlug,
      contactId: contact.id,
      email: contact.email,
      displayName: contact.display_name,
      organizationId: contact.organization_id,
      locale: contact.locale ?? 'en',
    };
    next();
  } catch (err) {
    next(err);
  }
}

export function currentPrincipal(req: Request): PortalPrincipal {
  if (!req.portal) throw new AppError(401, 'Portal sign-in required');
  return req.portal;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — Reads
// ═════════════════════════════════════════════════════════════════════════════

export type PortalScope = 'mine' | 'organization';

export interface PortalTicketSummary {
  id: number;
  number: string;
  subject: string;
  statusSlug: string;
  statusCategory: StatusCategory;
  prioritySlug: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  /** Only when `portal.showSlaCountdown` is on for the tenant. */
  dueAt?: string | null;
  /** Present on the organisation scope, so a requester knows whose ticket it is. */
  requesterEmail?: string | null;
  mine: boolean;
}

/**
 * THE visibility predicate. Every portal read goes through it.
 *
 * One function rather than a `.where()` repeated at four call sites: a
 * visibility rule that exists in four places is a visibility rule that will
 * eventually exist correctly in three.
 */
function visibleTickets(
  principal: PortalPrincipal,
  scopeName: PortalScope,
  executor: Executor = db,
): Knex.QueryBuilder {
  const qb = scoped('tickets', principal.tenantId, executor).whereNull('tickets.deleted_at');

  if (scopeName === 'organization' && principal.organizationId !== null) {
    return qb.where((builder) => {
      builder
        .where('tickets.requester_contact_id', principal.contactId)
        .orWhere('tickets.organization_id', principal.organizationId as number);
    });
  }

  // The default, and the fallback when the contact belongs to no organisation:
  // their own tickets only.
  return qb.where('tickets.requester_contact_id', principal.contactId);
}

export interface ListPortalTicketsQuery {
  scope?: PortalScope;
  /** `open` (the default) hides the archive; `all` shows everything. */
  state?: 'open' | 'closed' | 'all';
  limit?: number;
  offset?: number;
}

const OPEN_CATEGORIES: StatusCategory[] = [
  'new',
  'open',
  'pending_requester',
  'pending_third_party',
  'scheduled',
];

export async function listTickets(
  principal: PortalPrincipal,
  query: ListPortalTicketsQuery = {},
  executor: Executor = db,
): Promise<{ items: PortalTicketSummary[]; total: number }> {
  const scopeName: PortalScope = query.scope === 'organization' ? 'organization' : 'mine';
  const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
  const offset = Math.max(query.offset ?? 0, 0);
  const state = query.state ?? 'open';

  const showSla = await settingsService
    .get<boolean>(principal.tenantId, 'portal.showSlaCountdown')
    .catch(() => false);

  const applyState = (qb: Knex.QueryBuilder): Knex.QueryBuilder => {
    if (state === 'open') return qb.whereIn('tickets.status_category', OPEN_CATEGORIES);
    if (state === 'closed') return qb.whereNotIn('tickets.status_category', OPEN_CATEGORIES);
    return qb;
  };

  const countRow = (await applyState(visibleTickets(principal, scopeName, executor)).count({
    total: '*',
  })) as unknown as Array<{ total: string | number }>;

  const rows = (await applyState(visibleTickets(principal, scopeName, executor))
    .leftJoin('portal_contacts as requester', function joinRequester() {
      this.on('requester.id', '=', 'tickets.requester_contact_id').andOn(
        'requester.tenant_id',
        '=',
        'tickets.tenant_id',
      );
    })
    .orderBy('tickets.updated_at', 'desc')
    .limit(limit)
    .offset(offset)
    .select(
      'tickets.id',
      'tickets.number',
      'tickets.subject',
      'tickets.status_slug',
      'tickets.status_category',
      'tickets.priority_slug',
      'tickets.created_at',
      'tickets.updated_at',
      'tickets.resolved_at',
      'tickets.due_at',
      'tickets.requester_contact_id',
      'requester.email as requester_email',
    )) as Array<Record<string, unknown>>;

  return {
    total: Number(countRow?.[0]?.total ?? 0),
    items: rows.map((row) => ({
      id: Number(row.id),
      number: String(row.number),
      subject: String(row.subject),
      statusSlug: String(row.status_slug),
      statusCategory: row.status_category as StatusCategory,
      prioritySlug: String(row.priority_slug),
      createdAt: new Date(row.created_at as string).toISOString(),
      updatedAt: new Date(row.updated_at as string).toISOString(),
      resolvedAt: row.resolved_at ? new Date(row.resolved_at as string).toISOString() : null,
      ...(showSla
        ? { dueAt: row.due_at ? new Date(row.due_at as string).toISOString() : null }
        : {}),
      requesterEmail: scopeName === 'organization' ? ((row.requester_email as string) ?? null) : undefined,
      mine: Number(row.requester_contact_id) === principal.contactId,
    })),
  };
}

export interface PortalTicketDetail extends PortalTicketSummary {
  descriptionHtml: string | null;
  journal: TicketJournalEntry[];
}

/**
 * Point inline images at the portal's own download route.
 *
 * Mail intake rewrites `cid:` references to `/api/attachments/<id>/download`,
 * which is the AGENT route — guarded by `TICKET_READ` across the tenant. A
 * requester following it gets a 401, so every inline image in their own e-mail
 * renders broken on the portal.
 *
 * The tempting fix is to open the agent route to portal sessions. That would
 * hand every requester every blob in the tenant, work notes included. Rewriting
 * the href instead keeps the two doors separate, and the portal door applies
 * `assertAttachmentVisible` — which additionally refuses anything hanging off
 * an internal journal entry.
 */
function portalizeAttachmentUrls(html: string | null): string | null {
  if (typeof html !== 'string' || html === '') return html;
  return html.replace(/\/api\/attachments\/(\d+)\/download/g, '/api/portal/attachments/$1');
}

/**
 * One ticket, if this contact may see it.
 *
 * The visibility predicate is part of the QUERY, not a check after the fetch. A
 * post-fetch check reads a row it is about to refuse, which means the refusal
 * path has already loaded another customer's subject line into memory and one
 * stray log line away from disclosing it.
 */
export async function getTicket(
  principal: PortalPrincipal,
  ticketId: number,
  executor: Executor = db,
): Promise<PortalTicketDetail> {
  // `organization` is used for the lookup so a colleague's ticket resolves to
  // a 200 rather than a 404 when the tenant shares them; the list default stays
  // narrow, but a direct link a colleague sent should work.
  const scopeName: PortalScope = principal.organizationId === null ? 'mine' : 'organization';

  const row = (await visibleTickets(principal, scopeName, executor)
    .where('tickets.id', ticketId)
    .first(
      'tickets.id',
      'tickets.number',
      'tickets.subject',
      'tickets.description_html',
      'tickets.status_slug',
      'tickets.status_category',
      'tickets.priority_slug',
      'tickets.created_at',
      'tickets.updated_at',
      'tickets.resolved_at',
      'tickets.due_at',
      'tickets.requester_contact_id',
    )) as Record<string, unknown> | undefined;

  if (!row) throw new AppError(404, 'Ticket not found');

  const showSla = await settingsService
    .get<boolean>(principal.tenantId, 'portal.showSlaCountdown')
    .catch(() => false);

  // `visibility: 'public'` is applied by the query, in journal.service. A
  // requester must never see a work note, and the one way to guarantee that is
  // for the internal rows never to leave the database.
  const page = await journalService.list(
    principal.tenantId,
    ticketId,
    { visibility: 'public', direction: 'asc', limit: 200, withAuthors: true },
    executor,
  );

  return {
    id: Number(row.id),
    number: String(row.number),
    subject: String(row.subject),
    descriptionHtml: portalizeAttachmentUrls((row.description_html as string) ?? null),
    statusSlug: String(row.status_slug),
    statusCategory: row.status_category as StatusCategory,
    prioritySlug: String(row.priority_slug),
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at as string).toISOString() : null,
    ...(showSla ? { dueAt: row.due_at ? new Date(row.due_at as string).toISOString() : null } : {}),
    mine: Number(row.requester_contact_id) === principal.contactId,
    journal: page.entries.map((entry) => ({
      ...entry,
      bodyHtml: portalizeAttachmentUrls(entry.bodyHtml),
      meta: {
        ...entry.meta,
        // The collapsed mail chip carries inline images too, and it is rendered
        // straight out of `meta` by the client.
        ...(typeof (entry.meta as { mail?: { chip?: unknown } }).mail?.chip === 'string'
          ? {
              mail: {
                ...(entry.meta as { mail: Record<string, unknown> }).mail,
                chip: portalizeAttachmentUrls(
                  (entry.meta as { mail: { chip: string } }).mail.chip,
                ),
              },
            }
          : {}),
      },
    })),
  };
}

/**
 * Guard for a portal attachment download.
 *
 * Answers "is this blob linked to something this contact may read?" and nothing
 * else. Inline images in a public reply are the reason it exists: without it a
 * requester's own screenshot renders as a broken image on the portal, and the
 * temptation is to open the agent download route to portal sessions — which
 * would expose every blob in the tenant, including the ones on work notes.
 */
export async function assertAttachmentVisible(
  principal: PortalPrincipal,
  attachmentId: number,
  executor: Executor = db,
): Promise<void> {
  const scopeName: PortalScope = principal.organizationId === null ? 'mine' : 'organization';
  const visibleIds = visibleTickets(principal, scopeName, executor).select('tickets.id');

  const link = (await scoped('attachment_links', principal.tenantId, executor)
    .where('attachment_links.attachment_id', attachmentId)
    .where((builder) => {
      builder
        .where((ticketBranch) => {
          ticketBranch
            .where('attachment_links.entity_type', 'ticket')
            .whereIn('attachment_links.entity_id', visibleIds.clone());
        })
        .orWhere((journalBranch) => {
          journalBranch
            .where('attachment_links.entity_type', 'journal')
            .whereIn('attachment_links.entity_id', (qb) => {
              qb.select('ticket_journal.id')
                .from('ticket_journal')
                .where('ticket_journal.tenant_id', principal.tenantId)
                // PUBLIC entries only — a blob on a work note is not visible
                // just because the ticket is.
                .where('ticket_journal.visibility', 'public')
                .whereIn('ticket_journal.ticket_id', visibleIds.clone());
            });
        });
    })
    .first('attachment_links.id')) as { id: number } | undefined;

  if (!link) throw new AppError(404, 'Attachment not found');
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 8 — Writes
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The actor a portal write runs as.
 *
 * `actorType: 'portal'` and `actorId: null`. The `null` matters: the desk's
 * journal writer maps `actor.userId` onto `ticket_journal.author_id`, which is
 * a foreign key into `users`. Passing the contact id there would either violate
 * the key or — worse, if the numbers happened to line up — attribute a
 * customer's message to an agent. The contact id is written to
 * `author_contact_id` explicitly, afterwards.
 */
function portalActor() {
  return ticketService.systemActor({ actorType: 'portal', actorId: null });
}

export interface PortalReplyInput {
  bodyMd: string;
  attachmentIds?: number[];
}

export interface PortalReplyResult {
  journalId: number;
  ticketId: number;
  reopened: boolean;
}

/**
 * A requester replies.
 *
 * Two things happen that a bare journal insert would miss: a reply to a
 * resolved ticket goes through `reopen()` (which owns the window rule and
 * starts a FRESH SLA clock rather than resuming the spent one), and the rules
 * engine is told, so a "customer responded" rule can fire.
 */
export async function reply(
  principal: PortalPrincipal,
  ticketId: number,
  input: PortalReplyInput,
): Promise<PortalReplyResult> {
  const body = (input.bodyMd ?? '').trim();
  if (body === '') throw new AppError(400, 'A reply cannot be empty');
  if (body.length > 100_000) throw new AppError(413, 'That reply is too long');

  // Proves visibility before anything is written, using the same predicate the
  // reads use.
  const detail = await getTicket(principal, ticketId);

  const attachmentIds = [...new Set(input.attachmentIds ?? [])].filter((id) =>
    Number.isInteger(id) && id > 0,
  );

  return db.transaction(async (trx) => {
    const actor = portalActor();

    let reopened = false;
    let targetId = detail.id;

    if (!OPEN_CATEGORIES.includes(detail.statusCategory)) {
      const result = await ticketService.reopen(
        principal.tenantId,
        actor,
        detail.id,
        { reason: 'requester_replied_on_portal', comment: body.slice(0, 500) },
        trx,
      );
      reopened = result.reopened;
      if (result.followUp) targetId = result.followUp.id;
    }

    // Attachments are accepted only when they are ALREADY linked to something
    // this contact may read — which, in practice, means the upload route linked
    // them to this ticket a moment ago. Without the check a requester could
    // attach any blob id in the tenant to their own reply and then read it back
    // through the portal download route.
    for (const attachmentId of attachmentIds) {
      await assertAttachmentVisible(principal, attachmentId, trx);
    }

    const entry = await ticketService.addJournalEntry(
      principal.tenantId,
      actor,
      targetId,
      { kind: 'public_reply', visibility: 'public', bodyMd: body, attachmentIds },
      trx,
    );

    // The desk's journal writer has no contact-aware overload; stamping the
    // author here (inside the same transaction, before anything has read the
    // row) is what makes the timeline say "Jane Doe" instead of "Portal".
    await scoped('ticket_journal', principal.tenantId, trx)
      .where('ticket_journal.id', entry.id)
      .update({
        author_contact_id: principal.contactId,
        author_type: 'portal',
        meta: db.raw("coalesce(ticket_journal.meta, '{}'::jsonb) || ?::jsonb", [
          JSON.stringify({ portal: { contactId: principal.contactId, email: principal.email } }),
        ]),
      });

    return { journalId: Number(entry.id), ticketId: targetId, reopened };
  });
}

export interface PortalCreateTicketInput {
  subject: string;
  bodyMd: string;
  /** HARD RULE 6 — intake asks WHEN IT HAPPENED, not when the form was filled. */
  occurredAt?: string | null;
  attachmentIds?: number[];
}

/**
 * A requester files a ticket.
 *
 * Priority, queue and status are NOT taken from the requester. Not because they
 * cannot be trusted, but because they are derived: the priority matrix owns
 * priority, the state machine owns the initial status, and routing owns the
 * queue. A portal that let a requester pick "P1" would have every ticket be a
 * P1 inside a month, and the matrix would be decoration.
 */
export async function createTicket(
  principal: PortalPrincipal,
  input: PortalCreateTicketInput,
): Promise<{ id: number; number: string }> {
  const subject = (input.subject ?? '').trim();
  if (subject === '') throw new AppError(400, 'A subject is required');
  const body = (input.bodyMd ?? '').trim();

  const attachmentIds = [...new Set(input.attachmentIds ?? [])].filter(
    (id) => Number.isInteger(id) && id > 0,
  );
  for (const attachmentId of attachmentIds) {
    await assertAttachmentVisible(principal, attachmentId);
  }

  const occurredAt = (() => {
    if (!input.occurredAt) return new Date().toISOString();
    const parsed = new Date(input.occurredAt);
    if (Number.isNaN(parsed.getTime())) return new Date().toISOString();
    // A requester's clock, or their typing, can put this in the future. The
    // honest clamp is "now" — an occurrence that has not happened yet would
    // make every elapsed-time metric on the ticket negative.
    return parsed.getTime() > Date.now() ? new Date().toISOString() : parsed.toISOString();
  })();

  const ticket = await ticketService.create(
    {
      tenantId: principal.tenantId,
      recordType: 'incident',
      subject: subject.slice(0, 512),
      descriptionMd: body,
      source: 'portal',
      requesterContactId: principal.contactId,
      organizationId: principal.organizationId,
      occurredAt,
      attachmentIds,
      openingEntry: {
        kind: 'public_reply',
        visibility: 'public',
        bodyMd: body,
        meta: { portal: { contactId: principal.contactId, email: principal.email } },
      },
    },
    { actorType: 'portal', actorId: null },
  );

  // Same reason as `reply()`: attribute the opening entry to the person who
  // wrote it rather than to the abstraction "portal".
  const opening = (await scoped('ticket_journal', principal.tenantId)
    .where('ticket_journal.ticket_id', ticket.id)
    .orderBy('ticket_journal.seq', 'asc')
    .first('ticket_journal.id')) as { id: string | number } | undefined;

  if (opening) {
    await scoped('ticket_journal', principal.tenantId)
      .where('ticket_journal.id', opening.id)
      .update({ author_contact_id: principal.contactId, author_type: 'portal' });
  }

  logger.info(
    { tenantId: principal.tenantId, contactId: principal.contactId, ticketId: ticket.id },
    'portal: ticket created by a requester',
  );

  return { id: ticket.id, number: ticket.number };
}

/** Whether this tenant lets requesters attach files at all. */
export async function attachmentsAllowed(tenantId: number): Promise<boolean> {
  return settingsService.get<boolean>(tenantId, 'portal.allowAttachmentUpload').catch(() => true);
}

/**
 * Store a file a requester uploaded and link it to a ticket they may see.
 *
 * Linked to the TICKET rather than left floating, so `assertAttachmentVisible`
 * can answer for it on the very next request and the orphan sweeper never
 * collects a file somebody is about to attach.
 */
export async function uploadAttachment(
  principal: PortalPrincipal,
  ticketId: number,
  file: { originalname: string; buffer: Buffer; mimetype?: string },
): Promise<{ id: number; filename: string; byteSize: number }> {
  if (!(await attachmentsAllowed(principal.tenantId))) {
    throw new AppError(403, 'This portal does not accept file uploads');
  }
  await getTicket(principal, ticketId);

  const result = await attachmentService.uploadAttachment({
    tenantId: principal.tenantId,
    uploadedBy: null,
    file,
    link: { entityType: 'ticket', entityId: ticketId },
    // A requester has no business uploading an executable, and unlike inbound
    // mail there is no evidentiary reason to keep one.
    rejectExecutables: true,
  });

  return {
    id: result.attachment.id,
    filename: result.attachment.filename ?? file.originalname,
    byteSize: result.attachment.byteSize,
  };
}

// ═════════════════════════════════════════════════════════════════════════════

export const portalService = {
  MAGIC_LINK_TTL_MS,
  PORTAL_SESSION_TTL_MS,
  requestMagicLink,
  verifyMagicLink,
  pruneTokens,
  requirePortalSession,
  currentPrincipal,
  listTickets,
  getTicket,
  assertAttachmentVisible,
  reply,
  createTicket,
  attachmentsAllowed,
  uploadAttachment,
};

export default portalService;
