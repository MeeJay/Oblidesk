/**
 * PresenceBar.tsx — collision detection, and the desk's realtime runtime.
 *
 * ── Why the socket accessor lives here ───────────────────────────────────────
 * Presence is the ONLY feature on the desk that is meaningless without a live
 * socket: a stale viewer list is worse than none. Everything else the ticket UI
 * does over the socket (a journal entry appearing, a row flashing, an SLA chip
 * turning amber) degrades to "refresh and you will see it". So the transport
 * lives next to the one component that cannot exist without it, and the rest of
 * the ticket UI imports `useDeskEvent` from here.
 *
 * `getDeskSocket()` reuses `window.__oblideskSocket` when the application shell
 * has already opened one, and publishes its own there otherwise. One tab, one
 * connection, regardless of which module got there first.
 *
 * ── What the bar actually protects against ───────────────────────────────────
 * Two agents answering the same customer ninety seconds apart. The bar answers
 * three questions, in descending order of urgency:
 *
 *   1. Is somebody editing the SAME FIELD as me right now?  → red warning
 *   2. Is somebody typing a reply?                          → amber line
 *   3. Who else has this ticket open?                       → avatars
 *
 * Presence is a HINT, not a lock. The actual protection against a lost edit is
 * `tickets.row_version` (HARD RULE 7), which is transactional and survives a
 * server restart. This bar exists so the 409 happens rarely enough to be
 * surprising.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Eye, PencilLine } from 'lucide-react';
import { io, type Socket } from 'socket.io-client';
import {
  PRESENCE_HEARTBEAT_MS,
  SOCKET_COMMANDS,
  SOCKET_EVENTS,
  STORAGE_KEYS,
} from '@oblidesk/shared';
import type { SessionContext, TicketPresenceEvent } from '@oblidesk/shared';
import apiClient from '@/api/client';

// ═════════════════════════════════════════════════════════════════════════════
// The socket
// ═════════════════════════════════════════════════════════════════════════════

type Viewer = TicketPresenceEvent['viewers'][number];

interface SocketCarrier {
  __oblideskSocket?: Socket;
}

/**
 * The desk's single socket.
 *
 * Authentication is the express session — the server runs the same session
 * middleware over the handshake. `auth.token` is the ObliTools bridge (a
 * cross-site WebView2 drops cookies); it proves nothing on its own, the session
 * store decides.
 */
export function getDeskSocket(): Socket {
  const carrier = window as unknown as SocketCarrier;
  if (carrier.__oblideskSocket) return carrier.__oblideskSocket;

  let token: string | null = null;
  try {
    token = sessionStorage.getItem(STORAGE_KEYS.obliToolsToken);
  } catch {
    // Private mode / blocked storage: fall back to cookie auth.
    token = null;
  }

  const socket = io({
    path: '/socket.io',
    withCredentials: true,
    transports: ['websocket', 'polling'],
    auth: token ? { token } : undefined,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5_000,
  });

  carrier.__oblideskSocket = socket;
  return socket;
}

/**
 * Subscribe to one server event for the lifetime of the component.
 *
 * The handler is held in a ref so a caller may pass an inline closure without
 * re-binding the listener on every render — the alternative is a listener churn
 * that silently drops the frame that arrives mid-swap.
 */
export function useDeskEvent<T>(
  event: string,
  handler: (payload: T) => void,
  enabled = true,
): void {
  const ref = useRef(handler);
  ref.current = handler;

  useEffect(() => {
    if (!enabled) return undefined;
    const socket = getDeskSocket();
    const listener = (payload: T): void => ref.current(payload);
    socket.on(event, listener);
    return () => {
      socket.off(event, listener);
    };
  }, [event, enabled]);
}

/** Live connection state, so the UI can say "reconnexion…" instead of freezing. */
export function useSocketConnected(): boolean {
  const [connected, setConnected] = useState(() => getDeskSocket().connected);

  useEffect(() => {
    const socket = getDeskSocket();
    const up = (): void => setConnected(true);
    const down = (): void => setConnected(false);
    socket.on('connect', up);
    socket.on('disconnect', down);
    setConnected(socket.connected);
    return () => {
      socket.off('connect', up);
      socket.off('disconnect', down);
    };
  }, []);

  return connected;
}

// ═════════════════════════════════════════════════════════════════════════════
// The session
// ═════════════════════════════════════════════════════════════════════════════

type SessionPayload = SessionContext & { authToken?: string; requires2faSetup?: boolean };

/**
 * One in-flight request per tab, shared by every caller.
 *
 * Three panes each asking "who am I?" on mount is three round-trips for one
 * answer that cannot differ between them.
 */
let sessionPromise: Promise<SessionPayload | null> | null = null;

export function loadDeskSession(force = false): Promise<SessionPayload | null> {
  if (force) sessionPromise = null;
  sessionPromise ??= apiClient
    .get<{ success: boolean; data: SessionPayload }>('/auth/me')
    .then((response) => response.data?.data ?? null)
    .catch(() => {
      // Do not cache a failure: a 401 during a token refresh must not make the
      // whole tab believe it is logged out forever.
      sessionPromise = null;
      return null;
    });
  return sessionPromise;
}

export function useDeskSession(): { session: SessionPayload | null; loading: boolean } {
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void loadDeskSession().then((value) => {
      if (!alive) return;
      setSession(value);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  return { session, loading };
}

// ═════════════════════════════════════════════════════════════════════════════
// Presence
// ═════════════════════════════════════════════════════════════════════════════

export interface TicketPresence {
  viewers: Viewer[];
  /** Others only — the list the bar renders. */
  others: Viewer[];
  /** Tell the room which field I am in. Debounced by the server, not by us. */
  signalEditing: (field: string | null) => void;
  /** Tell the room I am composing. */
  signalTyping: (typing: boolean, field?: string | null) => void;
}

/**
 * Join the ticket room, heartbeat, and keep the viewer list fresh.
 *
 * Joining the room is what registers presence server-side, so this hook is the
 * single place a ticket is "opened". Unmounting leaves the room, which is what
 * makes the other agents' bars drop us immediately rather than after the 30 s
 * TTL.
 */
export function useTicketPresence(ticketId: number | null, selfUserId?: number | null): TicketPresence {
  const [viewers, setViewers] = useState<Viewer[]>([]);
  const editingRef = useRef<string | null>(null);

  useEffect(() => {
    if (!ticketId) {
      setViewers([]);
      return undefined;
    }

    const socket = getDeskSocket();
    setViewers([]);

    const subscribe = (): void => {
      socket.emit(SOCKET_COMMANDS.subscribeTicket, { ticketId });
    };

    subscribe();
    // A reconnect is a fresh socket on the server: re-join, or the room is lost
    // and presence silently stops working for the rest of the session.
    socket.on('connect', subscribe);

    const beat = window.setInterval(() => {
      socket.emit(SOCKET_COMMANDS.presenceHeartbeat, { ticketId });
    }, PRESENCE_HEARTBEAT_MS);

    return () => {
      window.clearInterval(beat);
      socket.off('connect', subscribe);
      socket.emit(SOCKET_COMMANDS.unsubscribeTicket, { ticketId });
    };
  }, [ticketId]);

  useDeskEvent<TicketPresenceEvent>(
    SOCKET_EVENTS.ticketPresence,
    (payload) => {
      if (!ticketId || payload.ticketId !== ticketId) return;
      setViewers(payload.viewers ?? []);
    },
    ticketId !== null,
  );

  const signalTyping = useCallback(
    (typing: boolean, field?: string | null) => {
      if (!ticketId) return;
      getDeskSocket().emit(SOCKET_COMMANDS.typing, {
        ticketId,
        typing,
        editingField: field ?? editingRef.current,
      });
    },
    [ticketId],
  );

  const signalEditing = useCallback(
    (field: string | null) => {
      editingRef.current = field;
      if (!ticketId) return;
      getDeskSocket().emit(SOCKET_COMMANDS.typing, {
        ticketId,
        typing: field !== null,
        editingField: field,
      });
    },
    [ticketId],
  );

  const others = useMemo(
    () => viewers.filter((viewer) => viewer.userId !== selfUserId),
    [viewers, selfUserId],
  );

  return { viewers, others, signalEditing, signalTyping };
}

// ═════════════════════════════════════════════════════════════════════════════
// The bar
// ═════════════════════════════════════════════════════════════════════════════

function initials(viewer: Viewer): string {
  const source = viewer.displayName?.trim() || viewer.username;
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

/** Deterministic hue per user, so the same face keeps the same colour. */
function hueOf(userId: number): number {
  return (userId * 137) % 360;
}

function Avatar({ viewer, warn }: { viewer: Viewer; warn: boolean }): JSX.Element {
  const label = viewer.displayName?.trim() || viewer.username;
  return (
    <span
      title={label}
      aria-label={label}
      className={clsx(
        'relative inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
        'font-mono text-[10px] font-medium text-white',
      )}
      style={{
        background: viewer.avatar ? undefined : `hsl(${hueOf(viewer.userId)} 42% 38%)`,
        boxShadow: warn ? '0 0 0 2px rgb(var(--c-sla-breach))' : undefined,
      }}
    >
      {viewer.avatar ? (
        <img src={viewer.avatar} alt="" className="h-full w-full rounded-full object-cover" />
      ) : (
        initials(viewer)
      )}
      {viewer.typing && (
        <span
          aria-hidden
          className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-accent"
          style={{ boxShadow: '0 0 0 2px rgb(var(--c-bg-secondary))' }}
        />
      )}
    </span>
  );
}

export interface PresenceBarProps {
  /** Everybody in the room except me. */
  others: Viewer[];
  /** The field I currently have focus in, so a clash can be detected. */
  myEditingField?: string | null;
  /** Rendered when nobody else is here — off by default; the bar stays quiet. */
  showWhenAlone?: boolean;
  className?: string;
}

export default function PresenceBar({
  others,
  myEditingField,
  showWhenAlone = false,
  className,
}: PresenceBarProps): JSX.Element | null {
  const { t } = useTranslation();

  const clashing = useMemo(
    () =>
      myEditingField
        ? others.filter((viewer) => viewer.typing && viewer.editingField === myEditingField)
        : [],
    [others, myEditingField],
  );

  const typing = useMemo(() => others.filter((viewer) => viewer.typing), [others]);

  if (others.length === 0 && !showWhenAlone) return null;

  const nameOf = (viewer: Viewer): string => viewer.displayName?.trim() || viewer.username;

  return (
    <div
      className={clsx(
        'flex min-h-[28px] flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px]',
        className,
      )}
    >
      <span className="flex items-center gap-1.5">
        <Eye size={13} className="shrink-0 text-text-muted" aria-hidden />
        <span className="flex -space-x-1.5">
          {others.slice(0, 6).map((viewer) => (
            <Avatar
              key={viewer.userId}
              viewer={viewer}
              warn={clashing.some((c) => c.userId === viewer.userId)}
            />
          ))}
        </span>
        {others.length > 6 && (
          <span className="font-mono text-[11px] text-text-muted">+{others.length - 6}</span>
        )}
        {others.length === 0 && (
          <span className="text-text-muted">{t('presence.alone', 'Vous êtes seul ici')}</span>
        )}
      </span>

      {/* 2 — somebody is composing. Amber, informational. */}
      {clashing.length === 0 && typing.length > 0 && (
        <span className="flex items-center gap-1.5 text-sla-warn">
          <PencilLine size={13} aria-hidden />
          {typing.length === 1
            ? t('presence.typingOne', '{{name}} est en train d’écrire', { name: nameOf(typing[0]) })
            : t('presence.typingMany', '{{count}} personnes écrivent', { count: typing.length })}
        </span>
      )}

      {/* 1 — same field, right now. This one is loud on purpose. */}
      {clashing.length > 0 && (
        <span
          role="alert"
          className="flex items-center gap-1.5 rounded-pill bg-sla-breach-bg px-2 py-1 font-medium text-sla-breach"
        >
          <AlertTriangle size={13} aria-hidden />
          {t(
            'presence.fieldCollision',
            '{{name}} modifie le même champ que vous — votre enregistrement risque un conflit de version.',
            { name: nameOf(clashing[0]) },
          )}
        </span>
      )}
    </div>
  );
}
