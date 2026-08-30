// ─────────────────────────────────────────────────────────────────────────────
// Feature capabilities.
//
// These are the keys Oblidesk registers with Obligate
// (`obligateService.syncCapabilitySchemas()` POSTs `CAPABILITY_SCHEMAS` to
// `/api/apps/sync-capability-schemas`) and that flow back into
// `user_tenants.capabilities` / `permission_sets.capabilities` /
// `teams.capabilities` on SSO login.
//
// They gate WHAT a tenant member may do. Simply being a member of a tenant
// grants nothing beyond what `ticket_read` / `kb_read` allow; every mutation is
// behind an explicit capability. Users with role `admin` implicitly hold all of
// them (see `hasCapability`).
//
// Any new entry MUST also be added to:
//   - server/src/validators/*.schema.ts (the zod enum on permission-set writes)
//   - server/src/services/permission.service.ts (the VALID_CAPABILITIES set)
//   - client/src/i18n/{en,fr}.json (capability.<key>)
// otherwise it is silently dropped on the GET → toggle → PUT round trip.
// ─────────────────────────────────────────────────────────────────────────────

export const CAPABILITIES = {
  /** See tickets in the tenant (subject to queue / group visibility). */
  TICKET_READ: 'ticket_read',
  /** Create tickets, reply, add work notes, change status, edit fields. */
  TICKET_RW: 'ticket_rw',
  /** Assign or reassign a ticket to another agent or group. */
  TICKET_ASSIGN: 'ticket_assign',
  /** Soft-delete / purge a ticket and merge tickets together. */
  TICKET_DELETE: 'ticket_delete',
  /** Create and configure queues, assignment groups and routing. */
  QUEUE_ADMIN: 'queue_admin',
  /**
   * Own problem records: promote an incident, link and unlink incidents,
   * conclude an RCA, publish a known error internally, and run the closure
   * cascade.
   *
   * WHY THIS IS A SEPARATE KEY AND `ticket_rw` DOES NOT COVER IT: `ticket_rw`
   * is held by every agent on the desk, and the sharpest edge in this module
   * resolves other people's tickets in bulk from one click. Gating a cascade
   * that touches 200 incidents behind the same key as "add a work note" is not
   * a permission model. The desk already draws exactly this line for the
   * knowledge base (`kb_rw` writes, `kb_publish` publishes); publishing a
   * workaround the whole desk will apply at 09:00 is the same act.
   *
   * WHY THERE IS NO MATCHING `problem_read`: a known error the desk cannot
   * read is a known error that does not exist. Reading problems and known
   * errors rides on `ticket_read`, so an existing agent permission set keeps
   * the intake banner on the day this ships instead of silently losing it.
   *
   * Editing the `problem_detection` config object is NOT here either — a
   * detector definition is automation, and it stays under `automation_admin`
   * with the rules, macros and escalation ladders.
   */
  PROBLEM_RW: 'problem_rw',
  /** Read published knowledge-base articles. */
  KB_READ: 'kb_read',
  /** Draft and edit knowledge-base articles. */
  KB_RW: 'kb_rw',
  /** Publish or retire a knowledge-base article. */
  KB_PUBLISH: 'kb_publish',
  /** Manage the service catalog and its request forms. */
  CATALOG_ADMIN: 'catalog_admin',
  /** Manage SLA policies, targets and business calendars. */
  SLA_ADMIN: 'sla_admin',
  /** Manage rules, macros, escalations and approval definitions. */
  AUTOMATION_ADMIN: 'automation_admin',
  /** Manage fields, forms, views, state machines and the priority matrix. */
  CONFIG_ADMIN: 'config_admin',
  /** View dashboards and reports. */
  REPORT_VIEW: 'report_view',
  /** Build and share dashboards, edit widgets, export raw data. */
  REPORT_ADMIN: 'report_admin',
  /** See time entries logged against tickets. */
  TIME_READ: 'time_read',
  /** Log and edit own time entries. */
  TIME_RW: 'time_rw',
  /** Approve time entries and edit other agents' time. */
  TIME_APPROVE: 'time_approve',
  /** Manage contracts, rate cards and consumption. */
  CONTRACT_ADMIN: 'contract_admin',
  /** Browse configuration items and their state. */
  CI_READ: 'ci_read',
  /** Edit desk-owned CI overlays and CI ↔ ticket links. */
  CI_RW: 'ci_rw',
  /** Manage suite alert bindings, suppressions and de-duplication. */
  ALERT_ADMIN: 'alert_admin',
  /** Manage portal contacts, organizations and portal branding. */
  PORTAL_ADMIN: 'portal_admin',
  /** Use AI assists (summarise, draft reply, suggest KB). */
  AI_USE: 'ai_use',
  /** Configure AI providers, models, budgets and per-feature toggles. */
  AI_ADMIN: 'ai_admin',
} as const;

export type Capability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

/** UI grouping for the permission-set editor. */
export type CapabilityGroup =
  | 'tickets'
  | 'knowledge'
  | 'configuration'
  | 'reporting'
  | 'time'
  | 'assets'
  | 'ai';

export interface CapabilityCatalogEntry {
  readonly key: Capability;
  /** Inline English fallback — always paired with `labelKey` in `t()`. */
  readonly label: string;
  readonly labelKey: string;
  readonly description: string;
  readonly group: CapabilityGroup;
  /** Order sent to Obligate and used in the permission-set editor. */
  readonly sortOrder: number;
  /** Capabilities this one implies (transitively expanded at check time). */
  readonly implies: readonly Capability[];
  /** Dangerous enough that the editor shows a confirm before granting it. */
  readonly sensitive: boolean;
}

export const CAPABILITY_CATALOG: readonly CapabilityCatalogEntry[] = [
  // ── Tickets ───────────────────────────────────────────────────────────────
  {
    key: CAPABILITIES.TICKET_READ,
    label: 'Read tickets',
    labelKey: 'capability.ticketRead',
    description: 'See tickets in this tenant, subject to queue and group visibility.',
    group: 'tickets',
    sortOrder: 0,
    implies: [],
    sensitive: false,
  },
  {
    key: CAPABILITIES.TICKET_RW,
    label: 'Work tickets',
    labelKey: 'capability.ticketRw',
    description: 'Create tickets, reply publicly, add work notes, change status and edit fields.',
    group: 'tickets',
    sortOrder: 1,
    implies: [CAPABILITIES.TICKET_READ],
    sensitive: false,
  },
  {
    key: CAPABILITIES.TICKET_ASSIGN,
    label: 'Assign tickets',
    labelKey: 'capability.ticketAssign',
    description: 'Assign or reassign a ticket to another agent or assignment group.',
    group: 'tickets',
    sortOrder: 2,
    implies: [CAPABILITIES.TICKET_READ],
    sensitive: false,
  },
  {
    key: CAPABILITIES.TICKET_DELETE,
    label: 'Delete & merge tickets',
    labelKey: 'capability.ticketDelete',
    description: 'Soft-delete or purge a ticket and merge tickets into one another.',
    group: 'tickets',
    sortOrder: 3,
    implies: [CAPABILITIES.TICKET_RW],
    sensitive: true,
  },
  {
    key: CAPABILITIES.QUEUE_ADMIN,
    label: 'Manage queues',
    labelKey: 'capability.queueAdmin',
    description: 'Create and configure queues, assignment groups and routing rules.',
    group: 'tickets',
    sortOrder: 4,
    implies: [CAPABILITIES.TICKET_READ],
    sensitive: false,
  },
  {
    key: CAPABILITIES.PROBLEM_RW,
    label: 'Manage problems',
    labelKey: 'capability.problemRw',
    description:
      'Promote an incident to a problem, run the root-cause analysis, publish a known error and resolve linked incidents when the problem is fixed.',
    group: 'tickets',
    sortOrder: 5,
    implies: [CAPABILITIES.TICKET_RW],
    // Sensitive because the closure cascade resolves other people's tickets in
    // bulk, and because a published known error is read by the whole desk.
    sensitive: true,
  },

  // ── Knowledge ─────────────────────────────────────────────────────────────
  {
    key: CAPABILITIES.KB_READ,
    label: 'Read knowledge base',
    labelKey: 'capability.kbRead',
    description: 'Read published knowledge-base articles.',
    group: 'knowledge',
    sortOrder: 10,
    implies: [],
    sensitive: false,
  },
  {
    key: CAPABILITIES.KB_RW,
    label: 'Write knowledge base',
    labelKey: 'capability.kbRw',
    description: 'Draft and edit knowledge-base articles.',
    group: 'knowledge',
    sortOrder: 11,
    implies: [CAPABILITIES.KB_READ],
    sensitive: false,
  },
  {
    key: CAPABILITIES.KB_PUBLISH,
    label: 'Publish knowledge base',
    labelKey: 'capability.kbPublish',
    description: 'Publish or retire an article, making it visible to the portal.',
    group: 'knowledge',
    sortOrder: 12,
    implies: [CAPABILITIES.KB_RW],
    sensitive: false,
  },
  {
    key: CAPABILITIES.CATALOG_ADMIN,
    label: 'Manage service catalog',
    labelKey: 'capability.catalogAdmin',
    description: 'Manage catalog items, their request forms and fulfilment routing.',
    group: 'knowledge',
    sortOrder: 13,
    implies: [CAPABILITIES.KB_READ],
    sensitive: false,
  },

  // ── Configuration ─────────────────────────────────────────────────────────
  {
    key: CAPABILITIES.SLA_ADMIN,
    label: 'Manage SLAs',
    labelKey: 'capability.slaAdmin',
    description: 'Manage SLA policies, targets, pause rules and business calendars.',
    group: 'configuration',
    sortOrder: 20,
    implies: [CAPABILITIES.TICKET_READ],
    sensitive: false,
  },
  {
    key: CAPABILITIES.AUTOMATION_ADMIN,
    label: 'Manage automation',
    labelKey: 'capability.automationAdmin',
    description: 'Manage rules, macros, escalations and approval definitions.',
    group: 'configuration',
    sortOrder: 21,
    implies: [CAPABILITIES.TICKET_READ],
    sensitive: true,
  },
  {
    key: CAPABILITIES.CONFIG_ADMIN,
    label: 'Manage configuration',
    labelKey: 'capability.configAdmin',
    description:
      'Manage fields, forms, views, state machines and the priority matrix — everything under Configuration.',
    group: 'configuration',
    sortOrder: 22,
    implies: [
      CAPABILITIES.TICKET_READ,
      CAPABILITIES.QUEUE_ADMIN,
      CAPABILITIES.SLA_ADMIN,
      CAPABILITIES.AUTOMATION_ADMIN,
      CAPABILITIES.CATALOG_ADMIN,
      CAPABILITIES.ALERT_ADMIN,
      CAPABILITIES.PORTAL_ADMIN,
    ],
    sensitive: true,
  },
  {
    key: CAPABILITIES.ALERT_ADMIN,
    label: 'Manage alert bindings',
    labelKey: 'capability.alertAdmin',
    description: 'Manage suite alert bindings, de-duplication keys and suppressions.',
    group: 'configuration',
    sortOrder: 23,
    implies: [CAPABILITIES.TICKET_READ],
    sensitive: false,
  },
  {
    key: CAPABILITIES.PORTAL_ADMIN,
    label: 'Manage portal',
    labelKey: 'capability.portalAdmin',
    description: 'Manage portal contacts, organizations, branding and self-service access.',
    group: 'configuration',
    sortOrder: 24,
    implies: [CAPABILITIES.TICKET_READ],
    sensitive: false,
  },

  // ── Reporting ─────────────────────────────────────────────────────────────
  {
    key: CAPABILITIES.REPORT_VIEW,
    label: 'View reports',
    labelKey: 'capability.reportView',
    description: 'View dashboards and reports for this tenant.',
    group: 'reporting',
    sortOrder: 30,
    implies: [],
    sensitive: false,
  },
  {
    key: CAPABILITIES.REPORT_ADMIN,
    label: 'Build reports',
    labelKey: 'capability.reportAdmin',
    description: 'Build and share dashboards, edit widgets and export raw data.',
    group: 'reporting',
    sortOrder: 31,
    implies: [CAPABILITIES.REPORT_VIEW],
    sensitive: false,
  },

  // ── Time & billing ────────────────────────────────────────────────────────
  {
    key: CAPABILITIES.TIME_READ,
    label: 'Read time entries',
    labelKey: 'capability.timeRead',
    description: 'See time logged against tickets.',
    group: 'time',
    sortOrder: 40,
    implies: [],
    sensitive: false,
  },
  {
    key: CAPABILITIES.TIME_RW,
    label: 'Log time',
    labelKey: 'capability.timeRw',
    description: 'Log and edit your own time entries.',
    group: 'time',
    sortOrder: 41,
    implies: [CAPABILITIES.TIME_READ],
    sensitive: false,
  },
  {
    key: CAPABILITIES.TIME_APPROVE,
    label: 'Approve time',
    labelKey: 'capability.timeApprove',
    description: "Approve time entries and edit other agents' time.",
    group: 'time',
    sortOrder: 42,
    implies: [CAPABILITIES.TIME_RW],
    sensitive: true,
  },
  {
    key: CAPABILITIES.CONTRACT_ADMIN,
    label: 'Manage contracts',
    labelKey: 'capability.contractAdmin',
    description: 'Manage contracts, rate cards and block-hour consumption.',
    group: 'time',
    sortOrder: 43,
    implies: [CAPABILITIES.TIME_READ],
    sensitive: true,
  },

  // ── Assets / CMDB ─────────────────────────────────────────────────────────
  {
    key: CAPABILITIES.CI_READ,
    label: 'Read configuration items',
    labelKey: 'capability.ciRead',
    description: 'Browse configuration items and their live state from the other Obli apps.',
    group: 'assets',
    sortOrder: 50,
    implies: [],
    sensitive: false,
  },
  {
    key: CAPABILITIES.CI_RW,
    label: 'Edit configuration items',
    labelKey: 'capability.ciRw',
    description: 'Edit desk-owned CI attributes and link CIs to tickets.',
    group: 'assets',
    sortOrder: 51,
    implies: [CAPABILITIES.CI_READ],
    sensitive: false,
  },

  // ── AI ────────────────────────────────────────────────────────────────────
  {
    key: CAPABILITIES.AI_USE,
    label: 'Use AI assists',
    labelKey: 'capability.aiUse',
    description: 'Summarise a thread, draft a reply, suggest a KB article, triage a ticket.',
    group: 'ai',
    sortOrder: 60,
    implies: [],
    sensitive: false,
  },
  {
    key: CAPABILITIES.AI_ADMIN,
    label: 'Manage AI',
    labelKey: 'capability.aiAdmin',
    description: 'Configure AI providers, models, per-feature toggles and spend budgets.',
    group: 'ai',
    sortOrder: 61,
    implies: [CAPABILITIES.AI_USE],
    sensitive: true,
  },
];

/** Every capability key, in catalog order. */
export const ALL_CAPABILITIES: readonly Capability[] = CAPABILITY_CATALOG.map((entry) => entry.key);

/**
 * The exact payload synced to Obligate. Derived from the catalog so the two can
 * never drift; Obligate only reads `{ key, label, sortOrder }`.
 */
export interface CapabilitySchema {
  key: Capability;
  label: string;
  sortOrder: number;
}

export const CAPABILITY_SCHEMAS: readonly CapabilitySchema[] = CAPABILITY_CATALOG.map((entry) => ({
  key: entry.key,
  label: entry.label,
  sortOrder: entry.sortOrder,
}));

const CATALOG_BY_KEY: Readonly<Record<Capability, CapabilityCatalogEntry>> = CAPABILITY_CATALOG.reduce(
  (acc, entry) => {
    acc[entry.key] = entry;
    return acc;
  },
  {} as Record<Capability, CapabilityCatalogEntry>,
);

export const CAPABILITY_GROUPS: readonly CapabilityGroup[] = [
  'tickets',
  'knowledge',
  'configuration',
  'reporting',
  'time',
  'assets',
  'ai',
];

export const CAPABILITY_GROUP_LABELS: Readonly<Record<CapabilityGroup, { key: string; fallback: string }>> = {
  tickets: { key: 'capability.group.tickets', fallback: 'Tickets' },
  knowledge: { key: 'capability.group.knowledge', fallback: 'Knowledge & catalog' },
  configuration: { key: 'capability.group.configuration', fallback: 'Configuration' },
  reporting: { key: 'capability.group.reporting', fallback: 'Reporting' },
  time: { key: 'capability.group.time', fallback: 'Time & billing' },
  assets: { key: 'capability.group.assets', fallback: 'Assets' },
  ai: { key: 'capability.group.ai', fallback: 'AI' },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Total type guard — safe on untrusted JSON. */
export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CATALOG_BY_KEY, value);
}

/** Drop anything that is not a known capability. Never throws. */
export function sanitizeCapabilities(values: unknown): Capability[] {
  if (!Array.isArray(values)) return [];
  const out = new Set<Capability>();
  for (const value of values) if (isCapability(value)) out.add(value);
  return [...out];
}

export function getCapabilityMeta(capability: Capability): CapabilityCatalogEntry {
  return CATALOG_BY_KEY[capability];
}

/** i18n key + inline English fallback, ready for `t(key, fallback)`. */
export function capabilityLabel(capability: Capability): { key: string; fallback: string } {
  const entry = CATALOG_BY_KEY[capability];
  return entry ? { key: entry.labelKey, fallback: entry.label } : { key: `capability.${capability}`, fallback: capability };
}

/**
 * Transitive closure of the `implies` graph. `config_admin` alone therefore
 * unlocks queue/sla/automation/catalog/alert/portal admin plus ticket_read.
 */
export function expandCapabilities(held: readonly Capability[]): Capability[] {
  const out = new Set<Capability>();
  const stack = [...held];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || out.has(current)) continue;
    out.add(current);
    const entry = CATALOG_BY_KEY[current];
    if (entry) for (const implied of entry.implies) if (!out.has(implied)) stack.push(implied);
  }
  return ALL_CAPABILITIES.filter((capability) => out.has(capability));
}

/**
 * The single capability check used on both sides. Admins hold everything.
 *
 * SECURITY: the client uses this to hide affordances; the server uses the SAME
 * function to reject the request. Never gate a mutation on the client call
 * alone.
 */
export function hasCapability(
  held: readonly Capability[] | null | undefined,
  needed: Capability,
  isAdmin = false,
): boolean {
  if (isAdmin) return true;
  if (!held || held.length === 0) return false;
  if (held.includes(needed)) return true;
  return expandCapabilities(held).includes(needed);
}

/** True when the holder has at least one of `needed`. */
export function hasAnyCapability(
  held: readonly Capability[] | null | undefined,
  needed: readonly Capability[],
  isAdmin = false,
): boolean {
  if (isAdmin) return true;
  if (needed.length === 0) return true;
  const expanded = expandCapabilities(held ?? []);
  return needed.some((capability) => expanded.includes(capability));
}

/** True when the holder has every one of `needed`. */
export function hasAllCapabilities(
  held: readonly Capability[] | null | undefined,
  needed: readonly Capability[],
  isAdmin = false,
): boolean {
  if (isAdmin) return true;
  if (needed.length === 0) return true;
  const expanded = expandCapabilities(held ?? []);
  return needed.every((capability) => expanded.includes(capability));
}

/**
 * Day-one presets offered in the permission-set editor. They are seeded as
 * `permission_sets` rows with `is_system = true`; a tenant can clone and edit.
 */
export const CAPABILITY_PRESETS: readonly {
  slug: string;
  name: string;
  nameKey: string;
  description: string;
  capabilities: readonly Capability[];
}[] = [
  {
    slug: 'agent',
    name: 'Agent',
    nameKey: 'permissionSet.agent',
    description: 'Works tickets, logs time, reads the knowledge base.',
    capabilities: [
      CAPABILITIES.TICKET_RW,
      CAPABILITIES.TICKET_ASSIGN,
      CAPABILITIES.KB_READ,
      CAPABILITIES.TIME_RW,
      CAPABILITIES.CI_READ,
      CAPABILITIES.REPORT_VIEW,
      CAPABILITIES.AI_USE,
    ],
  },
  {
    slug: 'senior_agent',
    name: 'Senior agent',
    nameKey: 'permissionSet.seniorAgent',
    description: 'Everything an agent does, plus merging, problem ownership, KB authoring and CI edits.',
    capabilities: [
      CAPABILITIES.TICKET_RW,
      CAPABILITIES.TICKET_ASSIGN,
      CAPABILITIES.TICKET_DELETE,
      CAPABILITIES.PROBLEM_RW,
      CAPABILITIES.KB_RW,
      CAPABILITIES.TIME_RW,
      CAPABILITIES.CI_RW,
      CAPABILITIES.REPORT_VIEW,
      CAPABILITIES.AI_USE,
    ],
  },
  {
    slug: 'service_manager',
    name: 'Service manager',
    nameKey: 'permissionSet.serviceManager',
    description: 'Owns queues, SLAs, automation, reporting and time approval.',
    capabilities: [
      CAPABILITIES.TICKET_RW,
      CAPABILITIES.TICKET_ASSIGN,
      CAPABILITIES.TICKET_DELETE,
      CAPABILITIES.PROBLEM_RW,
      CAPABILITIES.QUEUE_ADMIN,
      CAPABILITIES.SLA_ADMIN,
      CAPABILITIES.AUTOMATION_ADMIN,
      CAPABILITIES.KB_PUBLISH,
      CAPABILITIES.CATALOG_ADMIN,
      CAPABILITIES.REPORT_ADMIN,
      CAPABILITIES.TIME_APPROVE,
      CAPABILITIES.CONTRACT_ADMIN,
      CAPABILITIES.CI_RW,
      CAPABILITIES.ALERT_ADMIN,
      CAPABILITIES.PORTAL_ADMIN,
      CAPABILITIES.AI_USE,
    ],
  },
  {
    slug: 'read_only',
    name: 'Read only',
    nameKey: 'permissionSet.readOnly',
    description: 'Sees tickets, the knowledge base, CIs and reports. Changes nothing.',
    capabilities: [
      CAPABILITIES.TICKET_READ,
      CAPABILITIES.KB_READ,
      CAPABILITIES.CI_READ,
      CAPABILITIES.TIME_READ,
      CAPABILITIES.REPORT_VIEW,
    ],
  },
];
