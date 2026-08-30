import type { Knex } from 'knex';

/**
 * 008_approval_step_purge_safety.ts — the last CHECK that made an account's own
 * history illegal once the account was gone.
 *
 * 007 relaxed the three pairs 006 shipped. This is the same contradiction, one
 * migration older: `approval_steps.approver_user_id` points at `users` with ON
 * DELETE SET NULL, while `approval_steps_approver_ck` demands that a step name
 * a user OR a group. Purging the sole named approver of any step — including a
 * step decided two years ago — makes that row illegal, so the RI trigger's
 * UPDATE raises 23514 and `DELETE /api/users/:id?purge=true` dies on an opaque
 * 500 with the account still there.
 *
 * ── Why this one is narrowed rather than dropped ────────────────────────────
 *
 * 007's three constraints were about the WRITE: you may not CONCLUDE an
 * analysis without naming a human, but the row stays legal when that human is
 * later forgotten. This one is not quite the same, and 002 says so in its own
 * comment on the line: "A step nobody can act on is a deadlock — make it
 * impossible to create one."
 *
 * That is a live-state invariant, not a write-time one. A `pending` step with
 * no approver really is a deadlock: nothing will ever move it. A step that is
 * `approved`, `rejected`, `expired`, `cancelled` or `skipped` is history, and
 * history with a forgotten actor is exactly what the SET NULL is for.
 *
 * So the rule keeps its teeth where it means something and lets go where it
 * does not: an approver is required WHILE the step is pending. Both halves of
 * 002's intent survive — a step cannot be CREATED unactionable, because a new
 * step is born `pending`.
 *
 * ── What still refuses, and now says why ────────────────────────────────────
 *
 * Purging someone who is the sole approver of a step that is still pending is
 * still refused, and that refusal is correct: blanking them would strand a
 * running approval nobody can decide. It is no longer a 23514 from inside the
 * RI trigger, though — `userService.delete` looks for those steps first and
 * answers with a message naming them, so the operator knows to reassign or
 * cancel the approval and can then purge.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.raw(
    'ALTER TABLE "approval_steps" DROP CONSTRAINT IF EXISTS approval_steps_approver_ck',
  );
  await knex.schema.raw(
    'ALTER TABLE "approval_steps" ADD CONSTRAINT approval_steps_approver_ck ' +
      "CHECK (state <> 'pending' OR approver_user_id IS NOT NULL OR approver_group_id IS NOT NULL)",
  );
}

export async function down(knex: Knex): Promise<void> {
  // Restoring 002's wording can fail on data this migration made legal: a
  // terminal step whose approver was purged while 008 was in force. Clearing
  // those rows would destroy the history the relaxation existed to keep, so the
  // rollback refuses instead of quietly deleting evidence.
  const [{ count }] = (await knex('approval_steps')
    .whereNot('state', 'pending')
    .whereNull('approver_user_id')
    .whereNull('approver_group_id')
    .count<[{ count: string }]>('* as count')) as unknown as [{ count: string }];

  if (Number(count) > 0) {
    throw new Error(
      `Cannot roll back 008: ${count} terminal approval step(s) have no approver, ` +
        'which 002\'s constraint forbids. They are history whose actor was purged; ' +
        'decide what should happen to them before rolling back.',
    );
  }

  await knex.schema.raw(
    'ALTER TABLE "approval_steps" DROP CONSTRAINT IF EXISTS approval_steps_approver_ck',
  );
  await knex.schema.raw(
    'ALTER TABLE "approval_steps" ADD CONSTRAINT approval_steps_approver_ck ' +
      'CHECK (approver_user_id IS NOT NULL OR approver_group_id IS NOT NULL)',
  );
}
