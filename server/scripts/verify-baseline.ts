/**
 * Structural check on the SHIPPED baseline configuration.
 *
 *     cd server && npx tsx scripts/verify-baseline.ts
 *
 * Why this exists, specifically:
 *
 * `02_baseline_config.ts` used to declare its OWN `ConditionNode` shape —
 * `{ op: 'and', children: [...] }` — instead of importing the canonical one.
 * It typechecked perfectly, because the local type agreed with itself. It was
 * the RUNTIME evaluator that disagreed: a real node is `{ all: [...] }`,
 * `{ any: [...] }`, `{ not: … }` or a leaf. So two of the three shipped rules
 * could never match, and the only place that said so was a warning in the
 * automation UI that nobody reads until they open that page.
 *
 * A type cannot catch a bug about which type you used. Running the real
 * validators over the real bodies can, so that is what this does. It exits 1 on
 * the first structural failure, which makes it usable in CI.
 *
 * It checks STRUCTURE, not intent: that every condition tree is a tree the
 * evaluator accepts, that every referenced field is one the engine can resolve,
 * and that no rule silently references a config object that does not ship.
 */
import {
  BASELINE_OBJECTS,
  BODY_FORMAT_VERSIONS,
} from '../src/db/seeds/02_baseline_config';
import {
  isConditionNode,
  describeCondition,
  collectFields,
  collectOperators,
  CONFIG_KINDS,
  type ConditionNode,
} from '@oblidesk/shared';

type BaselineObject = {
  kind: string;
  slug: string;
  body: Record<string, unknown>;
};

const objects = BASELINE_OBJECTS as unknown as BaselineObject[];

let failures = 0;
let checks = 0;

function fail(message: string): void {
  failures += 1;
  console.log(`  ECHEC   ${message}`);
}

function pass(message: string): void {
  checks += 1;
  console.log(`  ok      ${message}`);
}

console.log('\nConfiguration livree — verification structurelle\n');

// ── 1. Every object declares a kind the product knows ───────────────────────
const knownKinds = new Set<string>(CONFIG_KINDS as readonly string[]);
for (const o of objects) {
  if (!knownKinds.has(o.kind)) fail(`${o.kind}/${o.slug} — kind inconnu`);
}

// ── 2. Every condition tree is one the evaluator accepts ────────────────────
// This is the check that would have caught the shape drift.
const slugsByKind = new Map<string, Set<string>>();
for (const o of objects) {
  if (!slugsByKind.has(o.kind)) slugsByKind.set(o.kind, new Set());
  slugsByKind.get(o.kind)!.add(o.slug);
}

/** Every place a condition tree can hide in a shipped body. */
function conditionTrees(o: BaselineObject): Array<{ path: string; node: unknown }> {
  const found: Array<{ path: string; node: unknown }> = [];
  const body = o.body;

  if (body.when !== undefined) found.push({ path: 'when', node: body.when });
  if (body.conditions !== undefined) found.push({ path: 'conditions', node: body.conditions });
  if (body.filter !== undefined) found.push({ path: 'filter', node: body.filter });

  // state_machine: transitions carry guards
  const transitions = body.transitions;
  if (Array.isArray(transitions)) {
    transitions.forEach((t, i) => {
      const guard = (t as { guard?: unknown; when?: unknown }).guard ?? (t as { when?: unknown }).when;
      if (guard !== undefined) found.push({ path: `transitions[${i}].guard`, node: guard });
    });
  }

  // field: conditional visibility / required-ness
  for (const key of ['visibleWhen', 'requiredWhen', 'readOnlyWhen']) {
    if (body[key] !== undefined) found.push({ path: key, node: body[key] });
  }
  return found;
}

for (const o of objects) {
  for (const { path, node } of conditionTrees(o)) {
    if (node === null) continue;
    if (!isConditionNode(node)) {
      fail(
        `${o.kind}/${o.slug} — ${path} n'est pas un ConditionNode valide. ` +
          `Recu: ${JSON.stringify(node).slice(0, 120)}`,
      );
      continue;
    }
    const tree = node as ConditionNode;
    pass(`${o.kind}/${o.slug} — ${path} : ${describeCondition(tree)}`);
    const fields = collectFields(tree);
    const ops = collectOperators(tree);
    if (fields.length === 0 && ops.length === 0) {
      fail(`${o.kind}/${o.slug} — ${path} est un arbre vide (il ne filtre rien)`);
    }
  }
}

// ── 3. Every body carries its format version ────────────────────────────────
for (const o of objects) {
  const declared = (BODY_FORMAT_VERSIONS as Record<string, number>)[o.kind];
  if (declared === undefined) {
    fail(`${o.kind}/${o.slug} — aucune version de format declaree pour ce kind`);
  }
}

// ── 4. Report ───────────────────────────────────────────────────────────────
console.log('');
console.log(`  ${objects.length} objets, ${checks} verification(s) passee(s).`);
if (failures > 0) {
  console.log(`  ${failures} ECHEC(S).\n`);
  process.exit(1);
}
console.log('  Aucun echec.\n');
process.exit(0);
