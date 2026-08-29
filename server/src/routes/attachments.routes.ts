/**
 * attachments.routes.ts — upload, list, link and download blobs.
 *
 * MOUNT POINT: `/api/attachments`
 *
 *   POST   /api/attachments                upload (multipart, field name `files`)
 *   GET    /api/attachments                list for an entity (?entityType&entityId)
 *   GET    /api/attachments/usage          this tenant's storage usage vs quota
 *   GET    /api/attachments/:id            metadata
 *   GET    /api/attachments/:id/download   the bytes
 *   POST   /api/attachments/:id/links      add a refcount link
 *   DELETE /api/attachments/:id/links      drop one (blob dies with its last link)
 *
 * ── multer ───────────────────────────────────────────────────────────────────
 * `memoryStorage` with an EXPLICIT `fileSize` limit. Memory storage is the right
 * choice here because the service has to hash and magic-byte sniff the whole
 * buffer before it decides where — or whether — to write it; disk storage would
 * mean writing an unvetted file to a path multer chose, which is exactly the
 * thing HARD RULE 9's hash-derived paths exist to prevent.
 *
 * The `fileSize` limit is what makes memory storage safe: without it, an
 * attacker uploads a 4 GB file and the server dies before any of our code runs.
 * With it, multer aborts the stream at the limit and we answer 413.
 *
 * ── Downloads ────────────────────────────────────────────────────────────────
 * Nginx denies `/custom/` outright; the bytes only ever leave through
 * `/:id/download`, which checks tenancy AND that a live `attachment_links` row
 * still points at the blob before streaming a byte.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { CAPABILITIES } from '@oblidesk/shared';

import { requireAuth } from '../middleware/auth';
import { requireCapability } from '../middleware/rbac';
import { AppError } from '../middleware/errorHandler';
import {
  MAX_ATTACHMENTS_PER_REQUEST,
  MAX_ATTACHMENT_BYTES,
} from '../services/attachment.service';
import {
  downloadAttachment,
  getAttachmentMeta,
  linkAttachment,
  listAttachments,
  storageUsage,
  unlinkAttachment,
  uploadAttachments,
} from '../controllers/ticket.controller';

const router = Router();

const upload = multer({
  // Nothing touches the disk until the service has hashed and sniffed it.
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_ATTACHMENT_BYTES,
    files: MAX_ATTACHMENTS_PER_REQUEST,
    // Keep the non-file part of the form small; the metadata is three fields.
    fields: 16,
    fieldSize: 16 * 1024,
  },
});

/**
 * Turn multer's own errors into the API envelope. Without this they surface as
 * a generic 500 and the user is told "internal error" when the truth is "your
 * file is too big", which is both wrong and unactionable.
 */
function receiveFiles(req: Request, res: Response, next: NextFunction): void {
  upload.array('files', MAX_ATTACHMENTS_PER_REQUEST)(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }
    const code = (error as { code?: string }).code;
    if (code === 'LIMIT_FILE_SIZE') {
      next(
        new AppError(
          413,
          `Each file must be under ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB`,
        ),
      );
      return;
    }
    if (code === 'LIMIT_FILE_COUNT') {
      next(new AppError(413, `At most ${MAX_ATTACHMENTS_PER_REQUEST} files per upload`));
      return;
    }
    if (code === 'LIMIT_UNEXPECTED_FILE') {
      next(new AppError(400, 'Unexpected file field — use "files"'));
      return;
    }
    next(error);
  });
}

const read = [requireAuth, requireCapability(CAPABILITIES.TICKET_READ)] as const;
const write = [requireAuth, requireCapability(CAPABILITIES.TICKET_RW)] as const;

// Literal paths before `/:id`.
router.get('/usage', ...read, storageUsage);

router.post('/', ...write, receiveFiles, uploadAttachments);
router.get('/', ...read, listAttachments);

router.get('/:id', ...read, getAttachmentMeta);
router.get('/:id/download', ...read, downloadAttachment);

router.post('/:id/links', ...write, linkAttachment);
router.delete('/:id/links', ...write, unlinkAttachment);

export default router;
