// ─────────────────────────────────────────────────────────────────────────────
// Oblidesk shared DTOs.
//
// Conventions (identical across the Obli suite):
//   • DTOs are camelCase; the DB is snake_case. Services translate at the edge.
//   • Every instant is an ISO-8601 UTC string. Never a Date, never epoch ms.
//   • Every enum is a string-literal union exported as a NAMED type.
//   • `tenantId` appears on every tenant-scoped DTO (HARD RULE 1) — it is the
//     shape the tenant-scoped query helper guarantees.
//   • Cross-references in CONFIGURATION are slugs (HARD RULE 3); references
//     between DATA rows are numeric foreign keys, which is fine because they
//     never leave the database.
// ─────────────────────────────────────────────────────────────────────────────

import type { Capability } from './capabilities';
import type { BusinessCalendar, CalendarShift, CalendarHoliday, CalendarExceptionDay } from './calendar';
import type { ConditionNode, ConditionTrace, ConditionIssue } from './conditions';
import type {
  ConfigKind,
  ConfigBodyFor,
  AnyConfigBody,
  ImpactLevel,
  UrgencyLevel,
  PrioritySpec,
  StatusSpec,
  QueueBody,
  WidgetType,
  ApprovalMode,
} from './configKinds';
import type { StatusCategory } from './statusCategories';
import type { AppTheme } from './themes';

// ═════════════════════════════════════════════════════════════════════════════
// API envelope
// ═════════════════════════════════════════════════════════════════════════════

export interface ApiSuccess<T> {
  success: true;
  data: T;
}

export interface ApiFailure {
  success: false;
  error: string;
  /** Machine-readable code for the client to branch on (409s, guards, …). */
  code?: ApiErrorCode;
  /** Field-level problems for a form, keyed by field slug. */
  fieldErrors?: Record<string, string>;
}

export type ApiResponse<T = unknown> = ApiSuccess<T> | ApiFailure;

export interface PaginatedSuccess<T> extends ApiSuccess<T[]> {
  total: number;
  page: number;
  limit: number;
}

export type PaginatedResponse<T> = PaginatedSuccess<T> | ApiFailure;

export type ApiErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'validation_failed'
  | 'version_conflict'
  | 'transition_blocked'
  | 'required_fields_missing'
  | 'rate_limited'
  | 'tenant_mismatch'
  | 'config_unreadable'
  | 'conflict'
  | 'internal_error';

export function isApiSuccess<T>(response: ApiResponse<T>): response is ApiSuccess<T> {
  return response.success === true;
}

export function isApiFailure<T>(response: ApiResponse<T>): response is ApiFailure {
  return response.success === false;
}

// ═════════════════════════════════════════════════════════════════════════════
// Users, auth, tenancy
// ═════════════════════════════════════════════════════════════════════════════

export type UserRole = 'admin' | 'manager' | 'agent' | 'user';
export type AuthSource = 'local' | 'obligate' | 'ldap';

export interface UserPreferences {
  toastEnabled?: boolean;
  toastPosition?: 'top-center' | 'bottom-right';
  preferredTheme?: AppTheme;
  /** Sidebar collapsed state, remembered per user. */
  sidebarCollapsed?: boolean;
  /** Saved view slug opened when the user lands on /tickets. */
  defaultViewSlug?: string;
  /** Density of the ticket table. */
  density?: 'comfortable' | 'compact';
  /** Show internal work notes expanded by default in the journal. */
  expandWorkNotes?: boolean;
  /** Play a sound when a ticket is assigned to me. */
  soundOnAssignment?: boolean;
  /** Receive live alerts for every tenant the user can reach, not just the active one. */
  multiTenantNotificationsEnabled?: boolean;
  anonymousMode?: boolean;
  /** Column widths per saved view, keyed by view slug. */
  columnWidths?: Record<string, Record<string, number>>;
}

export interface User {
  id: number;
  username: string;
  displayName: string | null;
  email: string | null;
  role: UserRole;
  isActive: boolean;
  /** Profile picture as a base64 data URI or remote URL — synced from Obligate. */
  avatar: string | null;
  totpEnabled: boolean;
  emailOtpEnabled: boolean;
  preferences: UserPreferences | null;
  preferredLanguage: string;
  enrollmentVersion: number;
  obligateUserId: number | null;
  authSource: AuthSource;
  createdAt: string;
  updatedAt: string;
}

export interface UserWithPassword extends User {
  passwordHash: string;
}

export interface CreateUserRequest {
  username: string;
  password?: string;
  displayName?: string | null;
  email?: string | null;
  role?: UserRole;
  isActive?: boolean;
  preferredLanguage?: string;
}

export type UpdateUserRequest = Partial<Omit<CreateUserRequest, 'username'>> & {
  avatar?: string | null;
  preferences?: UserPreferences | null;
};

export interface PasswordResetToken {
  id: number;
  userId: number;
  token: string;
  expiresAt: string;
  usedAt: string | null;
}

export interface SsoLinkToken {
  id: number;
  token: string;
  obligateUserId: number;
  payload: Record<string, unknown>;
  expiresAt: string;
  consumedAt: string | null;
}

export interface Tenant {
  id: number;
  /** The cross-app identity (HARD RULE 13) — joins are ALWAYS on this. */
  slug: string;
  name: string;
  /** The god-view tenant: sees operational data across every tenant. */
  isMaster: boolean;
  settings: TenantSettings;
  createdAt: string;
  updatedAt: string;
}

export interface TenantSettings {
  /** Prefix for human ticket numbers, e.g. 'ACME' → ACME-1042. */
  ticketPrefix?: string;
  defaultCalendarSlug?: string;
  defaultQueueSlug?: string;
  defaultSlaPolicySlug?: string;
  defaultStateMachineSlug?: string;
  timezone?: string;
  locale?: string;
  /** Portal branding. */
  portalEnabled?: boolean;
  portalTitle?: string;
  portalLogoUrl?: string;
  /** Outbound mail identity for this tenant. */
  fromAddress?: string;
  fromName?: string;
  /** Business rules. */
  autoCloseResolvedAfterDays?: number;
  requireResolutionCode?: boolean;
  csatEnabled?: boolean;
  aiEnabled?: boolean;
  [key: string]: unknown;
}

export type CreateTenantRequest = {
  slug: string;
  name: string;
  isMaster?: boolean;
  settings?: TenantSettings;
};

export type UpdateTenantRequest = Partial<Omit<CreateTenantRequest, 'slug'>>;

export interface UserTenant {
  userId: number;
  tenantId: number;
  /** Role WITHIN this tenant — may differ from the global `users.role`. */
  role: UserRole;
  capabilities: Capability[];
}

/** A tenant as offered in the tenant selector, with the viewer's rights. */
export interface TenantMembership {
  tenantId: number;
  tenantSlug: string;
  tenantName: string;
  isMaster: boolean;
  role: UserRole;
  capabilities: Capability[];
}

export interface Team {
  id: number;
  tenantId: number;
  name: string;
  description: string | null;
  capabilities: Capability[];
  memberCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface TeamMembership {
  teamId: number;
  userId: number;
}

export interface CreateTeamRequest {
  name: string;
  description?: string | null;
  capabilities?: Capability[];
}

export type UpdateTeamRequest = Partial<CreateTeamRequest>;

export interface PermissionSet {
  id: number;
  tenantId: number;
  name: string;
  description: string | null;
  capabilities: Capability[];
  /** Seeded preset — renameable but not deletable. */
  isSystem: boolean;
}

export interface CreatePermissionSetRequest {
  name: string;
  description?: string | null;
  capabilities: Capability[];
}

export type UpdatePermissionSetRequest = Partial<CreatePermissionSetRequest>;

export interface UserPermissionSet {
  userId: number;
  permissionSetId: number;
}

/**
 * Everything the client needs to decide what to render, resolved for the ACTIVE
 * tenant. The server computes it once per request; the client caches it in the
 * auth store. `capabilities` is already expanded (see `expandCapabilities`).
 */
export interface SessionContext {
  user: User;
  tenant: Tenant;
  tenants: TenantMembership[];
  role: UserRole;
  capabilities: Capability[];
  teams: Array<{ id: number; name: string }>;
  isAdmin: boolean;
  isMasterTenant: boolean;
}

export interface LoginRequest {
  username: string;
  password: string;
  totpCode?: string;
  emailOtpCode?: string;
}

export interface LoginResponse {
  /** Present when authentication completed. */
  session?: SessionContext;
  /** Present when a second factor is required before the session is issued. */
  mfaRequired?: 'totp' | 'email_otp';
  mfaToken?: string;
}

/** Obligate SSO gateway settings. The raw API key is never exposed. */
export interface ObligateConfig {
  url: string | null;
  apiKeySet: boolean;
  enabled: boolean;
}

export interface AppConfig {
  allow2fa: boolean;
  force2fa: boolean;
  otpSmtpServerId: number | null;
  obligate: ObligateConfig;
  ai: AiConfig;
}

export interface AiConfig {
  enabled: boolean;
  provider: 'anthropic' | 'openai' | 'azure' | 'local' | 'none';
  model: string | null;
  /** Never returned to the client — only whether one is stored. */
  apiKeySet: boolean;
  /** Hard monthly ceiling in USD; the engine refuses past it. */
  monthlyBudgetUsd: number | null;
  features: {
    summarize: boolean;
    draftReply: boolean;
    suggestKb: boolean;
    triage: boolean;
    dedupe: boolean;
  };
}

export type SettingsScope = 'global' | 'tenant';

export interface SettingRecord {
  id: number;
  tenantId: number | null;
  scope: SettingsScope;
  key: string;
  value: unknown;
}

// ═════════════════════════════════════════════════════════════════════════════
// Audit & decision logs
// ═════════════════════════════════════════════════════════════════════════════

export type ActorType = 'user' | 'system' | 'automation' | 'ai' | 'portal';

/**
 * Append-only, hash-chained. `hash = sha256(prevHash + canonical(row))`, so a
 * deleted or edited row breaks the chain and the integrity check surfaces it.
 */
export interface AuditLogEntry {
  id: number;
  tenantId: number;
  actorId: number | null;
  actorType: ActorType;
  action: string;
  entityType: string;
  entityId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip: string | null;
  userAgent: string | null;
  at: string;
  prevHash: string | null;
  hash: string;
}

export type DecisionSubsystem =
  | 'routing'
  | 'priority'
  | 'sla'
  | 'assignment'
  | 'escalation'
  | 'approval'
  | 'rule'
  | 'alert'
  | 'ai'
  | 'workflow';

/**
 * HARD RULE 2 — written on the SAME code path as the action, by the engine that
 * took it. Never reconstructed afterwards, never batched up later. `inputs`
 * carries the condition trace so the Why drawer can replay the decision without
 * re-running anything.
 */
export interface DecisionLogEntry {
  id: number;
  tenantId: number;
  ticketId: number | null;
  at: string;
  subsystem: DecisionSubsystem;
  /** Short machine key, e.g. 'assigned_round_robin', 'priority_from_matrix'. */
  decision: string;
  inputs: DecisionInputs;
  /** The config object that decided (HARD RULE 3 — a slug). */
  ruleSlug: string | null;
  ruleVersion: number | null;
  outcome: Record<string, unknown>;
  durationMs: number | null;
}

export interface DecisionInputs {
  /** Snapshot of the fields the decision actually read. */
  fields?: Record<string, unknown>;
  /** The condition evaluation that produced the decision. */
  trace?: ConditionTrace;
  issues?: ConditionIssue[];
  /** Anything else the engine wants replayable — candidates, weights, scores. */
  [key: string]: unknown;
}

/** What the "Why?" drawer renders for one ticket. */
export interface WhyExplanation {
  ticketId: number;
  entries: Array<
    DecisionLogEntry & {
      /** Human sentence produced by `describeCondition` at write time. */
      summary: string;
      actorLabel: string | null;
    }
  >;
}

// ═════════════════════════════════════════════════════════════════════════════
// Configuration objects
// ═════════════════════════════════════════════════════════════════════════════

export type ConfigStatus = 'draft' | 'published' | 'archived';

/**
 * `K` narrows `body` to the right shape (see `ConfigBodyByKind`). Use
 * `ConfigObject` (unparameterised) for lists that mix kinds.
 */
export interface ConfigObject<K extends ConfigKind = ConfigKind> {
  id: number;
  tenantId: number;
  kind: K;
  /** Human identity — everything cross-references this (HARD RULE 3). */
  slug: string;
  name: string;
  description: string | null;
  body: K extends ConfigKind ? ConfigBodyFor<K> : AnyConfigBody;
  /** HARD RULE 4 — per-kind. Never bumped silently. */
  bodyFormatVersion: number;
  status: ConfigStatus;
  /** Monotonic; every publish writes a `config_object_versions` row. */
  version: number;
  /** Shipped in the day-one bundle. Editable, not deletable. */
  isSystem: boolean;
  /** Master-tenant objects pushed to these tenants; empty = this tenant only. */
  targetTenantIds: number[];
  /** sha256 of the normalised body — drives "modified from baseline" badges. */
  checksum: string;
  createdBy: number | null;
  updatedAt: string;
}

export interface ConfigObjectVersion {
  id: number;
  configObjectId: number;
  version: number;
  body: AnyConfigBody;
  bodyFormatVersion: number;
  authorId: number | null;
  note: string | null;
  createdAt: string;
}

export interface CreateConfigObjectRequest<K extends ConfigKind = ConfigKind> {
  kind: K;
  slug: string;
  name: string;
  description?: string | null;
  body: ConfigBodyFor<K>;
  status?: ConfigStatus;
  targetTenantIds?: number[];
}

export interface UpdateConfigObjectRequest<K extends ConfigKind = ConfigKind> {
  name?: string;
  description?: string | null;
  body?: ConfigBodyFor<K>;
  status?: ConfigStatus;
  targetTenantIds?: number[];
  /** Note stored on the resulting version row. */
  note?: string;
  /** Optimistic concurrency against `version`. */
  baseVersion?: number;
}

/** One finding from the config linter. */
export interface ConfigLintIssue {
  severity: 'error' | 'warning' | 'info';
  kind: ConfigKind;
  slug: string;
  /** Dotted path inside the body, e.g. 'targets[0].calendarSlug'. */
  path: string;
  code:
    | 'dangling_reference'
    | 'unknown_field'
    | 'unreachable_status'
    | 'missing_category'
    | 'duplicate_slug'
    | 'empty_condition'
    | 'incomplete_matrix'
    | 'body_version_ahead'
    | 'no_initial_status';
  message: string;
}

/** The exportable/importable day-one bundle. */
export interface ConfigBundle {
  formatVersion: 1;
  app: 'oblidesk';
  exportedAt: string;
  sourceTenantSlug: string;
  objects: Array<{
    kind: ConfigKind;
    slug: string;
    name: string;
    description: string | null;
    body: AnyConfigBody;
    bodyFormatVersion: number;
    isSystem: boolean;
  }>;
}

// ═════════════════════════════════════════════════════════════════════════════
// Organizations, contacts, groups, queues
// ═════════════════════════════════════════════════════════════════════════════

export interface Organization {
  id: number;
  tenantId: number;
  name: string;
  slug: string;
  /** Email domains that auto-associate an inbound contact with this org. */
  domains: string[];
  /** Id in the system of record (CRM / billing), if any. */
  externalRef: string | null;
  createdAt: string;
  updatedAt: string;
  /** Denormalised counters for the org list. */
  contactCount?: number;
  openTicketCount?: number;
}

export interface CreateOrganizationRequest {
  name: string;
  slug: string;
  domains?: string[];
  externalRef?: string | null;
}

export type UpdateOrganizationRequest = Partial<Omit<CreateOrganizationRequest, 'slug'>>;

export interface PortalContact {
  id: number;
  tenantId: number;
  email: string;
  displayName: string | null;
  phone: string | null;
  organizationId: number | null;
  organizationName?: string | null;
  /** Set when the contact also has an agent-side account. */
  userId: number | null;
  isActive: boolean;
  locale: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePortalContactRequest {
  email: string;
  displayName?: string | null;
  phone?: string | null;
  organizationId?: number | null;
  locale?: string;
  isActive?: boolean;
}

export type UpdatePortalContactRequest = Partial<Omit<CreatePortalContactRequest, 'email'>>;

export interface AssignmentGroup {
  id: number;
  tenantId: number;
  slug: string;
  name: string;
  description: string | null;
  memberUserIds: number[];
  /** Group mailbox that receives assignment notifications. */
  email: string | null;
  isActive: boolean;
  members?: Array<Pick<User, 'id' | 'username' | 'displayName' | 'avatar'>>;
}

export interface CreateAssignmentGroupRequest {
  slug: string;
  name: string;
  description?: string | null;
  memberUserIds?: number[];
  email?: string | null;
  isActive?: boolean;
}

export type UpdateAssignmentGroupRequest = Partial<Omit<CreateAssignmentGroupRequest, 'slug'>>;

/**
 * A queue, resolved from its `config_objects` row for the UI. `slug` is the
 * identity everything else references (HARD RULE 3).
 */
export interface Queue extends QueueBody {
  slug: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  status: ConfigStatus;
  /** Live counters for the sidebar. */
  openCount?: number;
  unassignedCount?: number;
  breachingSoonCount?: number;
}

/** A priority, resolved from the tenant's priority_matrix config object. */
export interface Priority extends PrioritySpec {}

/** A status, resolved from the tenant's state_machine config object. */
export interface Status extends StatusSpec {}

export interface TicketSequence {
  tenantId: number;
  prefix: string;
  lastNumber: number;
}

// ═════════════════════════════════════════════════════════════════════════════
// Tickets
// ═════════════════════════════════════════════════════════════════════════════

export type TicketRecordType = 'incident' | 'request' | 'problem' | 'change' | 'task' | 'release';

export type TicketSource = 'web' | 'email' | 'portal' | 'api' | 'alert' | 'phone' | 'chat';

export type TicketImpact = ImpactLevel;
export type TicketUrgency = UrgencyLevel;

/**
 * Provenance of a field value: who or what last wrote it. Stored in
 * `tickets.set_by` so the UI can show "priority set by rule
 * escalate_p1_after_15m" without a join, and so a rule can decline to overwrite
 * a value a human chose.
 */
export interface FieldProvenance {
  actorType: ActorType;
  actorId: number | null;
  /** Config object slug when an engine wrote it (HARD RULE 3). */
  ruleSlug?: string | null;
  at: string;
}

export interface Ticket {
  id: number;
  tenantId: number;
  recordType: TicketRecordType;
  /** Human number, unique per tenant, e.g. 'ACME-1042'. */
  number: string;
  subject: string;
  descriptionMd: string | null;
  descriptionHtml: string | null;

  /** Configurable slug… */
  statusSlug: string;
  /** …and its MANDATORY hard-coded category. Engines key off THIS (RULE 5). */
  statusCategory: StatusCategory;

  prioritySlug: string;
  impact: TicketImpact;
  urgency: TicketUrgency;

  queueSlug: string;
  assignmentGroupId: number | null;
  assigneeId: number | null;
  requesterContactId: number | null;
  requesterUserId: number | null;
  organizationId: number | null;
  primaryCiId: number | null;

  source: TicketSource;

  /**
   * HARD RULE 6 — when the thing actually HAPPENED, captured at intake and
   * distinct from `createdAt` (when we heard about it). This is what makes
   * Rewind possible; it cannot be backfilled, so intake must always ask.
   */
  occurredAt: string;
  createdAt: string;
  updatedAt: string;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  /** Nearest live SLA due date, denormalised for sorting. */
  dueAt: string | null;

  reopenCount: number;
  parentTicketId: number | null;
  mergedIntoId: number | null;

  resolutionCode: string | null;
  resolutionMd: string | null;
  csatScore: number | null;

  /** Custom fields, keyed by field config-object `body.key`. */
  data: Record<string, unknown>;
  /** Provenance per field key (see `FieldProvenance`). */
  setBy: Record<string, FieldProvenance>;

  /** HARD RULE 7 — optimistic concurrency. Bumped on every mutation. */
  rowVersion: number;
  deletedAt: string | null;
}

/** Ticket plus the joins the list and detail views always need. */
export interface TicketWithRelations extends Ticket {
  status?: Status;
  priority?: Priority;
  queue?: Pick<Queue, 'slug' | 'name' | 'color' | 'icon'>;
  assignee?: Pick<User, 'id' | 'username' | 'displayName' | 'avatar'> | null;
  assignmentGroup?: Pick<AssignmentGroup, 'id' | 'slug' | 'name'> | null;
  requesterContact?: Pick<PortalContact, 'id' | 'email' | 'displayName'> | null;
  organization?: Pick<Organization, 'id' | 'name' | 'slug'> | null;
  slaInstances?: SlaInstance[];
  watcherCount?: number;
  journalCount?: number;
  attachmentCount?: number;
  timeLoggedMinutes?: number;
  cis?: Array<Pick<Ci, 'id' | 'displayName' | 'kind' | 'criticality'>>;
  tags?: string[];
}

export interface CreateTicketRequest {
  recordType?: TicketRecordType;
  subject: string;
  descriptionMd?: string | null;
  /** HARD RULE 6 — intake MUST capture this; defaults to now if omitted. */
  occurredAt?: string;
  statusSlug?: string;
  prioritySlug?: string;
  impact?: TicketImpact;
  urgency?: TicketUrgency;
  queueSlug?: string;
  assignmentGroupId?: number | null;
  assigneeId?: number | null;
  requesterContactId?: number | null;
  requesterUserId?: number | null;
  organizationId?: number | null;
  primaryCiId?: number | null;
  source?: TicketSource;
  parentTicketId?: number | null;
  data?: Record<string, unknown>;
  /** Attachment ids already uploaded, to link on creation. */
  attachmentIds?: number[];
  /** Catalog item slug when the ticket came from the service catalog. */
  catalogItemSlug?: string | null;
}

/**
 * HARD RULE 7 — `baseRowVersion` is REQUIRED on every mutation. A mismatch
 * returns 409 with `TicketConflict` so the client can show the diff instead of
 * clobbering someone else's edit.
 *
 * HARD RULE 12 — an inline field edit sends ONLY the field it changed and is
 * never validated for required-ness. Required-ness lives on the transition.
 */
export interface UpdateTicketRequest {
  baseRowVersion: number;
  subject?: string;
  descriptionMd?: string | null;
  prioritySlug?: string;
  impact?: TicketImpact;
  urgency?: TicketUrgency;
  queueSlug?: string;
  assignmentGroupId?: number | null;
  assigneeId?: number | null;
  requesterContactId?: number | null;
  organizationId?: number | null;
  primaryCiId?: number | null;
  occurredAt?: string;
  dueAt?: string | null;
  resolutionCode?: string | null;
  resolutionMd?: string | null;
  /** Partial patch of the custom-field bag — merged, not replaced. */
  data?: Record<string, unknown>;
}

/** Body of the 409 returned on a `rowVersion` mismatch. */
export interface TicketConflict {
  code: 'version_conflict';
  /** The row as it stands now — render the diff against the local copy. */
  current: TicketWithRelations;
  /** Field keys that differ between the caller's base and `current`. */
  conflictingFields: string[];
}

export interface TransitionTicketRequest {
  baseRowVersion: number;
  /** Destination status slug; the transition is looked up from the machine. */
  toStatusSlug: string;
  /** Values collected by the transition dialog (`promptFor` fields). */
  fields?: Record<string, unknown>;
  /** Optional journal entry appended atomically with the transition. */
  comment?: { bodyMd: string; visibility: JournalVisibility } | null;
  resolutionCode?: string | null;
  resolutionMd?: string | null;
}

/**
 * Result of the shared transition evaluator — run identically on client
 * (to enable/disable the button) and server (to allow/reject). HARD RULE 12.
 */
export interface TransitionEvaluation {
  toStatusSlug: string;
  allowed: boolean;
  /** Field slugs that must be filled before the move. */
  missingRequiredFields: string[];
  /** Capabilities the actor lacks. */
  missingCapabilities: Capability[];
  /** Why the guard said no, ready for the tooltip. */
  guardTrace: ConditionTrace | null;
  reason: string | null;
}

export interface TicketListQuery {
  page?: number;
  limit?: number;
  /** Saved view slug — the server resolves its filter (HARD RULE 3). */
  viewSlug?: string;
  /** Ad-hoc filter tree, merged with the view's own filter using `all`. */
  filter?: ConditionNode | null;
  /** Full-text query against `search_tsv` (simple + unaccent + pg_trgm). */
  q?: string;
  statusCategories?: StatusCategory[];
  queueSlugs?: string[];
  prioritySlugs?: string[];
  assigneeIds?: number[];
  assignmentGroupIds?: number[];
  organizationIds?: number[];
  recordTypes?: TicketRecordType[];
  sources?: TicketSource[];
  ciIds?: number[];
  /** Filters on `occurred_at`, not `created_at` — Rewind (HARD RULE 6). */
  occurredFrom?: string;
  occurredTo?: string;
  createdFrom?: string;
  createdTo?: string;
  updatedFrom?: string;
  updatedTo?: string;
  /** Only tickets with a live SLA due within N minutes. */
  breachingWithinMinutes?: number;
  includeDeleted?: boolean;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
}

export interface TicketSearchHit {
  ticket: TicketWithRelations;
  /** ts_headline fragment with <mark> around the matches. */
  highlight?: string;
  rank?: number;
}

export interface MergeTicketsRequest {
  /** Tickets to fold in; they become `merged_into_id = targetTicketId`. */
  sourceTicketIds: number[];
  targetTicketId: number;
  /** Move the journal entries across, or leave them on the source. */
  moveJournal?: boolean;
  comment?: string;
}

export interface BulkTicketUpdateRequest {
  ticketIds: number[];
  /** Every ticket is checked against its own row version. */
  baseRowVersions: Record<number, number>;
  set: Pick<
    UpdateTicketRequest,
    'prioritySlug' | 'queueSlug' | 'assigneeId' | 'assignmentGroupId' | 'impact' | 'urgency'
  >;
}

export interface BulkTicketResult {
  updated: number[];
  conflicted: Array<{ ticketId: number; currentRowVersion: number }>;
  failed: Array<{ ticketId: number; error: string }>;
}

// ═════════════════════════════════════════════════════════════════════════════
// Journal, links, watchers, participants
// ═════════════════════════════════════════════════════════════════════════════

export type JournalKind =
  | 'public_reply'
  | 'work_note'
  | 'system'
  | 'state_change'
  | 'assignment'
  | 'attachment'
  | 'ai_suggestion'
  | 'automation'
  | 'approval'
  | 'time'
  | 'merge'
  | 'alert';

export type JournalVisibility = 'public' | 'internal';

export interface TicketJournalEntry {
  id: number;
  ticketId: number;
  tenantId: number;
  /** Monotonic per ticket. `(ticket_id, seq)` is unique — no gaps, no reorder. */
  seq: number;
  kind: JournalKind;
  visibility: JournalVisibility;
  authorId: number | null;
  authorContactId: number | null;
  authorType: ActorType;
  bodyMd: string | null;
  bodyHtml: string | null;
  /** Kind-specific payload — the state change, the rule slug, the alert, … */
  meta: JournalMeta;
  createdAt: string;
  /** Joined for rendering. */
  author?: Pick<User, 'id' | 'username' | 'displayName' | 'avatar'> | null;
  authorContact?: Pick<PortalContact, 'id' | 'email' | 'displayName'> | null;
  attachments?: Attachment[];
}

export interface JournalMeta {
  /** state_change */
  fromStatusSlug?: string;
  toStatusSlug?: string;
  fromCategory?: StatusCategory;
  toCategory?: StatusCategory;
  /** assignment */
  fromAssigneeId?: number | null;
  toAssigneeId?: number | null;
  fromGroupId?: number | null;
  toGroupId?: number | null;
  /** automation / rule (HARD RULE 3 — a slug) */
  ruleSlug?: string;
  ruleVersion?: number;
  macroSlug?: string;
  /** decision_log row this entry corresponds to, for the Why drawer */
  decisionLogId?: number;
  /** alert */
  alertId?: number;
  dedupeKey?: string;
  /** time */
  timeEntryId?: number;
  minutes?: number;
  /** approval */
  approvalId?: number;
  approvalState?: ApprovalState;
  /** merge */
  mergedTicketIds?: number[];
  /** mail */
  mailMessageId?: number;
  emailMessageId?: string;
  /** field diff for an inline edit */
  changes?: Array<{ field: string; from: unknown; to: unknown }>;
  [key: string]: unknown;
}

export interface CreateJournalEntryRequest {
  kind: Extract<JournalKind, 'public_reply' | 'work_note'>;
  visibility: JournalVisibility;
  bodyMd: string;
  attachmentIds?: number[];
  /** Additional CC addresses for a public reply. */
  ccEmails?: string[];
  /** Macro applied alongside the reply (HARD RULE 3 — a slug). */
  macroSlug?: string | null;
}

export type TicketLinkKind = 'related' | 'duplicate' | 'blocks' | 'caused_by' | 'child' | 'merged_from';

export interface TicketLink {
  id: number;
  tenantId: number;
  fromTicketId: number;
  toTicketId: number;
  kind: TicketLinkKind;
  createdBy: number | null;
  createdAt: string;
  /** Joined for rendering the link list. */
  toTicket?: Pick<Ticket, 'id' | 'number' | 'subject' | 'statusSlug' | 'statusCategory'>;
}

export interface CreateTicketLinkRequest {
  toTicketId: number;
  kind: TicketLinkKind;
}

export type WatcherReason = 'manual' | 'assignee' | 'requester' | 'mentioned' | 'group' | 'rule';

export interface TicketWatcher {
  id: number;
  tenantId: number;
  ticketId: number;
  userId: number | null;
  contactId: number | null;
  reason: WatcherReason;
  user?: Pick<User, 'id' | 'username' | 'displayName' | 'avatar'> | null;
  contact?: Pick<PortalContact, 'id' | 'email' | 'displayName'> | null;
}

export type ParticipantRole = 'requester' | 'cc' | 'bcc';

export interface TicketParticipant {
  id: number;
  tenantId: number;
  ticketId: number;
  contactId: number;
  role: ParticipantRole;
  contact?: Pick<PortalContact, 'id' | 'email' | 'displayName'>;
}

// ═════════════════════════════════════════════════════════════════════════════
// Attachments  (HARD RULE 9)
// ═════════════════════════════════════════════════════════════════════════════

export type AttachmentScanStatus = 'pending' | 'clean' | 'infected' | 'skipped';

/**
 * Metadata only. The bytes live at
 *   /custom/attachments/<tenant_id>/<yyyy>/<mm>/<sha256[0:2]>/<sha256>
 * and `(tenant_id, content_hash)` is unique — dedupe is PER TENANT, never a
 * global pool, so one tenant can never probe another's content by hash.
 */
export interface Attachment {
  id: number;
  tenantId: number;
  contentHash: string;
  mime: string;
  byteSize: number;
  filename: string;
  /** Path relative to /custom, as built by `buildAttachmentStorageKey`. */
  storageKey: string;
  scanStatus: AttachmentScanStatus;
  uploadedBy: number | null;
  createdAt: string;
  /** How many links point at the blob — it dies when this reaches zero. */
  linkCount?: number;
  /** Signed, short-lived download URL minted per request. */
  downloadUrl?: string;
}

export type AttachmentEntityType = 'ticket' | 'journal' | 'kb_article' | 'mail_message' | 'catalog_request';

/** The refcount. A blob dies when its last link dies. */
export interface AttachmentLink {
  id: number;
  attachmentId: number;
  tenantId: number;
  entityType: AttachmentEntityType;
  entityId: number;
  /** Content-ID for an inline image referenced from the HTML body. */
  inlineCid: string | null;
  createdAt: string;
}

export interface AttachmentUploadResult {
  attachment: Attachment;
  /** True when the bytes were already on disk for this tenant. */
  deduplicated: boolean;
}

// ═════════════════════════════════════════════════════════════════════════════
// Mail
// ═════════════════════════════════════════════════════════════════════════════

export type MailAccountKind = 'imap' | 'graph' | 'webhook';

export interface MailAccountConfig {
  host?: string;
  port?: number;
  secure?: boolean;
  username?: string;
  /** Never returned to the client — only `passwordSet`. */
  passwordSet?: boolean;
  mailbox?: string;
  /** Graph / OAuth. */
  tenantIdOauth?: string;
  clientId?: string;
  clientSecretSet?: boolean;
  /** Webhook ingest. */
  webhookSecretSet?: boolean;
  /** Behaviour. */
  pollSeconds?: number;
  deleteAfterFetch?: boolean;
  archiveFolder?: string;
  stripQuotedReplies?: boolean;
  [key: string]: unknown;
}

export interface MailAccountHealth {
  ok: boolean;
  lastError: string | null;
  lastErrorAt: string | null;
  consecutiveFailures: number;
  messagesFetched24h?: number;
}

export interface MailAccount {
  id: number;
  tenantId: number;
  name: string;
  kind: MailAccountKind;
  config: MailAccountConfig;
  /** Queue inbound mail lands in (HARD RULE 3 — a slug). */
  queueSlug: string;
  health: MailAccountHealth;
  lastSeenAt: string | null;
  isActive: boolean;
}

export interface CreateMailAccountRequest {
  name: string;
  kind: MailAccountKind;
  config: MailAccountConfig & { password?: string; clientSecret?: string };
  queueSlug: string;
  isActive?: boolean;
}

export type UpdateMailAccountRequest = Partial<CreateMailAccountRequest>;

export type MailDirection = 'in' | 'out';

export interface MailMessage {
  id: number;
  tenantId: number;
  mailAccountId: number | null;
  /** RFC 5322 Message-ID, unique per tenant — the idempotency key. */
  messageId: string;
  referencesIds: string[];
  inReplyTo: string | null;
  direction: MailDirection;
  ticketId: number | null;
  journalId: number | null;
  /** Storage key of the raw RFC822 blob under /custom. */
  rawKey: string | null;
  rawHash: string | null;
  parsed: MailParsedSummary;
  fromAddress: string;
  toAddresses: string[];
  subject: string | null;
  receivedAt: string;
}

export interface MailParsedSummary {
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  textBody?: string;
  htmlBody?: string;
  attachmentCount?: number;
  /** Auto-Submitted / Precedence — used to avoid mail loops. */
  autoSubmitted?: boolean;
  spamScore?: number;
  [key: string]: unknown;
}

export interface MailSuppression {
  id: number;
  tenantId: number;
  address: string;
  reason: string;
  createdAt: string;
}

// ═════════════════════════════════════════════════════════════════════════════
// Calendars & SLA
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The `calendars` + `calendar_shifts` + `calendar_holidays` rows, denormalised.
 * `toBusinessCalendar()` in the server hands the pure part to `calendar.ts`.
 */
export interface Calendar {
  id: number;
  tenantId: number;
  slug: string;
  name: string;
  /** IANA zone — the wall clock every shift is expressed in. */
  timezone: string;
  isDefault: boolean;
  shifts: CalendarShift[];
  holidays: CalendarHoliday[];
  exceptions?: CalendarExceptionDay[];
  is24x7?: boolean;
}

export interface CreateCalendarRequest {
  slug: string;
  name: string;
  timezone: string;
  isDefault?: boolean;
  shifts?: CalendarShift[];
  holidays?: CalendarHoliday[];
  exceptions?: CalendarExceptionDay[];
  is24x7?: boolean;
}

export type UpdateCalendarRequest = Partial<Omit<CreateCalendarRequest, 'slug'>>;

/** Narrow the DB row down to the pure shape `calendar.ts` consumes. */
export type CalendarKernel = BusinessCalendar;

export type SlaStatus = 'running' | 'paused' | 'met' | 'breached' | 'cancelled';

export interface SlaInstance {
  id: number;
  tenantId: number;
  ticketId: number;
  /** Target within the policy (HARD RULE 3 — a slug). */
  targetSlug: string;
  policySlug: string;
  /** The policy version this clock was started under — never re-read live. */
  policyVersion: number;
  calendarSlug: string;
  startedAt: string;
  dueAt: string;
  /** Business milliseconds accumulated while paused. */
  pausedMs: number;
  running: boolean;
  status: SlaStatus;
  breachedAt: string | null;
  metAt: string | null;
  /** What satisfied the target — the journal entry, the transition, … */
  resolvedVia: SlaResolvedVia | null;
  /** Computed for rendering; never stored. */
  remainingMinutes?: number;
  elapsedPercent?: number;
}

export interface SlaResolvedVia {
  kind: 'journal' | 'transition' | 'manual' | 'rule' | 'cancelled';
  journalId?: number;
  toStatusSlug?: string;
  actorId?: number | null;
  ruleSlug?: string;
}

/**
 * Every value the clock engine writes. `note` arrived with migration 003: it is
 * an ANNOTATION and never a state change — the way a repair or a boot catch-up
 * records why a clock looks the way it does, without telling that story as a
 * fake `pause`/`resume` pair the replay would then believe. The DB's
 * `sla_ledger_event_ck` allows exactly these eight, and a ledger row the client
 * cannot type is a ledger row the client will not render.
 */
export type SlaLedgerEvent =
  | 'start'
  | 'pause'
  | 'resume'
  | 'target_switch'
  | 'breach'
  | 'met'
  | 'cancel'
  | 'note';

/**
 * Append-only audit of every clock event. `(instance_id, event, at)` is unique,
 * so a replayed webhook or a double-fired job cannot double-count a pause.
 * The engine writes a `decision_log` row on the SAME path (HARD RULE 2).
 */
export interface SlaLedgerEntry {
  id: number;
  instanceId: number;
  tenantId: number;
  at: string;
  event: SlaLedgerEvent;
  /** Why — e.g. 'status_category:pending_requester', 'priority_changed'. */
  reasonCode: string;
  actorId: number | null;
  /** Business ms elapsed BEFORE this event — the replayable running total. */
  elapsedBusinessMsBefore: number;
  newDueAt: string | null;
  note: string | null;
}

export interface SlaSummary {
  ticketId: number;
  instances: SlaInstance[];
  /** The instance nearest to breaching, for the header countdown. */
  nearest: SlaInstance | null;
}

// ═════════════════════════════════════════════════════════════════════════════
// Rules
// ═════════════════════════════════════════════════════════════════════════════

export interface RuleExecution {
  id: number;
  tenantId: number;
  ticketId: number | null;
  ruleSlug: string;
  ruleVersion: number;
  at: string;
  matched: boolean;
  /** What the rule did (or would have done, when `dryRun`). */
  actions: Array<{ type: string; params: Record<string, unknown>; ok: boolean; error?: string }>;
  error: string | null;
  durationMs: number;
  dryRun: boolean;
}

export interface RuleTestRequest {
  /** Rule body to try, without saving it. */
  body: ConfigBodyFor<'rule'>;
  /** Tickets to evaluate it against. */
  ticketIds: number[];
}

export interface RuleTestResult {
  ticketId: number;
  ticketNumber: string;
  matched: boolean;
  trace: ConditionTrace;
  issues: ConditionIssue[];
  wouldDo: Array<{ type: string; summary: string }>;
}

// ═════════════════════════════════════════════════════════════════════════════
// CMDB — configuration items
// ═════════════════════════════════════════════════════════════════════════════

export type CiKind = 'device' | 'monitor' | 'host' | 'network' | 'service' | 'identity' | 'other';

export type CiCriticality = 'critical' | 'high' | 'medium' | 'low';

export interface Ci {
  id: number;
  tenantId: number;
  kind: CiKind;
  displayName: string;
  /**
   * The cross-app join key. Obliance/Obliguard agents report the same hardware
   * UUID, which is how a desk ticket reaches the right device.
   */
  hardwareUuid: string | null;
  criticality: CiCriticality;
  ownerContactId: number | null;
  supportGroupId: number | null;
  firstSeenAt: string;
  lastSeenAt: string | null;
  deletedAt: string | null;
  /** Joined for the CI drawer. */
  sources?: CiSourceLink[];
  overlays?: CiOverlay[];
  state?: CiStateCache | null;
  openTicketCount?: number;
}

/**
 * Where the CI came from. Oblidesk NEVER owns the source data — it links to it
 * and caches a payload. Desk-owned attributes go in `ci_overlays`.
 */
export interface CiSourceLink {
  id: number;
  ciId: number;
  tenantId: number;
  /** 'obliguard' | 'obliance' | 'obliview' | 'oblimap' | … */
  appType: string;
  externalId: string;
  /** Deep-link path within the source app, e.g. '/devices/42'. */
  externalPath: string | null;
  url: string | null;
  lastFetchedAt: string | null;
  payload: Record<string, unknown>;
}

/** Desk-owned attributes ONLY — never a mirror of the source app's fields. */
export interface CiOverlay {
  id: number;
  ciId: number;
  tenantId: number;
  key: string;
  value: unknown;
}

export interface CiStateCache {
  ciId: number;
  tenantId: number;
  online: boolean;
  state: Record<string, unknown>;
  observedAt: string;
}

export type TicketCiRole = 'primary' | 'affected' | 'cause';

export interface TicketCi {
  ticketId: number;
  ciId: number;
  tenantId: number;
  role: TicketCiRole;
  ci?: Pick<Ci, 'id' | 'displayName' | 'kind' | 'criticality'>;
}

export type EvidenceKind = 'metric' | 'log' | 'screenshot' | 'config_diff' | 'alert' | 'scan' | 'other';

/** A frozen snapshot captured from another app at ticket time. */
export interface TicketEvidence {
  id: number;
  tenantId: number;
  ticketId: number;
  kind: EvidenceKind;
  sourceApp: string;
  capturedAt: string;
  payload: Record<string, unknown>;
}

// ═════════════════════════════════════════════════════════════════════════════
// Suite alerts
// ═════════════════════════════════════════════════════════════════════════════

export type AlertSeverity = 'info' | 'warning' | 'critical' | 'down' | 'up';

/**
 * An alert pushed in by another Obli app. `(tenant_id, dedupe_key,
 * first_seen_at)` is unique: a flapping check becomes ONE row with a rising
 * `occurrenceCount`, not a thousand tickets.
 *
 * HARD RULE 13 — `tenantSlug` is what the source app sent; the numeric
 * `tenantId` is resolved locally from it.
 */
export interface SuiteAlert {
  id: number;
  tenantId: number;
  sourceApp: string;
  dedupeKey: string;
  severity: AlertSeverity;
  title: string;
  message: string | null;
  ciId: number | null;
  externalId: string | null;
  tenantSlug: string;
  occurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  clearedAt: string | null;
  ticketId: number | null;
  /** Set when a binding chose not to raise: 'flap_guard', 'suppress_when', … */
  suppressedReason: string | null;
  payload: Record<string, unknown>;
}

/** Payload the other apps POST to /api/alerts/ingest. */
export interface AlertIngestRequest {
  sourceApp: string;
  /** HARD RULE 13 — slug, never a numeric tenant id. */
  tenantSlug: string;
  dedupeKey?: string;
  severity: AlertSeverity;
  title: string;
  message?: string;
  externalId?: string;
  /** Cross-app CI join key. */
  hardwareUuid?: string;
  occurredAt?: string;
  cleared?: boolean;
  payload?: Record<string, unknown>;
}

export interface AlertIngestResult {
  alertId: number;
  action: 'created' | 'deduplicated' | 'suppressed' | 'cleared';
  ticketId: number | null;
  bindingSlug: string | null;
}

// ═════════════════════════════════════════════════════════════════════════════
// Time, contracts, billing
// ═════════════════════════════════════════════════════════════════════════════

export type TimeEntrySource = 'manual' | 'timer' | 'remote_session';

export interface TimeEntry {
  id: number;
  tenantId: number;
  ticketId: number;
  userId: number;
  startedAt: string;
  endedAt: string | null;
  minutes: number;
  billable: boolean;
  /** Rate card by SLUG (HARD RULE 3). */
  rateCardSlug: string | null;
  note: string | null;
  source: TimeEntrySource;
  /** Session id in the source app when the time came from a remote session. */
  externalRef: string | null;
  approvedAt: string | null;
  approvedBy: number | null;
  user?: Pick<User, 'id' | 'username' | 'displayName' | 'avatar'>;
}

export interface CreateTimeEntryRequest {
  ticketId: number;
  startedAt: string;
  endedAt?: string | null;
  minutes: number;
  billable?: boolean;
  rateCardSlug?: string | null;
  note?: string | null;
  source?: TimeEntrySource;
}

export type UpdateTimeEntryRequest = Partial<Omit<CreateTimeEntryRequest, 'ticketId'>>;

export type ContractKind = 'block_hours' | 'retainer' | 'per_ticket' | 'unlimited';

export interface Contract {
  id: number;
  tenantId: number;
  organizationId: number;
  name: string;
  kind: ContractKind;
  totalMinutes: number | null;
  consumedMinutes: number;
  periodStart: string;
  periodEnd: string;
  slaPolicySlug: string | null;
  isActive: boolean;
  organization?: Pick<Organization, 'id' | 'name' | 'slug'>;
  /** Computed. */
  remainingMinutes?: number;
  consumedPercent?: number;
}

export interface CreateContractRequest {
  organizationId: number;
  name: string;
  kind: ContractKind;
  totalMinutes?: number | null;
  periodStart: string;
  periodEnd: string;
  slaPolicySlug?: string | null;
  isActive?: boolean;
}

export type UpdateContractRequest = Partial<Omit<CreateContractRequest, 'organizationId'>>;

export interface RateCard {
  id: number;
  tenantId: number;
  slug: string;
  name: string;
  hourlyRate: number;
  currency: string;
  /** When this rate applies — after-hours, weekend, on-site, … */
  conditions: ConditionNode | null;
}

export interface CreateRateCardRequest {
  slug: string;
  name: string;
  hourlyRate: number;
  currency: string;
  conditions?: ConditionNode | null;
}

export type UpdateRateCardRequest = Partial<Omit<CreateRateCardRequest, 'slug'>>;

// ═════════════════════════════════════════════════════════════════════════════
// Knowledge base
// ═════════════════════════════════════════════════════════════════════════════

export type KbStatus = 'draft' | 'review' | 'published' | 'retired';

export interface KbArticle {
  id: number;
  tenantId: number;
  slug: string;
  title: string;
  bodyMd: string;
  bodyHtml: string | null;
  /** 'en' | 'fr' — `(tenant, slug, locale)` is unique. */
  locale: string;
  status: KbStatus;
  category: string | null;
  tags: string[];
  authorId: number | null;
  reviewedBy: number | null;
  publishedAt: string | null;
  views: number;
  helpful: number;
  unhelpful: number;
  createdAt?: string;
  updatedAt?: string;
  /** Search rendering. */
  highlight?: string;
  rank?: number;
}

export interface CreateKbArticleRequest {
  slug: string;
  title: string;
  bodyMd: string;
  locale?: string;
  status?: KbStatus;
  category?: string | null;
  tags?: string[];
}

export type UpdateKbArticleRequest = Partial<Omit<CreateKbArticleRequest, 'slug'>> & {
  note?: string;
};

export interface KbArticleVersion {
  id: number;
  articleId: number;
  version: number;
  bodyMd: string;
  authorId: number | null;
  note: string | null;
  createdAt: string;
}

export interface KbFeedback {
  id: number;
  articleId: number;
  tenantId: number;
  helpful: boolean;
  comment: string | null;
  contactId: number | null;
  createdAt: string;
}

// ═════════════════════════════════════════════════════════════════════════════
// Approvals
// ═════════════════════════════════════════════════════════════════════════════

export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';
export type ApprovalStepState = ApprovalState | 'skipped';
/** Re-exported from ./configKinds — the approval config body owns this union. */
export type { ApprovalMode };

export interface Approval {
  id: number;
  tenantId: number;
  ticketId: number;
  /** Approval config object (HARD RULE 3 — a slug). */
  definitionSlug: string;
  state: ApprovalState;
  mode: ApprovalMode;
  quorum: number | null;
  dueAt: string | null;
  createdAt: string;
  decidedAt: string | null;
  steps?: ApprovalStep[];
}

export interface ApprovalStep {
  id: number;
  approvalId: number;
  tenantId: number;
  stepIndex: number;
  approverUserId: number | null;
  approverGroupId: number | null;
  state: ApprovalStepState;
  decidedAt: string | null;
  comment: string | null;
  approver?: Pick<User, 'id' | 'username' | 'displayName' | 'avatar'> | null;
}

export interface ApprovalDecisionRequest {
  decision: 'approve' | 'reject';
  comment?: string;
  /** Delegate to another user instead of deciding, when the body allows it. */
  delegateToUserId?: number;
}

// ═════════════════════════════════════════════════════════════════════════════
// Dashboards, metrics, satisfaction
// ═════════════════════════════════════════════════════════════════════════════

export interface Dashboard {
  id: number;
  tenantId: number;
  slug: string;
  name: string;
  ownerId: number | null;
  isShared: boolean;
  isDefault: boolean;
  /** Grid layout per tab, mirroring the widget rows. */
  layout: Record<string, unknown>;
  widgets?: DashboardWidget[];
}

export interface DashboardWidget {
  id: number;
  dashboardId: number;
  tenantId: number;
  tabKey: string;
  x: number;
  y: number;
  w: number;
  h: number;
  widgetType: WidgetType;
  title: string;
  config: Record<string, unknown>;
  sortOrder: number;
}

export interface CreateDashboardRequest {
  slug: string;
  name: string;
  isShared?: boolean;
  isDefault?: boolean;
  layout?: Record<string, unknown>;
}

export type UpdateDashboardRequest = Partial<Omit<CreateDashboardRequest, 'slug'>>;

export interface CreateDashboardWidgetRequest {
  tabKey: string;
  widgetType: WidgetType;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  config?: Record<string, unknown>;
  sortOrder?: number;
}

export type UpdateDashboardWidgetRequest = Partial<CreateDashboardWidgetRequest>;

/** One row of `metric_daily_rollup`, and the unit every chart consumes. */
export interface MetricPoint {
  id?: number;
  tenantId: number;
  /** Local date 'YYYY-MM-DD' in the tenant timezone. */
  day: string;
  /** e.g. 'tickets.created', 'sla.first_response.met_pct', 'time.billable_min'. */
  metricKey: string;
  /** Breakdown axes — queue slug, priority slug, agent id, … */
  dimensions: Record<string, string | number>;
  value: number;
}

export interface MetricQuery {
  metricKeys: string[];
  from: string;
  to: string;
  groupBy?: string[];
  filter?: ConditionNode | null;
  /** Bucket size for the response series. */
  granularity?: 'day' | 'week' | 'month';
}

export interface MetricSeries {
  metricKey: string;
  dimensions: Record<string, string | number>;
  points: Array<{ day: string; value: number }>;
  total: number;
}

export interface SatisfactionResponse {
  id: number;
  tenantId: number;
  ticketId: number;
  contactId: number | null;
  /** 1-5. */
  score: number;
  comment: string | null;
  respondedAt: string;
  /** Single-use token from the survey link. Never rendered to an agent. */
  token: string;
}

/** Cached count badge for a saved view, per user. */
export interface SavedViewCount {
  viewSlug: string;
  tenantId: number;
  userId: number;
  count: number;
  computedAt: string;
}

// ═════════════════════════════════════════════════════════════════════════════
// AI
// ═════════════════════════════════════════════════════════════════════════════

export type AiSuggestionKind =
  | 'summary'
  | 'draft_reply'
  | 'kb_suggestion'
  | 'triage'
  | 'duplicate'
  | 'resolution_code'
  | 'sentiment';

export type AiEngine = 'llm' | 'heuristic';

export interface AiSuggestion {
  id: number;
  tenantId: number;
  ticketId: number;
  kind: AiSuggestionKind;
  payload: AiSuggestionPayload;
  /** 0-1. Below the tenant threshold the UI shows it greyed with a warning. */
  confidence: number;
  engine: AiEngine;
  model: string | null;
  accepted: boolean | null;
  acceptedBy: number | null;
  acceptedAt: string | null;
  costUsd: number | null;
  createdAt: string;
}

export interface AiSuggestionPayload {
  text?: string;
  /** kb_suggestion */
  articleSlugs?: string[];
  /** triage */
  queueSlug?: string;
  prioritySlug?: string;
  impact?: TicketImpact;
  urgency?: TicketUrgency;
  /** duplicate */
  duplicateTicketIds?: number[];
  /** sentiment */
  sentiment?: 'positive' | 'neutral' | 'negative';
  /** Always present — what the model was shown, for auditability. */
  promptSummary?: string;
  [key: string]: unknown;
}

export interface AiUsageLedgerEntry {
  id: number;
  tenantId: number;
  at: string;
  feature: AiSuggestionKind | string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  ticketId: number | null;
}

export interface AiUsageSummary {
  tenantId: number;
  periodStart: string;
  periodEnd: string;
  totalCostUsd: number;
  budgetUsd: number | null;
  byFeature: Array<{ feature: string; costUsd: number; calls: number }>;
}

// ═════════════════════════════════════════════════════════════════════════════
// Notifications
// ═════════════════════════════════════════════════════════════════════════════

export interface NotificationChannel {
  id: number;
  /** Null = shared across every tenant (master-owned). */
  tenantId: number | null;
  name: string;
  /** 'email' | 'webhook' | 'slack' | 'teams' | 'inapp' | … */
  type: string;
  /** Secrets are redacted server-side before this leaves the process. */
  config: Record<string, unknown>;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateNotificationChannelRequest {
  name: string;
  type: string;
  config: Record<string, unknown>;
  isActive?: boolean;
}

export type UpdateNotificationChannelRequest = Partial<CreateNotificationChannelRequest>;

export interface NotificationBinding {
  id: number;
  channelId: number;
  /** Domain event, e.g. 'ticket.created', 'sla.breached'. */
  event: string;
  conditions: ConditionNode | null;
  isActive: boolean;
}

export type NotificationStatus = 'pending' | 'sent' | 'failed';

export interface NotificationLogEntry {
  id: number;
  tenantId: number;
  channelId: number | null;
  event: string;
  payload: Record<string, unknown>;
  status: NotificationStatus;
  error: string | null;
  sentAt: string | null;
}

export interface NotificationOutboxItem {
  id: number;
  tenantId: number;
  /** 'email' | 'webhook' | 'inapp' | … */
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  nextAttemptAt: string;
  status: NotificationStatus;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface SmtpServer {
  id: number;
  tenantId: number | null;
  name: string;
  host: string;
  port: number;
  secure: boolean;
  username: string | null;
  /** The encrypted password never leaves the server. */
  passwordSet: boolean;
  fromAddress: string;
  fromName: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSmtpServerRequest {
  name: string;
  host: string;
  port: number;
  secure?: boolean;
  username?: string | null;
  password?: string | null;
  fromAddress: string;
  fromName?: string | null;
  isDefault?: boolean;
}

export type UpdateSmtpServerRequest = Partial<CreateSmtpServerRequest>;

/** A DB-backed toast / bell entry. */
export interface LiveAlert {
  id: number;
  tenantId: number;
  tenantName?: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  /** Client route to open when the alert is clicked. */
  navigateTo: string | null;
  /** De-duplication key so a re-fire updates rather than stacks. */
  stableKey: string | null;
  readAt: string | null;
  createdAt: string;
}

// ═════════════════════════════════════════════════════════════════════════════
// Socket event payloads
// ═════════════════════════════════════════════════════════════════════════════

/** Every payload carries `tenantId` so a mis-routed room is detectable. */
export interface SocketEnvelope {
  tenantId: number;
  /** Server clock at emit — clients use it to drop stale out-of-order frames. */
  at: string;
}

export interface TicketCreatedEvent extends SocketEnvelope {
  ticket: TicketWithRelations;
}

export interface TicketUpdatedEvent extends SocketEnvelope {
  ticketId: number;
  /** Full row so a list can patch in place without a refetch. */
  ticket: TicketWithRelations;
  /** Which columns actually moved — lets the row flash only what changed. */
  changedFields: string[];
  rowVersion: number;
  actorId: number | null;
  actorType: ActorType;
}

export interface TicketDeletedEvent extends SocketEnvelope {
  ticketId: number;
  number: string;
  purged: boolean;
}

export interface TicketStatusChangedEvent extends SocketEnvelope {
  ticketId: number;
  fromStatusSlug: string;
  toStatusSlug: string;
  fromCategory: StatusCategory;
  toCategory: StatusCategory;
  rowVersion: number;
  actorId: number | null;
}

export interface TicketAssignedEvent extends SocketEnvelope {
  ticketId: number;
  number: string;
  subject: string;
  fromAssigneeId: number | null;
  toAssigneeId: number | null;
  assignmentGroupId: number | null;
  actorId: number | null;
  /** Set when an engine assigned it (HARD RULE 3 — a slug). */
  ruleSlug: string | null;
}

export interface JournalAppendedEvent extends SocketEnvelope {
  ticketId: number;
  entry: TicketJournalEntry;
}

export interface SlaTickEvent extends SocketEnvelope {
  ticketId: number;
  instances: Array<Pick<SlaInstance, 'id' | 'targetSlug' | 'dueAt' | 'status' | 'running' | 'remainingMinutes'>>;
}

export interface SlaBreachedEvent extends SocketEnvelope {
  ticketId: number;
  number: string;
  instanceId: number;
  targetSlug: string;
  policySlug: string;
  breachedAt: string;
}

export interface SlaWarningEvent extends SocketEnvelope {
  ticketId: number;
  number: string;
  instanceId: number;
  targetSlug: string;
  dueAt: string;
  remainingMinutes: number;
}

export interface AlertRaisedEvent extends SocketEnvelope {
  alert: SuiteAlert;
  ticketId: number | null;
}

export interface AlertClearedEvent extends SocketEnvelope {
  alertId: number;
  dedupeKey: string;
  ticketId: number | null;
}

export interface ApprovalRequestedEvent extends SocketEnvelope {
  approvalId: number;
  ticketId: number;
  number: string;
  stepIndex: number;
  approverUserIds: number[];
  dueAt: string | null;
}

export interface ApprovalDecidedEvent extends SocketEnvelope {
  approvalId: number;
  ticketId: number;
  state: ApprovalState;
  decidedBy: number | null;
}

export interface ConfigPublishedEvent extends SocketEnvelope {
  kind: ConfigKind;
  slug: string;
  version: number;
  bodyFormatVersion: number;
  actorId: number | null;
}

export interface QueueCountsEvent extends SocketEnvelope {
  counts: Array<{ queueSlug: string; open: number; unassigned: number; breachingSoon: number }>;
}

export interface ViewCountsEvent extends SocketEnvelope {
  counts: Array<{ viewSlug: string; count: number }>;
}

export interface NotificationNewEvent extends SocketEnvelope {
  alert: LiveAlert;
}

export interface MailAccountHealthEvent extends SocketEnvelope {
  mailAccountId: number;
  health: MailAccountHealth;
}

export interface AiSuggestionReadyEvent extends SocketEnvelope {
  ticketId: number;
  suggestion: AiSuggestion;
}

/** Who is looking at / typing on a ticket right now. Ephemeral, never stored. */
export interface TicketPresenceEvent extends SocketEnvelope {
  ticketId: number;
  viewers: Array<{
    userId: number;
    username: string;
    displayName: string | null;
    avatar: string | null;
    typing: boolean;
    /** Field slug the user is editing, so the UI can grey it for others. */
    editingField: string | null;
  }>;
}

export interface TimeEntryChangedEvent extends SocketEnvelope {
  ticketId: number;
  entry: TimeEntry;
  removed?: boolean;
}

export interface SettingsUpdatedEvent extends SocketEnvelope {
  scope: SettingsScope;
  key: string;
}

// ── Client → server payloads ─────────────────────────────────────────────────

export interface SubscribeTicketPayload {
  ticketId: number;
}

export interface PresencePayload {
  ticketId: number;
  typing?: boolean;
  editingField?: string | null;
}

export interface SubscribeViewPayload {
  viewSlugs: string[];
}
