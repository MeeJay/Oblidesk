/**
 * constants.ts — runtime constants shared by the Oblidesk server and client.
 *
 * Anything in here is a VALUE (not a type) that both sides must agree on:
 * socket event names, room names, default slugs, pagination limits.
 *
 * Rule: a string that crosses the wire is declared here once. A socket event
 * emitted with a hand-typed string is a bug waiting for a rename.
 */

// ═════════════════════════════════════════════════════════════════════════════
// App identity
// ═════════════════════════════════════════════════════════════════════════════

/** Suite app type slug — must match Obligate's `AppType` union. */
export const APP_TYPE = 'oblidesk' as const;

/** Display name. Overridden at runtime by the APP_NAME env var. */
export const APP_NAME = 'Oblidesk' as const;

/** Brand accent, per D:\Mockup\obli-design-system.md §1. */
export const APP_ACCENT_HEX = '#22b8f5' as const;
export const APP_ACCENT_HIGHLIGHT_HEX = '#5fd0ff' as const;

/** localStorage keys. Prefixed so they never collide with a sibling app on the same host. */
export const STORAGE_KEYS = {
  /** Shared across the suite on purpose — collapsing here stays collapsed in Obliance. */
  theme: 'og-theme',
  sidebarCollapsed: 'oblidesk:groupPanelCollapsed',
  sidebarWidth: 'oblidesk:sidebarWidth',
  sidebarFloating: 'oblidesk:sidebarFloating',
  keymap: 'oblidesk:keymap',
  lastView: 'oblidesk:lastView',
  queueDensity: 'oblidesk:queueDensity',
  composerDrafts: 'oblidesk:drafts',
  obliToolsToken: 'oblitools_auth_token',
} as const;

// ═════════════════════════════════════════════════════════════════════════════
// Socket rooms
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Room taxonomy. A socket joins `tenant:` and `user:` on connect; it joins
 * `ticket:` only while the ticket is open (that is what drives presence), and
 * `queue:` / `view:` while a board is on screen.
 */
export const ROOMS = {
  tenant: (tenantId: number) => `tenant:${tenantId}`,
  user: (userId: number) => `user:${userId}`,
  ticket: (ticketId: number) => `ticket:${ticketId}`,
  queue: (tenantId: number, queueSlug: string) => `queue:${tenantId}:${queueSlug}`,
  view: (tenantId: number, viewSlug: string) => `view:${tenantId}:${viewSlug}`,
} as const;

/** Prefix test — used by the socket handler to authorise a join request. */
export const ROOM_PREFIXES = ['tenant', 'user', 'ticket', 'queue', 'view'] as const;
export type RoomPrefix = (typeof ROOM_PREFIXES)[number];

// ═════════════════════════════════════════════════════════════════════════════
// Socket events
// ═════════════════════════════════════════════════════════════════════════════

/** Server → client. Payload types live in types.ts as `*Event` interfaces. */
export const SOCKET_EVENTS = {
  ticketCreated: 'ticket:created',
  ticketUpdated: 'ticket:updated',
  ticketDeleted: 'ticket:deleted',
  ticketStatusChanged: 'ticket:status-changed',
  ticketAssigned: 'ticket:assigned',
  journalAppended: 'ticket:journal',
  ticketPresence: 'ticket:presence',
  ticketTyping: 'ticket:typing',

  slaTick: 'sla:tick',
  slaWarning: 'sla:warning',
  slaBreached: 'sla:breach',

  alertRaised: 'alert:new',
  alertCleared: 'alert:cleared',

  approvalRequested: 'approval:requested',
  approvalDecided: 'approval:decided',

  configPublished: 'config:published',
  settingsUpdated: 'settings:updated',

  queueCounters: 'queue:counters',
  viewCounters: 'view:counters',

  notificationNew: 'notification:new',
  mailAccountHealth: 'mail:health',
  aiSuggestionReady: 'ai:suggestion',
  timeEntryChanged: 'time:changed',
} as const;
export type SocketEventName = (typeof SOCKET_EVENTS)[keyof typeof SOCKET_EVENTS];

/** Client → server. */
export const SOCKET_COMMANDS = {
  subscribeTicket: 'subscribe:ticket',
  unsubscribeTicket: 'unsubscribe:ticket',
  subscribeQueue: 'subscribe:queue',
  unsubscribeQueue: 'unsubscribe:queue',
  subscribeView: 'subscribe:view',
  unsubscribeView: 'unsubscribe:view',
  presenceHeartbeat: 'presence:heartbeat',
  typing: 'typing',
} as const;
export type SocketCommandName = (typeof SOCKET_COMMANDS)[keyof typeof SOCKET_COMMANDS];

/**
 * How long a presence entry survives without a heartbeat. The client beats at
 * half this interval, so one dropped beat does not make an agent flicker out of
 * the collision bar.
 */
export const PRESENCE_TTL_MS = 30_000;
export const PRESENCE_HEARTBEAT_MS = 15_000;
/** Typing indicators are noisier and shorter-lived than presence. */
export const TYPING_TTL_MS = 6_000;

// ═════════════════════════════════════════════════════════════════════════════
// Baseline slugs — shipped by seeds/02_baseline_config.ts
// ═════════════════════════════════════════════════════════════════════════════

/**
 * These are the slugs of the day-one config bundle. Code may reference them as
 * FALLBACKS, never as guarantees: an admin can archive any of them, so every
 * read must degrade rather than throw.
 */
export const BASELINE_SLUGS = {
  stateMachine: 'default',
  priorityMatrix: 'default',
  calendarBusiness: 'business',
  calendar247: '24x7',
  slaStandard: 'standard',
  queueGeneral: 'general',
  formIncidentDefault: 'incident_default',
} as const;

/** Default status slug for a freshly created ticket, before any rule runs. */
export const DEFAULT_STATUS_SLUG = 'new';
/** Default priority slug when impact × urgency cannot be resolved. */
export const DEFAULT_PRIORITY_SLUG = 'p3';
export const DEFAULT_QUEUE_SLUG = 'general';

/** Ticket number prefix used when a tenant has not chosen one. */
export const DEFAULT_TICKET_PREFIX = 'TKT';

// ═════════════════════════════════════════════════════════════════════════════
// Limits
// ═════════════════════════════════════════════════════════════════════════════

export const PAGINATION = {
  /** The queue is virtualised — this is one keyset page, not a screenful. */
  defaultLimit: 50,
  maxLimit: 200,
  /** Above this many matching rows the saved-view count goes approximate. */
  exactCountThreshold: 5_000,
} as const;

export const LIMITS = {
  subjectMaxLength: 512,
  bodyMaxBytes: 2 * 1024 * 1024,
  attachmentMaxBytes: 25 * 1024 * 1024,
  attachmentsPerMessage: 20,
  /** Bulk actions preview then apply; beyond this the UI refuses and asks for a filter. */
  bulkMaxTickets: 1_000,
  /** How long a bulk action stays undoable. */
  bulkUndoWindowMs: 10 * 60 * 1000,
  /** A resolved ticket reopens on a requester reply inside this window; after it, a linked follow-up is created instead. */
  reopenWindowDays: 14,
  /** A merge stays reversible this long, unless the target was closed and invoiced. */
  mergeRevertWindowDays: 30,
  /** Rewind data upstream in Obliance is pruned at 7 days — do not promise more. */
  rewindRetentionDays: 7,

  /**
   * Ceiling on one closure-cascade pass, deliberately the same number as
   * `bulkMaxTickets`: the cascade IS a bulk action, and giving it a second,
   * larger ceiling would be a bulk action that escaped the bulk ceiling.
   * Beyond it the pass resolves the first N, reports `truncated: true` with
   * the remainder, and SAYS SO. A truncation that looks like a completion is
   * the failure nobody catches.
   */
  problemCascadeMaxIncidents: 1_000,
  /** How long a rejected detector signature stays suppressed. */
  problemCandidateCooldownDays: 90,
  /** Default look-back of one detection pass. */
  problemDetectionWindowDays: 14,
  /** New cards per tenant per pass. A detector that can emit 200 produces zero attention. */
  problemMaxNewCandidatesPerRun: 5,
} as const;

/** Never trust the declared MIME type; these are the ones we refuse to serve inline. */
export const NEVER_INLINE_MIME = ['image/svg+xml', 'text/html', 'application/xhtml+xml'] as const;

// ═════════════════════════════════════════════════════════════════════════════
// Enumerations that are values, not just types
// ═════════════════════════════════════════════════════════════════════════════

export const TICKET_RECORD_TYPES = [
  'incident',
  'request',
  'problem',
  'change',
  'task',
  'release',
] as const;

export const TICKET_SOURCES = [
  'web',
  'email',
  'portal',
  'api',
  'alert',
  'phone',
  'chat',
] as const;

export const JOURNAL_KINDS = [
  'public_reply',
  'work_note',
  'system',
  'state_change',
  'assignment',
  'attachment',
  'ai_suggestion',
  'automation',
  'approval',
  'time',
  'merge',
  'alert',
] as const;

/** Journal kinds that are pure noise and collapse into one expandable row. */
export const COLLAPSIBLE_JOURNAL_KINDS = ['system', 'state_change', 'assignment', 'automation'] as const;

export const DECISION_SUBSYSTEMS = [
  'routing',
  'priority',
  'sla',
  'assignment',
  'escalation',
  'approval',
  'rule',
  'alert',
  'ai',
  'workflow',
  /**
   * Problem management: promotion, incident linking, RCA conclusions, known
   * error publication, the closure cascade and the recurrence detector.
   * `decision_log.subsystem` is an unconstrained varchar(24), so this is a
   * constant addition with no migration.
   */
  'problem',
] as const;

/** Apps whose data can appear on a CI, in the order the context rail renders them. */
export const CI_SOURCE_APPS = ['obliance', 'obliview', 'obliguard', 'oblimap', 'obligate'] as const;
export type CiSourceApp = (typeof CI_SOURCE_APPS)[number];

// ═════════════════════════════════════════════════════════════════════════════
// Locales
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The suite ships 18 locales. Oblidesk seeds `fr` and `en` only; the rest fall
 * back to `en` until the sweep script runs (suite convention — see CLAUDE.md).
 */
export const SUPPORTED_LOCALES = [
  'en', 'fr', 'de', 'es', 'it', 'nl', 'pt-BR', 'pl', 'cs', 'da',
  'sv', 'tr', 'ru', 'uk', 'ar', 'ja', 'ko', 'zh-CN',
] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const SEEDED_LOCALES = ['en', 'fr'] as const;
export const DEFAULT_LOCALE: SupportedLocale = 'fr';
export const FALLBACK_LOCALE: SupportedLocale = 'en';
/** Right-to-left locales — the layout mirrors for these. */
export const RTL_LOCALES: readonly SupportedLocale[] = ['ar'];

// ═════════════════════════════════════════════════════════════════════════════
// API
// ═════════════════════════════════════════════════════════════════════════════

export const API_PREFIX = '/api';
/** Header carrying the session id when cookies are unavailable (ObliTools WebView2). */
export const AUTH_TOKEN_HEADER = 'X-Auth-Token';
/** Header carrying the optimistic-concurrency base version on a ticket mutation. */
export const ROW_VERSION_HEADER = 'X-Row-Version';
/** Header an admin uses to act inside a tenant other than the session's current one. */
export const TENANT_OVERRIDE_HEADER = 'X-Tenant-Id';
