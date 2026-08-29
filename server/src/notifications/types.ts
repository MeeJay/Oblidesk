/**
 * notifications/types.ts — the plugin contract.
 *
 * Identical in shape to the sibling apps' notification plugins (Obliguard,
 * Obliview): a plugin declares its `type`, a human name, and the config fields
 * the channel editor should render, then implements `send` and `sendTest`.
 * Keeping the interface the same across the suite is deliberate — a plugin
 * written for one app is a copy-paste away from working in another, and the
 * channel editor UI is the same component everywhere.
 *
 * What differs from the monitoring apps is the PAYLOAD. Obliview sends
 * "monitor X went down"; a service desk sends "ticket ACME-1042 breached its
 * resolution SLA". The payload below is therefore desk-shaped: a ticket, an
 * optional SLA clock, an optional approval, and a pre-rendered title/body that
 * the notification service produced from a `notification_template` config
 * object in the recipient's locale.
 *
 * IMPORTANT: plugins never localise. By the time a payload reaches a plugin,
 * `title` and `body` are already in the recipient's language (HARD RULE 10 —
 * the template carries `en` and `fr`). A plugin that concatenates English
 * words onto a French body is a bug that only shows up in production, in
 * French.
 */

// ═════════════════════════════════════════════════════════════════════════════
// Channel config field descriptors (rendered by the channel editor)
// ═════════════════════════════════════════════════════════════════════════════

export type NotificationFieldType =
  | 'text'
  | 'password'
  | 'url'
  | 'number'
  | 'boolean'
  | 'textarea'
  | 'select'
  /** Renders the SMTP-server picker instead of raw host/port/credentials. */
  | 'smtp_server_select';

export interface NotificationConfigField {
  key: string;
  /** Inline English fallback; the client pairs it with `t('notify.field.<key>', label)`. */
  label: string;
  type: NotificationFieldType;
  required?: boolean;
  placeholder?: string;
  /** Help text shown under the input. */
  hint?: string;
  /** For `type: 'select'`. */
  options?: Array<{ value: string; label: string }>;
  defaultValue?: string | number | boolean;
  /**
   * Secret: the value is write-only. The API returns `true`/`false` for
   * "is it set", never the value itself.
   */
  secret?: boolean;
}

/** What the client needs to render the "add a channel" screen. */
export interface NotificationPluginMeta {
  type: string;
  name: string;
  description: string;
  configFields: NotificationConfigField[];
  /** Rich formatting available: cards, colours, markdown. Drives the preview. */
  supportsRichFormat: boolean;
}

// ═════════════════════════════════════════════════════════════════════════════
// The payload
// ═════════════════════════════════════════════════════════════════════════════

export type NotificationSeverity = 'critical' | 'warning' | 'info' | 'success';

export interface NotificationTicketRef {
  id: number;
  /** Human number, e.g. ACME-1042 — what people actually say out loud. */
  number: string;
  subject: string;
  recordType: string;
  statusSlug: string;
  /** HARD RULE 5 — the category is the contract; the slug is a label. */
  statusCategory: string;
  prioritySlug: string;
  queueSlug: string;
  assigneeName: string | null;
  requesterName: string | null;
  organizationName: string | null;
  /** HARD RULE 6 — when it actually happened, not when it was filed. */
  occurredAt: string | null;
  createdAt: string;
}

export interface NotificationSlaRef {
  targetSlug: string;
  policySlug: string;
  dueAt: string | null;
  /** 0–100+; over 100 means breached. */
  percentElapsed: number;
  status: string;
}

export interface NotificationApprovalRef {
  id: number;
  definitionSlug: string;
  state: string;
  dueAt: string | null;
}

export interface NotificationPayload {
  /** Domain event: 'ticket.created', 'sla.breached', 'approval.requested'… */
  event: string;
  /** Display name of this installation — 'Oblidesk' unless APP_NAME overrides. */
  appName: string;
  /** Cross-app tenant identity (HARD RULE 13) — a slug, never a numeric id. */
  tenantSlug: string;
  tenantName: string;

  /** Already localised. Plugins render, they do not translate. */
  title: string;
  /** Markdown / plain text body, already localised. */
  body: string;
  /** Optional pre-rendered HTML for channels that take it (email). */
  bodyHtml?: string;

  severity: NotificationSeverity;
  /** Absolute deep link back into the desk. */
  url?: string;

  ticket?: NotificationTicketRef;
  sla?: NotificationSlaRef;
  approval?: NotificationApprovalRef;

  /** Extra label/value rows rendered as a fact table by the rich channels. */
  facts?: Array<{ label: string; value: string }>;

  /** ISO-8601. The moment the event happened, not the moment we sent it. */
  occurredAt: string;
  /** BCP-47 tag the title/body were rendered in — 'en' | 'fr'. */
  locale: string;

  /** Per-send recipient override (email `to`, chat channel, …). */
  to?: string;
}

// ═════════════════════════════════════════════════════════════════════════════
// The plugin
// ═════════════════════════════════════════════════════════════════════════════

export interface NotificationPlugin {
  type: string;
  name: string;
  description: string;
  configFields: NotificationConfigField[];
  supportsRichFormat?: boolean;

  /**
   * Deliver one payload. MUST throw on failure — the outbox worker keys its
   * retry/backoff off the thrown error, so a plugin that swallows a 500 and
   * returns quietly turns a retryable failure into silent data loss.
   *
   * `config` is the RESOLVED config: the notification service has already
   * injected SMTP credentials, decrypted secrets and applied defaults.
   */
  send(config: Record<string, unknown>, payload: NotificationPayload): Promise<void>;

  /** "Send test" from the channel editor. Same delivery path, canned payload. */
  sendTest(config: Record<string, unknown>): Promise<void>;
}

// ═════════════════════════════════════════════════════════════════════════════
// Shared render helpers
// ═════════════════════════════════════════════════════════════════════════════

/** Severity → an emoji every chat client renders identically. */
export const SEVERITY_EMOJI: Readonly<Record<NotificationSeverity, string>> = {
  critical: '🔴',
  warning: '🟠',
  info: '🔵',
  success: '🟢',
};

/** Severity → hex, matching the design system's status tones. */
export const SEVERITY_HEX: Readonly<Record<NotificationSeverity, string>> = {
  critical: '#ef4444',
  warning: '#f59e0b',
  info: '#22b8f5',
  success: '#22c55e',
};

/** Severity → integer colour, for Discord embeds. */
export const SEVERITY_INT: Readonly<Record<NotificationSeverity, number>> = {
  critical: 0xef4444,
  warning: 0xf59e0b,
  info: 0x22b8f5,
  success: 0x22c55e,
};

/**
 * The label/value rows every rich channel shows. Built once here so Slack,
 * Teams and Discord cannot drift into showing different facts for the same
 * event — a difference that is invisible until two people compare screens.
 */
export function payloadFacts(payload: NotificationPayload): Array<{ label: string; value: string }> {
  const facts: Array<{ label: string; value: string }> = [];

  if (payload.ticket) {
    facts.push({ label: 'Ticket', value: payload.ticket.number });
    facts.push({ label: 'Status', value: payload.ticket.statusSlug });
    facts.push({ label: 'Priority', value: payload.ticket.prioritySlug });
    facts.push({ label: 'Queue', value: payload.ticket.queueSlug });
    if (payload.ticket.assigneeName) {
      facts.push({ label: 'Assignee', value: payload.ticket.assigneeName });
    }
    if (payload.ticket.requesterName) {
      facts.push({ label: 'Requester', value: payload.ticket.requesterName });
    }
    if (payload.ticket.organizationName) {
      facts.push({ label: 'Organization', value: payload.ticket.organizationName });
    }
    // Surfaced explicitly whenever it differs from created_at: an outage that
    // started at 02:14 and was ticketed at 08:30 keeps 02:14 (HARD RULE 6),
    // and the notification is the first place an operator sees that gap.
    if (payload.ticket.occurredAt && payload.ticket.occurredAt !== payload.ticket.createdAt) {
      facts.push({ label: 'Occurred at', value: payload.ticket.occurredAt });
    }
  }

  if (payload.sla) {
    facts.push({
      label: 'SLA target',
      value: `${payload.sla.targetSlug} (${payload.sla.policySlug})`,
    });
    if (payload.sla.dueAt) facts.push({ label: 'Due', value: payload.sla.dueAt });
    facts.push({ label: 'Elapsed', value: `${Math.round(payload.sla.percentElapsed)}%` });
  }

  if (payload.approval) {
    facts.push({ label: 'Approval', value: payload.approval.definitionSlug });
    facts.push({ label: 'Approval state', value: payload.approval.state });
  }

  if (payload.facts) facts.push(...payload.facts);

  return facts;
}

/** Escape for HTML contexts (email bodies, Telegram's HTML parse mode). */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** How long a plugin waits on a remote endpoint before giving up and retrying. */
export const PLUGIN_TIMEOUT_MS = 10_000;

/** The canned payload behind every plugin's "send test". */
export function testPayload(overrides: Partial<NotificationPayload> = {}): NotificationPayload {
  const now = new Date().toISOString();
  return {
    event: 'ticket.created',
    appName: 'Oblidesk',
    tenantSlug: 'default',
    tenantName: 'Default',
    title: 'Test notification from Oblidesk',
    body:
      'This is a test notification. If you can read this, the channel is wired up correctly.',
    severity: 'info',
    url: undefined,
    ticket: {
      id: 0,
      number: 'TKT-0000',
      subject: 'Test ticket — printer on floor 2 is offline',
      recordType: 'incident',
      statusSlug: 'new',
      statusCategory: 'new',
      prioritySlug: 'p3',
      queueSlug: 'general',
      assigneeName: null,
      requesterName: 'Test Requester',
      organizationName: null,
      occurredAt: now,
      createdAt: now,
    },
    occurredAt: now,
    locale: 'en',
    ...overrides,
  };
}
