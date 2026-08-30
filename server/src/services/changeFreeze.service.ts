/**
 * changeFreeze.service.ts — the freeze engine's public door. A FAÇADE, on
 * purpose: there is no logic in this file.
 *
 * ── Why the file exists at all ──────────────────────────────────────────────
 * Freeze evaluation lives in `changeConflict.service` and belongs there. A
 * freeze and a CI overlap are the same question asked of the same window —
 * "what stops this running on Thursday night?" — they are cached in the same
 * `change_conflicts` table, they are rendered in the same panel with the same
 * vocabulary, and they share the whole apparatus that resolves the policy,
 * reads the change and bounds the work. Splitting the implementation in two
 * would mean two policy loaders, two change readers and two chances for the
 * conflict panel and the freeze banner to disagree about the same window.
 *
 * But the module has TWO callers that both, reasonably, expect a module named
 * after the thing they are asking about, and they call it two different ways:
 *
 *   `routes/changes.routes.ts`  `evaluate(tenantId, ticketId)`
 *                               — the freeze drawer has a ticket id and nothing
 *                                 else.
 *   `services/change.service.ts` `evaluate({ tenantId, changeTicketId,
 *                                 changeType, risk, window, gate, executor })`
 *                               — it already holds the change and the resolved
 *                                 policy band, and reaches this module through
 *                                 a call-time `require` behind a STRUCTURAL
 *                                 port, because a static import would close a
 *                                 module-initialisation cycle.
 *
 * A structural port is not type-checked across the boundary. A signature
 * mismatch there would compile perfectly, throw at runtime, be swallowed by
 * that module's `try`, and log "freeze evaluation failed" for the life of the
 * install — which is the dead-hook defect the previous module shipped, wearing
 * a different hat. So this file accepts BOTH shapes and dispatches. That is its
 * entire job.
 *
 * ── What it must never become ───────────────────────────────────────────────
 * `isChangeFrozen` (in `@oblidesk/shared`) reads the verdicts this returns and
 * paints a banner. It is a READ PREDICATE. Authorising a bypass is
 * `evaluateChangeFreezeOverride`, a capability question with its own columns
 * and its own audit trail. Do not add an override path here.
 */

import type { ChangeFreezeVerdict, ChangeGateMode, ChangeRisk, ChangeType } from '@oblidesk/shared';

import { db, type Executor } from '../db';
import {
  evaluateFreezes,
  evaluateFreezesForChange,
  loadChangeFreezes,
  readChangeSubject,
} from './changeConflict.service';

/**
 * The object form `change.service` calls through its structural port.
 *
 * `window` is the change's PLANNED window (HARD RULE 6: not `occurred_at`, and
 * not the actual window either — a freeze governs what you are ABOUT to do).
 * `gate` is the policy band's `freezeGate`: `off` skips the evaluation
 * entirely, `warn` downgrades every verdict, which is how an `emergency` change
 * is exempted from the BLOCK without being exempted from the RECORD.
 */
export interface FreezeScanInput {
  tenantId: number;
  changeTicketId: number;
  changeType: ChangeType;
  risk: ChangeRisk | null;
  window: { startAt: string; endAt: string } | null;
  gate: ChangeGateMode;
  executor?: Executor;
  now?: string;
}

export async function evaluate(
  tenantId: number,
  ticketId: number,
  options?: { now?: string; executor?: Executor },
): Promise<ChangeFreezeVerdict[]>;
export async function evaluate(input: FreezeScanInput): Promise<ChangeFreezeVerdict[]>;
export async function evaluate(
  a: number | FreezeScanInput,
  b?: number,
  c: { now?: string; executor?: Executor } = {},
): Promise<ChangeFreezeVerdict[]> {
  // ── Positional form: the route has a ticket id and nothing else, so the
  // engine reads the change and resolves the policy itself (baseline included).
  if (typeof a === 'number') {
    return evaluateFreezesForChange(a, b ?? 0, c);
  }

  // ── Object form: the caller already holds the change and the band's gate.
  // Only the ticket columns are missing, and those are needed for one reason —
  // a freeze may carry an `appliesWhen` condition written against the ticket
  // ("only the network queue"). Reading them here rather than re-resolving the
  // whole policy keeps the caller's gate authoritative: it resolved the band to
  // decide that gate, and re-deriving it would be two resolutions of one policy
  // inside one transaction.
  const executor = a.executor ?? db;
  const subject = await readChangeSubject(a.tenantId, a.changeTicketId, executor);

  return evaluateFreezes({
    tenantId: a.tenantId,
    change: {
      ticketId: a.changeTicketId,
      changeType: a.changeType,
      risk: a.risk,
      plannedStartAt: a.window?.startAt ?? null,
      plannedEndAt: a.window?.endAt ?? null,
      // Absent when the change or its ticket is gone. `evaluateFreezes` then
      // leaves `appliesWhenMatched` undefined, which reads as MATCHING — a
      // freeze whose condition cannot be evaluated must not quietly stop
      // applying, because a freeze that silently lapses is the exact failure
      // this control exists to prevent.
      ticket: subject?.ticketFields ?? null,
    },
    gate: a.gate,
    // A READ. Painting the banner is not a decision, and a decision row every
    // time a drawer opens would bury the row written when a freeze actually
    // refuses a move (HARD RULE 2, volumetrically).
    record: false,
    now: a.now,
    executor,
  });
}

export const changeFreezeService = {
  evaluate,
  load: loadChangeFreezes,
};

export default changeFreezeService;
