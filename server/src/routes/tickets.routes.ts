/**
 * tickets.routes.ts — everything under `/api/tickets`.
 *
 * MOUNT POINT: `/api/tickets` (this router also mounts `journal.routes`, so
 * `routes/index.ts` needs one line, not two).
 *
 * ── Route ordering is load-bearing ───────────────────────────────────────────
 * Express matches in declaration order, so every literal path (`/search`,
 * `/merge`, `/bulk/*`) is declared BEFORE `/:id`. Put `/:id` first and
 * `GET /api/tickets/search` becomes "fetch the ticket whose id is 'search'",
 * which fails as a 400 that looks like a client bug for as long as it takes
 * somebody to read this file.
 *
 * ── Capabilities ─────────────────────────────────────────────────────────────
 *   TICKET_READ    every read
 *   TICKET_RW      create, inline edit, reply, transition, split, reopen
 *   TICKET_DELETE  soft delete, restore, merge and un-merge — all four are
 *                  ways to make a ticket stop existing as its own record
 *
 * A transition additionally checks the capabilities the STATE MACHINE demands
 * for that specific edge; that check lives in the evaluator, not here, because
 * it is configuration rather than routing.
 */
import { Router } from 'express';
import { CAPABILITIES } from '@oblidesk/shared';

import { requireAuth } from '../middleware/auth';
import { requireCapability } from '../middleware/rbac';
import journalRouter from './journal.routes';
import {
  bulkApply,
  bulkPreview,
  bulkUndo,
  createLink,
  createTicket,
  deleteLink,
  deleteTicket,
  getTicket,
  getTransitions,
  listLinks,
  listTickets,
  listWatchers,
  mergeTickets,
  reopenTicket,
  restoreTicket,
  revertMerge,
  searchTickets,
  splitTicket,
  suggestTickets,
  summarizeTickets,
  explainTicket,
  transitionTicket,
  updateTicket,
  addWatcher,
  removeWatcher,
} from '../controllers/ticket.controller';

const router = Router();

const read = [requireAuth, requireCapability(CAPABILITIES.TICKET_READ)] as const;
const write = [requireAuth, requireCapability(CAPABILITIES.TICKET_RW)] as const;
const destroy = [requireAuth, requireCapability(CAPABILITIES.TICKET_DELETE)] as const;

// ── Collection: literal paths first ──────────────────────────────────────────

// Literal, so it must precede `/:id` — otherwise 'summary' is parsed as an id
// and the header chips get a 400 that reads like a client bug.
router.get('/summary', ...read, summarizeTickets);
router.get('/search', ...read, searchTickets);
router.get('/suggest', ...read, suggestTickets);

router.post('/bulk/preview', ...write, bulkPreview);
router.post('/bulk/apply', ...write, bulkApply);
router.post('/bulk/undo', ...write, bulkUndo);

router.post('/merge', ...destroy, mergeTickets);
router.post('/merge/revert', ...destroy, revertMerge);

router.get('/', ...read, listTickets);
router.post('/', ...write, createTicket);

// ── The timeline (declared before `/:id` for the same reason) ────────────────

router.use(journalRouter);

// ── One ticket ───────────────────────────────────────────────────────────────

router.get('/:id', ...read, getTicket);
/** Inline autosave. Never validates required-ness (HARD RULE 12). */
router.patch('/:id', ...write, updateTicket);
router.delete('/:id', ...destroy, deleteTicket);
router.post('/:id/restore', ...destroy, restoreTicket);

/** What the header bar may render, blocked moves included, with reasons. */
// The Why panel: a straight read of decision_log (HARD RULE 2).
router.get('/:id/explain', ...read, explainTicket);

router.get('/:id/transitions', ...read, getTransitions);
/** The ONLY endpoint that enforces required-ness. */
router.post('/:id/transition', ...write, transitionTicket);

router.post('/:id/split', ...write, splitTicket);
router.post('/:id/reopen', ...write, reopenTicket);

router.get('/:id/links', ...read, listLinks);
router.post('/:id/links', ...write, createLink);
router.delete('/:id/links/:linkId', ...write, deleteLink);

router.get('/:id/watchers', ...read, listWatchers);
router.post('/:id/watchers', ...write, addWatcher);
router.delete('/:id/watchers', ...write, removeWatcher);

export default router;
