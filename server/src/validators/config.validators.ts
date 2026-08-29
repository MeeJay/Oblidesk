/**
 * config.validators.ts — the HTTP boundary for the configuration, view,
 * dashboard and metric routes.
 *
 * Three jobs, and they are all boundary jobs:
 *
 *  1. ASSEMBLE THE ACTOR. Every service in this slice takes a `ConfigActor`
 *     and never touches a request object. {@link resolveActor} is the single
 *     place a session becomes one: tenant, role, capabilities, group
 *     membership, master-tenant flag, IP and user agent. Because it reads the
 *     session and re-reads the tenant membership from the database on each
 *     request, a route that is accidentally mounted outside the auth
 *     middleware still fails with 401 rather than acting as nobody in
 *     particular.
 *
 *  2. VALIDATE THE SHAPE. zod schemas, one per request, kept next to each
 *     other so the vocabulary of the whole slice is readable in one file.
 *
 *  3. SHAPE THE ENVELOPE. `{ success: true, data }` / `{ success: false,
 *     error }`, with the right status, and one translation from the services'
 *     error classes to HTTP.
 *
 * Note what is NOT here: no metric filter object, no column list, no operator,
 * no ORDER BY. The metric schema accepts a registered key, a declared
 * dimension, an offered range and a published view slug — see
 * metric.service.ts for why that boundary is drawn where it is.
 */

import type { Request, Response } from 'express';
import { z } from 'zod';

import {
  CONFIG_KINDS,
  TENANT_OVERRIDE_HEADER,
  hasCapability,
  sanitizeCapabilities,
  type Capability,
  type UserRole,
} from '@oblidesk/shared';

import { db, scoped } from '../db';
import {
  ConfigLintError,
  ConfigServiceError,
  ConfigVersionConflictError,
  isMasterTenant,
  type ConfigActor,
} from '../services/configObject.service';
import { FieldAccessError, FieldValueError } from '../services/customField.service';
import { METRIC_DIMENSIONS, METRIC_RANGES } from '../services/metric.service';

// ═════════════════════════════════════════════════════════════════════════════
// Session reading
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The session fields this slice reads.
 *
 * Deliberately NOT an `express-session` module augmentation: interface merging
 * requires every declaration of a property to have an identical type, so two
 * modules declaring `userId` slightly differently is a compile error in a file
 * neither of them owns. A local shape plus a cast costs one line and cannot
 * collide with the auth middleware's own declaration.
 */
interface SessionShape {
  userId?: number;
  username?: string;
  role?: string;
  currentTenantId?: number;
  tenantId?: number;
}

function readSession(req: Request): SessionShape {
  const session = (req as unknown as { session?: unknown }).session;
  if (!session || typeof session !== 'object') return {};
  return session as SessionShape;
}

function clientIp(req: Request): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const candidate = typeof first === 'string' ? first.split(',')[0]?.trim() : undefined;
  return candidate || req.socket?.remoteAddress || null;
}

const ROLES: readonly UserRole[] = ['admin', 'manager', 'agent', 'user'];

function toRole(value: unknown, fallback: UserRole = 'agent'): UserRole {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
    ? value as UserRole
    : fallback;
}

/**
 * Build the actor for this request.
 *
 * Capabilities come from three places and are unioned: the per-tenant
 * overrides on `user_tenants`, the permission sets the user holds in this
 * tenant, and nothing else — a role does not imply capabilities here, it is
 * carried alongside them so `hasCapability(..., isAdmin)` can short-circuit
 * for an admin without inventing a grant.
 */
export async function resolveActor(req: Request): Promise<ConfigActor> {
  const session = readSession(req);
  const userId = typeof session.userId === 'number' ? session.userId : null;

  if (userId === null) {
    throw new ConfigServiceError(401, 'Authentication required.', 'forbidden');
  }

  const user = (await db('users')
    .select('id', 'role', 'is_active')
    .where('id', userId)
    .first()) as { id: number; role: string; is_active: boolean } | undefined;

  if (!user || user.is_active !== true) {
    throw new ConfigServiceError(401, 'Authentication required.', 'forbidden');
  }

  const platformRole = toRole(user.role, 'user');

  // Tenant selection: the session's current tenant, unless a platform admin
  // explicitly asks for another one via the override header. A non-admin's
  // header is ignored rather than rejected — it is not an error to send it,
  // it simply has no effect.
  let tenantId = typeof session.currentTenantId === 'number'
    ? session.currentTenantId
    : typeof session.tenantId === 'number' ? session.tenantId : null;

  const override = req.header(TENANT_OVERRIDE_HEADER);
  if (override && platformRole === 'admin') {
    const requested = Number(override);
    if (Number.isInteger(requested) && requested > 0) tenantId = requested;
  }

  if (tenantId === null) {
    throw new ConfigServiceError(400, 'No tenant selected for this session.', 'tenant_mismatch');
  }

  const membership = (await db('user_tenants')
    .select('role', 'capabilities')
    .where('user_id', userId)
    .where('tenant_id', tenantId)
    .first()) as { role: string; capabilities: unknown } | undefined;

  if (!membership && platformRole !== 'admin') {
    throw new ConfigServiceError(403, 'You are not a member of this tenant.', 'forbidden');
  }

  const role = membership ? toRole(membership.role, 'agent') : platformRole;
  const isAdmin = role === 'admin' || platformRole === 'admin';

  const capabilities = new Set<Capability>(
    sanitizeCapabilities(parseMaybeJson(membership?.capabilities)),
  );

  const sets = (await scoped('permission_sets', tenantId)
    .join('user_permission_sets', 'user_permission_sets.permission_set_id', 'permission_sets.id')
    .where('user_permission_sets.user_id', userId)
    .select('permission_sets.capabilities')) as Array<{ capabilities: unknown }>;
  for (const set of sets) {
    for (const capability of sanitizeCapabilities(parseMaybeJson(set.capabilities))) {
      capabilities.add(capability);
    }
  }

  // Assignment groups resolve the `@my_groups` token in a saved view.
  const groups = (await scoped('assignment_groups', tenantId)
    .select('id')
    .whereRaw('assignment_groups.member_user_ids @> ?::int[]', [`{${userId}}`])) as Array<{ id: number }>;

  const tenant = (await db('tenants').select('slug').where('id', tenantId).first()) as { slug: string } | undefined;

  return {
    tenantId,
    tenantSlug: tenant ? String(tenant.slug) : null,
    userId,
    actorType: 'user',
    role,
    capabilities: [...capabilities],
    isAdmin,
    isMasterTenant: await isMasterTenant(tenantId),
    groupIds: groups.map((group) => Number(group.id)),
    ip: clientIp(req),
    userAgent: req.header('user-agent') ?? null,
  };
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

/** Throw unless the actor holds the capability (admins always do). */
export function requireCapability(actor: ConfigActor, capability: Capability): void {
  if (hasCapability(actor.capabilities, capability, actor.isAdmin)) return;
  throw new ConfigServiceError(403, `This action needs the "${capability}" capability.`, 'forbidden');
}

// ═════════════════════════════════════════════════════════════════════════════
// Envelope
// ═════════════════════════════════════════════════════════════════════════════

export function sendOk<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ success: true, data });
}

export function sendList<T>(
  res: Response,
  data: T[],
  meta: { total: number; page: number; limit: number },
): void {
  res.status(200).json({ success: true, data, ...meta });
}

export function sendFail(res: Response, status: number, error: string, extra?: Record<string, unknown>): void {
  res.status(status).json({ success: false, error, ...extra });
}

/**
 * One translation from this slice's errors to HTTP.
 *
 * The lint error carries its findings and the conflict error carries the
 * current row, because in both cases the client's next move is impossible
 * without them: "publish failed" with no findings is a dead end, and a 409
 * with no current version cannot render a diff.
 */
export function handleServiceError(res: Response, error: unknown): void {
  if (error instanceof ConfigLintError) {
    sendFail(res, error.status, error.message, {
      code: 'validation_failed',
      issues: error.findings,
    });
    return;
  }
  if (error instanceof ConfigVersionConflictError) {
    sendFail(res, 409, error.message, { code: 'version_conflict', current: error.current });
    return;
  }
  if (error instanceof FieldAccessError || error instanceof FieldValueError) {
    sendFail(res, error.status, error.message, { code: error.code, fieldErrors: error.fieldErrors });
    return;
  }
  if (error instanceof ConfigServiceError) {
    sendFail(res, error.status, error.message, { code: error.code });
    return;
  }
  if (error instanceof z.ZodError) {
    sendFail(res, 400, 'The request body is not valid.', {
      code: 'validation_failed',
      fieldErrors: zodFieldErrors(error),
    });
    return;
  }

  // Anything unrecognised is a bug, not a user error: log it, and do not
  // return its message — an unexpected error's text is as likely to be a
  // Postgres detail line as anything a user should read.
  // eslint-disable-next-line no-console
  console.error('[config.routes] unhandled error', error);
  sendFail(res, 500, 'Something went wrong handling that request.', { code: 'internal_error' });
}

function zodFieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.errors) {
    out[issue.path.join('.') || '_'] = issue.message;
  }
  return out;
}

/** Parse with a schema, throwing a ZodError `handleServiceError` understands. */
export function parseOrThrow<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  return schema.parse(value);
}

// ═════════════════════════════════════════════════════════════════════════════
// Shared primitives
// ═════════════════════════════════════════════════════════════════════════════

const kindEnum = z.enum(CONFIG_KINDS as unknown as [string, ...string[]]);
const statusEnum = z.enum(['draft', 'published', 'archived']);

/**
 * A slug is the identity every cross-reference uses (HARD RULE 3), so its
 * grammar is enforced at the boundary rather than left to the database's
 * `citext` to accept anything with a case-insensitive comparison.
 */
export const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'A slug is lowercase letters, digits, hyphen and underscore, starting with a letter or digit.');

/**
 * A condition tree arrives as opaque JSON and is validated structurally by
 * `isConditionNode` after `normalizeConditionTree` has folded the two dialects
 * together — a zod schema here would have to encode the recursion twice and
 * would still not catch an unknown operator.
 */
const conditionSchema = z.unknown().nullable().optional();

const bodySchema = z.record(z.unknown());

// ═════════════════════════════════════════════════════════════════════════════
// Config object schemas
// ═════════════════════════════════════════════════════════════════════════════

export const listConfigQuerySchema = z.object({
  kind: z.union([kindEnum, z.array(kindEnum)]).optional(),
  status: z.union([statusEnum, z.array(statusEnum)]).optional(),
  q: z.string().trim().max(128).optional(),
  isSystem: z.coerce.boolean().optional(),
  includeShared: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const createConfigObjectSchema = z.object({
  kind: kindEnum,
  slug: slugSchema,
  name: z.string().trim().min(1).max(191),
  description: z.string().max(4000).nullable().optional(),
  body: bodySchema,
  status: z.enum(['draft', 'published']).optional(),
  /**
   * Accepted, then IGNORED for any caller that is not the master tenant — see
   * `sanitizeTargetTenantIds`. Validated here only so a malformed array is a
   * 400 rather than a silent no-op.
   */
  targetTenantIds: z.array(z.coerce.number().int().positive()).max(500).optional(),
  note: z.string().max(1000).optional(),
});

export const updateConfigObjectSchema = z.object({
  name: z.string().trim().min(1).max(191).optional(),
  description: z.string().max(4000).nullable().optional(),
  body: bodySchema.optional(),
  targetTenantIds: z.array(z.coerce.number().int().positive()).max(500).optional(),
  note: z.string().max(1000).optional(),
  baseVersion: z.coerce.number().int().min(1).optional(),
});

export const publishConfigObjectSchema = z.object({
  note: z.string().max(1000).optional(),
});

export const revertConfigObjectSchema = z.object({
  version: z.coerce.number().int().min(1),
});

// ═════════════════════════════════════════════════════════════════════════════
// Bundle schemas
// ═════════════════════════════════════════════════════════════════════════════

export const exportBundleQuerySchema = z.object({
  kinds: z.union([kindEnum, z.array(kindEnum)]).optional(),
  includeDrafts: z.coerce.boolean().optional(),
  includeArchived: z.coerce.boolean().optional(),
});

/**
 * The envelope is checked structurally by `assertReadableBundle`, which knows
 * about format versions and per-kind body versions. This schema only asserts
 * that something bundle-shaped arrived, so the detailed refusal comes from the
 * one place that can explain it.
 */
export const importBundleSchema = z.object({
  bundle: z.unknown(),
  decisions: z.record(z.enum(['apply', 'skip'])).optional(),
  applyConflicts: z.coerce.boolean().optional(),
  note: z.string().max(1000).optional(),
});

export const resetDefaultsSchema = z.object({
  overwriteLocalEdits: z.coerce.boolean().optional(),
});

// ═════════════════════════════════════════════════════════════════════════════
// View schemas
// ═════════════════════════════════════════════════════════════════════════════

const viewColumnSchema = z.union([
  z.string().trim().min(1).max(128),
  z.object({
    field: z.string().trim().min(1).max(128),
    width: z.coerce.number().int().min(20).max(1000).optional(),
    align: z.enum(['left', 'center', 'right']).optional(),
    sortOrder: z.coerce.number().int().optional(),
  }),
]);

const viewSortSchema = z.object({
  field: z.string().trim().min(1).max(128),
  direction: z.enum(['asc', 'desc']).default('desc'),
});

export const saveViewSchema = z.object({
  slug: slugSchema,
  name: z.string().trim().min(1).max(191),
  description: z.string().max(2000).nullable().optional(),
  filter: conditionSchema,
  columns: z.array(viewColumnSchema).max(40).optional(),
  sort: z.array(viewSortSchema).max(4).optional(),
  groupBy: z.string().trim().max(128).nullable().optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
  showCount: z.coerce.boolean().optional(),
  icon: z.string().trim().max(64).nullable().optional(),
  layout: z.enum(['table', 'board', 'split']).optional(),
  scope: z.enum(['personal', 'tenant', 'system']).optional(),
  visibleToCapabilities: z.array(z.string().max(64)).max(32).optional(),
  sortOrder: z.coerce.number().int().optional(),
  publish: z.coerce.boolean().optional(),
});

export const updateViewSchema = saveViewSchema.omit({ slug: true }).extend({
  baseVersion: z.coerce.number().int().min(1).optional(),
});

export const viewListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const viewCountQuerySchema = z.object({
  force: z.coerce.boolean().optional(),
});

export const viewGroupQuerySchema = z.object({
  groupBy: z.string().trim().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

// ═════════════════════════════════════════════════════════════════════════════
// Dashboard schemas
// ═════════════════════════════════════════════════════════════════════════════

export const createDashboardSchema = z.object({
  slug: slugSchema,
  name: z.string().trim().min(1).max(200),
  isShared: z.coerce.boolean().optional(),
  isDefault: z.coerce.boolean().optional(),
  layout: z.record(z.unknown()).optional(),
});

export const updateDashboardSchema = createDashboardSchema.partial().omit({ slug: true });

export const widgetSchema = z.object({
  tabKey: z.string().trim().max(64).optional(),
  widgetType: z.string().trim().min(1).max(48),
  title: z.string().max(200).nullable().optional(),
  x: z.coerce.number().int().min(0).max(11).optional(),
  y: z.coerce.number().int().min(0).max(500).optional(),
  w: z.coerce.number().int().min(1).max(12).optional(),
  h: z.coerce.number().int().min(1).max(40).optional(),
  /**
   * Free-form only in shape. Every key that reaches a query is re-read and
   * checked against the metric registry by `planWidget`, which the write path
   * calls before this ever reaches the database.
   */
  config: z.record(z.unknown()).optional(),
  sortOrder: z.coerce.number().int().optional(),
});

export const updateWidgetSchema = widgetSchema.partial();

export const layoutSchema = z.object({
  positions: z.array(z.object({
    id: z.coerce.number().int().positive(),
    x: z.coerce.number().int().min(0).max(11),
    y: z.coerce.number().int().min(0).max(500),
    w: z.coerce.number().int().min(1).max(12),
    h: z.coerce.number().int().min(1).max(40),
    tabKey: z.string().trim().max(64).optional(),
    sortOrder: z.coerce.number().int().optional(),
  })).max(200),
});

export const materializeSchema = z.object({
  configSlug: slugSchema,
});

// ═════════════════════════════════════════════════════════════════════════════
// Metric schemas — the closed vocabulary
// ═════════════════════════════════════════════════════════════════════════════

const dimensionEnum = z.enum(METRIC_DIMENSIONS as unknown as [string, ...string[]]);
const rangeEnum = z.enum(METRIC_RANGES as unknown as [string, ...string[]]);

/**
 * THE boundary that keeps client SQL off the server.
 *
 * There is no `filter`, no `columns`, no `orderBy`, no `having`, no raw
 * anything. A caller may name a registered metric, one declared dimension, one
 * offered range, and a published saved view. Every one of those is validated
 * against the registry again inside `metric.service`, so this schema is a
 * convenience for a good client rather than the only thing standing between a
 * bad one and the database.
 */
export const metricQuerySchema = z.object({
  key: z.string().trim().min(1).max(64),
  range: rangeEnum.optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  groupBy: dimensionEnum.nullable().optional(),
  granularity: z.enum(['day', 'week', 'month']).nullable().optional(),
  viewSlug: slugSchema.nullable().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),

  // The closed scope vocabulary. Each is accepted only when the chosen metric
  // declares the matching dimension — enforced in `applyScope`.
  queueSlug: z.string().trim().max(128).optional(),
  prioritySlug: z.string().trim().max(128).optional(),
  assigneeId: z.coerce.number().int().positive().optional(),
  assignmentGroupId: z.coerce.number().int().positive().optional(),
  organizationId: z.coerce.number().int().positive().optional(),
  recordType: z.enum(['incident', 'request', 'problem', 'change', 'task', 'release']).optional(),
  source: z.enum(['web', 'email', 'portal', 'api', 'alert', 'phone', 'chat']).optional(),
  statusCategory: z.enum([
    'new', 'open', 'pending_requester', 'pending_third_party',
    'scheduled', 'resolved', 'closed', 'cancelled',
  ]).optional(),
});

export const metricRecordsQuerySchema = metricQuerySchema.extend({
  group: z.string().max(191).nullable().optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const metricDeltaQuerySchema = metricQuerySchema.extend({
  compareTo: z.enum(['yesterday', 'last_week']).optional(),
});

/** Split a parsed metric query into the request shape the service takes. */
export function toMetricRequest(parsed: z.infer<typeof metricQuerySchema>): {
  key: string;
  range?: (typeof METRIC_RANGES)[number];
  from?: string;
  to?: string;
  groupBy?: (typeof METRIC_DIMENSIONS)[number] | null;
  granularity?: 'day' | 'week' | 'month' | null;
  viewSlug?: string | null;
  limit?: number;
  scope: Record<string, unknown>;
} {
  const {
    key, range, from, to, groupBy, granularity, viewSlug, limit,
    queueSlug, prioritySlug, assigneeId, assignmentGroupId,
    organizationId, recordType, source, statusCategory,
  } = parsed;

  const scope: Record<string, unknown> = {};
  if (queueSlug) scope.queueSlug = queueSlug;
  if (prioritySlug) scope.prioritySlug = prioritySlug;
  if (assigneeId) scope.assigneeId = assigneeId;
  if (assignmentGroupId) scope.assignmentGroupId = assignmentGroupId;
  if (organizationId) scope.organizationId = organizationId;
  if (recordType) scope.recordType = recordType;
  if (source) scope.source = source;
  if (statusCategory) scope.statusCategory = statusCategory;

  return {
    key,
    range: range as (typeof METRIC_RANGES)[number] | undefined,
    from,
    to,
    groupBy: (groupBy ?? null) as (typeof METRIC_DIMENSIONS)[number] | null,
    granularity: granularity ?? null,
    viewSlug: viewSlug ?? null,
    limit,
    scope,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Route param helpers
// ═════════════════════════════════════════════════════════════════════════════

export const kindParamSchema = kindEnum;
export const slugParamSchema = slugSchema;
export const idParamSchema = z.coerce.number().int().positive();

/** Normalise a query value that may arrive as a repeated parameter. */
export function asArray<T>(value: T | T[] | undefined): T[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}
