/**
 * mailbox.service.ts — the `mail_accounts` row, its secrets and its health.
 *
 * One row per mailbox the desk collects from or sends as. Everything that
 * needs to know *where* mail comes from goes through here, so there is exactly
 * one place that decrypts a mailbox password and exactly one place that decides
 * what the channel console is allowed to see.
 *
 * ── Secrets ─────────────────────────────────────────────────────────────────
 * `mail_accounts.config` is a jsonb blob that mixes public settings (host,
 * port, folder) with credentials (IMAP password, OAuth client secret, webhook
 * bearer). The credentials are stored as AES-256-GCM ciphertext under
 * ENCRYPTION_KEY via `utils/crypto`, and `toDto()` never returns them — the
 * client sees `passwordSet: true`, which is the only fact it needs to render
 * the form correctly.
 *
 * That split is enforced by construction rather than by discipline:
 * `SECRET_KEYS` lists the fields that are encrypted on write and deleted on
 * read, and both directions read the same list. A field added to one half and
 * forgotten in the other is the bug that leaks a mailbox password into an
 * admin screen, and lists are harder to forget than two symmetrical `if`s.
 *
 * ── Health, and why the sync cursor lives inside it ─────────────────────────
 * `health` drives the channel console: is this mailbox connected, when did it
 * last succeed, how many times has it failed in a row. The IMAP cursor
 * (UIDVALIDITY + last seen UID, per folder) lives in the same column under a
 * `sync` key.
 *
 * That is deliberate. The cursor and the health state are written by the same
 * connection at the same moments, and keeping them in one jsonb column means
 * one atomic `||` merge rather than two writes that can disagree after a
 * crash — a mailbox whose health says "connected" and whose cursor says
 * "never synced" re-downloads its entire inbox, which is how one restart turns
 * into four thousand duplicate tickets. `toHealthDto()` projects only the five
 * public fields, so the cursor never reaches a browser.
 *
 * Every write merges rather than replaces (`health || patch`), because the
 * connection updates `lastSeenAt` while the console might be updating nothing
 * at all, and a last-write-wins replace would silently reset the cursor.
 */
import type { Knex } from 'knex';
import type { MailAccount, MailAccountConfig, MailAccountHealth, MailAccountKind } from '@oblidesk/shared';
import { SOCKET_EVENTS } from '@oblidesk/shared';

import { db, scoped, insertScoped, assertTenantId, type Executor } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { encryptSecret, tryDecryptSecret, safeEqual } from '../../utils/crypto';
import { logger } from '../../utils/logger';
import { emitToTenant } from '../../socket';

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Rows, secrets and DTOs
// ═════════════════════════════════════════════════════════════════════════════

export interface MailAccountRow {
  id: number;
  tenant_id: number;
  name: string;
  kind: MailAccountKind;
  config: Record<string, unknown> | string;
  queue_slug: string | null;
  health: Record<string, unknown> | string;
  last_seen_at: Date | string | null;
  is_active: boolean;
}

/**
 * Config keys holding a secret. Encrypted on write, stripped on read, and
 * surfaced to the UI only as the matching `…Set` boolean.
 */
const SECRET_KEYS = ['password', 'clientSecret', 'webhookSecret', 'accessToken', 'refreshToken'] as const;
type SecretKey = (typeof SECRET_KEYS)[number];

const SECRET_FLAG: Readonly<Record<SecretKey, string>> = {
  password: 'passwordSet',
  clientSecret: 'clientSecretSet',
  webhookSecret: 'webhookSecretSet',
  accessToken: 'accessTokenSet',
  refreshToken: 'refreshTokenSet',
};

function asObject(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' ? ({ ...(value as Record<string, unknown>) }) : {};
}

/** The five public health fields. Anything else in the column stays server-side. */
export function toHealthDto(raw: unknown): MailAccountHealth {
  const health = asObject(raw);
  return {
    ok: health.ok === undefined ? true : Boolean(health.ok),
    lastError: typeof health.lastError === 'string' ? health.lastError : null,
    lastErrorAt: typeof health.lastErrorAt === 'string' ? health.lastErrorAt : null,
    consecutiveFailures: Number(health.consecutiveFailures ?? 0) || 0,
    messagesFetched24h: Number(health.messagesFetched24h ?? 0) || 0,
  };
}

/** Strip every secret, replacing it with its `…Set` flag. */
export function toConfigDto(raw: unknown): MailAccountConfig {
  const config = asObject(raw);
  for (const key of SECRET_KEYS) {
    const present = typeof config[key] === 'string' && (config[key] as string).length > 0;
    delete config[key];
    config[SECRET_FLAG[key]] = present;
  }
  // The sync cursor is operational state, not configuration.
  delete config.sync;
  return config as MailAccountConfig;
}

export function toDto(row: MailAccountRow): MailAccount {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    kind: row.kind,
    config: toConfigDto(row.config),
    queueSlug: row.queue_slug ?? 'general',
    health: toHealthDto(row.health),
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
    isActive: row.is_active,
  };
}

const COLUMNS = [
  'mail_accounts.id',
  'mail_accounts.tenant_id',
  'mail_accounts.name',
  'mail_accounts.kind',
  'mail_accounts.config',
  'mail_accounts.queue_slug',
  'mail_accounts.health',
  'mail_accounts.last_seen_at',
  'mail_accounts.is_active',
];

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — Tenant identity (HARD RULE 13)
// ═════════════════════════════════════════════════════════════════════════════

export interface TenantIdentity {
  id: number;
  slug: string;
  name: string;
}

const identityCache = new Map<number, TenantIdentity>();

/**
 * The tenant's SLUG, which is what the mail layer signs with and stamps into
 * List-Id — never the numeric id, which means nothing outside this database
 * (HARD RULE 13). `tenants` is a global table, so `db()` is correct here.
 */
export async function tenantIdentity(
  tenantId: number,
  executor: Executor = db,
): Promise<TenantIdentity> {
  assertTenantId(tenantId);
  const cached = identityCache.get(tenantId);
  if (cached) return cached;

  const row = (await executor('tenants')
    .where({ id: tenantId })
    .first('id', 'slug', 'name')) as TenantIdentity | undefined;
  if (!row) throw new AppError(404, `Tenant ${tenantId} does not exist`);

  const identity: TenantIdentity = { id: row.id, slug: String(row.slug), name: row.name };
  identityCache.set(tenantId, identity);
  return identity;
}

/** Resolve a tenant by its slug — the identity the suite passes around. */
export async function tenantBySlug(
  slug: string,
  executor: Executor = db,
): Promise<TenantIdentity | null> {
  const cleaned = (slug ?? '').trim();
  if (cleaned === '') return null;
  const row = (await executor('tenants')
    .where('slug', cleaned)
    .first('id', 'slug', 'name')) as TenantIdentity | undefined;
  if (!row) return null;
  const identity: TenantIdentity = { id: row.id, slug: String(row.slug), name: row.name };
  identityCache.set(identity.id, identity);
  return identity;
}

export function invalidateTenantIdentityCache(tenantId?: number): void {
  if (tenantId === undefined) identityCache.clear();
  else identityCache.delete(tenantId);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — Reads
// ═════════════════════════════════════════════════════════════════════════════

export async function list(tenantId: number, executor: Executor = db): Promise<MailAccount[]> {
  assertTenantId(tenantId);
  const rows = (await scoped('mail_accounts', tenantId, executor)
    .orderBy('mail_accounts.name')
    .select(...COLUMNS)) as MailAccountRow[];
  return rows.map(toDto);
}

/** The raw row, secrets still encrypted. Service-internal — never returned by a route. */
export async function getRow(
  tenantId: number,
  id: number,
  executor: Executor = db,
): Promise<MailAccountRow | null> {
  assertTenantId(tenantId);
  const row = (await scoped('mail_accounts', tenantId, executor)
    .where('mail_accounts.id', id)
    .first(...COLUMNS)) as MailAccountRow | undefined;
  return row ?? null;
}

export async function getById(
  tenantId: number,
  id: number,
  executor: Executor = db,
): Promise<MailAccount | null> {
  const row = await getRow(tenantId, id, executor);
  return row ? toDto(row) : null;
}

/**
 * Find the mailbox a message was addressed to, by name or by its own address.
 *
 * Scoped to one tenant on purpose. Resolving a mailbox from an address ACROSS
 * tenants would mean an attacker who knows one tenant's support address can
 * post mail into it while claiming to be another tenant — the webhook route
 * therefore names the tenant slug first and looks the mailbox up inside it.
 */
export async function findByAddressOrName(
  tenantId: number,
  needle: string,
  executor: Executor = db,
): Promise<MailAccountRow | null> {
  assertTenantId(tenantId);
  const cleaned = (needle ?? '').trim().toLowerCase();
  if (cleaned === '') return null;

  const rows = (await scoped('mail_accounts', tenantId, executor)
    .select(...COLUMNS)) as MailAccountRow[];

  for (const row of rows) {
    if (row.name.trim().toLowerCase() === cleaned) return row;
    const config = asObject(row.config);
    const address = String(config.address ?? config.username ?? '').trim().toLowerCase();
    if (address !== '' && address === cleaned) return row;
  }
  return null;
}

/** Every active mailbox the poller should hold a connection to, across tenants. */
export async function listActiveForPolling(
  executor: Executor = db,
): Promise<Array<MailAccountRow & { tenant_slug: string }>> {
  // The poller has no tenant context — it connects on behalf of all of them —
  // so this is the one read that must span tenants. It is a bare listing with
  // no caller-supplied predicate, and every row it yields is immediately
  // re-scoped by `tenant_id` before anything is written. Same exception, and
  // the same reasoning, as `outbox.service`'s worker.
  return (await executor('mail_accounts')
    .join('tenants', 'tenants.id', 'mail_accounts.tenant_id')
    .where('mail_accounts.is_active', true)
    .whereIn('mail_accounts.kind', ['imap', 'graph'])
    .orderBy('mail_accounts.tenant_id')
    .select(...COLUMNS, 'tenants.slug as tenant_slug')) as Array<
    MailAccountRow & { tenant_slug: string }
  >;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — Writes
// ═════════════════════════════════════════════════════════════════════════════

export interface SaveMailAccountInput {
  name: string;
  kind: MailAccountKind;
  config: Record<string, unknown>;
  queueSlug: string;
  isActive?: boolean;
}

const VALID_KINDS: readonly MailAccountKind[] = ['imap', 'graph', 'webhook'];

/**
 * Merge an incoming config onto the stored one, encrypting new secrets and
 * KEEPING the stored ciphertext for any secret the caller did not resend.
 *
 * That last part is what makes the settings form usable: the browser never
 * receives the password, so it cannot send it back, and a naive replace would
 * blank the credential every time somebody changed the port number.
 */
function mergeConfig(
  stored: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...stored };

  for (const [key, value] of Object.entries(incoming)) {
    if ((SECRET_KEYS as readonly string[]).includes(key)) continue;
    // The `…Set` booleans are outbound-only; echoing one back must not create
    // a config key named `passwordSet` that shadows the real question.
    if (Object.values(SECRET_FLAG).includes(key)) continue;
    if (key === 'sync') continue;
    next[key] = value;
  }

  for (const key of SECRET_KEYS) {
    const supplied = incoming[key];
    if (typeof supplied !== 'string') continue;
    if (supplied === '') {
      delete next[key];
      continue;
    }
    next[key] = encryptSecret(supplied);
  }

  return next;
}

export async function create(
  tenantId: number,
  input: SaveMailAccountInput,
  executor: Executor = db,
): Promise<MailAccount> {
  assertTenantId(tenantId);
  const name = (input.name ?? '').trim();
  if (name === '') throw new AppError(400, 'A mailbox name is required');
  if (!VALID_KINDS.includes(input.kind)) {
    throw new AppError(400, `Unknown mailbox kind "${String(input.kind)}"`);
  }
  const queueSlug = (input.queueSlug ?? '').trim();
  if (queueSlug === '') throw new AppError(400, 'A destination queue slug is required');

  const inserted = (await insertScoped(
    'mail_accounts',
    tenantId,
    {
      name,
      kind: input.kind,
      config: JSON.stringify(mergeConfig({}, asObject(input.config))),
      queue_slug: queueSlug,
      health: JSON.stringify({ ok: true, consecutiveFailures: 0 }),
      is_active: input.isActive !== false,
    },
    executor,
  ).returning(COLUMNS.map((c) => c.split('.')[1]))) as unknown as MailAccountRow[];

  return toDto(inserted[0]);
}

export async function update(
  tenantId: number,
  id: number,
  patch: Partial<SaveMailAccountInput>,
  executor: Executor = db,
): Promise<MailAccount> {
  const row = await getRow(tenantId, id, executor);
  if (!row) throw new AppError(404, 'Mailbox not found');

  const changes: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (name === '') throw new AppError(400, 'A mailbox name is required');
    changes.name = name;
  }
  if (patch.kind !== undefined) {
    if (!VALID_KINDS.includes(patch.kind)) {
      throw new AppError(400, `Unknown mailbox kind "${String(patch.kind)}"`);
    }
    changes.kind = patch.kind;
  }
  if (patch.queueSlug !== undefined) {
    const queueSlug = patch.queueSlug.trim();
    if (queueSlug === '') throw new AppError(400, 'A destination queue slug is required');
    changes.queue_slug = queueSlug;
  }
  if (patch.isActive !== undefined) changes.is_active = patch.isActive;
  if (patch.config !== undefined) {
    changes.config = JSON.stringify(mergeConfig(asObject(row.config), asObject(patch.config)));
  }

  if (Object.keys(changes).length === 0) return toDto(row);

  await scoped('mail_accounts', tenantId, executor).where('mail_accounts.id', id).update(changes);
  const updated = await getRow(tenantId, id, executor);
  if (!updated) throw new AppError(404, 'Mailbox not found');
  return toDto(updated);
}

export async function remove(tenantId: number, id: number, executor: Executor = db): Promise<void> {
  assertTenantId(tenantId);
  const deleted = await scoped('mail_accounts', tenantId, executor)
    .where('mail_accounts.id', id)
    .del();
  if (deleted === 0) throw new AppError(404, 'Mailbox not found');
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — Health and the sync cursor
// ═════════════════════════════════════════════════════════════════════════════

export interface MailboxSyncState {
  /** IMAP UIDVALIDITY as a decimal string — it is a uint32 and can exceed 2^31. */
  uidValidity: string | null;
  lastUid: number;
  lastSyncAt: string | null;
}

export interface HealthPatch {
  ok?: boolean;
  lastError?: string | null;
  consecutiveFailures?: number;
  messagesFetched24h?: number;
  /** Per-folder IMAP cursor. Merged, never replaced. */
  sync?: Record<string, MailboxSyncState>;
}

/**
 * Merge a patch into `health` and, when the caller says so, bump `last_seen_at`.
 *
 * `coalesce(health,'{}') || patch` is a shallow merge done by Postgres inside
 * one statement, so two connections updating different keys cannot lose each
 * other's write the way a read-modify-write in Node would.
 *
 * `sync` is merged one level deeper by hand, because the shallow `||` would
 * replace the whole `sync` object and a mailbox with two folders would forget
 * one cursor every time the other one advanced.
 */
export async function recordHealth(
  tenantId: number,
  id: number,
  patch: HealthPatch,
  options: { touchLastSeen?: boolean; emit?: boolean } = {},
  executor: Executor = db,
): Promise<MailAccountHealth> {
  assertTenantId(tenantId);

  const merged: Record<string, unknown> = {};
  if (patch.ok !== undefined) merged.ok = patch.ok;
  if (patch.consecutiveFailures !== undefined) merged.consecutiveFailures = patch.consecutiveFailures;
  if (patch.messagesFetched24h !== undefined) merged.messagesFetched24h = patch.messagesFetched24h;
  if (patch.lastError !== undefined) {
    merged.lastError = patch.lastError;
    merged.lastErrorAt = patch.lastError ? new Date().toISOString() : null;
  }

  const changes: Record<string, unknown> = {
    health: db.raw("coalesce(mail_accounts.health, '{}'::jsonb) || ?::jsonb", [
      JSON.stringify(merged),
    ]),
  };
  if (options.touchLastSeen) changes.last_seen_at = new Date();

  await scoped('mail_accounts', tenantId, executor).where('mail_accounts.id', id).update(changes);

  if (patch.sync) {
    // jsonb_set with create_missing=true, one folder at a time. `#-`-free, so
    // an unrelated folder's cursor is untouched.
    for (const [folder, state] of Object.entries(patch.sync)) {
      await scoped('mail_accounts', tenantId, executor)
        .where('mail_accounts.id', id)
        .update({
          // `?::text` inside the ARRAY constructor is not decoration: an
          // untyped bind parameter there leaves Postgres unable to infer the
          // array's element type, and it answers with "could not determine
          // polymorphic type" rather than doing the update.
          health: db.raw(
            "jsonb_set(coalesce(mail_accounts.health, '{}'::jsonb), ARRAY['sync', ?::text], ?::jsonb, true)",
            [folder, JSON.stringify(state)],
          ),
        });
    }
  }

  const row = await getRow(tenantId, id, executor);
  const health = toHealthDto(row?.health);

  if (options.emit !== false) {
    emitToTenant(tenantId, SOCKET_EVENTS.mailAccountHealth, {
      tenantId,
      at: new Date().toISOString(),
      mailAccountId: id,
      health,
    });
  }
  return health;
}

export async function readSyncState(
  tenantId: number,
  id: number,
  folder: string,
  executor: Executor = db,
): Promise<MailboxSyncState> {
  const row = await getRow(tenantId, id, executor);
  const sync = asObject(asObject(row?.health).sync);
  const state = asObject(sync[folder]);
  return {
    uidValidity: typeof state.uidValidity === 'string' ? state.uidValidity : null,
    lastUid: Number(state.lastUid ?? 0) || 0,
    lastSyncAt: typeof state.lastSyncAt === 'string' ? state.lastSyncAt : null,
  };
}

export async function writeSyncState(
  tenantId: number,
  id: number,
  folder: string,
  state: MailboxSyncState,
  executor: Executor = db,
): Promise<void> {
  await recordHealth(tenantId, id, { sync: { [folder]: state } }, { emit: false }, executor);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — Credentials, resolved
// ═════════════════════════════════════════════════════════════════════════════

export interface ImapConnectionSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  /** Plaintext. Never log this, never put it in a health row. */
  pass: string | null;
  accessToken: string | null;
  folder: string;
  archiveFolder: string | null;
  deleteAfterFetch: boolean;
  /** The address this mailbox answers as, for +alias and List-Id. */
  address: string;
}

/**
 * Everything a connection needs, with the password decrypted.
 *
 * The ONE function that returns plaintext. `tryDecryptSecret` rather than
 * `decryptSecret` because a rotated ENCRYPTION_KEY must surface as "this
 * mailbox needs its password re-entered" in the channel console, not as a
 * 500 that takes the whole poller down with it.
 */
export function resolveImapSettings(row: MailAccountRow): ImapConnectionSettings {
  const config = asObject(row.config);
  const user = String(config.username ?? config.user ?? '');
  const address = String(config.address ?? user);

  return {
    host: String(config.host ?? ''),
    port: Number(config.port ?? (config.secure === false ? 143 : 993)) || 993,
    secure: config.secure === undefined ? true : Boolean(config.secure),
    user,
    pass: typeof config.password === 'string' ? tryDecryptSecret(config.password) : null,
    accessToken: typeof config.accessToken === 'string' ? tryDecryptSecret(config.accessToken) : null,
    folder: String(config.mailbox ?? config.folder ?? 'INBOX'),
    archiveFolder: typeof config.archiveFolder === 'string' && config.archiveFolder.trim() !== ''
      ? config.archiveFolder.trim()
      : null,
    deleteAfterFetch: Boolean(config.deleteAfterFetch),
    address,
  };
}

/** The address this mailbox sends and receives as, for threading and List-Id. */
export function mailboxAddress(row: MailAccountRow): string | null {
  const config = asObject(row.config);
  const address = String(config.address ?? config.username ?? '').trim();
  return address.includes('@') ? address.toLowerCase() : null;
}

/**
 * Per-mailbox overrides of the tenant-wide mail settings. `null` means "this
 * mailbox has no opinion" — the caller then falls back to the tenant setting,
 * which is why these are tri-state rather than booleans with a default baked in
 * here.
 */
export function mailboxFlags(row: MailAccountRow | null): {
  stripQuotedReplies: boolean | null;
  pollSeconds: number | null;
} {
  const config = asObject(row?.config);
  return {
    stripQuotedReplies:
      config.stripQuotedReplies === undefined ? null : Boolean(config.stripQuotedReplies),
    pollSeconds: Number.isFinite(Number(config.pollSeconds)) ? Number(config.pollSeconds) : null,
  };
}

/**
 * Constant-time check of a webhook bearer against this mailbox's own secret.
 *
 * Returns false — never throws — when the mailbox has no secret configured, so
 * the caller falls through to the installation-wide ingest key rather than
 * treating "not configured" as "authorised".
 */
export function verifyWebhookSecret(row: MailAccountRow, presented: string): boolean {
  const config = asObject(row.config);
  if (typeof config.webhookSecret !== 'string' || config.webhookSecret === '') return false;
  const expected = tryDecryptSecret(config.webhookSecret);
  if (!expected) {
    logger.warn(
      { mailAccountId: row.id, tenantId: row.tenant_id },
      'mailbox: webhook secret could not be decrypted — has ENCRYPTION_KEY changed?',
    );
    return false;
  }
  return safeEqual(presented, expected);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — Suppressions
// ═════════════════════════════════════════════════════════════════════════════

export type SuppressionReason = 'hard_bounce' | 'complaint' | 'unsubscribe' | 'loop_detected';

export async function isSuppressed(
  tenantId: number,
  address: string,
  executor: Executor = db,
): Promise<boolean> {
  assertTenantId(tenantId);
  const cleaned = (address ?? '').trim().toLowerCase();
  if (cleaned === '') return true;
  const row = await scoped('mail_suppressions', tenantId, executor)
    .where('mail_suppressions.address', cleaned)
    .first('mail_suppressions.id');
  return Boolean(row);
}

/**
 * Stop mailing an address, with a stated reason.
 *
 * Idempotent by design (`onConflict … merge`): a loop detector that fires eight
 * times in a minute must not throw on the second, because the throw would
 * abort whatever transaction was trying to protect the tenant.
 */
export async function suppress(
  tenantId: number,
  address: string,
  reason: SuppressionReason,
  executor: Executor = db,
): Promise<void> {
  assertTenantId(tenantId);
  const cleaned = (address ?? '').trim().toLowerCase();
  if (cleaned === '' || !cleaned.includes('@')) return;

  await insertScoped('mail_suppressions', tenantId, { address: cleaned, reason }, executor)
    .onConflict(['tenant_id', 'address'])
    .merge(['reason']);

  logger.warn({ tenantId, address: cleaned, reason }, 'mail: address suppressed');
}

export async function unsuppress(
  tenantId: number,
  address: string,
  executor: Executor = db,
): Promise<boolean> {
  assertTenantId(tenantId);
  const deleted = await scoped('mail_suppressions', tenantId, executor)
    .where('mail_suppressions.address', (address ?? '').trim().toLowerCase())
    .del();
  return deleted > 0;
}

export async function listSuppressions(tenantId: number, executor: Executor = db) {
  assertTenantId(tenantId);
  const rows = (await scoped('mail_suppressions', tenantId, executor)
    .orderBy('mail_suppressions.created_at', 'desc')
    .limit(500)
    .select('*')) as Array<{
    id: number;
    tenant_id: number;
    address: string;
    reason: string | null;
    created_at: Date | string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    address: row.address,
    reason: row.reason ?? 'unknown',
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 8 — The console view
// ═════════════════════════════════════════════════════════════════════════════

export interface MailboxHealthView extends MailAccount {
  /** Inbound messages recorded in the last 24 hours. */
  received24h: number;
  /** Outbound messages recorded in the last 24 hours. */
  sent24h: number;
  /** Outbound messages still waiting on a retry. */
  pendingOutbound: number;
  lastMessageAt: string | null;
}

/**
 * The channel console's whole payload, in three queries rather than three per
 * mailbox. An admin with twelve mailboxes should not pay thirty-six round trips
 * to find out which one stopped collecting last night.
 */
export async function healthOverview(
  tenantId: number,
  executor: Executor = db,
): Promise<MailboxHealthView[]> {
  assertTenantId(tenantId);
  const accounts = (await scoped('mail_accounts', tenantId, executor)
    .orderBy('mail_accounts.name')
    .select(...COLUMNS)) as MailAccountRow[];
  if (accounts.length === 0) return [];

  const since = new Date(Date.now() - 24 * 3600_000);

  const counts = (await scoped('mail_messages', tenantId, executor)
    .where('mail_messages.received_at', '>=', since)
    .groupBy('mail_messages.mail_account_id', 'mail_messages.direction')
    .select('mail_messages.mail_account_id', 'mail_messages.direction')
    .count({ total: '*' })) as Array<{
    mail_account_id: number | null;
    direction: string;
    total: string | number;
  }>;

  const pending = (await scoped('mail_messages', tenantId, executor)
    .where('mail_messages.direction', 'out')
    .whereRaw("mail_messages.parsed -> 'delivery' ->> 'status' = 'pending'")
    .groupBy('mail_messages.mail_account_id')
    .select('mail_messages.mail_account_id')
    .count({ total: '*' })) as Array<{ mail_account_id: number | null; total: string | number }>;

  const last = (await scoped('mail_messages', tenantId, executor)
    .groupBy('mail_messages.mail_account_id')
    .select('mail_messages.mail_account_id')
    .max({ last_at: 'mail_messages.received_at' })) as Array<{
    mail_account_id: number | null;
    last_at: Date | string | null;
  }>;

  const key = (id: number | null, direction: string) => `${id ?? 0}:${direction}`;
  const countMap = new Map(counts.map((c) => [key(c.mail_account_id, c.direction), Number(c.total)]));
  const pendingMap = new Map(pending.map((p) => [p.mail_account_id ?? 0, Number(p.total)]));
  const lastMap = new Map(last.map((l) => [l.mail_account_id ?? 0, l.last_at]));

  return accounts.map((row) => {
    const lastAt = lastMap.get(row.id) ?? null;
    return {
      ...toDto(row),
      received24h: countMap.get(key(row.id, 'in')) ?? 0,
      sent24h: countMap.get(key(row.id, 'out')) ?? 0,
      pendingOutbound: pendingMap.get(row.id) ?? 0,
      lastMessageAt: lastAt ? new Date(lastAt).toISOString() : null,
    };
  });
}

// ═════════════════════════════════════════════════════════════════════════════

export const mailboxService = {
  toDto,
  toConfigDto,
  toHealthDto,
  tenantIdentity,
  tenantBySlug,
  invalidateTenantIdentityCache,
  list,
  getRow,
  getById,
  findByAddressOrName,
  listActiveForPolling,
  create,
  update,
  remove,
  recordHealth,
  readSyncState,
  writeSyncState,
  resolveImapSettings,
  mailboxAddress,
  mailboxFlags,
  verifyWebhookSecret,
  isSuppressed,
  suppress,
  unsuppress,
  listSuppressions,
  healthOverview,
};

export type { Knex };
export default mailboxService;
