/**
 * smtpServer.service.ts — SMTP credentials, encrypted at rest.
 *
 * `smtp_servers` has a NULLABLE tenant_id: NULL is the PLATFORM server usable
 * by every tenant, a non-NULL row belongs to that tenant. Reads therefore go
 * through `scopedOrGlobal()` so a tenant sees its own servers plus the shared
 * ones; writes carry an explicit tenant_id (or explicit NULL) from an
 * admin-only path.
 *
 * ── Encryption ────────────────────────────────────────────────────────────
 * `password_enc` is AES-256-GCM ciphertext under `ENCRYPTION_KEY` (64 hex
 * characters = the 32-byte key). Plaintext never lands in a column, never
 * leaves this module, and never appears in an API response: the DTO exposes
 * `passwordSet: boolean` and nothing else. The only consumer of the plaintext
 * is `getTransportConfig()`, which the SMTP plugin calls at send time.
 *
 * GCM rather than CBC because it authenticates: a tampered ciphertext fails to
 * decrypt loudly instead of yielding garbage that nodemailer would then try to
 * use as a password against a real mail server.
 *
 * Rotating `ENCRYPTION_KEY` makes every existing `password_enc` unreadable.
 * That is a documented operational fact, not a bug — `decryptSecret` throws a
 * message that says exactly this, because "SMTP auth failed" is a far worse
 * error to debug than "this ciphertext was written under a different key".
 */

import crypto from 'crypto';
import nodemailer from 'nodemailer';
import type { Knex } from 'knex';
import { db, scopedOrGlobal, assertTenantId } from '../db';
import type { CreateSmtpServerRequest, SmtpServer, UpdateSmtpServerRequest } from '@oblidesk/shared';
import { auditService } from './audit.service';
import { logger } from '../utils/logger';

// ═════════════════════════════════════════════════════════════════════════════
// Crypto
// ═════════════════════════════════════════════════════════════════════════════

const ENC_ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // GCM's canonical nonce length
const KEY_BYTES = 32;

let cachedKey: Buffer | null = null;

/**
 * The 32-byte key. `ENCRYPTION_KEY` is expected to be 64 hex characters; a
 * passphrase of any other shape is hashed to 32 bytes so a misconfigured
 * deployment still works deterministically rather than crashing at 3am — but
 * it is logged once, loudly, because a hashed passphrase is weaker than a real
 * random key and the operator should fix it.
 */
function encryptionKey(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = process.env.ENCRYPTION_KEY ?? '';
  if (!raw) {
    throw new Error(
      'ENCRYPTION_KEY is not set — refusing to store or read SMTP credentials. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }

  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    cachedKey = Buffer.from(raw, 'hex');
  } else {
    logger.warn(
      'ENCRYPTION_KEY is not 64 hex characters — deriving a key by sha256. ' +
        'Replace it with 32 random bytes in hex.',
    );
    cachedKey = crypto.createHash('sha256').update(raw, 'utf8').digest();
  }

  if (cachedKey.length !== KEY_BYTES) {
    throw new Error(`ENCRYPTION_KEY derived to ${cachedKey.length} bytes, expected ${KEY_BYTES}`);
  }
  return cachedKey;
}

/** `iv:tag:ciphertext`, all hex. */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ENC_ALGORITHM, encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptSecret(payload: string): string {
  const [ivHex, tagHex, dataHex] = payload.split(':');
  if (!ivHex || !tagHex || !dataHex) {
    throw new Error('smtp: stored credential is not in iv:tag:ciphertext form');
  }
  try {
    const decipher = crypto.createDecipheriv(
      ENC_ALGORITHM,
      encryptionKey(),
      Buffer.from(ivHex, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataHex, 'hex')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error(
      'smtp: could not decrypt the stored password. This almost always means ' +
        'ENCRYPTION_KEY changed since it was saved — re-enter the password on this server.',
    );
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Rows and DTOs
// ═════════════════════════════════════════════════════════════════════════════

interface SmtpServerRow {
  id: number;
  tenant_id: number | null;
  name: string;
  host: string;
  port: number;
  secure: boolean;
  username: string | null;
  password_enc: string | null;
  from_address: string;
  from_name: string | null;
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface SmtpTransportConfig {
  id: number;
  host: string;
  port: number;
  secure: boolean;
  username: string | null;
  /** Plaintext. Never serialise this. */
  password: string | null;
  fromAddress: string;
  fromName: string | null;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function rowToServer(row: SmtpServerRow): SmtpServer {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    host: row.host,
    port: row.port,
    secure: row.secure,
    username: row.username,
    // Never the value, never the ciphertext. Just "is one stored?".
    passwordSet: Boolean(row.password_enc),
    fromAddress: row.from_address,
    fromName: row.from_name,
    isDefault: row.is_default,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Service
// ═════════════════════════════════════════════════════════════════════════════

export interface SmtpAuditContext {
  actorId?: number | null;
  ip?: string | null;
  userAgent?: string | null;
}

export const smtpServerService = {
  /** This tenant's servers PLUS the platform ones, tenant rows first. */
  async list(tenantId: number): Promise<SmtpServer[]> {
    assertTenantId(tenantId);
    const rows = (await scopedOrGlobal('smtp_servers', tenantId)
      .orderByRaw('smtp_servers.tenant_id NULLS LAST')
      .orderBy('smtp_servers.name')
      .select('*')) as SmtpServerRow[];
    return rows.map(rowToServer);
  },

  /** Platform-wide servers only (tenant_id IS NULL) — the master admin view. */
  async listPlatform(): Promise<SmtpServer[]> {
    const rows = (await db('smtp_servers')
      .whereNull('tenant_id')
      .orderBy('name')
      .select('*')) as SmtpServerRow[];
    return rows.map(rowToServer);
  },

  /**
   * One server, visible to this tenant. Returns null when the row belongs to a
   * DIFFERENT tenant — a 404 rather than a 403, so probing ids leaks nothing.
   */
  async getById(tenantId: number, id: number): Promise<SmtpServer | null> {
    assertTenantId(tenantId);
    const row = (await scopedOrGlobal('smtp_servers', tenantId)
      .where('smtp_servers.id', id)
      .first()) as SmtpServerRow | undefined;
    return row ? rowToServer(row) : null;
  },

  /**
   * The default server for a tenant: its own default if it has one, otherwise
   * the platform default. `tenant_id NULLS LAST` is what expresses that
   * preference in one query.
   */
  async getDefault(tenantId: number): Promise<SmtpServer | null> {
    assertTenantId(tenantId);
    const row = (await scopedOrGlobal('smtp_servers', tenantId)
      .where('smtp_servers.is_default', true)
      .orderByRaw('smtp_servers.tenant_id NULLS LAST')
      .first()) as SmtpServerRow | undefined;
    return row ? rowToServer(row) : null;
  },

  /**
   * Everything nodemailer needs, INCLUDING the decrypted password.
   * The only method that returns plaintext. Callers must not log the result.
   */
  async getTransportConfig(id: number): Promise<SmtpTransportConfig | null> {
    const row = (await db('smtp_servers').where({ id }).first()) as SmtpServerRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      host: row.host,
      port: row.port,
      secure: row.secure,
      username: row.username,
      password: row.password_enc ? decryptSecret(row.password_enc) : null,
      fromAddress: row.from_address,
      fromName: row.from_name,
    };
  },

  // ── Writes ───────────────────────────────────────────────────────────────

  /**
   * Create a server. `tenantId = null` creates a PLATFORM server — only the
   * master tenant's admins should reach that path.
   *
   * The partial unique index `uq_smtp_servers_default` allows one default per
   * scope, so promoting a new default must demote the old one in the SAME
   * transaction; doing it in two statements would either violate the index or
   * leave a window with no default at all.
   */
  async create(
    tenantId: number | null,
    data: CreateSmtpServerRequest,
    ctx: SmtpAuditContext = {},
  ): Promise<SmtpServer> {
    if (tenantId !== null) assertTenantId(tenantId);

    return db.transaction(async (trx) => {
      if (data.isDefault) await clearDefault(trx, tenantId);

      const [row] = (await trx('smtp_servers')
        .insert({
          tenant_id: tenantId,
          name: data.name,
          host: data.host,
          port: data.port,
          secure: data.secure ?? false,
          username: data.username ?? null,
          password_enc: data.password ? encryptSecret(data.password) : null,
          from_address: data.fromAddress,
          from_name: data.fromName ?? null,
          is_default: data.isDefault ?? false,
        })
        .returning('*')) as SmtpServerRow[];

      const server = rowToServer(row);

      if (tenantId !== null) {
        await auditService.record(
          {
            tenantId,
            actorId: ctx.actorId ?? null,
            action: 'smtp_server.create',
            entityType: 'smtp_server',
            entityId: server.id,
            after: redactForAudit(server),
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          },
          trx,
        );
      }

      return server;
    });
  },

  /**
   * Update a server. A `password` of `undefined` LEAVES the stored one alone;
   * an empty string CLEARS it. Without that distinction every save from a form
   * that shows a blank password box would silently wipe the credential.
   */
  async update(
    tenantId: number,
    id: number,
    data: UpdateSmtpServerRequest,
    ctx: SmtpAuditContext = {},
  ): Promise<SmtpServer | null> {
    assertTenantId(tenantId);

    return db.transaction(async (trx) => {
      const existing = (await scopedOrGlobal('smtp_servers', tenantId, trx)
        .where('smtp_servers.id', id)
        .first()) as SmtpServerRow | undefined;
      if (!existing) return null;

      // A tenant admin must not edit the platform server out from under every
      // other tenant. Only a caller acting at platform scope may do that, and
      // that path calls updatePlatform().
      if (existing.tenant_id === null) {
        throw new Error('smtp: this is a platform server — edit it from the platform settings');
      }

      const patch: Record<string, unknown> = { updated_at: new Date() };
      if (data.name !== undefined) patch.name = data.name;
      if (data.host !== undefined) patch.host = data.host;
      if (data.port !== undefined) patch.port = data.port;
      if (data.secure !== undefined) patch.secure = data.secure;
      if (data.username !== undefined) patch.username = data.username;
      if (data.fromAddress !== undefined) patch.from_address = data.fromAddress;
      if (data.fromName !== undefined) patch.from_name = data.fromName;
      if (data.password !== undefined) {
        patch.password_enc = data.password ? encryptSecret(data.password) : null;
      }

      if (data.isDefault === true) {
        await clearDefault(trx, existing.tenant_id);
        patch.is_default = true;
      } else if (data.isDefault === false) {
        patch.is_default = false;
      }

      const [row] = (await trx('smtp_servers')
        .where({ id })
        .update(patch)
        .returning('*')) as SmtpServerRow[];

      const server = rowToServer(row);

      await auditService.record(
        {
          tenantId,
          actorId: ctx.actorId ?? null,
          action: 'smtp_server.update',
          entityType: 'smtp_server',
          entityId: id,
          before: redactForAudit(rowToServer(existing)),
          after: redactForAudit(server),
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        trx,
      );

      return server;
    });
  },

  async delete(tenantId: number, id: number, ctx: SmtpAuditContext = {}): Promise<boolean> {
    assertTenantId(tenantId);

    return db.transaction(async (trx) => {
      const existing = (await trx('smtp_servers')
        .where({ id, tenant_id: tenantId })
        .first()) as SmtpServerRow | undefined;
      if (!existing) return false;

      await trx('smtp_servers').where({ id }).del();

      await auditService.record(
        {
          tenantId,
          actorId: ctx.actorId ?? null,
          action: 'smtp_server.delete',
          entityType: 'smtp_server',
          entityId: id,
          before: redactForAudit(rowToServer(existing)),
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        trx,
      );

      return true;
    });
  },

  /**
   * Open a connection and authenticate, without sending anything.
   * `verify()` catches the two failures that matter — wrong host/port and wrong
   * credentials — before an operator discovers them via an SLA notification
   * that never arrived.
   */
  async test(tenantId: number, id: number): Promise<void> {
    assertTenantId(tenantId);

    const visible = (await scopedOrGlobal('smtp_servers', tenantId)
      .where('smtp_servers.id', id)
      .first('id')) as { id: number } | undefined;
    if (!visible) throw new Error('smtp: server not found');

    const config = await smtpServerService.getTransportConfig(id);
    if (!config) throw new Error('smtp: server not found');

    const transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.username ? { user: config.username, pass: config.password ?? '' } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
    });

    await transport.verify();
  },

  /**
   * Update a PLATFORM server (tenant_id IS NULL). Separate from `update()` on
   * purpose: editing the shared server changes mail for every tenant at once,
   * so it has to be an explicit, differently-named call that a tenant-scoped
   * route cannot reach by accident.
   */
  async updatePlatform(id: number, data: UpdateSmtpServerRequest): Promise<SmtpServer | null> {
    return db.transaction(async (trx) => {
      const existing = (await trx('smtp_servers')
        .where({ id })
        .whereNull('tenant_id')
        .first()) as SmtpServerRow | undefined;
      if (!existing) return null;

      const patch: Record<string, unknown> = { updated_at: new Date() };
      if (data.name !== undefined) patch.name = data.name;
      if (data.host !== undefined) patch.host = data.host;
      if (data.port !== undefined) patch.port = data.port;
      if (data.secure !== undefined) patch.secure = data.secure;
      if (data.username !== undefined) patch.username = data.username;
      if (data.fromAddress !== undefined) patch.from_address = data.fromAddress;
      if (data.fromName !== undefined) patch.from_name = data.fromName;
      if (data.password !== undefined) {
        patch.password_enc = data.password ? encryptSecret(data.password) : null;
      }
      if (data.isDefault === true) {
        await clearDefault(trx, null);
        patch.is_default = true;
      } else if (data.isDefault === false) {
        patch.is_default = false;
      }

      const [row] = (await trx('smtp_servers')
        .where({ id })
        .update(patch)
        .returning('*')) as SmtpServerRow[];
      return rowToServer(row);
    });
  },

  /** Send a one-off probe e-mail. Used by the "send test mail" button. */
  async sendTestMail(tenantId: number, id: number, to: string): Promise<void> {
    assertTenantId(tenantId);

    const visible = (await scopedOrGlobal('smtp_servers', tenantId)
      .where('smtp_servers.id', id)
      .first('id')) as { id: number } | undefined;
    if (!visible) throw new Error('smtp: server not found');

    const config = await smtpServerService.getTransportConfig(id);
    if (!config) throw new Error('smtp: server not found');

    const transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.username ? { user: config.username, pass: config.password ?? '' } : undefined,
    });

    await transport.sendMail({
      from: config.fromName ? `"${config.fromName}" <${config.fromAddress}>` : config.fromAddress,
      to,
      subject: 'Oblidesk SMTP test',
      text: 'This is a test message from Oblidesk. Your SMTP server is configured correctly.',
    });
  },
};

/**
 * Demote the current default for one scope. `tenant_id IS NULL` and
 * `tenant_id = n` are separate scopes, matching the partial unique index
 * `uq_smtp_servers_default ON ((COALESCE(tenant_id, 0))) WHERE is_default`.
 */
async function clearDefault(trx: Knex.Transaction, tenantId: number | null): Promise<void> {
  const query = trx('smtp_servers').where('is_default', true);
  if (tenantId === null) query.whereNull('tenant_id');
  else query.where('tenant_id', tenantId);
  await query.update({ is_default: false, updated_at: new Date() });
}

/** Audit rows must never carry a credential, not even its ciphertext. */
function redactForAudit(server: SmtpServer): Record<string, unknown> {
  return {
    id: server.id,
    name: server.name,
    host: server.host,
    port: server.port,
    secure: server.secure,
    username: server.username,
    passwordSet: server.passwordSet,
    fromAddress: server.fromAddress,
    fromName: server.fromName,
    isDefault: server.isDefault,
  };
}

export default smtpServerService;
