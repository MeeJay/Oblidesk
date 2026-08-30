/**
 * portalAdmin.validators.ts — the HTTP boundary for `/api/organizations` and
 * `/api/portal-admin`, the two routers an AGENT uses to administer the portal.
 *
 * Three things this file is deliberate about:
 *
 * 1. `orgVisibility` IS NOT ACCEPTED ON A CREATE OR A PATCH. Only
 *    {@link setContactVisibilitySchema} carries it, and it is the body of one
 *    route. That mirrors the invariant `portal.service.ts` states in its
 *    administration section: raising a contact's reading right to
 *    `'organization'` hands them every ticket their whole company ever filed,
 *    so it gets its own verb, its own route and its own audit action rather
 *    than riding along as a field on a directory form. A schema that accepted
 *    it "for convenience" on `POST /contacts` is how it ends up preset in a
 *    seeding script nobody reviews.
 *
 * 2. NOTHING HERE VALIDATES COMPLETENESS (HARD RULE 12). Every field on the
 *    two update schemas is optional, so the inline editors can autosave one
 *    field at a time and leave a contact half-filled all day. What IS enforced
 *    is TYPE and SHAPE — an e-mail is an e-mail, a domain is a domain — because
 *    those are properties of the value, not of the record being finished.
 *
 * 3. THE VOCABULARIES MIRROR THE CHECK CONSTRAINTS. `orgVisibilitySchema` is
 *    the same two literals as migration 009's
 *    `portal_contacts_org_visibility_ck`, kept as a literal tuple so a mismatch
 *    is a compile error in one file instead of a 23514 at runtime — the same
 *    convention `ci.validators.ts` follows for the CI vocabulary.
 *
 * Query parameters arrive as strings, so the paging, the booleans and the
 * "no organisation" sentinel go through the preprocessors below; this is the
 * only place that conversion happens.
 */
import { z } from 'zod';
import { PAGINATION } from '@oblidesk/shared';

// The generic ZodError → 400 translation lives in the validate middleware and
// is not owned by any slice. Re-exported so the two routers import one
// validators module, exactly as `problem.validators.ts` does.
export { parseOrThrow } from '../middleware/validate';

// A contact id and an organisation id are ordinary ids, and a slug here is the
// same slug the rest of the API means (HARD RULE 3). Import the two primitives
// rather than restating them, so a change to what the desk calls a slug reaches
// these routes too.
import { idSchema, slugSchema } from './ticket.validators';

export { idSchema, slugSchema };

// ═════════════════════════════════════════════════════════════════════════════
// Primitives
// ═════════════════════════════════════════════════════════════════════════════

export const idParamSchema = z.object({ id: idSchema });

/**
 * `z.coerce.boolean()` is a trap for query strings: `Boolean('false')` is
 * `true`, so `?isActive=false` would ask for the opposite of what it says.
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

/** Shared paging shape: 1-based page, clamped to the suite-wide ceiling. */
const pagingSchema = {
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(PAGINATION.maxLimit).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
};

/** Free-text search. Capped because it becomes an ILIKE pattern. */
const searchSchema = z.string().trim().max(200).optional();

/**
 * The two values migration 009's `portal_contacts_org_visibility_ck` allows.
 * `own` = their own tickets; `organization` = every ticket of their
 * organisation.
 */
export const ORG_VISIBILITIES = ['own', 'organization'] as const;
export const orgVisibilitySchema = z.enum(ORG_VISIBILITIES);

/**
 * Only the two locales the suite seeds (HARD RULE 10). It is not decoration:
 * `requestMagicLink` picks the sign-in mail's language from this column, and it
 * has exactly two templates. A `de` stored here would silently send English.
 */
export const contactLocaleSchema = z.enum(['en', 'fr']);

/**
 * A mail domain, as `inbound.service.resolveRequester()` matches it: the bare
 * host, lowercased, no scheme, no path, no leading `@`. Anything else would sit
 * in the column matching nothing, which looks like a working rule until an
 * unattributed ticket turns up.
 */
export const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(253)
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/,
    'Expected a bare mail domain, for example "acme.example"',
  );

/** Enough for a customer with a long list of acquired brands, and no more. */
const domainListSchema = z.array(domainSchema).max(50);

// ═════════════════════════════════════════════════════════════════════════════
// Organisations
// ═════════════════════════════════════════════════════════════════════════════

export const listOrganizationsQuerySchema = z
  .object({
    q: searchSchema,
    sort: z.enum(['name', 'slug', 'createdAt', 'updatedAt']).optional(),
    ...pagingSchema,
  })
  .strip();

/**
 * `slug` is optional on create: the service derives one from the name and
 * suffixes it if it collides, because "Acme is taken" is not something the
 * person who typed a company name can act on. Supplied explicitly, a collision
 * is a 409 — they chose it, so they can choose again.
 */
export const createOrganizationSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    slug: slugSchema.optional(),
    domains: domainListSchema.optional(),
    externalRef: z.string().trim().max(200).nullish(),
  })
  .strict();

/**
 * Every field optional (HARD RULE 12). Note that `domains` replaces the whole
 * list rather than appending — a PATCH that carried an "add one domain" verb
 * would need a matching "remove", and two verbs over a five-element array is
 * more machinery than the screen needs.
 */
export const updateOrganizationSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    slug: slugSchema.optional(),
    domains: domainListSchema.optional(),
    externalRef: z.string().trim().max(200).nullish(),
  })
  .strict();

/**
 * Move every contact out of one organisation. `null` means "into no
 * organisation at all", which is the emptying step before a delete; it is
 * spelled explicitly rather than by omitting the key, so an accidental `{}`
 * cannot detach a customer's whole contact list.
 */
export const reassignContactsSchema = z
  .object({
    targetOrganizationId: idSchema.nullable(),
  })
  .strict();

// ═════════════════════════════════════════════════════════════════════════════
// Portal contacts
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `organizationId` accepts the literal `none` as well as an id, so the list can
 * ask for the contacts that belong to nobody — the ones mail intake created
 * from an address whose domain matched no organisation, which is exactly the
 * queue an administrator opens this screen to work through.
 */
const organizationFilterSchema = z
  .preprocess((value) => {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'string' && value.trim().toLowerCase() === 'none') return 'none';
    return value;
  }, z.union([z.literal('none'), idSchema]))
  .optional();

export const listContactsQuerySchema = z
  .object({
    q: searchSchema,
    organizationId: organizationFilterSchema,
    isActive: boolParam,
    orgVisibility: orgVisibilitySchema.optional(),
    sort: z.enum(['email', 'displayName', 'createdAt', 'updatedAt']).optional(),
    ...pagingSchema,
  })
  .strip();

/**
 * Note the absence of `orgVisibility`. See point 1 in this file's header: a
 * contact is born reading their own tickets, and the wider right is a separate,
 * audited act.
 */
export const createContactSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    displayName: z.string().trim().max(200).nullish(),
    phone: z.string().trim().max(64).nullish(),
    organizationId: idSchema.nullish(),
    locale: contactLocaleSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

/**
 * `email` is absent on purpose, matching `UpdatePortalContactRequest` in
 * shared. An address is where magic links are sent, what inbound mail threads
 * on, and the identity every ticket this person filed is attributed to.
 * Changing it means "this is a different person", which is a create plus a
 * deactivate, not an edit — and `.strict()` makes sending it a 400 rather than
 * a silently ignored field, so a client that tries finds out.
 */
export const updateContactSchema = z
  .object({
    displayName: z.string().trim().max(200).nullish(),
    phone: z.string().trim().max(64).nullish(),
    organizationId: idSchema.nullish(),
    locale: contactLocaleSchema.optional(),
  })
  .strict();

export const setContactActiveSchema = z.object({ isActive: z.boolean() }).strict();

/**
 * THE grant, and the only schema in this file that carries `orgVisibility`.
 *
 * `organizationId` is optional so the common flow — "promote this person to
 * read all of ACME" — is one request: assign the organisation and grant the
 * right together. Omitted, the contact's current organisation stands. The
 * service refuses `organization` with no organisation to name, with a sentence
 * and a field, before migration 009's CHECK would have refused it with a 23514.
 */
export const setContactVisibilitySchema = z
  .object({
    orgVisibility: orgVisibilitySchema,
    organizationId: idSchema.nullish(),
  })
  .strict();

export type ListOrganizationsQueryInput = z.infer<typeof listOrganizationsQuerySchema>;
export type CreateOrganizationInputDto = z.infer<typeof createOrganizationSchema>;
export type UpdateOrganizationInputDto = z.infer<typeof updateOrganizationSchema>;
export type ReassignContactsInputDto = z.infer<typeof reassignContactsSchema>;
export type ListContactsQueryInput = z.infer<typeof listContactsQuerySchema>;
export type CreateContactInputDto = z.infer<typeof createContactSchema>;
export type UpdateContactInputDto = z.infer<typeof updateContactSchema>;
export type SetContactVisibilityInputDto = z.infer<typeof setContactVisibilitySchema>;
