/**
 * socket/index.ts — the real-time connection.
 *
 * ── Authentication ──────────────────────────────────────────────────────────
 * The socket authenticates against the SAME express session as the REST API.
 * The handshake carries no user id: the server runs its session middleware over
 * the handshake request and decides who this is. A `userId` sent from here
 * would be a claim, and a claim is not an identity.
 *
 * The one thing we may send is `auth.token` — the session id — for the
 * cookie-less ObliTools shell, exactly mirroring the `X-Auth-Token` bridge on
 * the REST side. And `auth.tenantId`, which is a REQUEST, not a grant: the
 * server checks membership before honouring it.
 *
 * ── Rooms ───────────────────────────────────────────────────────────────────
 * A room name is a capability, so the client never joins one directly — it
 * sends a subscribe COMMAND and the server authorises it. Every subscribe here
 * takes an ack, and a refusal is reported rather than swallowed: a board that
 * silently stopped receiving counters looks identical to a quiet queue.
 *
 * ── Sleep / wake ────────────────────────────────────────────────────────────
 * When the machine suspends, the TCP connection dies but socket.io can take
 * ~45 s (pingInterval + pingTimeout) to notice. We watch `visibilitychange` and
 * force a reconnect when the page was hidden long enough to be suspicious, so
 * the connection indicator tells the truth immediately.
 */

import { io, type Socket } from 'socket.io-client';
import {
  PRESENCE_HEARTBEAT_MS,
  SOCKET_COMMANDS,
  SOCKET_EVENTS,
  type SocketEventName,
} from '@oblidesk/shared';
import type {
  AiSuggestionReadyEvent,
  AlertClearedEvent,
  AlertRaisedEvent,
  ApprovalDecidedEvent,
  ApprovalRequestedEvent,
  ConfigPublishedEvent,
  JournalAppendedEvent,
  MailAccountHealthEvent,
  NotificationNewEvent,
  QueueCountsEvent,
  SettingsUpdatedEvent,
  SlaBreachedEvent,
  SlaTickEvent,
  SlaWarningEvent,
  TicketAssignedEvent,
  TicketCreatedEvent,
  TicketDeletedEvent,
  TicketPresenceEvent,
  TicketStatusChangedEvent,
  TicketUpdatedEvent,
  TimeEntryChangedEvent,
  ViewCountsEvent,
} from '@oblidesk/shared';
import { getAuthToken, isInObliTools } from '@/api/client';
import { useSocketStore } from '@/store/socketStore';

/**
 * Event → payload map, keyed on the SOCKET_EVENTS values. It is the mirror of
 * the server's map, and it is what makes `onSocket(SOCKET_EVENTS.slaBreached,
 * handler)` refuse a handler typed for a different event.
 */
export interface SocketEventPayloads {
  [SOCKET_EVENTS.ticketCreated]: TicketCreatedEvent;
  [SOCKET_EVENTS.ticketUpdated]: TicketUpdatedEvent;
  [SOCKET_EVENTS.ticketDeleted]: TicketDeletedEvent;
  [SOCKET_EVENTS.ticketStatusChanged]: TicketStatusChangedEvent;
  [SOCKET_EVENTS.ticketAssigned]: TicketAssignedEvent;
  [SOCKET_EVENTS.journalAppended]: JournalAppendedEvent;
  [SOCKET_EVENTS.ticketPresence]: TicketPresenceEvent;
  [SOCKET_EVENTS.ticketTyping]: TicketTypingEvent;

  [SOCKET_EVENTS.slaTick]: SlaTickEvent;
  [SOCKET_EVENTS.slaWarning]: SlaWarningEvent;
  [SOCKET_EVENTS.slaBreached]: SlaBreachedEvent;

  [SOCKET_EVENTS.alertRaised]: AlertRaisedEvent;
  [SOCKET_EVENTS.alertCleared]: AlertClearedEvent;

  [SOCKET_EVENTS.approvalRequested]: ApprovalRequestedEvent;
  [SOCKET_EVENTS.approvalDecided]: ApprovalDecidedEvent;

  [SOCKET_EVENTS.configPublished]: ConfigPublishedEvent;
  [SOCKET_EVENTS.settingsUpdated]: SettingsUpdatedEvent;

  [SOCKET_EVENTS.queueCounters]: QueueCountsEvent;
  [SOCKET_EVENTS.viewCounters]: ViewCountsEvent;

  [SOCKET_EVENTS.notificationNew]: NotificationNewEvent;
  [SOCKET_EVENTS.mailAccountHealth]: MailAccountHealthEvent;
  [SOCKET_EVENTS.aiSuggestionReady]: AiSuggestionReadyEvent;
  [SOCKET_EVENTS.timeEntryChanged]: TimeEntryChangedEvent;
}

/**
 * The typing frame. Declared here because it is a socket-transport concern the
 * server declares locally too — it never reaches a REST payload, so it does not
 * belong in the shared DTO surface.
 */
export interface TicketTypingEvent {
  tenantId: number;
  at: string;
  ticketId: number;
  userId: number;
  username: string;
  displayName: string | null;
  typing: boolean;
  editingField: string | null;
}

export type SocketAck = { ok: boolean; error?: string };

let socket: Socket | null = null;
let visibilityListenerAdded = false;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

/** Timestamp the page was last hidden — see the sleep/wake note above. */
let hiddenAt: number | null = null;
const STALE_THRESHOLD_MS = 30_000;

/**
 * Rooms this client believes it is in. Replayed on every reconnect: socket.io
 * restores the transport, never the subscriptions, and a silently unsubscribed
 * ticket detail is a page that stops updating without telling anyone.
 */
const openTickets = new Set<number>();
const openQueues = new Set<string>();
const openViews = new Set<string>();

export function getSocket(): Socket | null {
  return socket;
}

export function isConnected(): boolean {
  return socket?.connected === true;
}

// ═════════════════════════════════════════════════════════════════════════════
// Lifecycle
// ═════════════════════════════════════════════════════════════════════════════

export function connectSocket(tenantId?: number): Socket {
  if (socket?.connected) {
    // A tenant switch reconnects rather than mutating the handshake: the
    // server's room memberships were decided at connect time.
    if (tenantId !== undefined && socket.auth && (socket.auth as { tenantId?: number }).tenantId !== tenantId) {
      disconnectSocket();
    } else {
      return socket;
    }
  }

  const auth: Record<string, unknown> = {};
  if (tenantId !== undefined) auth.tenantId = tenantId;
  // Only in the shell: elsewhere the cookie is the credential and replaying the
  // id in a JS-readable field would widen the blast radius of an XSS for nothing.
  if (isInObliTools) {
    const token = getAuthToken();
    if (token) auth.token = token;
  }

  socket = io(window.location.origin, {
    auth,
    // Polling first so the handshake survives a reverse proxy without WebSocket
    // upgrade support; socket.io upgrades in the background when it can.
    transports: ['polling', 'websocket'],
    withCredentials: true,
  });

  const store = useSocketStore.getState();

  socket.on('connect', () => {
    store.setStatus('connected');
    store.setLastError(null);
    resubscribeAll();
    startHeartbeat();
  });

  socket.on('disconnect', (reason) => {
    stopHeartbeat();
    useSocketStore.getState().setStatus('disconnected');
    useSocketStore.getState().setLastError(reason);
  });

  socket.on('connect_error', (err: Error) => {
    useSocketStore.getState().setStatus('disconnected');
    useSocketStore.getState().setLastError(err.message);
  });

  socket.io.on('reconnect_attempt', () => {
    useSocketStore.getState().setStatus('reconnecting');
  });

  socket.io.on('reconnect', () => {
    useSocketStore.getState().setStatus('connected');
  });

  installVisibilityWatch();
  return socket;
}

export function disconnectSocket(): void {
  stopHeartbeat();
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
  openTickets.clear();
  openQueues.clear();
  openViews.clear();
  useSocketStore.getState().setStatus('disconnected');
}

function installVisibilityWatch(): void {
  if (visibilityListenerAdded || typeof document === 'undefined') return;
  visibilityListenerAdded = true;

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }

    const live = getSocket();
    if (!live) return;

    const hiddenFor = hiddenAt !== null ? Date.now() - hiddenAt : 0;
    hiddenAt = null;

    if (!live.connected) {
      // Already dead — say so now rather than at the next render.
      useSocketStore.getState().setStatus('disconnected');
    } else if (hiddenFor > STALE_THRESHOLD_MS) {
      // Hidden long enough that the connection may be a ghost. Force the
      // question rather than trusting a socket that has not been exercised.
      live.disconnect().connect();
    }
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Typed listeners
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Subscribe to one server event. Returns the unsubscribe — always call it from
 * a `useEffect` cleanup, or a remounting page stacks a second handler and every
 * arrival is processed twice.
 */
export function onSocket<E extends SocketEventName & keyof SocketEventPayloads>(
  event: E,
  handler: (payload: SocketEventPayloads[E]) => void,
): () => void {
  const live = getSocket();
  if (!live) return () => undefined;
  // socket.io types `on` against its own events map, and with `E` still generic
  // the listener type stays an unresolved conditional. Widening the event name
  // to `string` — which is what the untyped map is keyed on — settles it. The
  // handler stays bound to `SocketEventPayloads[E]` for every caller.
  const name: string = event;
  const listener = handler as (...args: unknown[]) => void;
  live.on(name, listener);
  return () => {
    live.off(name, listener);
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Subscriptions
// ═════════════════════════════════════════════════════════════════════════════

function emitWithAck(command: string, payload: unknown): Promise<SocketAck> {
  const live = getSocket();
  if (!live?.connected) return Promise.resolve({ ok: false, error: 'disconnected' });
  return new Promise((resolve) => {
    let settled = false;
    const done = (ack: SocketAck) => {
      if (settled) return;
      settled = true;
      resolve(ack);
    };
    // A server that never acks must not leave a caller awaiting forever.
    const timer = setTimeout(() => done({ ok: false, error: 'timeout' }), 5_000);
    live.emit(command, payload, (ack: SocketAck | undefined) => {
      clearTimeout(timer);
      done(ack ?? { ok: true });
    });
  });
}

/** Join a ticket room. This is also what registers presence on the ticket. */
export async function subscribeTicket(ticketId: number): Promise<SocketAck> {
  const ack = await emitWithAck(SOCKET_COMMANDS.subscribeTicket, { ticketId });
  if (ack.ok) openTickets.add(ticketId);
  return ack;
}

export async function unsubscribeTicket(ticketId: number): Promise<SocketAck> {
  openTickets.delete(ticketId);
  return emitWithAck(SOCKET_COMMANDS.unsubscribeTicket, { ticketId });
}

export async function subscribeQueues(queueSlugs: string[]): Promise<SocketAck> {
  const ack = await emitWithAck(SOCKET_COMMANDS.subscribeQueue, { queueSlugs });
  if (ack.ok) for (const slug of queueSlugs) openQueues.add(slug);
  return ack;
}

export async function unsubscribeQueues(queueSlugs: string[]): Promise<SocketAck> {
  for (const slug of queueSlugs) openQueues.delete(slug);
  return emitWithAck(SOCKET_COMMANDS.unsubscribeQueue, { queueSlugs });
}

/**
 * Replaces the view subscription set — the server drops the previous view rooms
 * on this command. Clicking through twenty views all morning must not leave an
 * agent receiving counters for all twenty.
 */
export async function subscribeViews(viewSlugs: string[]): Promise<SocketAck> {
  const ack = await emitWithAck(SOCKET_COMMANDS.subscribeView, { viewSlugs });
  if (ack.ok) {
    openViews.clear();
    for (const slug of viewSlugs) openViews.add(slug);
  }
  return ack;
}

export async function unsubscribeViews(viewSlugs: string[]): Promise<SocketAck> {
  for (const slug of viewSlugs) openViews.delete(slug);
  return emitWithAck(SOCKET_COMMANDS.unsubscribeView, { viewSlugs });
}

/** Tell the ticket's other viewers what this agent is doing right now. */
export function sendTyping(ticketId: number, typing: boolean, editingField: string | null = null): void {
  getSocket()?.emit(SOCKET_COMMANDS.typing, { ticketId, typing, editingField });
}

function resubscribeAll(): void {
  for (const ticketId of openTickets) {
    void emitWithAck(SOCKET_COMMANDS.subscribeTicket, { ticketId });
  }
  if (openQueues.size > 0) {
    void emitWithAck(SOCKET_COMMANDS.subscribeQueue, { queueSlugs: [...openQueues] });
  }
  if (openViews.size > 0) {
    void emitWithAck(SOCKET_COMMANDS.subscribeView, { viewSlugs: [...openViews] });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Presence heartbeat
// ═════════════════════════════════════════════════════════════════════════════

/**
 * One timer for every open ticket, beating at half the TTL so a single dropped
 * beat does not make an agent flicker out of the collision bar.
 */
function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    const live = getSocket();
    if (!live?.connected || openTickets.size === 0) return;
    // A bare heartbeat refreshes every ticket this socket has open.
    live.emit(SOCKET_COMMANDS.presenceHeartbeat, {});
  }, PRESENCE_HEARTBEAT_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

export const socketClient = {
  connect: connectSocket,
  disconnect: disconnectSocket,
  get: getSocket,
  isConnected,
  on: onSocket,
  subscribeTicket,
  unsubscribeTicket,
  subscribeQueues,
  unsubscribeQueues,
  subscribeViews,
  unsubscribeViews,
  sendTyping,
};

export default socketClient;
