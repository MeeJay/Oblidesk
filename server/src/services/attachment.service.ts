/**
 * attachment.service.ts — metadata, refcounts and the rules that keep an
 * attachment from becoming an attack (HARD RULE 9).
 *
 * Three invariants this module exists to hold:
 *
 * 1. THE DECLARED MIME TYPE IS A LIE. `Content-Type` on an upload is attacker
 *    controlled. Everything here sniffs the magic bytes and stores what it
 *    found, never what it was told. A file claiming `image/png` that begins
 *    `<svg onload=…>` is stored — and served — as SVG, which is exactly why…
 *
 * 2. …NOTHING IS EVER SERVED INLINE. Every download carries
 *    `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`,
 *    and the types in `NEVER_INLINE_MIME` (svg, html, xhtml) additionally have
 *    their Content-Type downgraded to `application/octet-stream`. An SVG
 *    rendered inline on the agent console is stored XSS against the one session
 *    in the product that can read every ticket in the tenant.
 *
 * 3. `attachment_links` IS THE REFCOUNT. A blob is alive while a link points at
 *    it and dies with its last link. Deleting a journal entry must not delete
 *    the image a KB article also uses; deduplicating two identical uploads must
 *    not make the second uploader's delete destroy the first one's file.
 *
 * Dedupe is PER TENANT (`UNIQUE (tenant_id, content_hash)`) and the storage key
 * starts with the tenant id. A global blob pool would let one tenant confirm
 * another's file exists by uploading it and watching for a dedupe hit.
 */
import type { Knex } from 'knex';
import {
  LIMITS,
  NEVER_INLINE_MIME,
  type Attachment,
  type AttachmentEntityType,
  type AttachmentUploadResult,
} from '@oblidesk/shared';

import { db, insertScoped, scoped, type Executor } from '../db';
import { AppError } from '../middleware/errorHandler';
import {
  buildAttachmentStorageKey,
  getStorageDriver,
  hashBytes,
  type StagedBlob,
} from './storage.service';

// ═════════════════════════════════════════════════════════════════════════════
// Limits
// ═════════════════════════════════════════════════════════════════════════════

/** Per-file ceiling. Also handed to multer so the socket dies before the RAM does. */
export const MAX_ATTACHMENT_BYTES = LIMITS.attachmentMaxBytes;

/** Per-request file count, mirrored in the route's multer config. */
export const MAX_ATTACHMENTS_PER_REQUEST = LIMITS.attachmentsPerMessage;

const DEFAULT_TENANT_QUOTA_BYTES = 20 * 1024 * 1024 * 1024; // 20 GiB

/** Read at call time so a container restart can change it without a rebuild. */
export function tenantQuotaBytes(): number {
  const raw = Number(process.env.ATTACHMENT_TENANT_QUOTA_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TENANT_QUOTA_BYTES;
}

// ═════════════════════════════════════════════════════════════════════════════
// MIME sniffing
// ═════════════════════════════════════════════════════════════════════════════

interface MagicSignature {
  mime: string;
  bytes: number[];
  offset?: number;
}

/**
 * Magic-byte table. Deliberately small: this is a safety check, not a file
 * manager. Anything unrecognised becomes `application/octet-stream`, which is
 * the correct answer for "I do not know what this is" and is served the same
 * way as everything else anyway.
 */
const SIGNATURES: readonly MagicSignature[] = [
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/bmp', bytes: [0x42, 0x4d] },
  { mime: 'image/tiff', bytes: [0x49, 0x49, 0x2a, 0x00] },
  { mime: 'image/tiff', bytes: [0x4d, 0x4d, 0x00, 0x2a] },
  { mime: 'image/vnd.microsoft.icon', bytes: [0x00, 0x00, 0x01, 0x00] },
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { mime: 'application/gzip', bytes: [0x1f, 0x8b] },
  { mime: 'application/x-bzip2', bytes: [0x42, 0x5a, 0x68] },
  { mime: 'application/x-7z-compressed', bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { mime: 'application/vnd.rar', bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07] },
  { mime: 'application/x-xz', bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] },
  // Legacy Office (.doc/.xls/.msg) — a compound file binary.
  { mime: 'application/x-cfb', bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
  { mime: 'application/rtf', bytes: [0x7b, 0x5c, 0x72, 0x74, 0x66] },
  // Executables, kept so they can be REFUSED knowingly rather than by accident.
  { mime: 'application/x-msdownload', bytes: [0x4d, 0x5a] },
  { mime: 'application/x-elf', bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { mime: 'audio/mpeg', bytes: [0x49, 0x44, 0x33] },
  { mime: 'application/ogg', bytes: [0x4f, 0x67, 0x67, 0x53] },
];

/** ZIP containers need their inner path read to tell docx from xlsx from jar. */
const ZIP_MAGIC = [0x50, 0x4b];

const ZIP_CONTENT_TYPES: ReadonlyArray<[string, string]> = [
  ['word/', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xl/', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['ppt/', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['mimetypeapplication/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.text'],
  ['mimetypeapplication/vnd.oasis.opendocument.spreadsheet', 'application/vnd.oasis.opendocument.spreadsheet'],
];

function startsWith(buffer: Buffer, bytes: number[], offset = 0): boolean {
  if (buffer.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i += 1) {
    if (buffer[offset + i] !== bytes[i]) return false;
  }
  return true;
}

/** RIFF containers: WEBP and WAV share the first four bytes. */
function sniffRiff(buffer: Buffer): string | null {
  if (!startsWith(buffer, [0x52, 0x49, 0x46, 0x46])) return null;
  const kind = buffer.subarray(8, 12).toString('latin1');
  if (kind === 'WEBP') return 'image/webp';
  if (kind === 'WAVE') return 'audio/wav';
  if (kind === 'AVI ') return 'video/x-msvideo';
  return 'application/octet-stream';
}

/** ISO base media (mp4/m4a/mov) puts 'ftyp' at offset 4. */
function sniffIsoMedia(buffer: Buffer): string | null {
  if (!startsWith(buffer, [0x66, 0x74, 0x79, 0x70], 4)) return null;
  const brand = buffer.subarray(8, 12).toString('latin1');
  if (brand.startsWith('qt')) return 'video/quicktime';
  if (brand.startsWith('M4A')) return 'audio/mp4';
  return 'video/mp4';
}

/**
 * Does this look like text, and if so what kind? Runs only when no binary
 * signature matched. The `<svg` and `<html` checks matter far more than the
 * others: those two are the payloads that turn an attachment into stored XSS,
 * and calling them what they are is what routes them into `NEVER_INLINE_MIME`.
 */
function sniffText(buffer: Buffer): string | null {
  const head = buffer.subarray(0, 2048);
  for (const byte of head) {
    // NUL, or a control character that is not tab/LF/CR/FF → binary.
    if (byte === 0) return null;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) return null;
  }
  const text = head.toString('utf8').replace(/^\uFEFF/, '').trimStart();
  const lowered = text.toLowerCase();

  if (lowered.startsWith('<svg') || /<svg[\s>]/.test(lowered.slice(0, 512))) return 'image/svg+xml';
  if (lowered.startsWith('<!doctype html') || lowered.startsWith('<html')) return 'text/html';
  if (lowered.startsWith('<?xml')) {
    return /<svg[\s>]/.test(lowered.slice(0, 1024)) ? 'image/svg+xml' : 'application/xml';
  }
  if (text.startsWith('{') || text.startsWith('[')) return 'application/json';
  return 'text/plain';
}

function sniffZip(buffer: Buffer): string {
  // The OOXML/ODF marker lives in the first local file header, well inside the
  // first kilobyte. Reading further would mean unzipping, which is a decompression
  // bomb waiting to happen for a value that only affects the download icon.
  const head = buffer.subarray(0, 2048).toString('latin1');
  for (const [needle, mime] of ZIP_CONTENT_TYPES) {
    if (head.includes(needle)) return mime;
  }
  return 'application/zip';
}

/**
 * The real content type. NEVER trusts `declared` — it is accepted only as a
 * tiebreak for formats with no magic bytes at all (csv vs plain text), and even
 * then only when the bytes already proved to be text.
 */
export function sniffMime(buffer: Buffer, declared?: string | null, filename?: string | null): string {
  if (buffer.length === 0) return 'application/octet-stream';

  if (startsWith(buffer, ZIP_MAGIC)) return sniffZip(buffer);

  const riff = sniffRiff(buffer);
  if (riff) return riff;

  const iso = sniffIsoMedia(buffer);
  if (iso) return iso;

  for (const signature of SIGNATURES) {
    if (startsWith(buffer, signature.bytes, signature.offset ?? 0)) return signature.mime;
  }

  const text = sniffText(buffer);
  if (!text) return 'application/octet-stream';

  // Only now, having PROVEN the bytes are text, may the extension refine the
  // label — and only between text subtypes, so nothing can be talked up into
  // an image or a document it is not.
  if (text === 'text/plain') {
    const extension = (filename ?? '').toLowerCase().split('.').pop() ?? '';
    if (extension === 'csv') return 'text/csv';
    if (extension === 'md') return 'text/markdown';
    if (extension === 'log' || extension === 'txt') return 'text/plain';
    if (declared === 'text/csv' || declared === 'text/markdown') return declared;
  }
  return text;
}

/** True for the types that must never render in a browser tab of ours. */
export function isNeverInline(mime: string): boolean {
  return (NEVER_INLINE_MIME as readonly string[]).includes(mime);
}

/**
 * The Content-Type to actually send. Everything is delivered as a download, and
 * the never-inline set is additionally stripped of its identity so that no
 * future code path — or misconfigured reverse proxy — can be tempted to render it.
 */
export function servableContentType(mime: string | null | undefined): string {
  if (!mime) return 'application/octet-stream';
  return isNeverInline(mime) ? 'application/octet-stream' : mime;
}

// ═════════════════════════════════════════════════════════════════════════════
// Filenames
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Make a filename safe to store and to put in a header. Path separators, NULs
 * and CR/LF go: the last two are header injection, the first is why
 * `storage_key` is derived from the hash and never from this value.
 */
export function sanitizeFilename(raw: string | null | undefined): string {
  const base = (raw ?? '')
    // Control characters first: CR/LF in a filename is header injection.
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[\\/]+/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return (base === '' ? 'attachment' : base).slice(0, 200);
}

/** RFC 5987 / 6266 `Content-Disposition` value, ASCII-safe plus a UTF-8 form. */
export function contentDispositionValue(filename: string): string {
  const safe = sanitizeFilename(filename);
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

// ═════════════════════════════════════════════════════════════════════════════
// Rows ↔ DTOs
// ═════════════════════════════════════════════════════════════════════════════

interface AttachmentRow {
  id: number;
  tenant_id: number;
  content_hash: string;
  mime: string | null;
  byte_size: string | number;
  filename: string | null;
  storage_key: string;
  scan_status: string;
  uploaded_by: number | null;
  created_at: Date | string;
  link_count?: string | number;
}

function mapAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    contentHash: row.content_hash,
    mime: row.mime ?? 'application/octet-stream',
    // `byte_size` is a bigint — node-postgres returns those as strings.
    byteSize: Number(row.byte_size),
    filename: row.filename ?? 'attachment',
    storageKey: row.storage_key,
    scanStatus: row.scan_status as Attachment['scanStatus'],
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    ...(row.link_count === undefined ? {} : { linkCount: Number(row.link_count) }),
  };
}

const ATTACHMENT_COLUMNS = [
  'attachments.id',
  'attachments.tenant_id',
  'attachments.content_hash',
  'attachments.mime',
  'attachments.byte_size',
  'attachments.filename',
  'attachments.storage_key',
  'attachments.scan_status',
  'attachments.uploaded_by',
  'attachments.created_at',
];

// ═════════════════════════════════════════════════════════════════════════════
// Quota
// ═════════════════════════════════════════════════════════════════════════════

export interface TenantStorageUsage {
  usedBytes: number;
  quotaBytes: number;
  fileCount: number;
}

export async function tenantUsage(
  tenantId: number,
  executor: Executor = db,
): Promise<TenantStorageUsage> {
  const rows = (await scoped('attachments', tenantId, executor)
    .sum({ used: 'attachments.byte_size' })
    .count({ files: '*' })) as unknown as Array<{ used: string | null; files: string }>;

  return {
    usedBytes: Number(rows?.[0]?.used ?? 0),
    quotaBytes: tenantQuotaBytes(),
    fileCount: Number(rows?.[0]?.files ?? 0),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Upload
// ═════════════════════════════════════════════════════════════════════════════

export interface UploadedFile {
  originalname: string;
  buffer: Buffer;
  size?: number;
  /** The DECLARED type. Recorded for diagnostics, never trusted. */
  mimetype?: string;
}

export interface AttachmentLinkTarget {
  entityType: AttachmentEntityType;
  entityId: number;
  /** Content-ID when the blob is an inline image in an HTML body. */
  inlineCid?: string | null;
  /**
   * Who attached it HERE. One side or the other, never both (migration 010).
   *
   * The attribution lives on the LINK and not on the blob because the blob is
   * de-duplicated per tenant: `attachments.uploaded_by` names whoever uploaded
   * those bytes first, anywhere, which is not what anybody is asking when they
   * look at one ticket. The same file attached by an agent and by a customer is
   * one blob and two links, each with its own author.
   */
  linkedByUserId?: number | null;
  linkedByContactId?: number | null;
}

export interface UploadAttachmentInput {
  tenantId: number;
  uploadedBy: number | null;
  file: UploadedFile;
  /** Link it immediately. Omit for a two-step upload-then-attach flow. */
  link?: AttachmentLinkTarget | null;
  /** Refuse Windows/Linux executables outright. */
  rejectExecutables?: boolean;
}

const EXECUTABLE_MIMES = new Set(['application/x-msdownload', 'application/x-elf']);

/**
 * Store one file.
 *
 * Ordering matters and is not incidental:
 *
 *   sniff → size → quota      refuse before a single byte is written
 *   stage                     bytes land somewhere private
 *   BEGIN … insert … COMMIT   metadata row, with the blob committed inside
 *
 * The blob is renamed into place INSIDE the transaction, just before it
 * commits. A crash before that leaves a staged file (swept) and no row; a crash
 * after leaves a row and a file. What can never happen is a row — and therefore
 * a journal entry rendering `<img src=…>` — pointing at bytes that are not there.
 */
export async function uploadAttachment(
  input: UploadAttachmentInput,
  trx?: Knex.Transaction,
): Promise<AttachmentUploadResult> {
  const { tenantId, file } = input;
  const bytes = file.buffer;

  if (!bytes || bytes.length === 0) throw new AppError(400, 'Empty file');
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new AppError(
      413,
      `File is larger than the ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB limit`,
    );
  }

  const mime = sniffMime(bytes, file.mimetype ?? null, file.originalname);
  if (input.rejectExecutables !== false && EXECUTABLE_MIMES.has(mime)) {
    throw new AppError(415, 'Executable files cannot be attached');
  }

  const filename = sanitizeFilename(file.originalname);
  const contentHash = hashBytes(bytes);
  const driver = getStorageDriver();

  const run = async (tx: Knex.Transaction): Promise<AttachmentUploadResult> => {
    // Dedupe FIRST: an identical blob for this tenant costs nothing to reuse
    // and, crucially, does not consume quota a second time.
    const existing = await scoped('attachments', tenantId, tx)
      .where('attachments.content_hash', contentHash)
      .first<AttachmentRow>(...ATTACHMENT_COLUMNS);

    if (existing) {
      const attachment = mapAttachment(existing);
      if (input.link) await linkAttachment(tenantId, attachment.id, input.link, tx);
      return { attachment, deduplicated: true };
    }

    // Quota is checked against NEW bytes only, which is why the dedupe branch
    // above returns before we get here.
    const usage = await tenantUsage(tenantId, tx);
    if (usage.usedBytes + bytes.length > usage.quotaBytes) {
      throw new AppError(507, 'Attachment storage quota exceeded for this tenant');
    }

    let staged: StagedBlob | null = null;
    try {
      staged = await driver.stage(bytes);
      const storageKey = buildAttachmentStorageKey(tenantId, contentHash);

      const inserted = (await insertScoped(
        'attachments',
        tenantId,
        {
          content_hash: contentHash,
          mime,
          byte_size: bytes.length,
          filename,
          storage_key: storageKey,
          // Scanning is a later phase; 'pending' is honest, and the download
          // path is safe regardless of the answer.
          scan_status: 'pending',
          uploaded_by: input.uploadedBy,
        },
        tx,
      ).returning('*')) as unknown as AttachmentRow[];

      // Only now do the bytes become visible under their final name.
      await driver.commit(staged, storageKey);
      staged = null;

      const attachment = mapAttachment(inserted[0]);
      if (input.link) await linkAttachment(tenantId, attachment.id, input.link, tx);
      return { attachment, deduplicated: false };
    } finally {
      if (staged) await driver.discard(staged);
    }
  };

  return trx ? run(trx) : db.transaction(run);
}

// ═════════════════════════════════════════════════════════════════════════════
// The refcount
// ═════════════════════════════════════════════════════════════════════════════

export async function linkAttachment(
  tenantId: number,
  attachmentId: number,
  target: AttachmentLinkTarget,
  executor: Executor = db,
): Promise<void> {
  const owned = await scoped('attachments', tenantId, executor)
    .where('attachments.id', attachmentId)
    .first<{ id: number }>('attachments.id');
  if (!owned) throw new AppError(404, 'Attachment not found');

  await insertScoped(
    'attachment_links',
    tenantId,
    {
      attachment_id: attachmentId,
      entity_type: target.entityType,
      entity_id: target.entityId,
      inline_cid: target.inlineCid ?? null,
      linked_by_user_id: target.linkedByUserId ?? null,
      linked_by_contact_id: target.linkedByContactId ?? null,
    },
    executor,
  )
    .onConflict(['attachment_id', 'entity_type', 'entity_id'])
    .ignore();
}

export async function linkMany(
  tenantId: number,
  attachmentIds: readonly number[],
  target: AttachmentLinkTarget,
  executor: Executor = db,
): Promise<void> {
  for (const id of attachmentIds) {
    await linkAttachment(tenantId, id, target, executor);
  }
}

/**
 * Remove one link and, if it was the last one, the blob.
 *
 * The row deletions happen inside the transaction; the FILE is unlinked after
 * it commits. That order is deliberate — a rolled-back transaction that had
 * already deleted the bytes would leave every surviving link pointing at
 * nothing, and there is no undo for that. An orphaned file, by contrast, is
 * bytes on a disk that the next sweep collects.
 */
export async function unlinkAttachment(
  tenantId: number,
  attachmentId: number,
  target: Pick<AttachmentLinkTarget, 'entityType' | 'entityId'>,
  trx?: Knex.Transaction,
): Promise<{ removed: boolean; blobDeleted: boolean }> {
  const run = async (tx: Knex.Transaction) => {
    const deleted = await scoped('attachment_links', tenantId, tx)
      .where({
        'attachment_links.attachment_id': attachmentId,
        'attachment_links.entity_type': target.entityType,
        'attachment_links.entity_id': target.entityId,
      })
      .del();

    if (deleted === 0) return { removed: false, blobDeleted: false, storageKey: null as string | null };

    const remaining = (await scoped('attachment_links', tenantId, tx)
      .where('attachment_links.attachment_id', attachmentId)
      .count({ count: '*' })) as unknown as Array<{ count: string }>;

    if (Number(remaining?.[0]?.count ?? 0) > 0) {
      return { removed: true, blobDeleted: false, storageKey: null as string | null };
    }

    const row = await scoped('attachments', tenantId, tx)
      .where('attachments.id', attachmentId)
      .first<{ storage_key: string }>('attachments.storage_key');

    await scoped('attachments', tenantId, tx).where('attachments.id', attachmentId).del();
    return { removed: true, blobDeleted: true, storageKey: row?.storage_key ?? null };
  };

  const result = trx ? await run(trx) : await db.transaction(run);

  if (result.blobDeleted && result.storageKey) {
    // Post-commit: the metadata is already gone, so a failure here costs disk,
    // not correctness.
    await getStorageDriver().remove(result.storageKey).catch(() => undefined);
  }
  return { removed: result.removed, blobDeleted: result.blobDeleted };
}

/** Drop every link an entity holds — used when a journal entry or KB draft dies. */
export async function unlinkAllForEntity(
  tenantId: number,
  target: Pick<AttachmentLinkTarget, 'entityType' | 'entityId'>,
  trx?: Knex.Transaction,
): Promise<number> {
  const ids = (await scoped('attachment_links', tenantId, trx ?? db)
    .where({
      'attachment_links.entity_type': target.entityType,
      'attachment_links.entity_id': target.entityId,
    })
    .pluck('attachment_links.attachment_id')) as unknown as number[];

  for (const id of ids) await unlinkAttachment(tenantId, id, target, trx);
  return ids.length;
}

// ═════════════════════════════════════════════════════════════════════════════
// Reads
// ═════════════════════════════════════════════════════════════════════════════

export async function getAttachment(
  tenantId: number,
  attachmentId: number,
  executor: Executor = db,
): Promise<Attachment | null> {
  const row = await scoped('attachments', tenantId, executor)
    .where('attachments.id', attachmentId)
    .first<AttachmentRow>(...ATTACHMENT_COLUMNS);
  return row ? mapAttachment(row) : null;
}

/** Every attachment linked to one entity, with its current refcount. */
export async function listForEntity(
  tenantId: number,
  target: Pick<AttachmentLinkTarget, 'entityType' | 'entityId'>,
  executor: Executor = db,
): Promise<Attachment[]> {
  const rows = (await scoped('attachment_links', tenantId, executor)
    .where({
      'attachment_links.entity_type': target.entityType,
      'attachment_links.entity_id': target.entityId,
    })
    .join('attachments', 'attachments.id', 'attachment_links.attachment_id')
    .where('attachments.tenant_id', tenantId)
    .orderBy('attachment_links.created_at', 'asc')
    .select(...ATTACHMENT_COLUMNS, 'attachment_links.inline_cid')) as unknown as AttachmentRow[];

  return rows.map(mapAttachment);
}

/** Bulk count per entity — one query for a whole page of tickets. */
export async function countsForEntities(
  tenantId: number,
  entityType: AttachmentEntityType,
  entityIds: readonly number[],
  executor: Executor = db,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (entityIds.length === 0) return out;

  const rows = (await scoped('attachment_links', tenantId, executor)
    .where('attachment_links.entity_type', entityType)
    .whereIn('attachment_links.entity_id', entityIds as number[])
    .groupBy('attachment_links.entity_id')
    .select('attachment_links.entity_id')
    .count({ count: '*' })) as unknown as Array<{ entity_id: string | number; count: string }>;

  for (const row of rows) out.set(Number(row.entity_id), Number(row.count));
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// Download
// ═════════════════════════════════════════════════════════════════════════════

export interface AttachmentDownload {
  attachment: Attachment;
  /** Ready to `pipe()` into the response. */
  stream: NodeJS.ReadableStream;
  /** Set these verbatim — they are the XSS defence, not decoration. */
  headers: Record<string, string>;
}

/**
 * Open a blob for download.
 *
 * Requires the attachment to be in the caller's tenant AND to still hold at
 * least one link. The link check is not paranoia: a blob whose links have all
 * been removed is logically deleted, and serving it because the row survived a
 * sweep is exactly how "deleted" attachments keep leaking.
 */
export async function openDownload(
  tenantId: number,
  attachmentId: number,
  options: { requireLink?: boolean; executor?: Executor } = {},
): Promise<AttachmentDownload> {
  const executor = options.executor ?? db;
  const attachment = await getAttachment(tenantId, attachmentId, executor);
  if (!attachment) throw new AppError(404, 'Attachment not found');

  if (options.requireLink !== false) {
    const link = await scoped('attachment_links', tenantId, executor)
      .where('attachment_links.attachment_id', attachmentId)
      .first<{ id: number }>('attachment_links.id');
    if (!link) throw new AppError(404, 'Attachment not found');
  }

  if (attachment.scanStatus === 'infected') {
    throw new AppError(403, 'This file was quarantined by the malware scan');
  }

  const driver = getStorageDriver();
  // Ask for the size rather than trusting the row: a wrong Content-Length makes
  // the browser hang waiting for bytes that will never arrive, which looks like
  // a network fault rather than the metadata drift it is.
  const actualSize = await driver.size(attachment.storageKey);
  if (actualSize === null) {
    // The metadata outlived the bytes: report it honestly rather than streaming
    // an empty body that looks like a corrupt download.
    throw new AppError(410, 'The stored file is no longer available');
  }

  return {
    attachment,
    stream: driver.openReadStream(attachment.storageKey),
    headers: {
      'Content-Type': servableContentType(attachment.mime),
      'Content-Length': String(actualSize),
      // Always `attachment`, for every type, with no exceptions and no query
      // parameter to turn it off (HARD RULE 9 / stored XSS).
      'Content-Disposition': contentDispositionValue(attachment.filename),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Frame-Options': 'DENY',
    },
  };
}

/**
 * Delete blobs no link points at any more. A safety net for crashes and for
 * rows deleted by an ON DELETE CASCADE that never ran through `unlinkAttachment`.
 */
export async function sweepOrphans(
  tenantId: number,
  limit = 200,
  executor: Executor = db,
): Promise<number> {
  const orphans = (await scoped('attachments', tenantId, executor)
    .whereNotExists((qb) =>
      qb
        .select(executor.raw('1'))
        .from('attachment_links')
        .whereRaw('attachment_links.attachment_id = attachments.id'),
    )
    .limit(limit)
    .select('attachments.id', 'attachments.storage_key')) as unknown as Array<{
    id: number;
    storage_key: string;
  }>;

  const driver = getStorageDriver();
  let removed = 0;
  for (const orphan of orphans) {
    await scoped('attachments', tenantId, executor).where('attachments.id', orphan.id).del();
    await driver.remove(orphan.storage_key).catch(() => undefined);
    removed += 1;
  }
  return removed;
}
