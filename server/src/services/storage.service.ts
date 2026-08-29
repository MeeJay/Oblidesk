/**
 * storage.service.ts — the attachment blob store (HARD RULE 9).
 *
 * ── The contract ─────────────────────────────────────────────────────────────
 * Bytes live on disk at
 *
 *     <CUSTOM_DIR>/attachments/<tenant_id>/<yyyy>/<mm>/<sha256[0:2]>/<sha256>
 *
 * and the database holds metadata only. `attachments` is UNIQUE(tenant_id,
 * content_hash) — the dedupe pool is PER TENANT, which is exactly why the path
 * starts with the tenant id. A global pool would let one tenant probe another's
 * content by hash and would make a tenant delete unsafe.
 *
 * ── Why staging exists ───────────────────────────────────────────────────────
 * A journal entry that references an image whose bytes never landed is worse
 * than a failed upload: it is a permanently broken timeline row that no retry
 * fixes. So every write is two-phase:
 *
 *     const staged = await driver.stage(bytes);   // writes to .staging/<uuid>
 *     …insert the DB row inside the transaction…
 *     await driver.commit(staged, key);           // atomic rename into place
 *     …commit the transaction…
 *
 * `rename(2)` inside one filesystem is atomic, so a reader never observes a
 * half-written blob. If anything between `stage` and `commit` throws, the
 * caller calls `discard()` and the staged file disappears; the worst case left
 * behind is a file in `.staging/` that `sweepStaging()` removes on the next
 * boot. The reverse failure — a committed blob with no DB row — is harmless: it
 * is unreferenced bytes, and `attachment_links` (the refcount) is what decides
 * a blob's life anyway.
 *
 * This module knows NOTHING about tenants' permissions, MIME types or quotas —
 * that is `attachment.service.ts`. Here there are only bytes and paths.
 */
import { createHash, randomUUID } from 'crypto';
import { createReadStream, type ReadStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';

// ═════════════════════════════════════════════════════════════════════════════
// Paths
// ═════════════════════════════════════════════════════════════════════════════

/** Directory name under CUSTOM_DIR that holds every blob. */
export const ATTACHMENT_ROOT_DIRNAME = 'attachments';

/** Sub-directory holding half-written uploads. Never served, swept on boot. */
export const STAGING_DIRNAME = '.staging';

/**
 * Resolved lazily, never at module load: `env.ts` is imported first by the
 * entrypoint, but a unit test may import this module before it. Reading the
 * variable at call time means the ordering can never bite.
 */
export function customDir(): string {
  const configured = process.env.CUSTOM_DIR?.trim();
  if (configured) return path.resolve(configured);
  return path.resolve(process.cwd(), 'custom');
}

export function attachmentsRoot(): string {
  return path.join(customDir(), ATTACHMENT_ROOT_DIRNAME);
}

const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * Build the canonical storage key for a blob. The key is RELATIVE to CUSTOM_DIR
 * and is derived entirely from (tenant, date, hash) — never from user input,
 * so a filename can never escape the store (HARD RULE 9).
 *
 * @param when the moment the blob was first stored; only its year and month are
 *   used, which keeps a single directory from accumulating millions of entries.
 */
export function buildAttachmentStorageKey(
  tenantId: number,
  sha256: string,
  when: Date = new Date(),
): string {
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    throw new Error(`storage: invalid tenant id ${JSON.stringify(tenantId)}`);
  }
  const hash = sha256.toLowerCase();
  if (!SHA256_RE.test(hash)) {
    throw new Error('storage: content hash must be 64 lowercase hex characters');
  }
  const yyyy = String(when.getUTCFullYear()).padStart(4, '0');
  const mm = String(when.getUTCMonth() + 1).padStart(2, '0');
  // POSIX separators in the key so the value stored in the DB is identical on
  // Windows and Linux; only `resolveKey()` turns it into a native path.
  return [ATTACHMENT_ROOT_DIRNAME, String(tenantId), yyyy, mm, hash.slice(0, 2), hash].join('/');
}

/**
 * Turn a storage key into an absolute path, refusing anything that would land
 * outside the attachment root. Even though keys are always machine-generated,
 * this check is the difference between "a bug" and "an arbitrary file read".
 */
export function resolveKey(storageKey: string): string {
  const normalised = storageKey.replace(/\\/g, '/').replace(/^\/+/, '');
  const absolute = path.resolve(customDir(), normalised);
  const root = attachmentsRoot();
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (absolute !== root && !absolute.startsWith(rootWithSep)) {
    throw new Error(`storage: refusing to touch "${storageKey}" — outside the attachment root`);
  }
  return absolute;
}

/** sha256 of a buffer, lowercase hex. */
export function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ═════════════════════════════════════════════════════════════════════════════
// The driver interface
// ═════════════════════════════════════════════════════════════════════════════

export interface StagedBlob {
  /** Absolute path of the staged file. Only the driver should touch it. */
  readonly absolutePath: string;
  readonly sha256: string;
  readonly byteSize: number;
}

export interface CommitResult {
  /** True when the destination already held these exact bytes. */
  readonly deduplicated: boolean;
  readonly storageKey: string;
  readonly byteSize: number;
}

export interface StorageDriver {
  /** Short identifier for logs and health output. */
  readonly kind: string;

  /** Write bytes somewhere private and return their hash + size. */
  stage(bytes: Buffer): Promise<StagedBlob>;

  /** Atomically move a staged blob to its final key. Idempotent. */
  commit(staged: StagedBlob, storageKey: string): Promise<CommitResult>;

  /** Remove a staged blob. Never throws — a failed cleanup must not fail a request. */
  discard(staged: StagedBlob): Promise<void>;

  exists(storageKey: string): Promise<boolean>;
  size(storageKey: string): Promise<number | null>;
  read(storageKey: string): Promise<Buffer>;
  openReadStream(storageKey: string): ReadStream;

  /** Delete a blob. Missing files are not an error — the goal is "gone". */
  remove(storageKey: string): Promise<void>;

  /** Delete leftovers from a crash. Returns how many files were removed. */
  sweepStaging(olderThanMs?: number): Promise<number>;
}

// ═════════════════════════════════════════════════════════════════════════════
// The filesystem driver
// ═════════════════════════════════════════════════════════════════════════════

export class FsStorageDriver implements StorageDriver {
  readonly kind = 'fs';

  private stagingDir(): string {
    return path.join(attachmentsRoot(), STAGING_DIRNAME);
  }

  async stage(bytes: Buffer): Promise<StagedBlob> {
    const dir = this.stagingDir();
    await fs.mkdir(dir, { recursive: true });
    const absolutePath = path.join(dir, `${Date.now().toString(36)}-${randomUUID()}`);
    // 'wx' so a colliding name is an error rather than a silent overwrite.
    await fs.writeFile(absolutePath, bytes, { flag: 'wx', mode: 0o640 });
    return { absolutePath, sha256: hashBytes(bytes), byteSize: bytes.byteLength };
  }

  async commit(staged: StagedBlob, storageKey: string): Promise<CommitResult> {
    const destination = resolveKey(storageKey);
    await fs.mkdir(path.dirname(destination), { recursive: true });

    const existing = await this.statOrNull(destination);
    if (existing) {
      // Same (tenant, hash) already on disk: the bytes are by definition
      // identical, so the staged copy is redundant. Drop it and report the
      // dedupe so the caller can tell the user "already uploaded".
      await this.discard(staged);
      return { deduplicated: true, storageKey, byteSize: existing.size };
    }

    try {
      await fs.rename(staged.absolutePath, destination);
    } catch (err) {
      // EXDEV: staging and the store ended up on different mounts (a bind
      // mount of a single tenant directory, for instance). Fall back to a
      // copy + unlink, which is no longer atomic but is still crash-safe
      // because the DB row is not committed until this call returns.
      if ((err as NodeJS.ErrnoException)?.code !== 'EXDEV') throw err;
      await fs.copyFile(staged.absolutePath, destination);
      await this.discard(staged);
    }
    return { deduplicated: false, storageKey, byteSize: staged.byteSize };
  }

  async discard(staged: StagedBlob): Promise<void> {
    try {
      await fs.unlink(staged.absolutePath);
    } catch {
      /* already gone, or never created — either way there is nothing to clean */
    }
  }

  async exists(storageKey: string): Promise<boolean> {
    return (await this.statOrNull(resolveKey(storageKey))) !== null;
  }

  async size(storageKey: string): Promise<number | null> {
    const stat = await this.statOrNull(resolveKey(storageKey));
    return stat ? stat.size : null;
  }

  async read(storageKey: string): Promise<Buffer> {
    return fs.readFile(resolveKey(storageKey));
  }

  openReadStream(storageKey: string): ReadStream {
    return createReadStream(resolveKey(storageKey));
  }

  async remove(storageKey: string): Promise<void> {
    try {
      await fs.unlink(resolveKey(storageKey));
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
    }
  }

  async sweepStaging(olderThanMs = 6 * 60 * 60 * 1000): Promise<number> {
    const dir = this.stagingDir();
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return 0;
    }
    const cutoff = Date.now() - olderThanMs;
    let removed = 0;
    for (const entry of entries) {
      const absolute = path.join(dir, entry);
      const stat = await this.statOrNull(absolute);
      if (!stat || stat.mtimeMs > cutoff) continue;
      try {
        await fs.unlink(absolute);
        removed += 1;
      } catch {
        /* another process got there first */
      }
    }
    return removed;
  }

  private async statOrNull(absolute: string) {
    try {
      const stat = await fs.stat(absolute);
      return stat.isFile() ? stat : null;
    } catch {
      return null;
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// The singleton
// ═════════════════════════════════════════════════════════════════════════════

let driver: StorageDriver = new FsStorageDriver();

export function getStorageDriver(): StorageDriver {
  return driver;
}

/**
 * Swap the driver. Exists so tests can run against an in-memory store and so a
 * later phase can add S3 without touching `attachment.service.ts`.
 */
export function setStorageDriver(next: StorageDriver): void {
  driver = next;
}

/**
 * Make sure the store is usable before the first upload arrives — a `/custom`
 * that is not mounted should fail at boot with a clear message, not at 17:40 on
 * the first attachment of the day.
 */
export async function ensureStorageReady(): Promise<{ root: string; writable: boolean }> {
  const root = attachmentsRoot();
  await fs.mkdir(path.join(root, STAGING_DIRNAME), { recursive: true });
  const probe = path.join(root, STAGING_DIRNAME, `.probe-${randomUUID()}`);
  try {
    await fs.writeFile(probe, 'ok');
    await fs.unlink(probe);
    return { root, writable: true };
  } catch {
    return { root, writable: false };
  }
}
