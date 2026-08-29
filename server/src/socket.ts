/**
 * socket.ts — the real-time surface.
 *
 * ── Authentication ──────────────────────────────────────────────────────────
 * The socket authenticates against the SAME express session as the REST API,
 * by running the very same session middleware over the handshake request. Not a
 * parallel token scheme, not a `userId` passed in the handshake `auth` object —
 * a client that could claim `auth.userId = 1` could impersonate the admin, and
 * a socket layer with its own idea of who you are is a second attack surface
 * that will drift from the first.
 *
 * ObliTools runs the app in a cross-site WebView2 where Chrome drops cookies,
 * so the handshake may instead carry `auth.token` — the session id. It is
 * turned into the signed cookie the session middleware expects (exactly the
 * same bridge the REST side uses, see `app.ts`) and then validated normally.
 * The token proves nothing on its own; it is the session store that decides.
 *
 * ── Room taxonomy (ROOMS in @oblidesk/shared) ───────────────────────────────
 *   tenant:<id>              every socket of a member of that tenant
 *   user:<id>                one person's own devices
 *   ticket:<id>              only while a ticket is open — this is what drives
 *                            presence and collision detection
 *   queue:<tenantId>:<slug>  while a queue board is on screen
 *   view:<tenantId>:<slug>   while a saved view is on screen
 *
 * EVERY join is authorised server-side. `socket.join()` is never called with a
 * room name the client supplied without first proving the socket may be in it:
 * a room name is a capability, and handing one out on request would let any
 * authenticated user of tenant A subscribe to tenant B's ticket stream.
 */
import type { Server as HttpServer } from 'http';
import type { RequestHandler, Request, Response } from 'express';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import {
  CAPABILITIES,
  ROOMS,
  SOCKET_EVENTS,
  hasCapability,
} from '@oblidesk/shared';
import type {
  AiSuggestionReadyEvent,
  AlertClearedEvent,
  AlertRaisedEvent,
  ApprovalDecidedEvent,
  ApprovalRequestedEvent,
  Capability,
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
  UserRole,
  ViewCountsEvent,
} from '@oblidesk/shared';
import { db, scoped } from './db';
import { logger } from './utils/logger';
import { signSessionCookie, SESSION_COOKIE_NAME } from './utils/crypto';
import { resolveUserCapabilities } from './middleware/rbac';
import { listUserTenantIds } from './middleware/tenant';
import { registerSocketHandlers, shutdownSocketHandlers } from './socket-handlers';

// ═════════════════════════════════════════════════════════════════════════════
// Event → payload map
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The emit helpers are keyed on SOCKET_EVENTS and typed through this map, so
 * `emitToTicket(id, SOCKET_EVENTS.slaBreached, { … })` will not compile with a
 * TicketUpdatedEvent in the payload. A socket event emitted with a hand-typed
 * string is a rename waiting to break silently; this is the guard against it.
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

export type EmittableEvent = keyof SocketEventPayloads;

/**
 * `ticket:typing` has no payload interface in @oblidesk/shared because typing
 * is a projection of presence — the same viewer list, refreshed more often.
 * Declared here rather than invented in each service.
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

// ═════════════════════════════════════════════════════════════════════════════
// Socket data
// ═════════════════════════════════════════════════════════════════════════════

export interface SocketUser {
  id: number;
  username: string;
  displayName: string | null;
  avatar: string | null;
  role: UserRole;
}

export interface SocketState {
  user: SocketUser;
  /** The tenant this socket is currently working in. */
  tenantId: number;
  /** Every tenant the user may reach — the join authoriser reads this. */
  tenantIds: number[];
  /** Expanded capabilities inside `tenantId`. */
  capabilities: Capability[];
  isPlatformAdmin: boolean;
  /** Ticket ids this socket is subscribed to, for presence cleanup. */
  tickets: Set<number>;
}

export type DeskSocket = Socket & { data: SocketState };

// ═════════════════════════════════════════════════════════════════════════════
// The server
// ═════════════════════════════════════════════════════════════════════════════

let io: SocketIOServer | null = null;

/** The live io instance, or null before `createSocketServer` has run. */
export function getIo(): SocketIOServer | null {
  return io;
}

interface UserRow {
  id: number;
  username: string;
  display_name: string | null;
  avatar: string | null;
  role: UserRole;
  is_active: boolean;
}

/**
 * Build the Socket.io server and wire authentication, room authorisation and
 * the command handlers.
 *
 * `sessionMiddleware` MUST be the very instance `app.ts` mounted — a second
 * `session()` with the same options would use a different store instance and,
 * worse, would quietly stop matching if the options ever drift.
 */
export function createSocketServer(
  httpServer: HttpServer,
  sessionMiddleware: RequestHandler,
): SocketIOServer {
  const server = new SocketIOServer(httpServer, {
    cors: {
      // Reflect the request origin. Security comes from the session check
      // below, not from an origin list that has to be reconfigured for every
      // deployment URL — and a socket with no valid session is refused
      // regardless of where it came from.
      origin: true,
      credentials: true,
    },
    transports: ['websocket', 'polling'],
    // A ticket page pushes presence heartbeats; the default 20s/25s pair is
    // fine, but be explicit so a change is deliberate.
    pingInterval: 25_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 1e6,
  });

  // ── 1. Run the express session over the handshake ─────────────────────────
  server.use((socket, next) => {
    const req = socket.request as Request;
    bridgeHandshakeToken(socket, req);
    sessionMiddleware(req, {} as Response, next as (err?: unknown) => void);
  });

  // ── 2. Turn the session into a validated socket identity ──────────────────
  server.use((socket, next) => {
    void authenticateSocket(socket as DeskSocket)
      .then(() => next())
      .catch((err: Error) => {
        logger.debug({ err: err.message }, 'Socket authentication refused');
        next(err);
      });
  });

  // ── 3. Rooms and commands ────────────────────────────────────────────────
  server.on('connection', (socket) => {
    const desk = socket as DeskSocket;
    const { user, tenantId } = desk.data;

    logger.debug(
      { userId: user.id, username: user.username, tenantId, socketId: desk.id },
      'Socket connected',
    );

    // Joined unconditionally: a socket always belongs to its own user, and the
    // tenant membership was proven during authentication.
    void desk.join(ROOMS.user(user.id));
    void desk.join(ROOMS.tenant(tenantId));

    registerSocketHandlers(server, desk);
  });

  io = server;
  return server;
}

/** Detach handlers and close every connection. Called from the shutdown path. */
export async function closeSocketServer(): Promise<void> {
  shutdownSocketHandlers();
  if (!io) return;
  await new Promise<void>((resolve) => {
    io?.close(() => resolve());
  });
  io = null;
}

// ═════════════════════════════════════════════════════════════════════════════
// Handshake helpers
// ═════════════════════════════════════════════════════════════════════════════

/**
 * ObliTools cannot send cookies (cross-site WebView2), so it sends the session
 * id as `auth.token`. Fold it into the request's Cookie header so the ordinary
 * session middleware picks it up — one code path for session lookup, not two.
 */
function bridgeHandshakeToken(socket: Socket, req: Request): void {
  const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
  if (typeof token !== 'string' || token.length === 0) return;
  // A real cookie always wins: it is the stronger signal and the browser sent
  // it, whereas the token is whatever the page had in sessionStorage.
  if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`${SESSION_COOKIE_NAME}=`)) {
    return;
  }

  const cookie = signSessionCookie(token);
  req.headers.cookie = req.headers.cookie ? `${req.headers.cookie}; ${cookie}` : cookie;
}

/**
 * Validate the session, load the user, resolve the tenant the socket asked for
 * and the capabilities held inside it.
 *
 * Every failure throws — `io.use` turns that into a connect_error the client
 * sees, and no partially-authenticated socket is ever admitted.
 */
async function authenticateSocket(socket: DeskSocket): Promise<void> {
  const session = (socket.request as Request).session as
    | { userId?: number; currentTenantId?: number; role?: UserRole }
    | undefined;

  const userId = session?.userId;
  if (!userId) throw new Error('Authentication required');

  // `users` is a GLOBAL table — db() is correct here.
  const user = (await db('users')
    .where('id', userId)
    .first('id', 'username', 'display_name', 'avatar', 'role', 'is_active')) as
    | UserRow
    | undefined;

  if (!user || !user.is_active) throw new Error('Invalid user');

  const isPlatformAdmin = user.role === 'admin';

  // Which tenants may this socket reach? Membership is the answer for everyone
  // except a platform admin, who may reach all of them.
  const tenantIds = isPlatformAdmin
    ? await db('tenants').pluck<number[]>('id') // `tenants` is a GLOBAL table
    : await listUserTenantIds(userId);

  if (tenantIds.length === 0) throw new Error('No tenant membership');

  // The client asks for a tenant in the handshake (it reconnects on a tenant
  // switch); the session's current tenant is the fallback, and the first
  // membership is the last resort.
  const requested = Number((socket.handshake.auth as { tenantId?: unknown } | undefined)?.tenantId);
  const candidate = Number.isInteger(requested) && requested > 0 ? requested : session?.currentTenantId;
  const tenantId =
    candidate !== undefined && tenantIds.includes(candidate) ? candidate : tenantIds[0];

  socket.data = {
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      avatar: user.avatar,
      role: user.role,
    },
    tenantId,
    tenantIds,
    capabilities: await resolveUserCapabilities(userId, tenantId, { isPlatformAdmin }),
    isPlatformAdmin,
    tickets: new Set<number>(),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Join authorisation
// ═════════════════════════════════════════════════════════════════════════════

/** May this socket subscribe to this tenant at all? */
export function canReachTenant(socket: DeskSocket, tenantId: number): boolean {
  return socket.data.isPlatformAdmin || socket.data.tenantIds.includes(tenantId);
}

/** Does this socket hold a capability inside its active tenant? */
export function socketHasCapability(socket: DeskSocket, capability: Capability): boolean {
  return hasCapability(socket.data.capabilities, capability, socket.data.isPlatformAdmin);
}

interface TicketRoomRow {
  id: number;
  queue_slug: string;
  assignee_id: number | null;
  deleted_at: Date | null;
}

/**
 * May this socket join `ticket:<id>`?
 *
 * The ticket must exist in the socket's ACTIVE tenant — the lookup is scoped,
 * so a ticket id belonging to another tenant simply is not found, and the
 * answer is the same "no such ticket" a non-existent id gets. That symmetry
 * matters: a different answer for "exists but not yours" is a cross-tenant
 * id-enumeration oracle over a websocket, where nobody is watching the logs.
 */
export async function canJoinTicket(socket: DeskSocket, ticketId: number): Promise<boolean> {
  if (!Number.isInteger(ticketId) || ticketId <= 0) return false;
  if (!socketHasCapability(socket, CAPABILITIES.TICKET_READ)) return false;

  const ticket = (await scoped('tickets', socket.data.tenantId)
    .where('tickets.id', ticketId)
    .first('id', 'queue_slug', 'assignee_id', 'deleted_at')) as TicketRoomRow | undefined;

  if (!ticket) return false;
  // A soft-deleted ticket still streams to whoever can restore it.
  if (ticket.deleted_at && !socketHasCapability(socket, CAPABILITIES.TICKET_DELETE)) return false;

  return true;
}

/**
 * May this socket join a queue or view board room?
 *
 * Board rooms carry counters and row patches for tickets the viewer can already
 * list, so tenant reach plus `ticket_read` is the whole test. Per-queue
 * visibility rules, when they exist, are enforced where the rows are produced —
 * the room only decides who gets told that something changed.
 */
export function canJoinBoard(socket: DeskSocket, tenantId: number): boolean {
  return canReachTenant(socket, tenantId) && socketHasCapability(socket, CAPABILITIES.TICKET_READ);
}

// ═════════════════════════════════════════════════════════════════════════════
// Emit helpers — the API every service calls
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Emitting is best-effort by design.
 *
 * A service writes its row, commits, and then tells the room. If the socket
 * server is not up yet (a migration-time backfill, a unit test, the boot window
 * before `createSocketServer`) the emit is dropped with a debug line and the
 * caller carries on. Real-time is a courtesy layer over the database; a failed
 * broadcast must never roll back a ticket.
 */
function emit<E extends EmittableEvent>(
  room: string,
  event: E,
  payload: SocketEventPayloads[E],
): void {
  if (!io) {
    logger.debug({ room, event }, 'Socket emit dropped — io not started');
    return;
  }
  io.to(room).emit(event, payload);
}

/** Everyone working in a tenant. */
export function emitToTenant<E extends EmittableEvent>(
  tenantId: number,
  event: E,
  payload: SocketEventPayloads[E],
): void {
  emit(ROOMS.tenant(tenantId), event, payload);
}

/** One person, on every device they have open. */
export function emitToUser<E extends EmittableEvent>(
  userId: number,
  event: E,
  payload: SocketEventPayloads[E],
): void {
  emit(ROOMS.user(userId), event, payload);
}

/** Everyone with this ticket open — the collision-detection audience. */
export function emitToTicket<E extends EmittableEvent>(
  ticketId: number,
  event: E,
  payload: SocketEventPayloads[E],
): void {
  emit(ROOMS.ticket(ticketId), event, payload);
}

/** Everyone with this queue board on screen. */
export function emitToQueue<E extends EmittableEvent>(
  tenantId: number,
  queueSlug: string,
  event: E,
  payload: SocketEventPayloads[E],
): void {
  emit(ROOMS.queue(tenantId, queueSlug), event, payload);
}

/** Everyone with this saved view on screen. */
export function emitToView<E extends EmittableEvent>(
  tenantId: number,
  viewSlug: string,
  event: E,
  payload: SocketEventPayloads[E],
): void {
  emit(ROOMS.view(tenantId, viewSlug), event, payload);
}

/**
 * A ticket change usually needs to reach three audiences at once: the people
 * looking at the ticket, the people looking at its queue board, and the tenant
 * at large. Socket.io de-duplicates across rooms, so a socket in two of them
 * still receives the frame once.
 */
export function emitTicketChange<E extends EmittableEvent>(
  tenantId: number,
  ticketId: number,
  queueSlug: string | null,
  event: E,
  payload: SocketEventPayloads[E],
): void {
  if (!io) {
    logger.debug({ event, ticketId }, 'Socket emit dropped — io not started');
    return;
  }
  const rooms = [ROOMS.tenant(tenantId), ROOMS.ticket(ticketId)];
  if (queueSlug) rooms.push(ROOMS.queue(tenantId, queueSlug));
  io.to(rooms).emit(event, payload);
}

/** The envelope every payload shares — `at` lets a client drop stale frames. */
export function envelope(tenantId: number): { tenantId: number; at: string } {
  return { tenantId, at: new Date().toISOString() };
}

/** How many sockets are currently connected. Reported by /api/system. */
export function connectedSocketCount(): number {
  return io ? io.sockets.sockets.size : 0;
}

/** Sanity check used by the system route: is the realtime layer alive? */
export function socketStatus(): { running: boolean; clients: number; rooms: number } {
  return {
    running: io !== null,
    clients: connectedSocketCount(),
    rooms: io ? io.sockets.adapter.rooms.size : 0,
  };
}
