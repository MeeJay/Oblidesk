// ─────────────────────────────────────────────────────────────────────────────
// Status CATEGORIES — HARD RULE 5, single source of truth.
//
// Statuses themselves are CONFIGURABLE (config_objects kind='state_machine',
// each StatusSpec carries a slug + a label + a MANDATORY `category`). The
// category enum below is HARD-CODED and never configurable.
//
// EVERY engine (routing, priority, SLA, assignment, escalation, approval,
// rules, alert binding, reporting, portal visibility, saved views) keys off the
// CATEGORY — never off the status slug. A tenant may rename "in_progress" to
// "chez le technicien"; the category stays `open` and every engine keeps
// working.
//
// Adding a category here is a breaking change: it must be added to
//   - server migration 002 (tickets.status_category CHECK constraint)
//   - the state_machine body_format_version bump (configKinds.ts)
//   - the i18n bundles (en + fr)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ordered for display: intake → active work → waiting → done.
 * The union type is derived from this array so the two can never drift.
 */
export const STATUS_CATEGORIES = [
  'new',
  'open',
  'pending_requester',
  'pending_third_party',
  'scheduled',
  'resolved',
  'closed',
  'cancelled',
] as const;

export type StatusCategory = (typeof STATUS_CATEGORIES)[number];

/**
 * Visual tone a category maps to. Consumers translate the tone into design
 * tokens (`--c-status-*`) — never hard-code a colour against a category.
 */
export type StatusTone =
  | 'info'      // brand-neutral, freshly arrived
  | 'active'    // being worked
  | 'waiting'   // blocked on somebody else
  | 'scheduled' // planned for a future window
  | 'success'   // fixed
  | 'neutral'   // archived / done
  | 'muted';    // abandoned

export interface StatusCategoryMeta {
  /** The category key itself. */
  readonly category: StatusCategory;
  /** i18n key — always paired with `label` as the inline English fallback. */
  readonly labelKey: string;
  /** Inline English fallback (HARD RULE 10). */
  readonly label: string;
  /** Display / sort weight. Stable — persisted in saved views. */
  readonly order: number;
  /** Design-token tone (see `StatusTone`). */
  readonly tone: StatusTone;
  /** Ticket still occupies a queue and shows in "open" counters. */
  readonly countsAsOpen: boolean;
  /** Waiting on a human outside the desk (requester / vendor). */
  readonly pending: boolean;
  /** SLA clocks PAUSE while the ticket sits in this category. */
  readonly pausesSla: boolean;
  /** SLA clocks STOP (met / cancelled) when the ticket enters this category. */
  readonly stopsSla: boolean;
  /** No further agent work is expected — the ticket is done. */
  readonly terminal: boolean;
  /** A ticket in this category may be reopened. */
  readonly reopenable: boolean;
  /** An agent can pick the ticket up and act on it right now. */
  readonly workable: boolean;
  /** Shown to portal contacts as an "in progress" state. */
  readonly portalActive: boolean;
}

export const STATUS_CATEGORY_META: Readonly<Record<StatusCategory, StatusCategoryMeta>> = {
  new: {
    category: 'new',
    labelKey: 'status.category.new',
    label: 'New',
    order: 10,
    tone: 'info',
    countsAsOpen: true,
    pending: false,
    pausesSla: false,
    stopsSla: false,
    terminal: false,
    reopenable: false,
    workable: true,
    portalActive: true,
  },
  open: {
    category: 'open',
    labelKey: 'status.category.open',
    label: 'Open',
    order: 20,
    tone: 'active',
    countsAsOpen: true,
    pending: false,
    pausesSla: false,
    stopsSla: false,
    terminal: false,
    reopenable: false,
    workable: true,
    portalActive: true,
  },
  pending_requester: {
    category: 'pending_requester',
    labelKey: 'status.category.pendingRequester',
    label: 'Pending requester',
    order: 30,
    tone: 'waiting',
    countsAsOpen: true,
    pending: true,
    pausesSla: true,
    stopsSla: false,
    terminal: false,
    reopenable: false,
    workable: false,
    portalActive: true,
  },
  pending_third_party: {
    category: 'pending_third_party',
    labelKey: 'status.category.pendingThirdParty',
    label: 'Pending third party',
    order: 40,
    tone: 'waiting',
    countsAsOpen: true,
    pending: true,
    pausesSla: true,
    stopsSla: false,
    terminal: false,
    reopenable: false,
    workable: false,
    portalActive: true,
  },
  scheduled: {
    category: 'scheduled',
    labelKey: 'status.category.scheduled',
    label: 'Scheduled',
    order: 50,
    tone: 'scheduled',
    countsAsOpen: true,
    pending: false,
    pausesSla: true,
    stopsSla: false,
    terminal: false,
    reopenable: false,
    workable: false,
    portalActive: true,
  },
  resolved: {
    category: 'resolved',
    labelKey: 'status.category.resolved',
    label: 'Resolved',
    order: 60,
    tone: 'success',
    countsAsOpen: false,
    pending: false,
    pausesSla: false,
    stopsSla: true,
    // `resolved` is NOT terminal: the requester can still push back and the
    // auto-close job has not run yet.
    terminal: false,
    reopenable: true,
    workable: false,
    portalActive: false,
  },
  closed: {
    category: 'closed',
    labelKey: 'status.category.closed',
    label: 'Closed',
    order: 70,
    tone: 'neutral',
    countsAsOpen: false,
    pending: false,
    pausesSla: false,
    stopsSla: true,
    terminal: true,
    reopenable: true,
    workable: false,
    portalActive: false,
  },
  cancelled: {
    category: 'cancelled',
    labelKey: 'status.category.cancelled',
    label: 'Cancelled',
    order: 80,
    tone: 'muted',
    countsAsOpen: false,
    pending: false,
    pausesSla: false,
    stopsSla: true,
    terminal: true,
    reopenable: false,
    workable: false,
    portalActive: false,
  },
};

/** Ordered display list — the canonical order for chips, filters and reports. */
export const STATUS_CATEGORY_ORDER: readonly StatusCategory[] = [...STATUS_CATEGORIES]
  .sort((a, b) => STATUS_CATEGORY_META[a].order - STATUS_CATEGORY_META[b].order);

// ── Type guards ──────────────────────────────────────────────────────────────

/** Total type guard — never throws, accepts anything. */
export function isStatusCategory(value: unknown): value is StatusCategory {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(STATUS_CATEGORY_META, value);
}

/**
 * Coerce an untrusted value (config import, API payload, legacy row) to a
 * category. Returns `fallback` (default `'open'`) rather than throwing so a bad
 * row can never take an engine down.
 */
export function toStatusCategory(value: unknown, fallback: StatusCategory = 'open'): StatusCategory {
  return isStatusCategory(value) ? value : fallback;
}

// ── Engine predicates ────────────────────────────────────────────────────────

/** Ticket is done and no further agent work is expected (closed / cancelled). */
export function isTerminal(category: StatusCategory): boolean {
  return STATUS_CATEGORY_META[category].terminal;
}

/** Waiting on a human outside the desk (requester or vendor). */
export function isPending(category: StatusCategory): boolean {
  return STATUS_CATEGORY_META[category].pending;
}

/** SLA clocks pause while the ticket sits here (pending_* and scheduled). */
export function pausesSla(category: StatusCategory): boolean {
  return STATUS_CATEGORY_META[category].pausesSla;
}

/** SLA clocks stop for good here (resolved / closed / cancelled). */
export function stopsSla(category: StatusCategory): boolean {
  return STATUS_CATEGORY_META[category].stopsSla;
}

/** Ticket still occupies a queue / shows in "open" counters. */
export function countsAsOpen(category: StatusCategory): boolean {
  return STATUS_CATEGORY_META[category].countsAsOpen;
}

/** An agent can act on the ticket right now (new / open). */
export function isWorkable(category: StatusCategory): boolean {
  return STATUS_CATEGORY_META[category].workable;
}

/** The ticket may be reopened from here (resolved / closed). */
export function canReopen(category: StatusCategory): boolean {
  return STATUS_CATEGORY_META[category].reopenable;
}

/** Portal contacts see the ticket as still in flight. */
export function isPortalActive(category: StatusCategory): boolean {
  return STATUS_CATEGORY_META[category].portalActive;
}

/** Design-token tone for the category chip. */
export function statusCategoryTone(category: StatusCategory): StatusTone {
  return STATUS_CATEGORY_META[category].tone;
}

/** i18n key + inline English fallback, ready for `t(key, fallback)`. */
export function statusCategoryLabel(category: StatusCategory): { key: string; fallback: string } {
  const meta = STATUS_CATEGORY_META[category];
  return { key: meta.labelKey, fallback: meta.label };
}

/** Stable comparator for lists grouped by category. */
export function compareStatusCategories(a: StatusCategory, b: StatusCategory): number {
  return STATUS_CATEGORY_META[a].order - STATUS_CATEGORY_META[b].order;
}

// ── Derived sets (frozen — safe to share) ────────────────────────────────────

export const OPEN_STATUS_CATEGORIES: readonly StatusCategory[] =
  STATUS_CATEGORY_ORDER.filter(countsAsOpen);

export const PENDING_STATUS_CATEGORIES: readonly StatusCategory[] =
  STATUS_CATEGORY_ORDER.filter(isPending);

export const SLA_PAUSING_STATUS_CATEGORIES: readonly StatusCategory[] =
  STATUS_CATEGORY_ORDER.filter(pausesSla);

export const SLA_STOPPING_STATUS_CATEGORIES: readonly StatusCategory[] =
  STATUS_CATEGORY_ORDER.filter(stopsSla);

export const TERMINAL_STATUS_CATEGORIES: readonly StatusCategory[] =
  STATUS_CATEGORY_ORDER.filter(isTerminal);

/**
 * Categories a transition may NOT leave without an explicit reopen action.
 * Used by the state-machine validator and by the portal.
 */
export const CLOSED_LIKE_STATUS_CATEGORIES: readonly StatusCategory[] = ['resolved', 'closed', 'cancelled'];
