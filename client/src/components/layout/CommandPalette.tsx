import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Building2,
  Compass,
  CornerDownLeft,
  FileText,
  Flag,
  GitMerge,
  Moon,
  Palette,
  Repeat,
  Search,
  Ticket,
  UserPlus,
  Wand2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  APP_THEMES,
  ROW_VERSION_HEADER,
  STATUS_CATEGORY_META,
  type AppTheme,
  type StatusCategory,
} from '@oblidesk/shared';
import { useTenantStore } from '@/store/tenantStore';
import { applyTheme } from '@/utils/theme';
import { cn } from '@/utils/cn';
import { normalizeTenants } from './TenantSwitcher';

// ═════════════════════════════════════════════════════════════════════════════
// Public registry API
//
// The palette is a HOST, not a catalogue. It ships the cross-cutting commands
// below, and any page can contribute its own for as long as it is mounted:
//
//   useEffect(() => registerCommands([
//     { id: 'kb.publish', group: 'ticket', title: t('kb.publish', 'Publier'),
//       run: () => publish(article.id) },
//   ]), [article.id]);
//
// `registerCommands` returns its own unregister function, so the effect above
// cleans itself up — a command can never outlive the page that meant it.
// ═════════════════════════════════════════════════════════════════════════════

export type CommandGroup = 'ticket' | 'navigate' | 'workspace';

export interface CommandOption {
  id: string;
  /** Already-translated. */
  label: string;
  /** Right-hand hint: a status category, a rank, a ticket subject. */
  hint?: string;
  /** Extra fuzzy-match fodder that is not displayed. */
  keywords?: string;
  /** Leading dot colour, any CSS colour. */
  color?: string;
}

export interface CommandArgument {
  kind: 'select' | 'text';
  /** Translated placeholder for the second-step input. */
  placeholder: string;
  /** `select` only. Called once when the command is picked. */
  load?: (query: string) => Promise<CommandOption[]>;
  /** `select` only — re-run `load` on every keystroke (server-side search). */
  remote?: boolean;
  /** `text` only — reject empty input rather than running with "". */
  requireValue?: boolean;
}

export interface CommandRunContext {
  navigate: (to: string) => void;
  close: () => void;
}

export interface CommandDef {
  id: string;
  group: CommandGroup;
  /** Already-translated. */
  title: string;
  /** Already-translated second line. */
  subtitle?: string;
  /** Untranslated extra match terms (English + French) — never displayed. */
  keywords?: string;
  /**
   * A single-character prefix that jumps straight into this command. Typing it
   * as the first character of an empty query enters the command's argument step
   * with everything after it as the argument query, exactly like `@` in a chat
   * client. This is the "shortcut" shown on the row.
   */
  prefix?: string;
  icon?: ReactNode;
  argument?: CommandArgument;
  /** Hide when the command cannot apply right now (no ticket open, no rights). */
  available?: () => boolean;
  run: (value: string | null, context: CommandRunContext) => void | Promise<void>;
}

type Batch = { id: number; commands: CommandDef[] };

let batchSeq = 0;
let batches: Batch[] = [];
let open = false;

const registryListeners = new Set<() => void>();
const openListeners = new Set<() => void>();

/** Cached flat snapshot — `useSyncExternalStore` requires a stable reference. */
let flatCache: CommandDef[] = [];

function recomputeFlat() {
  flatCache = batches.flatMap((batch) => batch.commands);
  for (const listener of registryListeners) listener();
}

/** Register a batch of commands. Returns the unregister function. */
export function registerCommands(commands: CommandDef[]): () => void {
  const id = ++batchSeq;
  batches = [...batches, { id, commands }];
  recomputeFlat();
  return () => {
    batches = batches.filter((batch) => batch.id !== id);
    recomputeFlat();
  };
}

/** Every currently registered command, in registration order. */
export function useCommandRegistry(): CommandDef[] {
  return useSyncExternalStore(
    (listener) => {
      registryListeners.add(listener);
      return () => registryListeners.delete(listener);
    },
    () => flatCache,
    () => flatCache,
  );
}

function setOpen(value: boolean) {
  if (open === value) return;
  open = value;
  for (const listener of openListeners) listener();
}

export function openCommandPalette() {
  setOpen(true);
}
export function closeCommandPalette() {
  setOpen(false);
}

function useCommandPaletteOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      openListeners.add(listener);
      return () => openListeners.delete(listener);
    },
    () => open,
    () => open,
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Fuzzy matching
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Subsequence scoring. Matching characters score 1, a match at a word boundary
 * scores 3, and a run of consecutive matches compounds — so "aut" ranks
 * "Automatisation" above "Ajouter une note interne", which merely contains the
 * three letters scattered.
 *
 * Returns null when the needle is not a subsequence at all.
 */
function fuzzyScore(haystack: string, needle: string): number | null {
  if (!needle) return 0;
  const text = haystack.toLowerCase();
  const query = needle.toLowerCase();

  let score = 0;
  let cursor = 0;
  let run = 0;

  for (const char of query) {
    const index = text.indexOf(char, cursor);
    if (index === -1) return null;
    const boundary = index === 0 || /[\s\-_/:.]/.test(text[index - 1] ?? '');
    score += boundary ? 3 : 1;
    run = index === cursor ? run + 1 : 0;
    score += run;
    cursor = index + 1;
  }

  // Shorter targets win ties: "Tickets" beats "Temps et contrats" for "t".
  return score - text.length * 0.01;
}

// ═════════════════════════════════════════════════════════════════════════════
// Recents
// ═════════════════════════════════════════════════════════════════════════════

const RECENTS_KEY = 'oblidesk:commandPalette:recent';
const RECENTS_MAX = 8;

function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function pushRecent(id: string) {
  try {
    const next = [id, ...loadRecents().filter((entry) => entry !== id)].slice(0, RECENTS_MAX);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Minimal API helpers
//
// Deliberately raw `fetch` rather than the axios client: the palette must keep
// working on a page that has not booted its own data layer, and the envelope is
// two fields wide.
// ═════════════════════════════════════════════════════════════════════════════

interface Envelope<T> {
  success?: boolean;
  data?: T;
  error?: string;
}

async function apiGet<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, { credentials: 'include' });
    const body = (await response.json()) as Envelope<T>;
    return body?.success && body.data !== undefined ? body.data : null;
  } catch {
    return null;
  }
}

interface MutateResult {
  ok: boolean;
  /** 409 — somebody else changed the ticket since we read it (HARD RULE 7). */
  conflict: boolean;
  error?: string;
}

async function apiMutate(
  url: string,
  method: 'POST' | 'PATCH',
  body: unknown,
  rowVersion?: number | null,
): Promise<MutateResult> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // HARD RULE 7 — every ticket mutation declares the version it read.
    if (rowVersion != null) headers[ROW_VERSION_HEADER] = String(rowVersion);

    const response = await fetch(url, {
      method,
      credentials: 'include',
      headers,
      body: JSON.stringify(body),
    });

    if (response.status === 409) return { ok: false, conflict: true };
    const payload = (await response.json().catch(() => null)) as Envelope<unknown> | null;
    return {
      ok: response.ok && payload?.success !== false,
      conflict: false,
      error: payload?.error,
    };
  } catch {
    return { ok: false, conflict: false };
  }
}

interface TicketHead {
  id: number;
  key?: string;
  rowVersion: number;
  subject?: string;
}

/**
 * Read the ticket's current `row_version` immediately before mutating it. The
 * palette does not hold ticket state of its own, so it cannot reuse a version
 * some page read minutes ago — that is exactly the stale write HARD RULE 7
 * exists to catch.
 */
async function readTicketHead(idOrKey: string): Promise<TicketHead | null> {
  const data = await apiGet<Record<string, unknown>>(
    `/api/tickets/${encodeURIComponent(idOrKey)}`,
  );
  if (!data) return null;
  const id = typeof data.id === 'number' ? data.id : Number(idOrKey);
  const rowVersion =
    typeof data.rowVersion === 'number'
      ? data.rowVersion
      : typeof data.row_version === 'number'
        ? data.row_version
        : 1;
  return {
    id,
    key: typeof data.key === 'string' ? data.key : undefined,
    subject: typeof data.subject === 'string' ? data.subject : undefined,
    rowVersion,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Palette
// ═════════════════════════════════════════════════════════════════════════════

const GROUP_ORDER: CommandGroup[] = ['ticket', 'navigate', 'workspace'];

interface Row {
  command: CommandDef;
  score: number;
  recentRank: number;
}

export function CommandPalette() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const isOpen = useCommandPaletteOpen();
  const contributed = useCommandRegistry();
  const { memberships, currentTenantId, switchTenant } = useTenantStore();

  const [query, setQuery] = useState('');
  const [active, setActive] = useState<CommandDef | null>(null);
  const [argQuery, setArgQuery] = useState('');
  const [options, setOptions] = useState<CommandOption[] | null>(null);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // ── The ticket in context ──────────────────────────────────────────────────
  // Derived from the URL rather than from a store, so the ticket-scoped commands
  // work on any route that renders a ticket, and vanish everywhere else.
  const ticketRef = useMemo(() => {
    const match = /^\/tickets\/([^/?#]+)/.exec(location.pathname);
    const value = match?.[1];
    return value && value !== 'new' ? decodeURIComponent(value) : null;
  }, [location.pathname]);

  const closeAll = useCallback(() => {
    setOpen(false);
    setQuery('');
    setActive(null);
    setArgQuery('');
    setOptions(null);
    setCursor(0);
    setBusy(false);
  }, []);

  const runContext = useMemo<CommandRunContext>(
    () => ({ navigate: (to: string) => navigate(to), close: closeAll }),
    [navigate, closeAll],
  );

  // ── Ticket mutation helper shared by the ticket commands ───────────────────
  const mutateTicket = useCallback(
    async (
      build: (head: TicketHead) => { url: string; method: 'POST' | 'PATCH'; body: unknown },
      successMessage: string,
    ) => {
      if (!ticketRef) return;
      setBusy(true);
      try {
        const head = await readTicketHead(ticketRef);
        if (!head) {
          toast.error(t('palette.ticketNotFound', 'Ticket introuvable'));
          return;
        }
        const request = build(head);
        const result = await apiMutate(request.url, request.method, request.body, head.rowVersion);
        if (result.conflict) {
          toast.error(
            t(
              'palette.conflict',
              'Le ticket a change entre-temps. Rechargez-le puis reessayez.',
            ),
          );
          return;
        }
        if (!result.ok) {
          toast.error(result.error ?? t('palette.actionFailed', "L'action a echoue"));
          return;
        }
        toast.success(successMessage);
        closeAll();
      } finally {
        setBusy(false);
      }
    },
    [ticketRef, t, closeAll],
  );

  // ── Built-in commands ──────────────────────────────────────────────────────
  const builtins = useMemo<CommandDef[]>(() => {
    const hasTicket = () => ticketRef !== null;

    const navTargets: Array<{ id: string; path: string; label: string; key: string }> = [
      { id: 'shiftBoard', path: '/', key: 'nav.shiftBoard', label: 'Shift Board' },
      { id: 'board', path: '/board', key: 'nav.kanban', label: 'Vue kanban' },
      { id: 'tickets', path: '/tickets', key: 'nav.tickets', label: 'Tickets' },
      { id: 'grid', path: '/grid', key: 'nav.gridView', label: 'Vue tableau' },
      { id: 'assets', path: '/ci', key: 'nav.assets', label: 'Actifs' },
      { id: 'problems', path: '/problems', key: 'nav.problems', label: 'Problemes' },
      { id: 'changes', path: '/changes', key: 'nav.changes', label: 'Changements' },
      { id: 'kb', path: '/kb', key: 'nav.knowledge', label: 'Connaissance' },
      { id: 'catalog', path: '/catalog', key: 'nav.catalog', label: 'Catalogue' },
      { id: 'dashboards', path: '/dashboards', key: 'nav.dashboards', label: 'Tableaux de bord' },
      {
        id: 'automation',
        path: '/admin/automation',
        key: 'nav.automation',
        label: 'Automatisation',
      },
      { id: 'sla', path: '/admin/sla', key: 'nav.slaAndTeams', label: 'SLA et equipes' },
      {
        id: 'contracts',
        path: '/admin/contracts',
        key: 'nav.timeAndContracts',
        label: 'Temps et contrats',
      },
      { id: 'channels', path: '/admin/channels', key: 'nav.channels', label: 'Canaux' },
      { id: 'config', path: '/admin/config', key: 'nav.configuration', label: 'Configuration' },
      { id: 'users', path: '/admin/users', key: 'nav.users', label: 'Utilisateurs' },
      { id: 'tenantsAdmin', path: '/admin/tenants', key: 'nav.tenants', label: 'Tenants' },
      { id: 'settings', path: '/settings', key: 'nav.settings', label: 'Parametres' },
    ];

    const list: CommandDef[] = [
      // ── Ticket actions ─────────────────────────────────────────────────────
      {
        id: 'ticket.assign',
        group: 'ticket',
        title: t('palette.assign', 'Assigner a…'),
        keywords: 'assign assignee owner attribuer proprietaire',
        prefix: '@',
        icon: <UserPlus size={15} />,
        available: hasTicket,
        argument: {
          kind: 'select',
          placeholder: t('palette.assignPlaceholder', 'Chercher un agent'),
          load: async () => {
            const users = await apiGet<Array<Record<string, unknown>>>('/api/users?limit=200');
            return (users ?? []).map((user) => ({
              id: String(user.id),
              label: String(user.displayName || user.username || user.id),
              hint: typeof user.username === 'string' ? user.username : undefined,
              keywords: `${user.username ?? ''} ${user.email ?? ''}`,
            }));
          },
        },
        run: (value) =>
          mutateTicket(
            (head) => ({
              url: `/api/tickets/${head.id}`,
              method: 'PATCH',
              body: { assigneeId: value === null ? null : Number(value) },
            }),
            t('palette.assigned', 'Ticket assigne'),
          ),
      },
      {
        id: 'ticket.status',
        group: 'ticket',
        title: t('palette.changeStatus', 'Changer le statut'),
        keywords: 'status statut transition etat resolve close',
        prefix: '#',
        icon: <Repeat size={15} />,
        available: hasTicket,
        argument: {
          kind: 'select',
          placeholder: t('palette.statusPlaceholder', 'Chercher un statut'),
          load: async () => {
            const statuses = await apiGet<Array<Record<string, unknown>>>('/api/config/statuses');
            return (statuses ?? []).map((status) => {
              const category = String(status.category) as StatusCategory;
              const meta = STATUS_CATEGORY_META[category];
              return {
                id: String(status.slug),
                label: String(status.label || status.slug),
                // Show the CATEGORY, not the slug: the category is what the SLA
                // clock and every other engine will actually react to.
                hint: meta ? t(meta.labelKey, meta.label) : String(status.category ?? ''),
                keywords: `${status.slug} ${status.category ?? ''}`,
                color: meta ? `rgb(var(--c-status-${category.replace(/_/g, '-')}))` : undefined,
              };
            });
          },
        },
        run: (value) =>
          mutateTicket(
            (head) => ({
              // A status change is a TRANSITION, not a field write: it is the one
              // place required-ness is enforced (HARD RULE 12), so it must go
              // through the transition endpoint even from the palette.
              url: `/api/tickets/${head.id}/transition`,
              method: 'POST',
              body: { toStatusSlug: value },
            }),
            t('palette.statusChanged', 'Statut mis a jour'),
          ),
      },
      {
        id: 'ticket.priority',
        group: 'ticket',
        title: t('palette.setPriority', 'Definir la priorite'),
        keywords: 'priority priorite urgent p1 p2 p3 p4',
        prefix: '!',
        icon: <Flag size={15} />,
        available: hasTicket,
        argument: {
          kind: 'select',
          placeholder: t('palette.priorityPlaceholder', 'Chercher une priorite'),
          load: async () => {
            const priorities =
              await apiGet<Array<Record<string, unknown>>>('/api/config/priorities');
            return (priorities ?? []).map((priority) => {
              const rank = Number(priority.rank ?? 3);
              const clamped = Math.min(4, Math.max(1, rank));
              return {
                id: String(priority.slug),
                label: String(priority.label || priority.slug),
                hint: `P${clamped}`,
                keywords: `${priority.slug} p${clamped}`,
                color: `rgb(var(--c-priority-p${clamped}))`,
              };
            });
          },
        },
        run: (value) =>
          mutateTicket(
            (head) => ({
              url: `/api/tickets/${head.id}`,
              method: 'PATCH',
              body: { prioritySlug: value },
            }),
            t('palette.priorityChanged', 'Priorite mise a jour'),
          ),
      },
      {
        id: 'ticket.note',
        group: 'ticket',
        title: t('palette.addWorkNote', 'Ajouter une note interne'),
        subtitle: t('palette.addWorkNoteHint', 'Invisible pour le demandeur'),
        keywords: 'note interne work note comment commentaire prive',
        prefix: '>',
        icon: <FileText size={15} />,
        available: hasTicket,
        argument: {
          kind: 'text',
          placeholder: t('palette.workNotePlaceholder', 'Ecrire la note interne…'),
          requireValue: true,
        },
        run: (value) =>
          mutateTicket(
            (head) => ({
              url: `/api/tickets/${head.id}/journal`,
              method: 'POST',
              body: { kind: 'work_note', visibility: 'internal', bodyMd: value ?? '' },
            }),
            t('palette.workNoteAdded', 'Note interne ajoutee'),
          ),
      },
      {
        id: 'ticket.macro',
        group: 'ticket',
        title: t('palette.applyMacro', 'Appliquer une macro'),
        keywords: 'macro modele canned reponse template',
        prefix: '%',
        icon: <Wand2 size={15} />,
        available: hasTicket,
        argument: {
          kind: 'select',
          placeholder: t('palette.macroPlaceholder', 'Chercher une macro'),
          load: async () => {
            const macros = await apiGet<Array<Record<string, unknown>>>('/api/config/macros');
            return (macros ?? []).map((macro) => ({
              id: String(macro.slug),
              label: String(macro.name || macro.slug),
              hint: typeof macro.slug === 'string' ? macro.slug : undefined,
            }));
          },
        },
        run: (value) =>
          mutateTicket(
            (head) => ({
              url: `/api/tickets/${head.id}/macros/${encodeURIComponent(value ?? '')}`,
              method: 'POST',
              body: {},
            }),
            t('palette.macroApplied', 'Macro appliquee'),
          ),
      },
      {
        id: 'ticket.merge',
        group: 'ticket',
        title: t('palette.merge', 'Fusionner avec…'),
        subtitle: t('palette.mergeHint', 'Ce ticket devient un doublon de la cible'),
        keywords: 'merge fusionner doublon duplicate',
        prefix: '&',
        icon: <GitMerge size={15} />,
        available: hasTicket,
        argument: {
          kind: 'select',
          remote: true,
          placeholder: t('palette.mergePlaceholder', 'Chercher le ticket cible'),
          load: async (search) => {
            if (search.trim().length < 2) return [];
            const hits = await apiGet<Array<Record<string, unknown>>>(
              `/api/search?q=${encodeURIComponent(search)}&limit=15`,
            );
            return (hits ?? [])
              .filter((hit) => String(hit.key ?? hit.id) !== ticketRef)
              .map((hit) => ({
                id: String(hit.id ?? hit.key),
                label: String(hit.subject ?? hit.key ?? hit.id),
                hint: typeof hit.key === 'string' ? hit.key : undefined,
              }));
          },
        },
        run: (value) =>
          mutateTicket(
            (head) => ({
              url: `/api/tickets/${head.id}/merge`,
              method: 'POST',
              body: { targetTicketId: Number(value) },
            }),
            t('palette.merged', 'Tickets fusionnes'),
          ),
      },
      {
        id: 'ticket.snooze',
        group: 'ticket',
        title: t('palette.snooze', 'Mettre en sommeil'),
        subtitle: t('palette.snoozeHint', 'Le ticket revient a la date choisie'),
        keywords: 'snooze sommeil reporter rappel wake later',
        prefix: '~',
        icon: <Moon size={15} />,
        available: hasTicket,
        argument: {
          kind: 'select',
          placeholder: t('palette.snoozePlaceholder', 'Reveiller dans…'),
          load: async () => [
            { id: '60', label: t('palette.snooze1h', '1 heure') },
            { id: '240', label: t('palette.snooze4h', '4 heures') },
            { id: '1440', label: t('palette.snooze1d', 'Demain') },
            { id: '4320', label: t('palette.snooze3d', '3 jours') },
            { id: '10080', label: t('palette.snooze1w', '1 semaine') },
          ],
        },
        run: (value) =>
          mutateTicket(
            (head) => ({
              url: `/api/tickets/${head.id}/snooze`,
              method: 'POST',
              body: { minutes: Number(value) },
            }),
            t('palette.snoozed', 'Ticket mis en sommeil'),
          ),
      },
      {
        id: 'ticket.open',
        group: 'ticket',
        title: t('palette.openTicket', 'Ouvrir un ticket par numero'),
        keywords: 'open ticket numero number key aller ouvrir',
        prefix: ':',
        icon: <Ticket size={15} />,
        argument: {
          kind: 'text',
          placeholder: t('palette.openTicketPlaceholder', 'TKT-1042 ou 1042'),
          requireValue: true,
        },
        run: (value, context) => {
          const raw = (value ?? '').trim();
          if (!raw) return;
          // Bare digits are a ticket NUMBER, not a row id — let the server
          // resolve either form; the route accepts both.
          context.navigate(`/tickets/${encodeURIComponent(raw.toUpperCase())}`);
          context.close();
        },
      },

      // ── Navigation ─────────────────────────────────────────────────────────
      ...navTargets.map<CommandDef>((target) => ({
        id: `nav.${target.id}`,
        group: 'navigate',
        title: t('palette.goTo', 'Aller a {{page}}', { page: t(target.key, target.label) }),
        keywords: `${target.label} ${target.path}`,
        icon: <Compass size={15} />,
        run: (_value, context) => {
          context.navigate(target.path);
          context.close();
        },
      })),

      // ── Workspace ──────────────────────────────────────────────────────────
      {
        id: 'workspace.tenant',
        group: 'workspace',
        title: t('palette.switchTenant', 'Changer de tenant'),
        keywords: 'tenant workspace espace client organisation',
        icon: <Building2 size={15} />,
        available: () => normalizeTenants(memberships).length > 1,
        argument: {
          kind: 'select',
          placeholder: t('palette.tenantPlaceholder', 'Chercher un tenant'),
          load: async () =>
            normalizeTenants(memberships).map((tenant) => ({
              id: String(tenant.id),
              label: tenant.name,
              hint: tenant.slug,
            })),
        },
        run: async (value) => {
          const id = Number(value);
          if (!Number.isFinite(id) || id === currentTenantId) return;
          await switchTenant(id);
          // Hard navigation — every tenant-scoped store has to be rebuilt.
          window.location.assign('/');
        },
      },
      {
        id: 'workspace.theme',
        group: 'workspace',
        title: t('palette.switchTheme', 'Changer de theme'),
        keywords: 'theme dark light sombre clair apparence',
        icon: <Palette size={15} />,
        argument: {
          kind: 'select',
          placeholder: t('palette.themePlaceholder', 'Choisir un theme'),
          load: async () =>
            APP_THEMES.map((theme) => ({
              id: theme,
              label: t(`theme.${theme}`, theme),
              hint: theme,
            })),
        },
        run: (value, context) => {
          applyTheme(value as AppTheme);
          context.close();
        },
      },
    ];

    return list;
  }, [t, ticketRef, mutateTicket, memberships, currentTenantId, switchTenant]);

  const allCommands = useMemo(
    () => [...builtins, ...contributed].filter((command) => command.available?.() !== false),
    [builtins, contributed],
  );

  // ── Prefix jump: "@" enters "Assigner a…" with the rest as the arg query ───
  useEffect(() => {
    if (active || query.length === 0) return;
    const first = query[0];
    if (/[a-z0-9\s]/i.test(first)) return;

    if (first === '/') {
      // "/" is reserved for the navigate group rather than one command.
      return;
    }
    const match = allCommands.find((command) => command.prefix === first);
    if (!match) return;
    setActive(match);
    setArgQuery(query.slice(1));
    setQuery('');
    setOptions(null);
    setCursor(0);
  }, [query, active, allCommands]);

  // ── Command list ───────────────────────────────────────────────────────────
  const recents = useMemo(() => (isOpen ? loadRecents() : []), [isOpen]);

  const rows = useMemo<Row[]>(() => {
    const navOnly = query.startsWith('/');
    const needle = (navOnly ? query.slice(1) : query).trim();
    const pool = navOnly
      ? allCommands.filter((command) => command.group === 'navigate')
      : allCommands;

    const scored: Row[] = [];
    for (const command of pool) {
      const haystack = `${command.title} ${command.subtitle ?? ''} ${command.keywords ?? ''}`;
      const score = fuzzyScore(haystack, needle);
      if (score === null) continue;
      const recentRank = recents.indexOf(command.id);
      scored.push({ command, score, recentRank });
    }

    scored.sort((a, b) => {
      // Group is the PRIMARY key so the painted list has exactly one heading
      // per group and its flat order matches this array — which is what the
      // keyboard cursor indexes into. Sorting by score first would interleave
      // groups and force either repeated headings or a second ordering that
      // disagrees with the cursor.
      const ga = GROUP_ORDER.indexOf(a.command.group);
      const gb = GROUP_ORDER.indexOf(b.command.group);
      if (ga !== gb) return ga - gb;

      // Inside a group: with no query, "what you just did" first; once the
      // agent types, relevance wins and recency only breaks ties.
      if (!needle) {
        const ar = a.recentRank === -1 ? 999 : a.recentRank;
        const br = b.recentRank === -1 ? 999 : b.recentRank;
        if (ar !== br) return ar - br;
      } else if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.command.title.localeCompare(b.command.title);
    });

    return scored.slice(0, 40);
  }, [allCommands, query, recents]);

  // ── Argument options ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!active?.argument || active.argument.kind !== 'select') {
      setOptions(null);
      return;
    }
    const loader = active.argument.load;
    if (!loader) {
      setOptions([]);
      return;
    }
    // Remote arguments (ticket search) re-query per keystroke; local ones load
    // once and are filtered in memory.
    if (!active.argument.remote && options !== null) return;

    let cancelled = false;
    setLoadingOptions(true);
    void loader(argQuery)
      .then((result) => {
        if (!cancelled) setOptions(result);
      })
      .catch(() => {
        if (!cancelled) setOptions([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingOptions(false);
      });
    return () => {
      cancelled = true;
    };
    // `options` is intentionally excluded: including it would re-run the effect
    // the moment it resolves and loop forever on the local-load branch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, argQuery]);

  const optionRows = useMemo(() => {
    if (!options) return [];
    if (active?.argument?.remote) return options;
    const needle = argQuery.trim();
    if (!needle) return options;
    return options
      .map((option) => ({
        option,
        score: fuzzyScore(`${option.label} ${option.hint ?? ''} ${option.keywords ?? ''}`, needle),
      }))
      .filter((entry): entry is { option: CommandOption; score: number } => entry.score !== null)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.option);
  }, [options, argQuery, active]);

  const maxCursor = active
    ? active.argument?.kind === 'select'
      ? Math.max(0, optionRows.length - 1)
      : 0
    : Math.max(0, rows.length - 1);

  useEffect(() => {
    setCursor((value) => Math.min(value, maxCursor));
  }, [maxCursor]);

  // ── Execution ──────────────────────────────────────────────────────────────
  const execute = useCallback(
    async (command: CommandDef, value: string | null) => {
      pushRecent(command.id);
      try {
        await command.run(value, runContext);
      } catch {
        toast.error(t('palette.actionFailed', "L'action a echoue"));
      }
    },
    [runContext, t],
  );

  const choose = useCallback(
    (command: CommandDef) => {
      if (command.argument) {
        setActive(command);
        setArgQuery('');
        setOptions(null);
        setCursor(0);
        return;
      }
      void execute(command, null);
    },
    [execute],
  );

  // ── Global hotkey ──────────────────────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen(!open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      setQuery('');
      setActive(null);
      setArgQuery('');
      setOptions(null);
      setCursor(0);
    }
  }, [isOpen]);

  // Keep the highlighted row on screen while arrowing through a long list.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-cursor="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [cursor, rows.length, optionRows.length]);

  if (!isOpen) return null;

  const inTextArgument = active?.argument?.kind === 'text';

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (active) {
        setActive(null);
        setArgQuery('');
        setOptions(null);
        setCursor(0);
      } else {
        closeAll();
      }
      return;
    }

    // Backspace on an empty argument steps back to the command list — the same
    // gesture as deleting the "@" you typed to get here.
    if (event.key === 'Backspace' && active && argQuery.length === 0) {
      event.preventDefault();
      setActive(null);
      setOptions(null);
      setCursor(0);
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setCursor((value) => (value >= maxCursor ? 0 : value + 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setCursor((value) => (value <= 0 ? maxCursor : value - 1));
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      if (busy) return;

      if (!active) {
        const row = rows[cursor];
        if (row) choose(row.command);
        return;
      }
      if (inTextArgument) {
        const value = argQuery.trim();
        if (active.argument?.requireValue && !value) return;
        void execute(active, value);
        return;
      }
      const option = optionRows[cursor];
      if (option) void execute(active, option.id);
    }
  };

  // ── Grouping for display ───────────────────────────────────────────────────
  const groupLabels: Record<CommandGroup, string> = {
    ticket: t('palette.groupTicket', 'Ticket'),
    navigate: t('palette.groupNavigate', 'Navigation'),
    workspace: t('palette.groupWorkspace', 'Espace de travail'),
  };

  // `rows` is already sorted group-first, so a run-length pass yields exactly
  // one section per group and preserves the flat index the cursor uses.
  const grouped: Array<{ group: CommandGroup; rows: Row[] }> = [];
  for (const row of rows) {
    const last = grouped[grouped.length - 1];
    if (last && last.group === row.command.group) last.rows.push(row);
    else grouped.push({ group: row.command.group, rows: [row] });
  }

  let flatIndex = -1;

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-start justify-center bg-bg-primary/70 px-4 py-[12vh] backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeAll();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('palette.title', 'Palette de commandes')}
        className="animate-scale-in flex w-full max-w-xl flex-col overflow-hidden rounded-modal bg-bg-secondary shadow-card"
      >
        {/* Query row */}
        <div className="flex items-center gap-2.5 px-4 py-3">
          {active ? (
            <span className="flex shrink-0 items-center gap-1.5 rounded-pill bg-accent/12 px-2 py-1 text-[12px] font-medium text-accent">
              {active.icon}
              {active.title}
            </span>
          ) : (
            <Search size={16} className="shrink-0 text-text-muted" />
          )}

          <input
            ref={inputRef}
            value={active ? argQuery : query}
            onChange={(event) =>
              active ? setArgQuery(event.target.value) : setQuery(event.target.value)
            }
            onKeyDown={handleKeyDown}
            placeholder={
              active
                ? active.argument?.placeholder
                : t('palette.placeholder', 'Tapez une commande ou cherchez…')
            }
            aria-label={t('palette.title', 'Palette de commandes')}
            className="min-w-0 flex-1 bg-transparent text-[14px] text-text-primary outline-none placeholder:text-text-muted"
            autoComplete="off"
            spellCheck={false}
          />

          {busy && (
            <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">
              {t('common.working', 'En cours…')}
            </span>
          )}
        </div>

        <div className="h-px bg-border" />

        {/* Results */}
        <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-2">
          {/* Argument step */}
          {active ? (
            inTextArgument ? (
              <p className="px-4 py-6 text-center text-[13px] text-text-muted">
                {argQuery.trim()
                  ? t('palette.pressEnterToConfirm', 'Entree pour confirmer')
                  : (active.argument?.placeholder ?? '')}
              </p>
            ) : loadingOptions && optionRows.length === 0 ? (
              <p className="px-4 py-6 text-center text-[13px] text-text-muted">
                {t('common.loading', 'Chargement…')}
              </p>
            ) : optionRows.length === 0 ? (
              <p className="px-4 py-6 text-center text-[13px] text-text-muted">
                {t('palette.noOptions', 'Aucun resultat')}
              </p>
            ) : (
              optionRows.map((option, index) => (
                <button
                  key={option.id}
                  type="button"
                  data-cursor={index === cursor}
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => void execute(active, option.id)}
                  className={cn(
                    'flex w-full items-center gap-3 px-4 py-2 text-left transition-colors',
                    index === cursor ? 'bg-bg-hover' : 'hover:bg-bg-hover/60',
                  )}
                >
                  {option.color && (
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: option.color }}
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate text-[13px] text-text-primary">
                    {option.label}
                  </span>
                  {option.hint && (
                    <span className="shrink-0 font-mono text-[11px] text-text-muted">
                      {option.hint}
                    </span>
                  )}
                </button>
              ))
            )
          ) : rows.length === 0 ? (
            <p className="px-4 py-6 text-center text-[13px] text-text-muted">
              {t('palette.noResults', 'Aucune commande ne correspond')}
            </p>
          ) : (
            grouped.map((section) => (
              <div key={section.group}>
                <div className="px-4 pb-1 pt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">
                  {groupLabels[section.group]}
                </div>
                {section.rows.map((row) => {
                  flatIndex += 1;
                  const index = flatIndex;
                  const isRecent = !query && row.recentRank !== -1;
                  return (
                    <button
                      key={row.command.id}
                      type="button"
                      data-cursor={index === cursor}
                      onMouseEnter={() => setCursor(index)}
                      onClick={() => choose(row.command)}
                      className={cn(
                        'flex w-full items-center gap-3 px-4 py-2 text-left transition-colors',
                        index === cursor ? 'bg-bg-hover' : 'hover:bg-bg-hover/60',
                      )}
                    >
                      <span
                        className={cn(
                          'flex h-7 w-7 shrink-0 items-center justify-center rounded-pill',
                          index === cursor
                            ? 'bg-accent/15 text-accent'
                            : 'bg-bg-tertiary text-text-muted',
                        )}
                      >
                        {row.command.icon ?? <ArrowRight size={15} />}
                      </span>

                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-text-primary">
                          {row.command.title}
                        </span>
                        {row.command.subtitle && (
                          <span className="block truncate text-[11px] text-text-muted">
                            {row.command.subtitle}
                          </span>
                        )}
                      </span>

                      {isRecent && (
                        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
                          {t('palette.recent', 'recent')}
                        </span>
                      )}

                      {/* The prefix IS the shortcut: typing it as the first
                          character drops straight into this command. */}
                      {row.command.prefix && (
                        <kbd className="shrink-0 rounded bg-bg-tertiary px-1.5 py-0.5 font-mono text-[11px] text-text-secondary">
                          {row.command.prefix}
                        </kbd>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer legend — the palette is keyboard-first, so say so. */}
        <div className="h-px bg-border" />
        <div className="flex items-center gap-4 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-text-muted">
          <span className="flex items-center gap-1">
            <CornerDownLeft size={11} /> {t('palette.legendRun', 'Executer')}
          </span>
          <span>↑↓ {t('palette.legendMove', 'Naviguer')}</span>
          <span>ESC {active ? t('palette.legendBack', 'Retour') : t('common.close', 'Fermer')}</span>
          {!active && !ticketRef && (
            <span className="ml-auto normal-case tracking-normal">
              {t('palette.openTicketForMore', 'Ouvrez un ticket pour plus d actions')}
            </span>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
