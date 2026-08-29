/**
 * anonymize.ts — "anonymous mode", for screen-sharing a live desk.
 *
 * The point is a demo or a support call where the agent's screen is visible to
 * people who must not read customer identities. It masks what is rendered; it
 * changes nothing about what was fetched, so it is a courtesy, not a control.
 * Never treat it as one: the data is still in the page.
 *
 * Every masker keeps enough shape for the agent to tell two rows apart (the
 * first characters, the domain's last label, the digit count) and destroys the
 * rest. A mask that collapses everything to "•••" makes the screen unusable
 * and the feature gets switched off, which protects nobody.
 */

import { useAuthStore } from '@/store/authStore';

const DOT = '•';

/** Is anonymous mode on for the signed-in user? */
export function isAnonymous(): boolean {
  return useAuthStore.getState().user?.preferences?.anonymousMode === true;
}

function mask(length: number, max = 8): string {
  return DOT.repeat(Math.max(1, Math.min(length, max)));
}

/** 'Marie Dupont' → 'Ma••••••••'. Keeps two characters so rows stay distinct. */
export function anonName(value: string | null | undefined): string {
  if (!value) return '—';
  if (!isAnonymous()) return value;
  if (value.length <= 2) return mask(2);
  return value.slice(0, 2) + mask(value.length - 2);
}

/** 'marie.dupont@acme.fr' → 'm•••••@•••.fr'. The TLD survives; it is not PII. */
export function anonEmail(value: string | null | undefined): string {
  if (!value) return '—';
  if (!isAnonymous()) return value;
  const at = value.indexOf('@');
  if (at <= 0) return anonName(value);
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const labels = domain.split('.');
  const tld = labels.length > 1 ? `.${labels[labels.length - 1]}` : '';
  return `${local[0]}${mask(local.length - 1, 6)}@${mask(4, 4)}${tld}`;
}

/** 'ACME Industries' → 'AC•••••••'. */
export function anonOrg(value: string | null | undefined): string {
  return anonName(value);
}

/** '+33 6 12 34 56 78' → '+33 •• •• •• ••' — the country code stays readable. */
export function anonPhone(value: string | null | undefined): string {
  if (!value) return '—';
  if (!isAnonymous()) return value;
  const trimmed = value.trim();
  const prefix = trimmed.startsWith('+') ? trimmed.slice(0, 3) : '';
  return `${prefix}${prefix ? ' ' : ''}${mask(8, 8)}`;
}

/**
 * A ticket subject. Kept longest of all, because an agent navigating a masked
 * queue has nothing else to steer by — the first three words survive.
 */
export function anonSubject(value: string | null | undefined): string {
  if (!value) return '—';
  if (!isAnonymous()) return value;
  const words = value.split(/\s+/);
  const head = words.slice(0, 3).join(' ');
  return words.length > 3 ? `${head} ${mask(6, 6)}` : head;
}

/** Free text — a journal body, a work note. Nothing survives. */
export function anonBody(value: string | null | undefined): string {
  if (!value) return '';
  if (!isAnonymous()) return value;
  return `${DOT.repeat(3)} contenu masqué ${DOT.repeat(3)}`;
}

/** 'srv-prod-01' → 'srv-•••••••'. Matches Obliguard so a CI reads the same. */
export function anonHostname(value: string | null | undefined): string {
  if (!value) return '—';
  if (!isAnonymous()) return value;
  if (value.length <= 3) return mask(3, 3);
  return value.slice(0, 3) + mask(value.length - 3);
}

/** '192.168.1.42' → '192.•••.•.••'. CIDR suffix is preserved. */
export function anonIp(value: string | null | undefined): string {
  if (!value) return '—';
  if (!isAnonymous()) return value;

  let cidr = '';
  let ip = value;
  const slash = value.indexOf('/');
  if (slash !== -1) {
    cidr = value.slice(slash);
    ip = value.slice(0, slash);
  }
  if (ip.includes(':')) {
    const parts = ip.split(':');
    return parts[0] + ':' + parts.slice(1).map(() => DOT.repeat(4)).join(':') + cidr;
  }
  const parts = ip.split('.');
  return parts[0] + '.' + parts.slice(1).map((p) => DOT.repeat(p.length)).join('.') + cidr;
}

/** A ticket number stays readable — it identifies work, not a person. */
export function anonTicketNumber(value: string | null | undefined): string {
  return value ?? '—';
}

/** '/var/log/auth.log' → '/•••/•••/••••.•••'. */
export function anonPath(value: string | null | undefined): string {
  if (!value) return '—';
  if (!isAnonymous()) return value;
  return value.replace(/[^/\\]+/g, (segment) => DOT.repeat(Math.min(segment.length, 6)));
}

/**
 * A person shaped like the joins the ticket DTOs carry. One call for an avatar
 * chip instead of three at every call site.
 */
export function anonPerson(
  person: { displayName?: string | null; username?: string | null; email?: string | null } | null | undefined,
): string {
  if (!person) return '—';
  const label = person.displayName || person.username || person.email || null;
  if (!label) return '—';
  return label.includes('@') ? anonEmail(label) : anonName(label);
}
