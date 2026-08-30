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
import type { ActorType, JournalKind, StatusCategory } from '@oblidesk/shared';
import { PAGINATION } from '@oblidesk/shared';

import { db, scoped, insertScoped, assertTenantId, type Executor } from '../db';
import { config } from '../config';
import { AppError, badRequest, conflict, notFound } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { generateUrlToken, hmacSha256Base64, safeEqual, sha256Hex } from '../utils/crypto';
import { auditService } from './audit.service';
import * as journalService from './journal.service';
import { ticketService } from './ticket.service';
import { settingsService } from './settings.service';
import * as attachmentService from './attachment.service';
import { mailboxService } from './mail/mailbox.service';
import { outboundService } from './mail/outbound.service';

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — The principal, and the session that carries it
// ═════════════════════════════════════════════════════════════════════════════

/** What a portal contact is allowed to read. See migration 009. */
export type PortalOrgVisibility = 'own' | 'organization';

export interface PortalPrincipal {
  tenantId: number;
  /** HARD RULE 13 — the cross-app tenant identity. */
  tenantSlug: string;
  contactId: number;
  email: string;
  displayName: string | null;
  organizationId: number | null;
  /**
   * What this contact may READ. Granted by an agent on the contact record;
   * never inferred from belonging to an organisation, and never taken from the
   * request. `?scope=organization` is a preference about what to show, not a
   * claim about what may be shown.
   */
  orgVisibility: PortalOrgVisibility;
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
// SECTION 2 — Token minting
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
// SECTION 3 — Request a link
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
  /**
   * Always true. See the note about enumeration below.
   *
   * And ONLY this. The shape used to carry a `devToken` outside production,
   * which made an unauthenticated endpoint hand back a live credential; the
   * field is gone rather than conditioned, so no caller can reintroduce the
   * habit by reading it.
   */
  accepted: true;
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
      'portal_contacts.org_visibility',
      'portal_contacts.locale',
      'portal_contacts.is_active',
    )) as
    | {
        id: number;
        email: string;
        display_name: string | null;
        organization_id: number | null;
        org_visibility: string;
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
  const recent = (await scoped('portal_login_tokens', tenant.id)
    .where('portal_login_tokens.email', email)
    .where('portal_login_tokens.created_at', '>=', since)
    .count({ total: '*' })) as unknown as Array<{ total: string | number }>;

  if (Number(recent?.[0]?.total ?? 0) >= RATE_MAX_REQUESTS) {
    logger.warn({ tenantId: tenant.id, email }, 'portal: magic-link rate limit hit for an address');
    return generic;
  }

  const live = (await scoped('portal_login_tokens', tenant.id)
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

  await insertScoped('portal_login_tokens', tenant.id, {
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

  // The token NEVER travels in this response, in any environment.
  //
  // It used to, whenever `config.isProd` was false — and `NODE_ENV` defaults to
  // 'development' (config.ts:83), so the safe branch was the one you had to opt
  // into. This endpoint is unauthenticated by nature: it is the front door. Any
  // caller who knew, or guessed, a contact address got that contact's live
  // login token back in the body and could open their session immediately. A
  // staging desk, a demo, or a production stack whose compose file forgot one
  // variable was an open account for every customer it served.
  //
  // Convenience during development is real, so it is kept — moved to the log,
  // where it reaches the operator running the server and nobody else. An
  // authentication boundary must not depend on an environment variable being
  // remembered.
  if (!config.isProd) {
    logger.warn(
      { tenantId: tenant.id, contactId: contact.id, devToken: minted.token },
      'portal: dev magic-link token (logged, never returned over HTTP)',
    );
  }

  return generic;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — Verify
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

  const token = (await scoped('portal_login_tokens', tenant.id)
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

  const burned = await scoped('portal_login_tokens', tenant.id)
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
      'portal_contacts.org_visibility',
      'portal_contacts.locale',
      'portal_contacts.is_active',
    )) as
    | {
        id: number;
        email: string;
        display_name: string | null;
        organization_id: number | null;
        org_visibility: string;
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
      orgVisibility: contact.org_visibility === 'organization' ? 'organization' : 'own',
      locale: contact.locale ?? 'en',
    },
    expiresAt: new Date(Date.now() + PORTAL_SESSION_TTL_MS).toISOString(),
  };
}

export interface PruneTokensOptions {
  /** Retention past expiry. Used and expired links are evidence for a day. */
  olderThanMs?: number;
  /** Confine the sweep to one tenant. See the note on HARD RULE 1 below. */
  tenantId?: number;
}

/**
 * Housekeeping: used and expired tokens are evidence for a day, litter after.
 *
 * ── A note on the unscoped delete (HARD RULE 1) ──────────────────────────────
 * `portal_login_tokens` is a tenant table and a bare `db(...)` against one is a
 * defect anywhere reachable from a request. This is the same worker exception
 * `outbox.service.ts` and `approval.service.ts` document, and it holds for the
 * same three reasons: the sweep has no tenant to scope by because it sweeps for
 * every tenant, its only predicate is a clock (no request value reaches it), and
 * it deletes rows that are already dead to `verifyMagicLink` — an expired token
 * proves nothing before this runs and nothing after. Given a `tenantId` it uses
 * the scoped builder, which is what the tests and any per-tenant purge take.
 */
export async function pruneTokens(options: PruneTokensOptions = {}): Promise<number> {
  const horizon = new Date(Date.now() - (options.olderThanMs ?? 24 * 3600_000));

  const base =
    options.tenantId !== undefined
      ? scoped('portal_login_tokens', options.tenantId)
      : db('portal_login_tokens');

  return base.where('portal_login_tokens.expires_at', '<', horizon).del();
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — The session guard
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
        'portal_contacts.org_visibility',
        'portal_contacts.locale',
        'portal_contacts.is_active',
      )) as
      | {
          id: number;
          email: string;
          display_name: string | null;
          organization_id: number | null;
          org_visibility: string;
          locale: string;
          is_active: boolean;
        }
      | undefined;

    if (!contact || !contact.is_active) {
      delete req.session.portal;
      res.status(401).json({ success: false, error: 'Portal sign-in required' });
      return;
    }

    // `portal.enabled` was consulted only by `requestMagicLink`, so switching
    // the portal off stopped new sign-ins and left every session already open
    // running until it expired twelve hours later. An operator who turns a
    // customer-facing surface off means now, usually because something is
    // wrong with what it is showing. Read on every request, next to the
    // `is_active` re-read that is here for the same reason.
    const portalOn = await settingsService
      .get<boolean>(session.tenantId, 'portal.enabled')
      .catch(() => true);
    if (!portalOn) {
      delete req.session.portal;
      res.status(503).json({ success: false, error: 'The portal is currently unavailable' });
      return;
    }

    req.portal = {
      tenantId: session.tenantId,
      tenantSlug: session.tenantSlug,
      contactId: contact.id,
      email: contact.email,
      displayName: contact.display_name,
      organizationId: contact.organization_id,
      orgVisibility: contact.org_visibility === 'organization' ? 'organization' : 'own',
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
// SECTION 6 — Reads
// ═════════════════════════════════════════════════════════════════════════════

export type PortalScope = 'mine' | 'organization';

/**
 * What a requester is shown of a timeline entry, field by field.
 *
 * An ALLOW-LIST, not a redaction. The portal used to spread the whole
 * `TicketJournalEntry` and the whole `meta` into its response, and `JournalMeta`
 * carries `[key: string]: unknown` — so every engine that ever writes a note
 * decides, by accident, what a customer reads. That already shipped the rule
 * slugs and versions that fired, `decisionLogId`, the alert `dedupeKey` (which
 * encodes infrastructure names), `approvalId`/`approvalState`, the ids of other
 * tickets a merge swallowed, the minutes the desk logged, and a `changes` diff
 * of arbitrary fields with their before and after values.
 *
 * Spelling the shape out means the next engine to invent a meta key is
 * invisible here by default, which is the only direction this list can safely
 * fail in.
 */
export interface PortalJournalEntry {
  id: number;
  seq: number;
  kind: JournalKind;
  /** 'portal' when the requester wrote it, anything else is the desk. */
  authorType: ActorType;
  /** Display name only. An agent's `username` is a login credential. */
  authorName: string | null;
  authorAvatar: string | null;
  authorContact: { displayName: string | null; email: string } | null;
  bodyMd: string | null;
  bodyHtml: string | null;
  createdAt: string;
  attachments?: unknown[];
  /**
   * The two things the portal actually renders out of `meta`: which status a
   * state change moved to, and the collapsed mail chip. Nothing else crosses.
   */
  meta: {
    toStatusSlug?: string;
    toCategory?: StatusCategory;
    mail?: { chip?: string };
  };
}

/**
 * The record types a requester may ever see. Not "everything that is not a
 * problem": a new internal record type must be invisible by DEFAULT, and an
 * allow-list is the only shape that gives it that.
 */
const PORTAL_RECORD_TYPES: readonly string[] = ['incident', 'request'];

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
  const qb = scoped('tickets', principal.tenantId, executor)
    .whereNull('tickets.deleted_at')
    // A requester files incidents and requests. Everything else on this table
    // is the desk talking to itself: a problem carries its root-cause analysis,
    // a change its risk assessment and approvals. They were reachable here
    // because `promote()` copies the originating incident's organization_id
    // onto the problem ticket (problem.service.ts), and this predicate keyed on
    // that column alone — so a customer with organisation reading could open
    // the internal record written ABOUT their incident.
    .whereIn('tickets.record_type', PORTAL_RECORD_TYPES);

  // The right decides, not the query string. A contact who has not been
  // granted organisation reading gets their own tickets whatever they ask for,
  // and is not told the parameter was ignored: refusing loudly would advertise
  // that a wider view exists to somebody probing for it.
  const mayWiden =
    principal.orgVisibility === 'organization' && principal.organizationId !== null;

  if (scopeName === 'organization' && mayWiden) {
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
  journal: PortalJournalEntry[];
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
    journal: page.entries.map((entry): PortalJournalEntry => {
      const chip = (entry.meta as { mail?: { chip?: unknown } }).mail?.chip;
      return {
        id: entry.id,
        seq: entry.seq,
        kind: entry.kind,
        authorType: entry.authorType,
        // The desk speaks with one voice to a customer. A display name is a
        // person; a username is how that person signs in.
        authorName: entry.author?.displayName?.trim() || null,
        authorAvatar: entry.author?.avatar ?? null,
        authorContact: entry.authorContact
          ? { displayName: entry.authorContact.displayName, email: entry.authorContact.email }
          : null,
        bodyMd: entry.bodyMd,
        bodyHtml: portalizeAttachmentUrls(entry.bodyHtml),
        createdAt: entry.createdAt,
        attachments: entry.attachments,
        meta: {
          ...(entry.meta.toStatusSlug ? { toStatusSlug: entry.meta.toStatusSlug } : {}),
          ...(entry.meta.toCategory ? { toCategory: entry.meta.toCategory } : {}),
          // The collapsed mail chip carries inline images too, and it is
          // rendered straight out of `meta` by the client.
          ...(typeof chip === 'string' ? { mail: { chip: portalizeAttachmentUrls(chip) ?? undefined } } : {}),
        },
      };
    }),
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
// SECTION 7 — Writes
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
/**
 * Prove the requester may WRITE on this ticket, not merely read it.
 *
 * `org_visibility` is a reading right and says so everywhere it is defined:
 * migration 009 ("what this contact may READ"), the column comment, the admin
 * screen. Writing was nonetheless authorised by `getTicket`, the READ
 * predicate, so a customer-side manager granted organisation reading could post
 * a public reply on any colleague's ticket. That reply carries their name into
 * a conversation they were given permission to watch, and because a requester
 * reply REOPENS a resolved ticket, it also moves somebody else's work back into
 * the queue.
 *
 * A wider read must never quietly widen the write. If replying on behalf of a
 * whole company is wanted later, it is a second right with its own grant and
 * its own audit line, not a side effect of the first.
 *
 * Answered from `mine`, which `getTicket` already computes, so there is no
 * second query and no second definition of "whose ticket is this".
 */
async function assertMayWrite(
  principal: PortalPrincipal,
  ticketId: number,
): Promise<PortalTicketDetail> {
  const detail = await getTicket(principal, ticketId);
  if (!detail.mine) {
    throw new AppError(403, 'You can read this ticket but only its requester can add to it', {
      code: 'forbidden',
    });
  }
  return detail;
}

export async function reply(
  principal: PortalPrincipal,
  ticketId: number,
  input: PortalReplyInput,
): Promise<PortalReplyResult> {
  const body = (input.bodyMd ?? '').trim();
  if (body === '') throw new AppError(400, 'A reply cannot be empty');
  if (body.length > 100_000) throw new AppError(413, 'That reply is too long');

  // Proves the WRITE right before anything is written. Visibility alone is not
  // it: see assertMayWrite.
  const detail = await assertMayWrite(principal, ticketId);

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
  // Attaching is writing: the file lands on the ticket and shows in its
  // timeline. Reading the ticket is not enough.
  await assertMayWrite(principal, ticketId);

  const result = await attachmentService.uploadAttachment({
    tenantId: principal.tenantId,
    uploadedBy: null,
    file,
    link: {
      entityType: 'ticket',
      entityId: ticketId,
      // "Who sent us this?" now has an answer on the one surface where the
      // sender is not an employee. `uploadedBy` above stays null on purpose:
      // that column names a `users` row and a requester has none.
      linkedByContactId: principal.contactId,
    },
    // A requester has no business uploading an executable, and unlike inbound
    // mail there is no evidentiary reason to keep one.
    rejectExecutables: true,
  });

  return {
    id: result.attachment.id,
    // The name the REQUESTER gave, never the stored row's.
    //
    // `uploadAttachment` de-duplicates by content hash across the whole tenant
    // and returns the EXISTING row when the bytes match. That row was named by
    // whoever uploaded it first — an agent, or another customer of the same
    // desk. Echoing it back told this requester a filename from a ticket they
    // cannot open, and a filename is often the whole secret
    // ("redundancy-plan-2026.xlsx"). Reusing the blob is right; inheriting its
    // label is not.
    filename: file.originalname,
    byteSize: result.attachment.byteSize,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 8 — Administration: what an AGENT does to the portal
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Everything above this line runs as a REQUESTER. Everything below runs as an
 * AGENT holding `portal_admin`, and the two never share a code path — the
 * functions here take a `tenantId` and a `PortalAdminActor` (a `users.id`),
 * never a `PortalPrincipal`, so a portal session cannot reach them even if a
 * route were miswired.
 *
 * ── The one invariant this section exists to protect ────────────────────────
 *
 *   `setContactVisibility` IS THE ONLY WRITE THAT CAN RAISE
 *   `org_visibility` TO 'organization'.
 *
 * `createContact` always writes 'own'; `updateContact` and
 * `reassignOrganizationContacts` can only LOWER it, and both do so
 * automatically whenever a contact's organisation changes. That asymmetry is
 * deliberate. The right is granted AGAINST A SPECIFIC ORGANISATION: carrying it
 * across when somebody moves the contact to a different customer would hand a
 * stranger a whole company's ticket history as a side effect of a directory
 * edit nobody read as a permission change. Narrowing silently is safe and is
 * audited; widening silently is the breach, so widening needs its own verb, its
 * own route and its own audit action.
 *
 * ── Why `decision_log` is not written here (HARD RULE 2) ────────────────────
 * `decision_log` explains AUTOMATED decisions on a TICKET — a routing choice, a
 * priority, an SLA retarget — and its rows carry a `ticket_id`. Nothing in this
 * section is automated and nothing here is about one ticket: a human opened a
 * screen and changed a directory record. That belongs in the hash-chained
 * `audit_log`, written by `auditService.record()` inside the same transaction
 * as the change it describes, which is what every function below does. Writing
 * a ticket-less decision row would put a human's edit in the table the "Why?"
 * panel replays, and the panel would start explaining things no engine decided.
 */

/** The agent behind an administrative write. `actorId` is a `users.id`. */
export interface PortalAdminActor {
  actorId: number;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Escape the LIKE metacharacters before wrapping a search term in `%…%`.
 * Without it, searching for `100%` matches every organisation in the tenant and
 * `_` becomes a single-character wildcard — a search box that silently ignores
 * two of the characters people type.
 */
function likeTerm(raw: string): string {
  return `%${raw.trim().replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** 1-based page → LIMIT/OFFSET, clamped to the shared ceiling. */
function pageWindow(page?: number, limit?: number): { page: number; limit: number; offset: number } {
  const size = Math.min(Math.max(Math.trunc(limit ?? PAGINATION.defaultLimit), 1), PAGINATION.maxLimit);
  const index = Math.max(Math.trunc(page ?? 1), 1);
  return { page: index, limit: size, offset: (index - 1) * size };
}

function countOf(rows: unknown): number {
  const first = (rows as Array<{ total?: string | number }> | undefined)?.[0];
  return Number(first?.total ?? 0);
}

function isoOf(value: Date | string): string {
  return new Date(value).toISOString();
}

/**
 * Order-sensitive list equality, used to decide whether a patch actually
 * changes anything. Element-wise rather than a joined string: a separator that
 * can appear inside an element makes `['a','b']` and `['a b']` compare equal,
 * and a domain list is exactly the kind of place that eventually happens.
 */
function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

// ── Organisations ────────────────────────────────────────────────────────────

export interface OrganizationRecord {
  id: number;
  name: string;
  /** HARD RULE 3 — the handle SLA policies and config bundles cross-reference. */
  slug: string;
  domains: string[];
  externalRef: string | null;
  createdAt: string;
  updatedAt: string;
  /** Denormalised for the directory list; see `organizationCounts`. */
  contactCount: number;
  openTicketCount: number;
}

/** What stands in the way of deleting an organisation. */
export interface OrganizationUsage {
  contactCount: number;
  /** Contacts whose reading right names this organisation. */
  orgReaderCount: number;
  ticketCount: number;
  openTicketCount: number;
  contractCount: number;
}

interface OrganizationRow {
  id: number;
  name: string;
  slug: string;
  domains: string[] | null;
  external_ref: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const ORGANIZATION_COLUMNS = [
  'organizations.id',
  'organizations.name',
  'organizations.slug',
  'organizations.domains',
  'organizations.external_ref',
  'organizations.created_at',
  'organizations.updated_at',
] as const;

function mapOrganization(
  row: OrganizationRow,
  counts: { contactCount?: number; openTicketCount?: number } = {},
): OrganizationRecord {
  return {
    id: Number(row.id),
    name: String(row.name),
    slug: String(row.slug),
    domains: Array.isArray(row.domains) ? row.domains.map(String) : [],
    externalRef: row.external_ref,
    createdAt: isoOf(row.created_at),
    updatedAt: isoOf(row.updated_at),
    contactCount: counts.contactCount ?? 0,
    openTicketCount: counts.openTicketCount ?? 0,
  };
}

/**
 * Slug from a name, for the common case where nobody typed one.
 *
 * The shape is the one `slugSchema` accepts everywhere else in the API: it must
 * start with a letter or a digit, and it must survive being written into an
 * SLA policy condition by hand.
 */
function slugifyName(raw: string): string {
  const base = raw
    .normalize('NFKD')
    // Strip the combining marks NFKD just separated out, so "Réseau" becomes
    // "reseau" rather than "r-seau".
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return base === '' ? 'org' : base;
}

/**
 * Domains are lowercased, de-duplicated and stripped of a leading `@`.
 *
 * Worth knowing what this list DOES: `inbound.service.resolveRequester()`
 * attributes an unknown sender to an organisation by matching the domain of
 * their address against it. A public domain entered here (`gmail.com`) files
 * every consumer address on the internet under that customer. The desk cannot
 * tell a public domain from a small company's, so this normalises rather than
 * refuses — but the screen that edits it should say so.
 */
function normalizeDomains(raw: readonly string[] | null | undefined): string[] {
  const seen = new Set<string>();
  for (const entry of raw ?? []) {
    const value = String(entry).trim().toLowerCase().replace(/^@+/, '');
    if (value !== '') seen.add(value.slice(0, 253));
  }
  return [...seen];
}

type OrganizationSort = 'name' | 'slug' | 'createdAt' | 'updatedAt';

const ORGANIZATION_SORT_COLUMNS: Record<OrganizationSort, string> = {
  name: 'organizations.name',
  slug: 'organizations.slug',
  createdAt: 'organizations.created_at',
  updatedAt: 'organizations.updated_at',
};

export interface ListOrganizationsQuery {
  q?: string;
  page?: number;
  limit?: number;
  sort?: OrganizationSort;
  dir?: 'asc' | 'desc';
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Contact and open-ticket counts for a page of organisations.
 *
 * Two grouped aggregates keyed on the ids already fetched, rather than
 * correlated sub-selects in the list query: the page is at most
 * `PAGINATION.maxLimit` rows, so this is two index scans instead of 2N, and the
 * SQL stays something a reviewer can read.
 */
async function organizationCounts(
  tenantId: number,
  ids: number[],
  executor: Executor = db,
): Promise<{ contacts: Map<number, number>; openTickets: Map<number, number> }> {
  const contacts = new Map<number, number>();
  const openTickets = new Map<number, number>();
  if (ids.length === 0) return { contacts, openTickets };

  const contactRows = (await scoped('portal_contacts', tenantId, executor)
    .whereIn('portal_contacts.organization_id', ids)
    .groupBy('portal_contacts.organization_id')
    .select('portal_contacts.organization_id')
    .count({ total: '*' })) as unknown as Array<{
    organization_id: number;
    total: string | number;
  }>;

  // HARD RULE 5 — "open" is a set of CATEGORIES, never a list of status slugs.
  // A tenant renaming "Open" to "In progress" must not empty this column.
  const ticketRows = (await scoped('tickets', tenantId, executor)
    .whereIn('tickets.organization_id', ids)
    .whereNull('tickets.deleted_at')
    .whereIn('tickets.status_category', OPEN_CATEGORIES)
    .groupBy('tickets.organization_id')
    .select('tickets.organization_id')
    .count({ total: '*' })) as unknown as Array<{
    organization_id: number;
    total: string | number;
  }>;

  for (const row of contactRows) contacts.set(Number(row.organization_id), Number(row.total));
  for (const row of ticketRows) openTickets.set(Number(row.organization_id), Number(row.total));

  return { contacts, openTickets };
}

export async function listOrganizations(
  tenantId: number,
  query: ListOrganizationsQuery = {},
): Promise<Paged<OrganizationRecord>> {
  assertTenantId(tenantId);
  const { page, limit, offset } = pageWindow(query.page, query.limit);
  const term = (query.q ?? '').trim();

  const applySearch = (qb: Knex.QueryBuilder): Knex.QueryBuilder => {
    if (term === '') return qb;
    const like = likeTerm(term);
    return qb.where((builder) => {
      builder
        .whereRaw('organizations.name ILIKE ?', [like])
        // `slug` is citext; the cast keeps the pattern operator unambiguous.
        .orWhereRaw('organizations.slug::text ILIKE ?', [like])
        // The GIN index on `domains` serves the EXACT lookup mail intake does
        // (`? = ANY(domains)`). This is a human typing three letters into a
        // search box over a directory of tens of rows, so flattening the array
        // is the honest trade rather than a missed index.
        .orWhereRaw("array_to_string(organizations.domains, ' ') ILIKE ?", [like]);
    });
  };

  const total = countOf(await applySearch(scoped('organizations', tenantId)).count({ total: '*' }));

  const rows = (await applySearch(scoped('organizations', tenantId))
    .orderBy(ORGANIZATION_SORT_COLUMNS[query.sort ?? 'name'], query.dir === 'desc' ? 'desc' : 'asc')
    // A stable tiebreak, so page 2 cannot repeat a row from page 1 when two
    // organisations share a name.
    .orderBy('organizations.id', 'asc')
    .limit(limit)
    .offset(offset)
    .select(...ORGANIZATION_COLUMNS)) as OrganizationRow[];

  const counts = await organizationCounts(
    tenantId,
    rows.map((row) => Number(row.id)),
  );

  return {
    page,
    limit,
    total,
    items: rows.map((row) =>
      mapOrganization(row, {
        contactCount: counts.contacts.get(Number(row.id)) ?? 0,
        openTicketCount: counts.openTickets.get(Number(row.id)) ?? 0,
      }),
    ),
  };
}

/**
 * Load one organisation, 404 if it is not this tenant's.
 *
 * `lock: true` takes `SELECT … FOR UPDATE` on the row, and it is not decoration
 * on the delete path. Postgres takes a `FOR KEY SHARE` lock on a referenced
 * parent row for every insert of a child that points at it, so holding
 * `FOR UPDATE` here is what makes "count the contacts, find none, delete" safe
 * against a contact being created against this organisation between the count
 * and the delete. Without it the FK's `ON DELETE SET NULL` would quietly
 * detach that new contact instead.
 */
async function loadOrganizationRow(
  tenantId: number,
  id: number,
  executor: Executor = db,
  options: { lock?: boolean } = {},
): Promise<OrganizationRow> {
  const query = scoped('organizations', tenantId, executor).where('organizations.id', id);
  if (options.lock) query.forUpdate();

  const row = (await query.first(...ORGANIZATION_COLUMNS)) as OrganizationRow | undefined;
  if (!row) throw notFound('Organisation not found');
  return row;
}

export async function getOrganization(
  tenantId: number,
  id: number,
  executor: Executor = db,
): Promise<OrganizationRecord> {
  assertTenantId(tenantId);
  const row = await loadOrganizationRow(tenantId, id, executor);
  const counts = await organizationCounts(tenantId, [Number(row.id)], executor);
  return mapOrganization(row, {
    contactCount: counts.contacts.get(Number(row.id)) ?? 0,
    openTicketCount: counts.openTickets.get(Number(row.id)) ?? 0,
  });
}

/** Everything that would be destroyed or orphaned by deleting this organisation. */
export async function organizationUsage(
  tenantId: number,
  id: number,
  executor: Executor = db,
): Promise<OrganizationUsage> {
  assertTenantId(tenantId);

  const contactCount = countOf(
    await scoped('portal_contacts', tenantId, executor)
      .where('portal_contacts.organization_id', id)
      .count({ total: '*' }),
  );
  const orgReaderCount = countOf(
    await scoped('portal_contacts', tenantId, executor)
      .where('portal_contacts.organization_id', id)
      .where('portal_contacts.org_visibility', 'organization')
      .count({ total: '*' }),
  );
  // Soft-deleted tickets count. They are still the record of who filed what,
  // and a delete would rewrite their `organization_id` just the same.
  const ticketCount = countOf(
    await scoped('tickets', tenantId, executor)
      .where('tickets.organization_id', id)
      .count({ total: '*' }),
  );
  const openTicketCount = countOf(
    await scoped('tickets', tenantId, executor)
      .where('tickets.organization_id', id)
      .whereNull('tickets.deleted_at')
      .whereIn('tickets.status_category', OPEN_CATEGORIES)
      .count({ total: '*' }),
  );
  const contractCount = countOf(
    await scoped('contracts', tenantId, executor)
      .where('contracts.organization_id', id)
      .count({ total: '*' }),
  );

  return { contactCount, orgReaderCount, ticketCount, openTicketCount, contractCount };
}

export interface CreateOrganizationInput {
  name: string;
  /** Optional. Derived from the name when absent — see `allocateSlug`. */
  slug?: string | null;
  domains?: string[];
  externalRef?: string | null;
}

/**
 * Pick a free slug.
 *
 * An EXPLICIT slug that collides is a 409: the caller typed it, so they can fix
 * it. A DERIVED slug that collides gets a numeric suffix instead, because
 * "Acme" being taken is not something the person who typed a company name can
 * act on, and the suffixed slug comes back in the response — it is never a
 * secret. The unique index is still the authority; this only buys a readable
 * error in the common case, and `create`/`update` translate the 23505 a race
 * would produce.
 */
async function allocateSlug(
  tenantId: number,
  desired: string | null | undefined,
  name: string,
  executor: Executor,
): Promise<string> {
  const explicit = (desired ?? '').trim();

  const taken = async (candidate: string): Promise<boolean> =>
    Boolean(
      await scoped('organizations', tenantId, executor)
        .where('organizations.slug', candidate)
        .first('organizations.id'),
    );

  if (explicit !== '') {
    if (await taken(explicit)) throw slugConflict(explicit);
    return explicit;
  }

  const base = slugifyName(name);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    if (!(await taken(candidate))) return candidate;
  }
  throw conflict('Could not derive a free slug from that name — choose one explicitly', {
    code: 'slug_taken',
    slug: base,
  });
}

function slugConflict(slug: string): AppError {
  return conflict(`The slug "${slug}" is already used by another organisation`, {
    code: 'slug_taken',
    slug,
  });
}

/** Turn the unique-index violation a race produces into the same 409. */
function translateSlugRace(error: unknown, slug: string): unknown {
  const pg = error as { code?: string; constraint?: string };
  if (pg?.code === '23505' && pg.constraint === 'organizations_tenant_slug_uq') {
    return slugConflict(slug);
  }
  return error;
}

export async function createOrganization(
  tenantId: number,
  input: CreateOrganizationInput,
  actor: PortalAdminActor,
): Promise<OrganizationRecord> {
  assertTenantId(tenantId);
  const name = input.name.trim();
  if (name === '') throw badRequest('An organisation name is required', { name: 'required' });

  return db.transaction(async (trx) => {
    const slug = await allocateSlug(tenantId, input.slug, name, trx);
    const domains = normalizeDomains(input.domains);
    const externalRef = input.externalRef?.trim() || null;

    // Unqualified column names in RETURNING: the SELECT lists elsewhere are
    // table-qualified so joins stay unambiguous, but a RETURNING clause has
    // exactly one table and qualifying it there buys nothing.
    const RETURNED = [
      'id',
      'name',
      'slug',
      'domains',
      'external_ref',
      'created_at',
      'updated_at',
    ];

    let row: OrganizationRow;
    try {
      const [created] = (await insertScoped(
        'organizations',
        tenantId,
        { name, slug, domains, external_ref: externalRef },
        trx,
      ).returning(RETURNED)) as OrganizationRow[];
      row = created;
    } catch (error) {
      throw translateSlugRace(error, slug);
    }

    await auditService.record(
      {
        tenantId,
        actorId: actor.actorId,
        action: 'organization.create',
        entityType: 'organization',
        entityId: Number(row.id),
        after: { name, slug, domains, externalRef },
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
      },
      trx,
    );

    return mapOrganization(row);
  });
}

export interface UpdateOrganizationInput {
  name?: string;
  slug?: string;
  domains?: string[];
  externalRef?: string | null;
}

/**
 * Partial update. HARD RULE 12 — an absent key is not a cleared field, so a
 * one-field autosave from the inline editor changes exactly that field.
 *
 * ── Renaming the slug is a cross-reference edit, not a cosmetic one ──────────
 * `organizations.slug` is what an SLA policy's conditions match on
 * (`sla.service.organizationSlugFor`) and what a config bundle exported from
 * this tenant carries. Renaming it re-points, or silently un-matches, every
 * policy that named the old value. The rename is allowed — a customer really
 * does get renamed — but it is recorded with both values in the audit row so
 * "why did this customer stop getting the gold SLA on Tuesday?" has an answer.
 */
export async function updateOrganization(
  tenantId: number,
  id: number,
  input: UpdateOrganizationInput,
  actor: PortalAdminActor,
): Promise<OrganizationRecord> {
  assertTenantId(tenantId);

  await db.transaction(async (trx) => {
    const existing = await loadOrganizationRow(tenantId, id, trx);

    const patch: Record<string, unknown> = { updated_at: new Date() };
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    if (input.name !== undefined) {
      const name = input.name.trim();
      if (name === '') throw badRequest('An organisation name cannot be empty', { name: 'required' });
      if (name !== existing.name) {
        patch.name = name;
        before.name = existing.name;
        after.name = name;
      }
    }

    if (input.slug !== undefined) {
      const slug = input.slug.trim();
      if (slug === '') throw badRequest('An organisation slug cannot be empty', { slug: 'required' });
      if (slug !== String(existing.slug)) {
        const taken = await scoped('organizations', tenantId, trx)
          .where('organizations.slug', slug)
          .whereNot('organizations.id', id)
          .first('organizations.id');
        if (taken) throw slugConflict(slug);
        patch.slug = slug;
        before.slug = String(existing.slug);
        after.slug = slug;
      }
    }

    if (input.domains !== undefined) {
      const domains = normalizeDomains(input.domains);
      const current = Array.isArray(existing.domains) ? existing.domains.map(String) : [];
      if (!sameStringList(domains, current)) {
        patch.domains = domains;
        before.domains = current;
        after.domains = domains;
      }
    }

    if (input.externalRef !== undefined) {
      const externalRef = input.externalRef?.trim() || null;
      if (externalRef !== existing.external_ref) {
        patch.external_ref = externalRef;
        before.externalRef = existing.external_ref;
        after.externalRef = externalRef;
      }
    }

    // Nothing actually changed. Do not write a row, and do not write an audit
    // entry either: a ledger padded with no-ops is a ledger nobody reads.
    if (Object.keys(after).length === 0) return;

    try {
      await scoped('organizations', tenantId, trx).where('organizations.id', id).update(patch);
    } catch (error) {
      throw translateSlugRace(error, String(patch.slug ?? existing.slug));
    }

    await auditService.record(
      {
        tenantId,
        actorId: actor.actorId,
        action: 'organization.update',
        entityType: 'organization',
        entityId: id,
        before,
        after,
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
      },
      trx,
    );
  });

  return getOrganization(tenantId, id);
}

/**
 * Delete an organisation, and refuse loudly when it still carries anything.
 *
 * ── Why this is not a cascade, and not an archive flag either ────────────────
 * Three foreign keys point at `organizations`, and every one of them makes a
 * silent delete a data-loss event rather than a tidy-up:
 *
 *   contracts.organization_id       ON DELETE CASCADE  — the billing contracts
 *       for that customer are DELETED. Block hours, retainers, the SLA policy
 *       slug they carry: gone, with no row left to say they existed.
 *   tickets.organization_id         ON DELETE SET NULL — every ticket that
 *       customer ever filed loses the only column that says whose it was.
 *       Reporting, contract consumption and the portal's organisation scope all
 *       read that column, and none of them can tell "never had an org" from
 *       "had one until somebody deleted it".
 *   portal_contacts.organization_id ON DELETE SET NULL — and for any contact
 *       holding `org_visibility = 'organization'` that violates migration 009's
 *       `portal_contacts_org_visibility_needs_org_ck`, so the delete fails
 *       halfway through as a raw 23514 that reads like a server bug.
 *
 * So: an organisation is deletable only while it is EMPTY, and the refusal
 * carries the counts so the screen can say exactly what is in the way. The way
 * out for a customer that has churned is `reassignOrganizationContacts` (which
 * empties the contact side deliberately and downgrades the reading rights it
 * invalidates) — and, for tickets, no way out at all. That is the correct
 * answer: a ticket is a historical record, and an organisation that has ever
 * received one is part of that record. Hiding such a customer from the pickers
 * is what an archive flag is for, and there is no column for one; adding it is
 * a migration, not something to fake by overloading `external_ref`.
 */
export async function deleteOrganization(
  tenantId: number,
  id: number,
  actor: PortalAdminActor,
): Promise<{ deleted: true }> {
  assertTenantId(tenantId);

  return db.transaction(async (trx) => {
    // Locked: the emptiness check and the delete have to see the same world.
    // See `loadOrganizationRow` for why a row lock on the PARENT closes the
    // window against a child being inserted in the middle.
    const existing = await loadOrganizationRow(tenantId, id, trx, { lock: true });
    const usage = await organizationUsage(tenantId, id, trx);

    if (usage.contactCount > 0 || usage.ticketCount > 0 || usage.contractCount > 0) {
      throw conflict(
        'This organisation still has contacts, tickets or contracts attached and cannot be deleted',
        { code: 'organization_not_empty', organizationId: id, usage },
      );
    }

    await scoped('organizations', tenantId, trx).where('organizations.id', id).del();

    await auditService.record(
      {
        tenantId,
        actorId: actor.actorId,
        action: 'organization.delete',
        entityType: 'organization',
        entityId: id,
        before: {
          name: existing.name,
          slug: String(existing.slug),
          domains: Array.isArray(existing.domains) ? existing.domains.map(String) : [],
          externalRef: existing.external_ref,
        },
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
      },
      trx,
    );

    return { deleted: true };
  });
}

export interface ReassignContactsResult {
  moved: number;
  /** How many lost `org_visibility = 'organization'` in the move. */
  visibilityRevoked: number;
}

/**
 * Move every contact out of one organisation, in one statement.
 *
 * The right that names the old organisation does NOT travel: the UPDATE writes
 * `org_visibility = 'own'` alongside the new `organization_id`, so a customer
 * manager moved to a different company does not arrive holding a licence to
 * read that company's tickets. Writing both columns in the SAME statement is
 * also what keeps migration 009's CHECK satisfied when the target is NULL —
 * clearing the organisation first and downgrading afterwards would fail with a
 * 23514 in between.
 *
 * One audit row rather than one per contact: it is a single administrative act,
 * and the row carries the ids so the revocations stay individually traceable.
 */
export async function reassignOrganizationContacts(
  tenantId: number,
  fromOrganizationId: number,
  targetOrganizationId: number | null,
  actor: PortalAdminActor,
): Promise<ReassignContactsResult> {
  assertTenantId(tenantId);

  if (targetOrganizationId === fromOrganizationId) {
    throw badRequest('Choose a different organisation to move these contacts into', {
      targetOrganizationId: 'must differ from the source organisation',
    });
  }

  return db.transaction(async (trx) => {
    // The source is locked for the same reason the delete locks it: this is
    // usually the step BEFORE a delete, and two administrators emptying the
    // same organisation at once should serialise rather than interleave.
    await loadOrganizationRow(tenantId, fromOrganizationId, trx, { lock: true });
    if (targetOrganizationId !== null) await loadOrganizationRow(tenantId, targetOrganizationId, trx);

    // The CONTACT rows are locked too, not just their organisation. Locking the
    // parent serialises two admins emptying the same org, but it does nothing
    // about a concurrent `setContactVisibility` grant, which touches a contact
    // without ever looking at the organisation. Without this lock such a grant
    // could land between the count and the UPDATE below: the update revokes it
    // — correctly — while `visibilityRevoked` and therefore the audit row say
    // it never existed. A ledger that under-reports what it took away is worse
    // than no ledger, because it is believed.
    const affected = (await scoped('portal_contacts', tenantId, trx)
      .where('portal_contacts.organization_id', fromOrganizationId)
      .forUpdate()
      .select('portal_contacts.id', 'portal_contacts.org_visibility')) as Array<{
      id: number;
      org_visibility: string;
    }>;

    if (affected.length === 0) return { moved: 0, visibilityRevoked: 0 };

    const revoked = affected
      .filter((row) => row.org_visibility === 'organization')
      .map((row) => Number(row.id));

    await scoped('portal_contacts', tenantId, trx)
      .where('portal_contacts.organization_id', fromOrganizationId)
      .update({
        organization_id: targetOrganizationId,
        org_visibility: 'own',
        updated_at: new Date(),
      });

    await auditService.record(
      {
        tenantId,
        actorId: actor.actorId,
        action: 'organization.contacts_reassign',
        entityType: 'organization',
        entityId: fromOrganizationId,
        before: {
          organizationId: fromOrganizationId,
          contactIds: affected.map((row) => Number(row.id)).slice(0, 500),
          organizationReaderContactIds: revoked.slice(0, 500),
        },
        after: {
          organizationId: targetOrganizationId,
          moved: affected.length,
          visibilityRevoked: revoked.length,
          truncated: affected.length > 500,
        },
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
      },
      trx,
    );

    logger.info(
      {
        tenantId,
        fromOrganizationId,
        targetOrganizationId,
        moved: affected.length,
        visibilityRevoked: revoked.length,
      },
      'portal admin: contacts reassigned between organisations',
    );

    return { moved: affected.length, visibilityRevoked: revoked.length };
  });
}

// ── Portal contacts ──────────────────────────────────────────────────────────

export interface PortalContactRecord {
  id: number;
  email: string;
  displayName: string | null;
  phone: string | null;
  organizationId: number | null;
  organizationName: string | null;
  organizationSlug: string | null;
  /** Set when this requester ALSO holds an agent login. Read-only here. */
  userId: number | null;
  isActive: boolean;
  orgVisibility: PortalOrgVisibility;
  locale: string;
  createdAt: string;
  updatedAt: string;
}

interface PortalContactRow {
  id: number;
  email: string;
  display_name: string | null;
  phone: string | null;
  organization_id: number | null;
  organization_name: string | null;
  organization_slug: string | null;
  user_id: number | null;
  is_active: boolean;
  org_visibility: string;
  locale: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapContact(row: PortalContactRow): PortalContactRecord {
  return {
    id: Number(row.id),
    email: String(row.email),
    displayName: row.display_name,
    phone: row.phone,
    organizationId: row.organization_id === null ? null : Number(row.organization_id),
    organizationName: row.organization_name,
    organizationSlug: row.organization_slug === null ? null : String(row.organization_slug),
    userId: row.user_id === null ? null : Number(row.user_id),
    isActive: Boolean(row.is_active),
    // The same narrowing the principal readers use: anything that is not
    // exactly 'organization' reads as 'own'.
    orgVisibility: row.org_visibility === 'organization' ? 'organization' : 'own',
    locale: row.locale ?? 'en',
    createdAt: isoOf(row.created_at),
    updatedAt: isoOf(row.updated_at),
  };
}

/**
 * The hydrated read. The join is scoped on BOTH sides — `organizations.tenant_id
 * = portal_contacts.tenant_id` — because a join predicate that only matches on
 * the id is a cross-tenant read waiting for two tenants to allocate the same
 * organisation id, which they will: each tenant's rows come from one shared
 * sequence, not a per-tenant one.
 */
function contactSelect(tenantId: number, executor: Executor = db): Knex.QueryBuilder {
  return scoped('portal_contacts', tenantId, executor)
    .leftJoin('organizations', function joinOrganization() {
      this.on('organizations.id', '=', 'portal_contacts.organization_id').andOn(
        'organizations.tenant_id',
        '=',
        'portal_contacts.tenant_id',
      );
    })
    .select(
      'portal_contacts.id',
      'portal_contacts.email',
      'portal_contacts.display_name',
      'portal_contacts.phone',
      'portal_contacts.organization_id',
      'portal_contacts.user_id',
      'portal_contacts.is_active',
      'portal_contacts.org_visibility',
      'portal_contacts.locale',
      'portal_contacts.created_at',
      'portal_contacts.updated_at',
      'organizations.name as organization_name',
      'organizations.slug as organization_slug',
    );
}

type PortalContactSort = 'email' | 'displayName' | 'createdAt' | 'updatedAt';

const CONTACT_SORT_COLUMNS: Record<PortalContactSort, string> = {
  email: 'portal_contacts.email',
  displayName: 'portal_contacts.display_name',
  createdAt: 'portal_contacts.created_at',
  updatedAt: 'portal_contacts.updated_at',
};

export interface ListPortalContactsQuery {
  q?: string;
  /** A numeric id, or the literal `'none'` for contacts belonging to nobody. */
  organizationId?: number | 'none';
  isActive?: boolean;
  orgVisibility?: PortalOrgVisibility;
  page?: number;
  limit?: number;
  sort?: PortalContactSort;
  dir?: 'asc' | 'desc';
}

export async function listContacts(
  tenantId: number,
  query: ListPortalContactsQuery = {},
): Promise<Paged<PortalContactRecord>> {
  assertTenantId(tenantId);
  const { page, limit, offset } = pageWindow(query.page, query.limit);
  const term = (query.q ?? '').trim();

  const applyFilters = (qb: Knex.QueryBuilder): Knex.QueryBuilder => {
    if (query.organizationId === 'none') qb.whereNull('portal_contacts.organization_id');
    else if (typeof query.organizationId === 'number') {
      qb.where('portal_contacts.organization_id', query.organizationId);
    }
    if (query.isActive !== undefined) qb.where('portal_contacts.is_active', query.isActive);
    if (query.orgVisibility !== undefined) {
      qb.where('portal_contacts.org_visibility', query.orgVisibility);
    }
    if (term !== '') {
      const like = likeTerm(term);
      qb.where((builder) => {
        builder
          // `email` is citext; the cast keeps ILIKE unambiguous.
          .whereRaw('portal_contacts.email::text ILIKE ?', [like])
          // `portal_contacts_name_trgm` (GIN, gin_trgm_ops) serves this one.
          .orWhereRaw('portal_contacts.display_name ILIKE ?', [like])
          .orWhereRaw('portal_contacts.phone ILIKE ?', [like]);
      });
    }
    return qb;
  };

  const total = countOf(await applyFilters(scoped('portal_contacts', tenantId)).count({ total: '*' }));

  const rows = (await applyFilters(contactSelect(tenantId))
    .orderBy(CONTACT_SORT_COLUMNS[query.sort ?? 'email'], query.dir === 'desc' ? 'desc' : 'asc')
    .orderBy('portal_contacts.id', 'asc')
    .limit(limit)
    .offset(offset)) as PortalContactRow[];

  return { page, limit, total, items: rows.map(mapContact) };
}

export async function getContact(
  tenantId: number,
  id: number,
  executor: Executor = db,
): Promise<PortalContactRecord> {
  assertTenantId(tenantId);
  const row = (await contactSelect(tenantId, executor).where('portal_contacts.id', id).first()) as
    | PortalContactRow
    | undefined;
  if (!row) throw notFound('Contact not found');
  return mapContact(row);
}

/**
 * Resolve an organisation id arriving in a request body.
 *
 * The lookup is scoped, so an id belonging to another tenant simply is not
 * found — and the answer is a 400 on the field rather than a 404 on the
 * request, because the request is about a CONTACT that does exist and the
 * organisation is one value inside it. It also means a caller probing tenant
 * boundaries learns the same thing whether the id is unknown or merely someone
 * else's.
 */
async function resolveOrganizationId(
  tenantId: number,
  organizationId: number | null | undefined,
  executor: Executor,
): Promise<number | null> {
  if (organizationId === null || organizationId === undefined) return null;
  const row = await scoped('organizations', tenantId, executor)
    .where('organizations.id', organizationId)
    .first('organizations.id');
  if (!row) {
    throw badRequest('That organisation does not exist in this tenant', {
      organizationId: 'unknown organisation',
    });
  }
  return Number(organizationId);
}

export interface CreatePortalContactInput {
  email: string;
  displayName?: string | null;
  phone?: string | null;
  organizationId?: number | null;
  locale?: string;
  isActive?: boolean;
}

/**
 * Create a requester.
 *
 * `org_visibility` is NOT an input. A contact is born reading their own tickets
 * and nothing else, and the wider right is granted afterwards through
 * `setContactVisibility` — one deliberate act, one audit verb, one screen that
 * has to explain what it does. Accepting it here would make "read every ticket
 * this customer ever filed" a checkbox on a create form, which is how it ends
 * up ticked by default in a seeding script six months from now.
 */
export async function createContact(
  tenantId: number,
  input: CreatePortalContactInput,
  actor: PortalAdminActor,
): Promise<PortalContactRecord> {
  assertTenantId(tenantId);

  const email = input.email.trim().toLowerCase();
  if (email === '' || !email.includes('@')) {
    throw badRequest('A valid e-mail address is required', { email: 'required' });
  }

  const id = await db.transaction(async (trx) => {
    const organizationId = await resolveOrganizationId(tenantId, input.organizationId ?? null, trx);

    const duplicate = await scoped('portal_contacts', tenantId, trx)
      .where('portal_contacts.email', email)
      .first('portal_contacts.id');
    if (duplicate) {
      throw conflict('A contact with that e-mail address already exists', {
        code: 'contact_email_taken',
        email,
        contactId: Number((duplicate as { id: number }).id),
      });
    }

    const [created] = (await insertScoped(
      'portal_contacts',
      tenantId,
      {
        email,
        display_name: input.displayName?.trim() || null,
        phone: input.phone?.trim() || null,
        organization_id: organizationId,
        is_active: input.isActive ?? true,
        locale: input.locale ?? 'en',
        // See the invariant at the top of this section: only
        // `setContactVisibility` may ever write 'organization'.
        org_visibility: 'own',
      },
      trx,
    ).returning('id')) as Array<{ id: number }>;

    await auditService.record(
      {
        tenantId,
        actorId: actor.actorId,
        action: 'portal_contact.create',
        entityType: 'portal_contact',
        entityId: Number(created.id),
        after: {
          email,
          displayName: input.displayName?.trim() || null,
          organizationId,
          isActive: input.isActive ?? true,
          orgVisibility: 'own',
        },
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
      },
      trx,
    );

    return Number(created.id);
  });

  return getContact(tenantId, id);
}

export interface UpdatePortalContactInput {
  displayName?: string | null;
  phone?: string | null;
  organizationId?: number | null;
  locale?: string;
}

/**
 * Partial update. HARD RULE 12 — an absent key changes nothing.
 *
 * `email` is deliberately not updatable, matching `UpdatePortalContactRequest`
 * in shared. An address is not a display field: it is where magic links are
 * sent, what inbound mail threads on, and the identity every ticket this person
 * filed is attributed to. Changing it is "this is now a different person", and
 * that is a create plus a deactivate, not an edit.
 *
 * Changing `organizationId` REVOKES `org_visibility`. See the invariant at the
 * top of this section — and note that revocation takes effect on the requester's
 * very next request, because `requirePortalSession` re-reads the column rather
 * than trusting the cookie.
 */
export async function updateContact(
  tenantId: number,
  id: number,
  input: UpdatePortalContactInput,
  actor: PortalAdminActor,
): Promise<PortalContactRecord> {
  assertTenantId(tenantId);

  await db.transaction(async (trx) => {
    const existing = (await scoped('portal_contacts', tenantId, trx)
      .where('portal_contacts.id', id)
      .first(
        'portal_contacts.id',
        'portal_contacts.display_name',
        'portal_contacts.phone',
        'portal_contacts.organization_id',
        'portal_contacts.org_visibility',
        'portal_contacts.locale',
      )) as
      | {
          id: number;
          display_name: string | null;
          phone: string | null;
          organization_id: number | null;
          org_visibility: string;
          locale: string;
        }
      | undefined;

    if (!existing) throw notFound('Contact not found');

    const patch: Record<string, unknown> = { updated_at: new Date() };
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    if (input.displayName !== undefined) {
      const displayName = input.displayName?.trim() || null;
      if (displayName !== existing.display_name) {
        patch.display_name = displayName;
        before.displayName = existing.display_name;
        after.displayName = displayName;
      }
    }

    if (input.phone !== undefined) {
      const phone = input.phone?.trim() || null;
      if (phone !== existing.phone) {
        patch.phone = phone;
        before.phone = existing.phone;
        after.phone = phone;
      }
    }

    if (input.locale !== undefined && input.locale !== existing.locale) {
      patch.locale = input.locale;
      before.locale = existing.locale;
      after.locale = input.locale;
    }

    if (input.organizationId !== undefined) {
      const organizationId = await resolveOrganizationId(tenantId, input.organizationId, trx);
      const current = existing.organization_id === null ? null : Number(existing.organization_id);
      if (organizationId !== current) {
        patch.organization_id = organizationId;
        before.organizationId = current;
        after.organizationId = organizationId;

        // The right named the OLD organisation. It does not follow the person.
        if (existing.org_visibility === 'organization') {
          patch.org_visibility = 'own';
          before.orgVisibility = 'organization';
          after.orgVisibility = 'own';
        }
      }
    }

    if (Object.keys(after).length === 0) return;

    await scoped('portal_contacts', tenantId, trx).where('portal_contacts.id', id).update(patch);

    await auditService.record(
      {
        tenantId,
        actorId: actor.actorId,
        action: 'portal_contact.update',
        entityType: 'portal_contact',
        entityId: id,
        before,
        after,
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
      },
      trx,
    );
  });

  return getContact(tenantId, id);
}

/**
 * Activate or deactivate a requester.
 *
 * Deactivation bites IMMEDIATELY, not at session expiry: `requirePortalSession`
 * re-reads `is_active` on every request and `verifyMagicLink` re-checks it after
 * burning the token, so an outstanding link sitting in a mailbox is already
 * dead. Nothing has to be revoked by hand, and nothing here writes the `users`
 * table — a portal contact is not a user (see the top of this file).
 *
 * Deactivation is also the ONLY removal this module offers. There is no
 * `deleteContact`, and that is a decision rather than an omission:
 * `tickets.requester_contact_id` and `ticket_journal.author_contact_id` are both
 * ON DELETE SET NULL, so deleting a contact would anonymise every ticket they
 * ever filed and every reply they ever wrote — turning a customer's history into
 * a set of messages from nobody.
 */
export async function setContactActive(
  tenantId: number,
  id: number,
  isActive: boolean,
  actor: PortalAdminActor,
): Promise<PortalContactRecord> {
  assertTenantId(tenantId);

  await db.transaction(async (trx) => {
    const existing = (await scoped('portal_contacts', tenantId, trx)
      .where('portal_contacts.id', id)
      .first('portal_contacts.id', 'portal_contacts.email', 'portal_contacts.is_active')) as
      | { id: number; email: string; is_active: boolean }
      | undefined;

    if (!existing) throw notFound('Contact not found');
    if (Boolean(existing.is_active) === isActive) return;

    await scoped('portal_contacts', tenantId, trx)
      .where('portal_contacts.id', id)
      .update({ is_active: isActive, updated_at: new Date() });

    await auditService.record(
      {
        tenantId,
        actorId: actor.actorId,
        // Two verbs rather than one `portal_contact.update` with a boolean:
        // "who locked this customer out, and when" is a question the ledger
        // should answer with a filter, not with a payload search.
        action: isActive ? 'portal_contact.activate' : 'portal_contact.deactivate',
        entityType: 'portal_contact',
        entityId: id,
        before: { isActive: Boolean(existing.is_active) },
        after: { isActive, email: String(existing.email) },
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
      },
      trx,
    );
  });

  return getContact(tenantId, id);
}

export interface SetContactVisibilityInput {
  orgVisibility: PortalOrgVisibility;
  /**
   * Optional. Grant the right and set the organisation in one act, for the
   * common "promote this person to read all of ACME" flow. Omitted, the
   * contact's current organisation is used.
   */
  organizationId?: number | null;
}

/**
 * THE grant. The only write in this module that can raise `org_visibility`.
 *
 * What is actually being handed over: `visibleTickets()` widens on this column,
 * so a contact holding 'organization' reads every ticket belonging to their
 * organisation — including the ones their colleagues filed about them. That is
 * the point (a customer-side manager who needs the whole picture), and it is
 * also why it is a deliberate act with its own route and its own audit verb
 * rather than a field on a form.
 *
 * ── Why the 409 instead of letting the CHECK fire ───────────────────────────
 * Migration 009 already refuses `organization` on a contact with no
 * organisation, and it is right to: a right that names nothing cannot be
 * exercised, and `visibleTickets` would silently narrow such a contact back to
 * their own tickets — an agent would tick the box, see it saved, and be wrong
 * about what the customer can see. But a bare constraint violation reaches the
 * client as a 23514 with no field and no sentence. So the same rule is stated
 * here, in words, with the field named; the CHECK stays as the floor under a
 * code path that forgets.
 */
export async function setContactVisibility(
  tenantId: number,
  id: number,
  input: SetContactVisibilityInput,
  actor: PortalAdminActor,
): Promise<PortalContactRecord> {
  assertTenantId(tenantId);

  await db.transaction(async (trx) => {
    const existing = (await scoped('portal_contacts', tenantId, trx)
      .where('portal_contacts.id', id)
      .first(
        'portal_contacts.id',
        'portal_contacts.email',
        'portal_contacts.organization_id',
        'portal_contacts.org_visibility',
      )) as
      | { id: number; email: string; organization_id: number | null; org_visibility: string }
      | undefined;

    if (!existing) throw notFound('Contact not found');

    const currentOrgId = existing.organization_id === null ? null : Number(existing.organization_id);
    const targetOrgId =
      input.organizationId === undefined
        ? currentOrgId
        : await resolveOrganizationId(tenantId, input.organizationId, trx);

    if (input.orgVisibility === 'organization' && targetOrgId === null) {
      throw conflict(
        'This contact belongs to no organisation, so there is nothing for them to read. Assign an organisation first.',
        { code: 'organization_required', contactId: id },
      );
    }

    const currentVisibility: PortalOrgVisibility =
      existing.org_visibility === 'organization' ? 'organization' : 'own';

    if (currentVisibility === input.orgVisibility && targetOrgId === currentOrgId) return;

    await scoped('portal_contacts', tenantId, trx)
      .where('portal_contacts.id', id)
      // Both columns in ONE statement: 009's CHECK is evaluated per row per
      // statement, so setting the organisation and the right together is what
      // makes "grant and assign in one act" legal at all.
      .update({
        organization_id: targetOrgId,
        org_visibility: input.orgVisibility,
        updated_at: new Date(),
      });

    await auditService.record(
      {
        tenantId,
        actorId: actor.actorId,
        action:
          input.orgVisibility === 'organization'
            ? 'portal_contact.visibility_grant'
            : 'portal_contact.visibility_revoke',
        entityType: 'portal_contact',
        entityId: id,
        before: { orgVisibility: currentVisibility, organizationId: currentOrgId },
        after: {
          orgVisibility: input.orgVisibility,
          organizationId: targetOrgId,
          email: String(existing.email),
        },
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
      },
      trx,
    );

    logger.info(
      { tenantId, contactId: id, orgVisibility: input.orgVisibility, organizationId: targetOrgId },
      'portal admin: contact reading right changed',
    );
  });

  return getContact(tenantId, id);
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

  // ── Administration (agent side, `portal_admin`) ──────────────────────────
  listOrganizations,
  getOrganization,
  organizationUsage,
  createOrganization,
  updateOrganization,
  deleteOrganization,
  reassignOrganizationContacts,
  listContacts,
  getContact,
  createContact,
  updateContact,
  setContactActive,
  setContactVisibility,
};

export default portalService;
