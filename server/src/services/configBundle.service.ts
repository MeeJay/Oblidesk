/**
 * configBundle.service.ts — export and import the whole configuration as one
 * JSON envelope, with a two-pass conflict protocol.
 *
 * ── Why one envelope ─────────────────────────────────────────────────────────
 * The configuration of a desk is a graph, not a list: a queue points at an SLA
 * policy, which points at a calendar; a form points at fields; a rule points at
 * a notification template. Exporting objects one at a time gives you a pile of
 * files that only work if you import them in the right order and nothing was
 * renamed in between. One envelope, imported in one transaction, either lands
 * whole or does not land at all.
 *
 * Every reference inside is a SLUG (HARD RULE 3), which is the only reason a
 * bundle can move between tenants at all — the numeric ids on either side have
 * nothing to do with each other.
 *
 * ── The two-pass conflict protocol ───────────────────────────────────────────
 * Pass 1 (`planImport`) touches nothing. It resolves every object against what
 * the tenant already has and reports one of four verdicts, which is exactly the
 * three-column diff the UI renders:
 *
 *   add        — the tenant has no object with this (kind, slug)
 *   update     — it has one, the body differs, and the local copy is unmodified
 *                from what IT was shipped/imported with, so overwriting loses
 *                nothing a human wrote
 *   conflict   — it has one, the body differs, AND the local copy has been
 *                edited since it arrived. Somebody's work is on the line, so
 *                the import will not touch it without an explicit decision
 *   unchanged  — byte-identical body; nothing to do
 *
 * Pass 2 (`applyImport`) takes the plan plus per-object decisions and writes.
 * Conflicts are skipped unless explicitly chosen, so the default behaviour of
 * "import this bundle" can never silently destroy local customisation.
 *
 * ── Reset to defaults is just a re-import ────────────────────────────────────
 * `db/seeds/02_baseline_config.ts` is written in exactly the shape this module
 * exports, so {@link baselineBundle} wraps it and {@link resetToDefaults} runs
 * the ordinary two-pass import over it. There is no separate "restore" code
 * path to rot — if reset works, import works, and vice versa.
 */

import type { Knex } from 'knex';

import {
  APP_TYPE,
  CONFIG_BODY_FORMAT_VERSIONS,
  isConfigKind,
  type ConfigBundle,
  type ConfigKind,
} from '@oblidesk/shared';

import { db, scoped } from '../db';
import { BASELINE_OBJECTS, BODY_FORMAT_VERSIONS } from '../db/seeds/02_baseline_config';
import {
  buildLintContext,
  checksumOfBody,
  lintObjects,
  type ConfigLintFinding,
  type LintTarget,
} from './configLinter.service';
import {
  ConfigServiceError,
  writeAudit,
  type ConfigActor,
} from './configObject.service';

// ═════════════════════════════════════════════════════════════════════════════
// Shapes
// ═════════════════════════════════════════════════════════════════════════════

export type BundleAction = 'add' | 'update' | 'conflict' | 'unchanged';

export interface BundlePlanEntry {
  kind: ConfigKind;
  slug: string;
  name: string;
  action: BundleAction;
  /** One sentence the UI puts under the verdict. */
  reason: string;
  incomingChecksum: string;
  currentChecksum: string | null;
  /** Checksum of the local object's FIRST version — what it arrived with. */
  shippedChecksum: string | null;
  /** True when the local body has drifted from what it arrived with. */
  locallyModified: boolean;
  isSystem: boolean;
  /** Blocking findings against the INCOMING body. */
  blocking: ConfigLintFinding[];
}

export interface BundleImportPlan {
  formatVersion: number;
  app: string;
  sourceTenantSlug: string;
  exportedAt: string;
  targetTenantId: number;
  entries: BundlePlanEntry[];
  summary: {
    add: number;
    update: number;
    conflict: number;
    unchanged: number;
    blocked: number;
  };
  /** Every lint finding over the incoming set, blocking or not. */
  findings: ConfigLintFinding[];
  /** Objects the tenant has that the bundle does not mention. */
  notInBundle: Array<{ kind: ConfigKind; slug: string; isSystem: boolean }>;
}

export type BundleDecision = 'apply' | 'skip';

export interface ApplyImportOptions {
  /** `${kind}:${slug}` → apply | skip. Anything absent uses the default. */
  decisions?: Record<string, BundleDecision>;
  /**
   * Apply conflicting objects too — the "overwrite my changes" button.
   * Off by default, on purpose.
   */
  applyConflicts?: boolean;
  /** Note stamped on every `config_object_versions` row this import writes. */
  note?: string;
}

export interface ApplyImportResult {
  added: string[];
  updated: string[];
  skipped: string[];
  /** Objects the plan said were already identical. */
  unchanged: string[];
}

const entryKey = (kind: ConfigKind, slug: string): string => `${kind}:${slug.toLowerCase()}`;

// ═════════════════════════════════════════════════════════════════════════════
// Export
// ═════════════════════════════════════════════════════════════════════════════

export interface ExportOptions {
  /** Restrict to these kinds; omitted = everything. */
  kinds?: ConfigKind[];
  /** Include drafts. Off by default — a bundle is what the desk RUNS. */
  includeDrafts?: boolean;
  /** Include archived objects. Off by default. */
  includeArchived?: boolean;
}

/**
 * Export the tenant's configuration.
 *
 * `target_tenant_ids` is deliberately NOT exported: it is a list of numeric
 * tenant ids in THIS installation, and carrying it into another one would
 * point a shared object at whichever unrelated tenants happen to hold those
 * ids. Sharing is re-declared by the master admin on the receiving side.
 */
export async function exportBundle(
  actor: ConfigActor,
  options: ExportOptions = {},
): Promise<ConfigBundle> {
  const statuses: string[] = ['published'];
  if (options.includeDrafts) statuses.push('draft');
  if (options.includeArchived) statuses.push('archived');

  const query = scoped('config_objects', actor.tenantId)
    .select('kind', 'slug', 'name', 'description', 'body', 'body_format_version', 'is_system')
    .whereIn('config_objects.status', statuses)
    .orderBy(['config_objects.kind', 'config_objects.slug']);

  if (options.kinds && options.kinds.length > 0) {
    query.whereIn('config_objects.kind', options.kinds);
  }

  const rows = (await query) as Array<Record<string, unknown>>;

  const tenant = await db('tenants').select('slug').where('id', actor.tenantId).first();

  return {
    formatVersion: 1,
    app: 'oblidesk',
    exportedAt: new Date().toISOString(),
    sourceTenantSlug: tenant ? String((tenant as { slug: string }).slug) : (actor.tenantSlug ?? 'unknown'),
    objects: rows
      .filter((row) => isConfigKind(row.kind))
      .map((row) => ({
        kind: row.kind as ConfigKind,
        slug: String(row.slug),
        name: String(row.name),
        description: (row.description as string | null) ?? null,
        body: parseJson(row.body) as unknown as ConfigBundle['objects'][number]['body'],
        bodyFormatVersion: Number(row.body_format_version) || 1,
        isSystem: row.is_system === true,
      })),
  };
}

/**
 * The shipped baseline, wrapped as an ordinary bundle. This is the same array
 * the seed inserts, so "reset to defaults" and "first boot" produce identical
 * rows by construction rather than by two implementations agreeing.
 */
export function baselineBundle(): ConfigBundle {
  return {
    formatVersion: 1,
    app: 'oblidesk',
    exportedAt: new Date().toISOString(),
    sourceTenantSlug: 'oblidesk-baseline',
    objects: BASELINE_OBJECTS.filter((object) => isConfigKind(object.kind)).map((object) => ({
      kind: object.kind as ConfigKind,
      slug: object.slug,
      name: object.name,
      description: object.description ?? null,
      body: object.body as unknown as ConfigBundle['objects'][number]['body'],
      bodyFormatVersion:
        BODY_FORMAT_VERSIONS[object.kind] ?? CONFIG_BODY_FORMAT_VERSIONS[object.kind as ConfigKind] ?? 1,
      isSystem: true,
    })),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Validation of an incoming envelope
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Reject a bundle we cannot read BEFORE we start diffing it. A half-understood
 * bundle is the one thing an import must never attempt: the objects it did
 * understand would land and the rest would not, leaving a configuration that
 * is neither the old one nor the new one.
 */
export function assertReadableBundle(value: unknown): ConfigBundle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigServiceError(400, 'That is not a configuration bundle.');
  }
  const bundle = value as Partial<ConfigBundle>;

  if (bundle.app !== APP_TYPE) {
    throw new ConfigServiceError(
      400,
      `This bundle was exported from "${String(bundle.app)}", not from ${APP_TYPE}.`,
    );
  }
  if (bundle.formatVersion !== 1) {
    throw new ConfigServiceError(
      400,
      `Bundle format version ${String(bundle.formatVersion)} is not readable by this Oblidesk (it understands 1). Refusing to guess at its shape.`,
      'config_unreadable',
    );
  }
  if (!Array.isArray(bundle.objects)) {
    throw new ConfigServiceError(400, 'The bundle carries no objects array.');
  }

  for (const [index, object] of bundle.objects.entries()) {
    if (!object || typeof object !== 'object') {
      throw new ConfigServiceError(400, `objects[${index}] is not an object.`);
    }
    if (!isConfigKind(object.kind)) {
      throw new ConfigServiceError(400, `objects[${index}] has an unknown kind "${String(object.kind)}".`);
    }
    if (typeof object.slug !== 'string' || object.slug.trim() === '') {
      throw new ConfigServiceError(400, `objects[${index}] (${object.kind}) has no slug.`);
    }
    const declared = Number(object.bodyFormatVersion);
    const supported = CONFIG_BODY_FORMAT_VERSIONS[object.kind];
    if (!Number.isInteger(declared) || declared < 1) {
      throw new ConfigServiceError(400, `${object.kind}:${object.slug} has no body_format_version (HARD RULE 4).`);
    }
    if (declared > supported) {
      throw new ConfigServiceError(
        422,
        `${object.kind}:${object.slug} declares body_format_version ${declared}; this Oblidesk understands up to ${supported}. Upgrade before importing — reading a newer body with an older parser is how a body gets silently truncated.`,
        'config_unreadable',
      );
    }
  }

  return bundle as ConfigBundle;
}

// ═════════════════════════════════════════════════════════════════════════════
// Pass 1 — the dry run
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Resolve the bundle against the tenant and report the three-column diff.
 * Reads only; safe to call as often as the UI likes.
 */
export async function planImport(
  actor: ConfigActor,
  raw: unknown,
): Promise<BundleImportPlan> {
  const bundle = assertReadableBundle(raw);

  // Everything the tenant currently has, with the checksum it ARRIVED with
  // (the first version row) so "has a human touched this?" is answerable.
  const currentRows = (await scoped('config_objects', actor.tenantId)
    .select('config_objects.id', 'config_objects.kind', 'config_objects.slug', 'config_objects.checksum',
      'config_objects.is_system', 'config_objects.body', 'config_objects.body_format_version')) as Array<Record<string, unknown>>;

  const currentById = new Map<number, Record<string, unknown>>();
  const currentByKey = new Map<string, Record<string, unknown>>();
  for (const row of currentRows) {
    if (!isConfigKind(row.kind)) continue;
    currentById.set(Number(row.id), row);
    currentByKey.set(entryKey(row.kind as ConfigKind, String(row.slug)), row);
  }

  const shippedChecksums = await firstVersionChecksums([...currentById.keys()], currentById);

  // Lint the incoming set as a WHOLE, so objects in the same bundle satisfy
  // each other's references — importing a queue and its SLA together has to be
  // possible, and each on its own would be dangling.
  const targets: LintTarget[] = bundle.objects.map((object) => ({
    kind: object.kind,
    slug: object.slug,
    name: object.name,
    body: object.body,
    bodyFormatVersion: object.bodyFormatVersion,
    status: 'published',
  }));
  const lintContext = await buildLintContext(actor.tenantId, targets);
  const findings = lintObjects(targets, lintContext);

  const blockingBySlug = new Map<string, ConfigLintFinding[]>();
  for (const finding of findings) {
    if (finding.severity !== 'error') continue;
    const key = entryKey(finding.kind, finding.slug);
    const list = blockingBySlug.get(key) ?? [];
    list.push(finding);
    blockingBySlug.set(key, list);
  }

  const entries: BundlePlanEntry[] = [];
  const mentioned = new Set<string>();

  for (const object of bundle.objects) {
    const key = entryKey(object.kind, object.slug);
    mentioned.add(key);

    const incomingChecksum = checksumOfBody(object.kind, object.body, object.bodyFormatVersion);
    const existing = currentByKey.get(key);
    const blocking = blockingBySlug.get(key) ?? [];

    if (!existing) {
      entries.push({
        kind: object.kind,
        slug: object.slug,
        name: object.name,
        action: 'add',
        reason: 'This tenant has no object with that slug.',
        incomingChecksum,
        currentChecksum: null,
        shippedChecksum: null,
        locallyModified: false,
        isSystem: object.isSystem === true,
        blocking,
      });
      continue;
    }

    const currentChecksum = (existing.checksum as string | null)
      ?? checksumOfBody(object.kind, parseJson(existing.body), Number(existing.body_format_version) || 1);
    const shippedChecksum = shippedChecksums.get(Number(existing.id)) ?? null;
    const locallyModified = shippedChecksum !== null && shippedChecksum !== currentChecksum;

    if (currentChecksum === incomingChecksum) {
      entries.push({
        kind: object.kind,
        slug: object.slug,
        name: object.name,
        action: 'unchanged',
        reason: 'Byte-identical to what this tenant already has.',
        incomingChecksum,
        currentChecksum,
        shippedChecksum,
        locallyModified,
        isSystem: existing.is_system === true,
        blocking,
      });
      continue;
    }

    entries.push({
      kind: object.kind,
      slug: object.slug,
      name: object.name,
      action: locallyModified ? 'conflict' : 'update',
      reason: locallyModified
        ? 'Both sides changed: this tenant edited its copy after it arrived, and the bundle carries a different body. Applying would discard the local edit.'
        : 'The local copy is untouched since it arrived, so applying the bundle loses nothing a human wrote.',
      incomingChecksum,
      currentChecksum,
      shippedChecksum,
      locallyModified,
      isSystem: existing.is_system === true,
      blocking,
    });
  }

  const notInBundle = [...currentByKey.entries()]
    .filter(([key]) => !mentioned.has(key))
    .map(([, row]) => ({
      kind: row.kind as ConfigKind,
      slug: String(row.slug),
      isSystem: row.is_system === true,
    }));

  const summary = {
    add: entries.filter((entry) => entry.action === 'add').length,
    update: entries.filter((entry) => entry.action === 'update').length,
    conflict: entries.filter((entry) => entry.action === 'conflict').length,
    unchanged: entries.filter((entry) => entry.action === 'unchanged').length,
    blocked: entries.filter((entry) => entry.blocking.length > 0).length,
  };

  return {
    formatVersion: bundle.formatVersion,
    app: bundle.app,
    sourceTenantSlug: bundle.sourceTenantSlug,
    exportedAt: bundle.exportedAt,
    targetTenantId: actor.tenantId,
    entries,
    summary,
    findings,
    notInBundle,
  };
}

/** Checksum of each object's first version row — what it arrived carrying. */
async function firstVersionChecksums(
  ids: number[],
  currentById: Map<number, Record<string, unknown>>,
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (ids.length === 0) return out;

  // config_object_versions has no tenant_id: it is reached through its
  // already-scoped parent, and `ids` came from a scoped query.
  const rows = (await db('config_object_versions')
    .select('config_object_id', 'version', 'body', 'body_format_version')
    .whereIn('config_object_id', ids)
    .orderBy(['config_object_id', 'version'])) as Array<Record<string, unknown>>;

  for (const row of rows) {
    const parentId = Number(row.config_object_id);
    if (out.has(parentId)) continue; // ordered ascending: the first is v1
    const parent = currentById.get(parentId);
    if (!parent || !isConfigKind(parent.kind)) continue;
    out.set(
      parentId,
      checksumOfBody(
        parent.kind as ConfigKind,
        parseJson(row.body),
        Number(row.body_format_version) || 1,
      ),
    );
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// Pass 2 — apply
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Apply the bundle. One transaction: the configuration graph either moves as a
 * whole or does not move.
 *
 * Objects land PUBLISHED — a bundle describes what a desk runs, not what
 * somebody is drafting — and every landing appends a `config_object_versions`
 * row so the import is as replayable as any other publish.
 *
 * An object whose incoming body has BLOCKING lint findings is never applied,
 * even when explicitly selected. Importing a body the store would refuse to
 * publish by hand would make the bundle a way around the linter, and the
 * linter is the only thing enforcing HARD RULE 3.
 */
export async function applyImport(
  actor: ConfigActor,
  raw: unknown,
  options: ApplyImportOptions = {},
): Promise<ApplyImportResult> {
  const bundle = assertReadableBundle(raw);
  const plan = await planImport(actor, bundle);

  const byKey = new Map<string, BundlePlanEntry>();
  for (const entry of plan.entries) byKey.set(entryKey(entry.kind, entry.slug), entry);

  const result: ApplyImportResult = { added: [], updated: [], skipped: [], unchanged: [] };

  await db.transaction(async (trx) => {
    for (const object of bundle.objects) {
      const key = entryKey(object.kind, object.slug);
      const entry = byKey.get(key);
      if (!entry) continue;

      const decision = options.decisions?.[key];

      if (entry.blocking.length > 0) {
        result.skipped.push(key);
        continue;
      }
      if (entry.action === 'unchanged') {
        result.unchanged.push(key);
        continue;
      }
      if (decision === 'skip') {
        result.skipped.push(key);
        continue;
      }
      if (entry.action === 'conflict' && decision !== 'apply' && options.applyConflicts !== true) {
        result.skipped.push(key);
        continue;
      }

      const applied = await upsertBundleObject(trx, actor, object, options.note ?? bundleNote(plan));
      if (applied === 'added') result.added.push(key);
      else result.updated.push(key);
    }

    await writeAudit(trx, actor, {
      action: 'config.import',
      entityType: 'config_bundle',
      entityId: plan.sourceTenantSlug,
      before: { summary: plan.summary },
      after: {
        added: result.added.length,
        updated: result.updated.length,
        skipped: result.skipped.length,
        unchanged: result.unchanged.length,
        sourceTenantSlug: plan.sourceTenantSlug,
        exportedAt: plan.exportedAt,
      },
    });
  });

  return result;
}

function bundleNote(plan: BundleImportPlan): string {
  return `Imported from bundle exported by "${plan.sourceTenantSlug}" at ${plan.exportedAt}.`;
}

type UpsertOutcome = 'added' | 'updated';

async function upsertBundleObject(
  trx: Knex.Transaction,
  actor: ConfigActor,
  object: ConfigBundle['objects'][number],
  note: string,
): Promise<UpsertOutcome> {
  const checksum = checksumOfBody(object.kind, object.body, object.bodyFormatVersion);

  const existing = (await scoped('config_objects', actor.tenantId, trx)
    .select('config_objects.id', 'config_objects.version', 'config_objects.checksum', 'config_objects.is_system')
    .where('config_objects.kind', object.kind)
    .where('config_objects.slug', object.slug)
    .first()) as { id: number; version: number; checksum: string | null; is_system: boolean } | undefined;

  if (!existing) {
    const inserted = (await trx('config_objects')
      .insert({
        tenant_id: actor.tenantId,
        kind: object.kind,
        slug: object.slug,
        name: object.name,
        description: object.description ?? null,
        body: JSON.stringify(object.body),
        body_format_version: object.bodyFormatVersion,
        status: 'published',
        version: 1,
        is_system: object.isSystem === true,
        // Never carried across an installation boundary — see exportBundle.
        target_tenant_ids: [],
        checksum,
        created_by: actor.userId,
        updated_at: trx.fn.now(),
      })
      .returning('id')) as Array<{ id: number } | number>;

    const newId = typeof inserted[0] === 'object' ? (inserted[0] as { id: number }).id : Number(inserted[0]);

    await trx('config_object_versions')
      .insert({
        config_object_id: newId,
        version: 1,
        body: JSON.stringify(object.body),
        body_format_version: object.bodyFormatVersion,
        author_id: actor.userId,
        note,
      })
      .onConflict(['config_object_id', 'version'])
      .ignore();

    return 'added';
  }

  const nextVersion = Number(existing.version) + 1;

  await scoped('config_objects', actor.tenantId, trx)
    .where('config_objects.id', existing.id)
    .update({
      name: object.name,
      description: object.description ?? null,
      body: JSON.stringify(object.body),
      body_format_version: object.bodyFormatVersion,
      status: 'published',
      version: nextVersion,
      checksum,
      updated_at: trx.fn.now(),
    });

  await trx('config_object_versions')
    .insert({
      config_object_id: existing.id,
      version: nextVersion,
      body: JSON.stringify(object.body),
      body_format_version: object.bodyFormatVersion,
      author_id: actor.userId,
      note,
    })
    .onConflict(['config_object_id', 'version'])
    .ignore();

  return 'updated';
}

// ═════════════════════════════════════════════════════════════════════════════
// Reset to defaults
// ═════════════════════════════════════════════════════════════════════════════

/** Dry run of "reset to defaults" — the same three columns as any import. */
export async function planResetToDefaults(actor: ConfigActor): Promise<BundleImportPlan> {
  return planImport(actor, baselineBundle());
}

/**
 * Reset to defaults.
 *
 * `overwriteLocalEdits` is the difference between "put back anything I have
 * deleted or broken" (the safe default: adds and clean updates only) and "I
 * want the shipped configuration back exactly, discard my edits". Both are
 * legitimate; only one of them is safe to be the default.
 */
export async function resetToDefaults(
  actor: ConfigActor,
  overwriteLocalEdits = false,
): Promise<ApplyImportResult> {
  return applyImport(actor, baselineBundle(), {
    applyConflicts: overwriteLocalEdits,
    note: 'Reset to the shipped Oblidesk baseline.',
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════════════════════

function parseJson(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}
