/**
 * journal.routes.ts — the ticket timeline.
 *
 * MOUNT POINT: `/api/tickets`
 *
 *   GET    /api/tickets/:ticketId/journal            list entries (keyset by seq)
 *   POST   /api/tickets/:ticketId/journal            append a reply or work note
 *   GET    /api/tickets/:ticketId/journal/:entryId   one entry
 *
 * `tickets.routes.ts` mounts this router itself, so wiring `/api/tickets` in
 * `routes/index.ts` is enough; it is exported separately only so it can be
 * mounted on its own (the portal mounts it with a read-only guard).
 *
 * There is no PATCH and no DELETE. `ticket_journal` is append-only: a timeline
 * an agent can edit after the fact is not evidence of anything, and the one
 * question it exists to answer — "what was said, and when?" — stops having a
 * trustworthy answer the moment it can be rewritten. Corrections are new
 * entries.
 */
import { Router } from 'express';
import { CAPABILITIES } from '@oblidesk/shared';

import { requireAuth } from '../middleware/auth';
import { requireCapability } from '../middleware/rbac';
import {
  createJournalEntry,
  getJournalEntry,
  listJournal,
} from '../controllers/ticket.controller';

// `mergeParams` so `:ticketId` from the parent mount is visible here.
const router = Router({ mergeParams: true });

router.get(
  '/:ticketId/journal',
  requireAuth,
  requireCapability(CAPABILITIES.TICKET_READ),
  listJournal,
);

router.post(
  '/:ticketId/journal',
  requireAuth,
  requireCapability(CAPABILITIES.TICKET_RW),
  createJournalEntry,
);

router.get(
  '/:ticketId/journal/:entryId',
  requireAuth,
  requireCapability(CAPABILITIES.TICKET_READ),
  getJournalEntry,
);

export default router;
