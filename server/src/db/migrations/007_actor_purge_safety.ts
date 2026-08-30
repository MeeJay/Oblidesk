import type { Knex } from 'knex';

/**
 * 007_actor_purge_safety.ts — three CHECK constraints from 006 relaxed so that
 * hard-deleting an account stops making that account's own history illegal.
 *
 * 001..006 are never edited: a migration that has run on a real database is
 * history, and rewriting history means the schema an operator has is not the
 * schema the file describes. 006 has run, so the correction lives here.
 *
 * ── The contradiction ───────────────────────────────────────────────────────
 *
 * Every `_by` column in this codebase points at `users` with ON DELETE SET
 * NULL, and that is deliberate: `user.service.ts` states the doctrine in so
 * many words — "history survives with a null actor rather than disappearing".
 * Postgres performs that SET NULL as an ordinary UPDATE through the RI trigger,
 * so every table CHECK is re-evaluated against the nulled row. A CHECK that
 * demands `<x>_by IS NOT NULL` therefore forbids the exact degradation the FK
 * exists to perform, and the two cancel each other out.
 *
 * 006 shipped three such pairs:
 *
 *   problem_analyses_concluded_ck    … AND concluded_by IS NOT NULL
 *   problem_causes_confirmed_ck      … AND confirmed_by IS NOT NULL
 *   problem_candidates_rejected_ck   decided_by IS NOT NULL AND …
 *
 * `DELETE /api/users/:id?purge=true` then dies on 23514 inside the single
 * transaction of `userService.delete`: the account can never be removed, the
 * operator gets an opaque 500, and a "delete this person" request has no
 * answer. The failure is clean — the transaction rolls back and nothing is
 * corrupted — but the operation is refused for ever, on a row the purge was
 * supposed to be allowed to blank.
 *
 * ── Why the CHECK moves and not the FK ──────────────────────────────────────
 *
 * Turning these three FKs into RESTRICT would keep every row legal and still
 * refuse the purge: it trades an unreadable 500 for a readable one and leaves
 * the account undeletable, which is the actual defect. The invariant was never
 * "this row names a living account for ever". It is "you cannot ENTER this
 * state without naming a human" — a rule about the WRITE. What survives the
 * purge and still proves the write happened is the instant (`concluded_at`,
 * `confirmed_at`, `decided_at`) and, where there is one, the method; the
 * identity is a foreign key the platform is allowed to forget.
 *
 * That is already the shape 006 uses for the one actor invariant it got right:
 * `problems_published_workaround_ck` demands `known_error_published_at IS NOT
 * NULL` and says nothing about `known_error_published_by`, whose FK is the same
 * SET NULL. These three now read the same way, so the file has one rule for
 * actor columns instead of two.
 *
 * The named human is not lost. It is enforced where this module already puts
 * its write-time gates and where a refusal can say what is missing:
 * `evaluateCauseConfirmation` in shared/ raises the `cause_needs_human` blocker
 * on both client and server, and `changeAnalysisState` raises
 * `analysis_needs_human` before the row is written. 006 says it itself, on the
 * conclude CHECK: the constraint is the last line of defence, not the first.
 *
 * `problem_candidates_rejected_ck` also fired at WRITE time, not only on purge:
 * `rejectCandidate` writes `decided_by: actor.userId ?? null`, so a rejection
 * driven by an automation hit the same 23514 with no explanation. Whether a
 * machine may bury a candidate is a product decision, and it belongs beside
 * `analysis_needs_human` in the service — a CHECK cannot name what it refused.
 *
 * Nothing is widened by accident: every relaxed predicate is implied by the
 * stricter one it replaces, so the re-validating scan on ADD CONSTRAINT cannot
 * fail on existing rows and no backfill is needed.
 */

export async function up(knex: Knex): Promise<void> {
  // ── problem_analyses ──────────────────────────────────────────────────────
  // Concluding still costs an elected root cause and a recorded instant, both
  // of which the purge cannot touch. `concluded_by` stays a column, an index
  // target and an audit read; it simply stops being a condition of legality.
  await knex.schema.raw(
    'ALTER TABLE "problem_analyses" DROP CONSTRAINT IF EXISTS problem_analyses_concluded_ck',
  );
  await knex.schema.raw(
    `ALTER TABLE "problem_analyses" ADD CONSTRAINT problem_analyses_concluded_ck CHECK (
       state <> 'concluded'
       OR (root_cause_id IS NOT NULL AND concluded_at IS NOT NULL))`,
  );

  // ── problem_causes ────────────────────────────────────────────────────────
  // The named METHOD is the half of the pair that carries the meaning
  // (fix_verified outranks expert_review, and a report blending the two lies),
  // and it survives the purge. The named human is the half the FK is allowed to
  // forget, so it is the shared evaluator that holds it at the gate.
  await knex.schema.raw(
    'ALTER TABLE "problem_causes" DROP CONSTRAINT IF EXISTS problem_causes_confirmed_ck',
  );
  await knex.schema.raw(
    `ALTER TABLE "problem_causes" ADD CONSTRAINT problem_causes_confirmed_ck CHECK (
       confidence NOT IN ('confirmed', 'refuted')
       OR (confirmation_method IS NOT NULL AND confirmed_at IS NOT NULL))`,
  );

  // ── problem_candidates ────────────────────────────────────────────────────
  // `decided_at` keeps the constraint biting where it was meant to: a bare
  // UPDATE flipping `state` to 'rejected' without deciding anything is still
  // refused, and the headstone still carries the moment it was raised.
  await knex.schema.raw(
    'ALTER TABLE "problem_candidates" DROP CONSTRAINT IF EXISTS problem_candidates_rejected_ck',
  );
  await knex.schema.raw(
    `ALTER TABLE "problem_candidates" ADD CONSTRAINT problem_candidates_rejected_ck CHECK (
       state <> 'rejected' OR decided_at IS NOT NULL)`,
  );
}

export async function down(knex: Knex): Promise<void> {
  // Restores the 006 predicates verbatim. Rolling back re-arms the purge
  // failure; that is what "down" means here and it is not a reason to keep a
  // weaker predicate on the way back.
  await knex.schema.raw(
    'ALTER TABLE "problem_candidates" DROP CONSTRAINT IF EXISTS problem_candidates_rejected_ck',
  );
  await knex.schema.raw(
    `ALTER TABLE "problem_candidates" ADD CONSTRAINT problem_candidates_rejected_ck CHECK (
       state <> 'rejected' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL))`,
  );

  await knex.schema.raw(
    'ALTER TABLE "problem_causes" DROP CONSTRAINT IF EXISTS problem_causes_confirmed_ck',
  );
  await knex.schema.raw(
    `ALTER TABLE "problem_causes" ADD CONSTRAINT problem_causes_confirmed_ck CHECK (
       confidence NOT IN ('confirmed', 'refuted')
       OR (confirmation_method IS NOT NULL AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL))`,
  );

  await knex.schema.raw(
    'ALTER TABLE "problem_analyses" DROP CONSTRAINT IF EXISTS problem_analyses_concluded_ck',
  );
  await knex.schema.raw(
    `ALTER TABLE "problem_analyses" ADD CONSTRAINT problem_analyses_concluded_ck CHECK (
       state <> 'concluded'
       OR (root_cause_id IS NOT NULL AND concluded_at IS NOT NULL AND concluded_by IS NOT NULL))`,
  );
}
