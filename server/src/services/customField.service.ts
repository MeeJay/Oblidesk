/**
 * customField.service.ts — custom fields: definitions in `config_objects`
 * (kind = 'field'), values in `tickets.data` (jsonb, GIN-indexed).
 *
 * ── The one rule that makes this file worth reading ──────────────────────────
 * A field's visibility is a ConditionNode tree. The client evaluates it to
 * decide what to draw; the server RE-EVALUATES the identical tree, with the
 * identical evaluator from @oblidesk/shared, on the save path — and rejects a
 * write to any field that is not visible to that actor at that moment.
 *
 * Skipping the server half is a security bug wearing a UX costume. The field
 * is not rendered, so it looks protected; but "not rendered" is a property of
 * one browser, and `PATCH /api/tickets/42 {"data":{"internal_cost":0}}` does
 * not go through a browser. A hidden-but-writable field is exactly as exposed
 * as a visible one, with the added disadvantage that nobody is watching it.
 *
 * ── HARD RULE 12, stated as code ─────────────────────────────────────────────
 * Nothing in the save path consults `requiredWhen`. Inline field edits autosave
 * one field at a time; blocking "save the phone number" because the resolution
 * code is empty is how an agent learns to keep a second copy of the ticket in
 * a text editor. Required-ness is evaluated ONCE, at a state transition, by
 * {@link missingRequiredFields} — the same evaluator, on the same trees, run by
 * the client to grey the button out and by the server to refuse the move.
 *
 * ── Both body dialects ───────────────────────────────────────────────────────
 * The shipped baseline writes snake_case field bodies (`applies_to_record_types`,
 * `max_length`) with `{ en, fr }` label maps; `shared/src/configKinds.ts`
 * declares camelCase with plain strings. {@link normalizeFieldBody} reads
 * either and hands the rest of the server one shape.
 */

import {
  evaluateCondition,
  buildConditionFields,
  DEFAULT_LOCALE,
  FALLBACK_LOCALE,
  type ConditionContext,
  type ConditionNode,
  type ConditionTrace,
  type FieldType,
  type TicketRecordType,
} from '@oblidesk/shared';

import { db, type Executor } from '../db';
import { normalizeConditionTree, normalizeFieldPath } from './configLinter.service';
import {
  ConfigServiceError,
  loadPublished,
  type ConfigActor,
} from './configObject.service';

// ═════════════════════════════════════════════════════════════════════════════
// Definitions
// ═════════════════════════════════════════════════════════════════════════════

export type FieldAudience = 'agent' | 'portal' | 'both';

export interface FieldOptionDefinition {
  value: string;
  label: string;
  labelKey?: string;
  color?: string;
  sortOrder: number;
  isActive: boolean;
}

export interface FieldDefinition {
  /** The config object slug. */
  slug: string;
  /** The key inside `tickets.data`. Defaults to the slug. */
  key: string;
  type: FieldType;
  label: string;
  labelKey?: string;
  helpText?: string;
  placeholder?: string;
  defaultValue?: unknown;
  options: FieldOptionDefinition[];
  optionsSourceSlug: string | null;
  min: number | null;
  max: number | null;
  step: number | null;
  maxLength: number | null;
  pattern: string | null;
  unit: string | null;
  currency: string | null;
  appliesToRecordTypes: string[];
  readOnly: boolean;
  indexed: boolean;
  piiSensitive: boolean;
  visibleTo: FieldAudience;
  /** HARD RULE 12 — read ONLY at a transition. Never on the save path. */
  requiredWhen: ConditionNode | null;
  visibleWhen: ConditionNode | null;
  editableWhen: ConditionNode | null;
  sortOrder: number;
  bodyFormatVersion: number;
}

/**
 * Pick a display string out of either dialect: a plain string, or the
 * `{ en, fr }` map the baseline uses. Falls back through the tenant default
 * locale to English so a missing translation degrades to readable text rather
 * than to a raw key (HARD RULE 10's server-side half).
 */
function localized(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const map = value as Record<string, unknown>;
    for (const locale of [DEFAULT_LOCALE, FALLBACK_LOCALE, 'en']) {
      const candidate = map[locale];
      if (typeof candidate === 'string' && candidate !== '') return candidate;
    }
    const first = Object.values(map).find((entry) => typeof entry === 'string');
    if (typeof first === 'string') return first;
  }
  return fallback;
}

function numberOrNull(...values: unknown[]): number | null {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function stringOrNull(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const FIELD_TYPES: readonly string[] = [
  'text', 'textarea', 'markdown', 'number', 'boolean', 'select', 'multiselect',
  'date', 'datetime', 'duration', 'url', 'email', 'phone', 'currency', 'json',
  'user', 'group', 'contact', 'organization', 'ci', 'ticket', 'attachment',
];

/** Read one field body in either dialect. */
export function normalizeFieldBody(
  slug: string,
  body: Record<string, unknown>,
  bodyFormatVersion = 1,
): FieldDefinition {
  // `storage` in the baseline is 'data.<key>'; `key` is the bare key.
  const storage = stringOrNull(body.storage);
  const derivedKey = storage && storage.startsWith('data.') ? storage.slice('data.'.length) : null;
  const key = stringOrNull(body.key, derivedKey, slug) ?? slug;

  const rawType = stringOrNull(body.type) ?? 'text';
  const type = (FIELD_TYPES.includes(rawType) ? rawType : 'text') as FieldType;

  const options: FieldOptionDefinition[] = Array.isArray(body.options)
    ? body.options.filter(isRecord).map((option, index) => ({
      value: String(option.value ?? option.slug ?? ''),
      label: localized(option.label, String(option.value ?? '')),
      labelKey: stringOrNull(option.labelKey) ?? undefined,
      color: stringOrNull(option.color) ?? undefined,
      sortOrder: numberOrNull(option.sortOrder, option.sort_order, option.order) ?? (index + 1) * 10,
      isActive: option.isActive !== false && option.is_active !== false,
    })).filter((option) => option.value !== '')
    : [];

  const appliesRaw = body.appliesToRecordTypes ?? body.applies_to_record_types;
  const appliesToRecordTypes = Array.isArray(appliesRaw)
    ? appliesRaw.filter((value): value is string => typeof value === 'string')
    : [];

  // Default audience is 'both'. The shipped baseline omits the key entirely
  // and places these fields on portal-visible form sections, so defaulting to
  // 'agent' would silently break the shipped intake form. The gate that
  // actually protects anything is `visibleWhen`, re-evaluated below on every
  // write; `visibleTo` is a coarse audience switch an admin can tighten.
  const rawAudience = stringOrNull(body.visibleTo, body.visible_to, body.audience);
  const visibleTo: FieldAudience =
    rawAudience === 'agent' || rawAudience === 'portal' || rawAudience === 'both'
      ? rawAudience
      : 'both';

  return {
    slug,
    key,
    type,
    label: localized(body.label, slug),
    labelKey: stringOrNull(body.labelKey) ?? undefined,
    helpText: localized(body.helpText ?? body.help, '') || undefined,
    placeholder: localized(body.placeholder, '') || undefined,
    defaultValue: body.defaultValue ?? body.default_value,
    options: options.sort((a, b) => a.sortOrder - b.sortOrder),
    optionsSourceSlug: stringOrNull(body.optionsSourceSlug, body.options_source_slug),
    min: numberOrNull(body.min),
    max: numberOrNull(body.max),
    step: numberOrNull(body.step),
    maxLength: numberOrNull(body.maxLength, body.max_length),
    pattern: stringOrNull(body.pattern),
    unit: stringOrNull(body.unit),
    currency: stringOrNull(body.currency),
    appliesToRecordTypes,
    readOnly: body.readOnly === true || body.read_only === true,
    indexed: body.indexed === true || body.searchable === true,
    piiSensitive: body.piiSensitive === true || body.pii_sensitive === true,
    visibleTo,
    requiredWhen: normalizeConditionTree(body.requiredWhen ?? body.required_when ?? null),
    visibleWhen: normalizeConditionTree(body.visibleWhen ?? body.visible_when ?? null),
    editableWhen: normalizeConditionTree(body.editableWhen ?? body.editable_when ?? null),
    sortOrder: numberOrNull(body.sortOrder, body.sort_order, body.order) ?? 1000,
    bodyFormatVersion,
  };
}

/**
 * Every published field definition for the tenant, keyed by its storage key
 * (which is what `tickets.data` uses). The slug index is available too — form
 * and transition bodies reference fields by SLUG (HARD RULE 3), while stored
 * values are keyed by `key`, and they are not always the same string.
 */
export interface FieldCatalog {
  byKey: Map<string, FieldDefinition>;
  bySlug: Map<string, FieldDefinition>;
  all: FieldDefinition[];
  /** `data.<key>` paths, for `buildConditionFields`'s declared-field overlay. */
  declaredPaths: string[];
}

export async function loadFieldCatalog(
  tenantId: number,
  executor: Executor = db,
): Promise<FieldCatalog> {
  const published = await loadPublished(tenantId, 'field', executor);

  const all: FieldDefinition[] = [];
  for (const entry of published.values()) {
    all.push(normalizeFieldBody(entry.slug, entry.body, entry.bodyFormatVersion));
  }
  all.sort((a, b) => (a.sortOrder === b.sortOrder ? a.slug.localeCompare(b.slug) : a.sortOrder - b.sortOrder));

  const byKey = new Map<string, FieldDefinition>();
  const bySlug = new Map<string, FieldDefinition>();
  for (const definition of all) {
    byKey.set(definition.key, definition);
    bySlug.set(definition.slug.toLowerCase(), definition);
  }

  return {
    byKey,
    bySlug,
    all,
    declaredPaths: all.map((definition) => `data.${definition.key}`),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Evaluation context
// ═════════════════════════════════════════════════════════════════════════════

/** The shape of a ticket this module needs — a raw `tickets` row is enough. */
export interface TicketSnapshot {
  id?: number;
  record_type?: string;
  status_slug?: string;
  status_category?: string;
  priority_slug?: string;
  queue_slug?: string;
  impact?: string | null;
  urgency?: string | null;
  assignee_id?: number | null;
  assignment_group_id?: number | null;
  requester_contact_id?: number | null;
  organization_id?: number | null;
  source?: string;
  data?: Record<string, unknown> | string | null;
  [column: string]: unknown;
}

function ticketData(ticket: TicketSnapshot): Record<string, unknown> {
  const raw = ticket.data;
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(raw) ? raw : {};
}

/**
 * Build the bag `evaluateCondition` reads.
 *
 * Every declared field is overlaid with `null` when the ticket has no value,
 * so `is_empty` means "known and empty" rather than "I could not find this" —
 * which is the distinction that makes required-ness at a transition
 * trustworthy instead of accidentally permissive.
 *
 * `now` is passed explicitly: an engine that lets the evaluator default to
 * `Date.now()` writes a `decision_log` row that cannot be replayed.
 */
export function buildFieldContext(
  ticket: TicketSnapshot,
  actor: ConfigActor,
  catalog: FieldCatalog,
  options: { now?: string | number; previous?: Record<string, unknown> | null } = {},
): ConditionContext {
  const data = ticketData(ticket);

  const base: Record<string, unknown> = { ...ticket, data };
  // Flatten `data.<key>` so a leaf can be written either way.
  for (const [key, value] of Object.entries(data)) base[`data.${key}`] = value;

  base.actor = {
    id: actor.userId,
    type: actor.actorType,
    role: actor.role,
    is_admin: actor.isAdmin,
    group_ids: actor.groupIds,
  };

  return {
    fields: buildConditionFields(base, catalog.declaredPaths),
    declaredFields: catalog.declaredPaths,
    previous: options.previous ?? null,
    now: options.now ?? Date.now(),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Visibility / editability
// ═════════════════════════════════════════════════════════════════════════════

export interface FieldAccess {
  definition: FieldDefinition;
  visible: boolean;
  editable: boolean;
  /** Why not, ready for the tooltip and the 403 body. */
  reason: string | null;
  trace: ConditionTrace | null;
}

function appliesToRecordType(definition: FieldDefinition, recordType: string | undefined): boolean {
  if (definition.appliesToRecordTypes.length === 0) return true;
  if (!recordType) return true;
  return definition.appliesToRecordTypes.includes(recordType);
}

function audienceAllows(definition: FieldDefinition, actor: ConfigActor): boolean {
  if (definition.visibleTo === 'both') return true;
  const isPortal = actor.actorType === 'portal';
  return definition.visibleTo === 'portal' ? isPortal : !isPortal;
}

/**
 * Decide visibility and editability for ONE field. This is the function both
 * halves of the product call: the API that renders the form, and the API that
 * saves it.
 */
export function evaluateFieldAccess(
  definition: FieldDefinition,
  actor: ConfigActor,
  ticket: TicketSnapshot,
  ctx: ConditionContext,
): FieldAccess {
  if (!appliesToRecordType(definition, typeof ticket.record_type === 'string' ? ticket.record_type : undefined)) {
    return {
      definition,
      visible: false,
      editable: false,
      reason: `"${definition.label}" does not apply to ${String(ticket.record_type)} records.`,
      trace: null,
    };
  }

  if (!audienceAllows(definition, actor)) {
    return {
      definition,
      visible: false,
      editable: false,
      reason: `"${definition.label}" is not shown to this audience.`,
      trace: null,
    };
  }

  // PII is never handed to a portal contact, whatever the audience says.
  if (definition.piiSensitive && actor.actorType === 'portal') {
    return {
      definition,
      visible: false,
      editable: false,
      reason: `"${definition.label}" holds personal data and is not exposed on the portal.`,
      trace: null,
    };
  }

  let trace: ConditionTrace | null = null;
  if (definition.visibleWhen !== null) {
    const evaluation = evaluateCondition(definition.visibleWhen, ctx);
    trace = evaluation.trace;
    if (!evaluation.matched) {
      return {
        definition,
        visible: false,
        editable: false,
        reason: `"${definition.label}" is hidden on this ticket by its visibility condition.`,
        trace,
      };
    }
  }

  if (definition.readOnly) {
    return { definition, visible: true, editable: false, reason: `"${definition.label}" is read-only.`, trace };
  }

  if (definition.editableWhen !== null) {
    const evaluation = evaluateCondition(definition.editableWhen, ctx);
    if (!evaluation.matched) {
      return {
        definition,
        visible: true,
        editable: false,
        reason: `"${definition.label}" is not editable on this ticket right now.`,
        trace: evaluation.trace,
      };
    }
  }

  return { definition, visible: true, editable: true, reason: null, trace };
}

/** Every field the actor may SEE on this ticket, in render order. */
export async function visibleFields(
  tenantId: number,
  actor: ConfigActor,
  ticket: TicketSnapshot,
  now?: string | number,
): Promise<FieldAccess[]> {
  const catalog = await loadFieldCatalog(tenantId);
  const ctx = buildFieldContext(ticket, actor, catalog, { now });
  return catalog.all
    .map((definition) => evaluateFieldAccess(definition, actor, ticket, ctx))
    .filter((access) => access.visible);
}

// ═════════════════════════════════════════════════════════════════════════════
// The save path
// ═════════════════════════════════════════════════════════════════════════════

/** A rejected write, with the per-field messages a form can render inline. */
export class FieldAccessError extends ConfigServiceError {
  constructor(readonly fieldErrors: Record<string, string>) {
    super(403, 'One or more fields cannot be written by this actor on this ticket.', 'forbidden');
    this.name = 'FieldAccessError';
  }
}

export class FieldValueError extends ConfigServiceError {
  constructor(readonly fieldErrors: Record<string, string>) {
    super(400, 'One or more field values are not valid for their field type.', 'validation_failed');
    this.name = 'FieldValueError';
  }
}

export interface SanitizedPatch {
  /** The values that may be written, keyed by `tickets.data` key. */
  data: Record<string, unknown>;
  /** Keys the caller sent that no field object declares (dropped). */
  unknownKeys: string[];
  /** Per-key provenance for `tickets.set_by`. */
  setBy: Record<string, { actor_type: string; actor: string | null; at: string }>;
}

/**
 * THE gate.
 *
 * Takes the `data` patch a caller sent, re-evaluates visibility and
 * editability against the ticket AS IT IS NOW, and returns only what may
 * legitimately be written — throwing if the caller asked to write something
 * they cannot see.
 *
 * Note the order: visibility is evaluated against the ticket's CURRENT values,
 * not against the values the patch would produce. Evaluating against the
 * post-patch state would let a single request unlock a field and write it in
 * the same breath, which is precisely the escalation the check exists to stop.
 *
 * Note also what is NOT here: required-ness. HARD RULE 12. An inline edit that
 * refused to save because a different field is empty is the behaviour this
 * product is deliberately built without.
 */
export async function sanitizeDataPatch(
  tenantId: number,
  actor: ConfigActor,
  ticket: TicketSnapshot,
  patch: Record<string, unknown>,
  options: { now?: string | number; dropUnknown?: boolean } = {},
): Promise<SanitizedPatch> {
  const catalog = await loadFieldCatalog(tenantId);
  const ctx = buildFieldContext(ticket, actor, catalog, { now: options.now });

  const accepted: Record<string, unknown> = {};
  const unknownKeys: string[] = [];
  const accessErrors: Record<string, string> = {};
  const valueErrors: Record<string, string> = {};
  const setBy: SanitizedPatch['setBy'] = {};
  const at = new Date().toISOString();
  const actorRef = actor.userId !== null ? `user:${actor.userId}` : actor.actorType;

  for (const [rawKey, value] of Object.entries(patch ?? {})) {
    const key = rawKey.startsWith('data.') ? rawKey.slice('data.'.length) : rawKey;
    const definition = catalog.byKey.get(key) ?? catalog.bySlug.get(key.toLowerCase());

    if (!definition) {
      unknownKeys.push(key);
      if (options.dropUnknown === false) {
        accessErrors[key] = `No field object declares "${key}".`;
      }
      continue;
    }

    const access = evaluateFieldAccess(definition, actor, ticket, ctx);
    if (!access.visible) {
      // Deliberately the same message shape as "not editable": telling a
      // caller which hidden fields exist is itself a disclosure.
      accessErrors[definition.key] = access.reason
        ?? `"${definition.label}" cannot be written on this ticket.`;
      continue;
    }
    if (!access.editable) {
      accessErrors[definition.key] = access.reason
        ?? `"${definition.label}" is not editable on this ticket.`;
      continue;
    }

    const coerced = coerceFieldValue(definition, value);
    if (!coerced.ok) {
      valueErrors[definition.key] = coerced.error;
      continue;
    }

    accepted[definition.key] = coerced.value;
    setBy[definition.key] = { actor_type: actor.actorType, actor: actorRef, at };
  }

  if (Object.keys(accessErrors).length > 0) throw new FieldAccessError(accessErrors);
  if (Object.keys(valueErrors).length > 0) throw new FieldValueError(valueErrors);

  return { data: accepted, unknownKeys, setBy };
}

// ═════════════════════════════════════════════════════════════════════════════
// Coercion
// ═════════════════════════════════════════════════════════════════════════════

export type CoercionResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Turn whatever arrived over the wire into the value that belongs in the jsonb.
 *
 * This is TYPE validation, not required-ness: `null` and `''` are always
 * accepted and normalise to `null`, because clearing a field is an ordinary
 * edit and the only place emptiness can block anything is a transition.
 */
export function coerceFieldValue(definition: FieldDefinition, raw: unknown): CoercionResult {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null };

  switch (definition.type) {
    case 'number':
    case 'currency':
    case 'duration': {
      const parsed = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(parsed)) return { ok: false, error: `"${definition.label}" must be a number.` };
      if (definition.min !== null && parsed < definition.min) {
        return { ok: false, error: `"${definition.label}" must be at least ${definition.min}.` };
      }
      if (definition.max !== null && parsed > definition.max) {
        return { ok: false, error: `"${definition.label}" must be at most ${definition.max}.` };
      }
      return { ok: true, value: parsed };
    }

    case 'boolean': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      const text = String(raw).toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(text)) return { ok: true, value: true };
      if (['false', '0', 'no', 'off'].includes(text)) return { ok: true, value: false };
      return { ok: false, error: `"${definition.label}" must be true or false.` };
    }

    case 'select': {
      const value = String(raw);
      if (definition.options.length > 0 && !definition.options.some((option) => option.value === value)) {
        return { ok: false, error: `"${value}" is not one of the options for "${definition.label}".` };
      }
      return { ok: true, value };
    }

    case 'multiselect': {
      const list = Array.isArray(raw) ? raw : [raw];
      const values = list.map((entry) => String(entry));
      if (definition.options.length > 0) {
        const allowed = new Set(definition.options.map((option) => option.value));
        const bad = values.filter((value) => !allowed.has(value));
        if (bad.length > 0) {
          return { ok: false, error: `Not options for "${definition.label}": ${bad.join(', ')}.` };
        }
      }
      return { ok: true, value: values };
    }

    case 'date':
    case 'datetime': {
      const ms = Date.parse(String(raw));
      if (Number.isNaN(ms)) return { ok: false, error: `"${definition.label}" must be a date.` };
      const iso = new Date(ms).toISOString();
      return { ok: true, value: definition.type === 'date' ? iso.slice(0, 10) : iso };
    }

    case 'email': {
      const value = String(raw).trim();
      if (!EMAIL_PATTERN.test(value)) {
        return { ok: false, error: `"${definition.label}" must be an email address.` };
      }
      return { ok: true, value };
    }

    case 'url': {
      const value = String(raw).trim();
      try {
        const parsed = new URL(value);
        // Never store a javascript: or data: URL — it would be rendered as a
        // link and clicked by the next agent who opens the ticket.
        if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
          return { ok: false, error: `"${definition.label}" must be an http(s) or mailto URL.` };
        }
      } catch {
        return { ok: false, error: `"${definition.label}" must be a URL.` };
      }
      return { ok: true, value };
    }

    case 'user':
    case 'group':
    case 'contact':
    case 'organization':
    case 'ci':
    case 'ticket': {
      const parsed = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return { ok: false, error: `"${definition.label}" must reference an existing record.` };
      }
      return { ok: true, value: parsed };
    }

    case 'attachment': {
      const list = Array.isArray(raw) ? raw : [raw];
      const ids = list.map((entry) => Number(entry));
      if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
        return { ok: false, error: `"${definition.label}" must be a list of attachment ids.` };
      }
      return { ok: true, value: ids };
    }

    case 'json': {
      if (typeof raw === 'object') return { ok: true, value: raw };
      try {
        return { ok: true, value: JSON.parse(String(raw)) };
      } catch {
        return { ok: false, error: `"${definition.label}" must be valid JSON.` };
      }
    }

    default: {
      const value = String(raw);
      if (definition.maxLength !== null && value.length > definition.maxLength) {
        return {
          ok: false,
          error: `"${definition.label}" is limited to ${definition.maxLength} characters.`,
        };
      }
      if (definition.pattern) {
        try {
          if (!new RegExp(definition.pattern).test(value)) {
            return { ok: false, error: `"${definition.label}" does not match its expected format.` };
          }
        } catch {
          // A bad pattern in configuration must never reject a user's value —
          // the linter's job is to complain about it, not this one's.
        }
      }
      return { ok: true, value };
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Required-ness — the transition path, and ONLY the transition path
// ═════════════════════════════════════════════════════════════════════════════

export interface MissingField {
  slug: string;
  key: string;
  label: string;
  /** Why it is required: 'transition' or the field's own requiredWhen. */
  because: 'transition' | 'condition';
}

/**
 * Evaluate required-ness for a state transition.
 *
 * `requiredPaths` comes from the transition's `requiredFields` and may name a
 * ticket COLUMN (`assignee_id`), a custom field path (`data.vendor_ref`), or a
 * bare field slug — all three appear in the shipped baseline, so all three are
 * handled here rather than at four call sites.
 *
 * The client runs this same logic on the same trees to grey the button out and
 * name what is missing; the server runs it to refuse the move. One evaluator,
 * two callers — which is what stops the button and the API disagreeing.
 */
export async function missingRequiredFields(
  tenantId: number,
  actor: ConfigActor,
  ticket: TicketSnapshot,
  requiredPaths: readonly string[],
  options: { now?: string | number; catalog?: FieldCatalog } = {},
): Promise<MissingField[]> {
  const catalog = options.catalog ?? await loadFieldCatalog(tenantId);
  const ctx = buildFieldContext(ticket, actor, catalog, { now: options.now });
  const data = ticketData(ticket);

  const missing: MissingField[] = [];
  const seen = new Set<string>();

  const isEmpty = (value: unknown): boolean =>
    value === null || value === undefined || value === ''
    || (Array.isArray(value) && value.length === 0);

  // 1 — the transition's own list.
  for (const rawPath of requiredPaths) {
    const path = normalizeFieldPath(rawPath);
    const isDataPath = path.startsWith('data.');
    const key = isDataPath ? path.slice('data.'.length) : path;

    const definition = catalog.byKey.get(key) ?? catalog.bySlug.get(key.toLowerCase());

    const value = definition
      ? data[definition.key]
      : (ticket as Record<string, unknown>)[key];

    if (!isEmpty(value)) continue;
    if (seen.has(key)) continue;
    seen.add(key);

    missing.push({
      slug: definition?.slug ?? key,
      key: definition?.key ?? key,
      label: definition?.label ?? humanizeColumn(key),
      because: 'transition',
    });
  }

  // 2 — fields whose own `requiredWhen` matches right now. Note this is
  // evaluated HERE, at the transition, and nowhere else in this file.
  for (const definition of catalog.all) {
    if (definition.requiredWhen === null) continue;
    if (seen.has(definition.key)) continue;
    if (!appliesToRecordType(definition, typeof ticket.record_type === 'string' ? ticket.record_type : undefined)) continue;

    const access = evaluateFieldAccess(definition, actor, ticket, ctx);
    // A field the actor cannot even see must never block them. Requiring an
    // invisible field is an unwinnable dialog.
    if (!access.visible) continue;

    if (!evaluateCondition(definition.requiredWhen, ctx).matched) continue;
    if (!isEmpty(data[definition.key])) continue;

    seen.add(definition.key);
    missing.push({
      slug: definition.slug,
      key: definition.key,
      label: definition.label,
      because: 'condition',
    });
  }

  return missing;
}

function humanizeColumn(column: string): string {
  return column
    .replace(/_id$/, '')
    .split(/[_.]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** Fields that apply to a record type — what the form builder offers. */
export async function fieldsForRecordType(
  tenantId: number,
  recordType: TicketRecordType | string,
): Promise<FieldDefinition[]> {
  const catalog = await loadFieldCatalog(tenantId);
  return catalog.all.filter((definition) => appliesToRecordType(definition, recordType));
}
