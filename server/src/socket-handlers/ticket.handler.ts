/**
 * ticket.handler.ts — the client → server commands.
 *
 * Every command here takes a room the CLIENT chose, so every command starts by
 * proving the socket may be in that room. A room name is a capability: handing
 * one out because it was asked for would let any authenticated user of tenant A
 * subscribe to tenant B's ticket stream, and websockets are exactly where such
 * a hole goes unnoticed — there is no URL in an access log to grep for
 * afterwards.
 *
 * Commands (SOCKET_COMMANDS in @oblidesk/shared):
 *   subscribe:ticket / unsubscribe:ticket   opens a ticket → drives presence
 *   subscribe:queue  / unsubscribe:queue    a queue board is on screen
 *   subscribe:view   / unsubscribe:view     a saved view is on screen
 *   presence:heartbeat                      keep-alive, every 15s
 *   typing                                  typing / field-focus signal
 *
 * Each takes an optional acknowledgement callback so the client can tell
 * "refused" from "no traffic yet" instead of staring at an empty ticket header
 * wondering whether presence is broken.
 */
import { ROOMS, SOCKET_COMMANDS } from '@oblidesk/shared';
import type { Server as SocketIOServer } from 'socket.io';
import { logger } from '../utils/logger';
import { canJoinBoard, canJoinTicket, type DeskSocket } from '../socket';
import {
  presenceHeartbeat,
  presenceJoin,
  presenceLeave,
  presenceLeaveAll,
  presenceTyping,
} from './presence.handler';

/** Shape of the ack every command may be given. */
type Ack = (response: { ok: boolean; error?: string }) => void;

function callAck(ack: unknown, ok: boolean, error?: string): void {
  if (typeof ack === 'function') (ack as Ack)(error ? { ok, error } : { ok });
}

/** Coerce whatever the client sent into a positive integer, or null. */
function toId(value: unknown): number | null {
  const raw =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : typeof value === 'object' && value !== null
          ? Number((value as { ticketId?: unknown }).ticketId)
          : NaN;
  return Number.isInteger(raw) && raw > 0 ? raw : null;
}

/**
 * Config slugs are citext identifiers, never free text. Anything outside this
 * shape is a client bug or an attempt to build a room name by hand.
 */
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function toSlugs(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item === 'string' && SLUG_RE.test(item)) out.push(item.toLowerCase());
    else if (item && typeof item === 'object') {
      const nested =
        (item as { queueSlug?: unknown }).queueSlug ?? (item as { viewSlug?: unknown }).viewSlug;
      if (typeof nested === 'string' && SLUG_RE.test(nested)) out.push(nested.toLowerCase());
      const many = (item as { viewSlugs?: unknown }).viewSlugs;
      if (Array.isArray(many)) {
        for (const slug of many) {
          if (typeof slug === 'string' && SLUG_RE.test(slug)) out.push(slug.toLowerCase());
        }
      }
    }
  }
  // Bound it: a client asking for 500 boards at once is not a client.
  return [...new Set(out)].slice(0, 50);
}

export function registerTicketHandlers(_io: SocketIOServer, socket: DeskSocket): void {
  // ── Ticket rooms — the ones that drive presence ──────────────────────────

  socket.on(SOCKET_COMMANDS.subscribeTicket, (payload: unknown, ack?: unknown) => {
    const ticketId = toId(payload);
    if (ticketId === null) {
      callAck(ack, false, 'invalid ticket id');
      return;
    }

    void canJoinTicket(socket, ticketId)
      .then(async (allowed) => {
        if (!allowed) {
          logger.debug(
            { userId: socket.data.user.id, tenantId: socket.data.tenantId, ticketId },
            'Ticket room join refused',
          );
          callAck(ack, false, 'not found');
          return;
        }
        await socket.join(ROOMS.ticket(ticketId));
        socket.data.tickets.add(ticketId);
        presenceJoin(socket, ticketId);
        callAck(ack, true);
      })
      .catch((err: Error) => {
        logger.error({ err, ticketId }, 'subscribe:ticket failed');
        callAck(ack, false, 'internal error');
      });
  });

  socket.on(SOCKET_COMMANDS.unsubscribeTicket, (payload: unknown, ack?: unknown) => {
    const ticketId = toId(payload);
    if (ticketId === null) {
      callAck(ack, false, 'invalid ticket id');
      return;
    }
    // Leaving needs no authorisation: a socket may always stop listening.
    presenceLeave(socket, ticketId);
    socket.data.tickets.delete(ticketId);
    void socket.leave(ROOMS.ticket(ticketId));
    callAck(ack, true);
  });

  // ── Board rooms — queue and saved view counters ──────────────────────────

  socket.on(SOCKET_COMMANDS.subscribeQueue, (payload: unknown, ack?: unknown) => {
    const { tenantId } = socket.data;
    if (!canJoinBoard(socket, tenantId)) {
      callAck(ack, false, 'forbidden');
      return;
    }
    const slugs = toSlugs(payload);
    for (const slug of slugs) void socket.join(ROOMS.queue(tenantId, slug));
    callAck(ack, slugs.length > 0, slugs.length > 0 ? undefined : 'no valid queue slug');
  });

  socket.on(SOCKET_COMMANDS.unsubscribeQueue, (payload: unknown, ack?: unknown) => {
    const { tenantId } = socket.data;
    for (const slug of toSlugs(payload)) void socket.leave(ROOMS.queue(tenantId, slug));
    callAck(ack, true);
  });

  socket.on(SOCKET_COMMANDS.subscribeView, (payload: unknown, ack?: unknown) => {
    const { tenantId } = socket.data;
    if (!canJoinBoard(socket, tenantId)) {
      callAck(ack, false, 'forbidden');
      return;
    }
    const slugs = toSlugs(payload);
    // Switching boards should not accumulate rooms: drop the previous view
    // subscriptions, then take the new set. Otherwise an agent who has clicked
    // through twenty views all morning is still receiving counters for all of
    // them.
    for (const room of socket.rooms) {
      if (room.startsWith(`view:${tenantId}:`)) void socket.leave(room);
    }
    for (const slug of slugs) void socket.join(ROOMS.view(tenantId, slug));
    callAck(ack, true);
  });

  socket.on(SOCKET_COMMANDS.unsubscribeView, (payload: unknown, ack?: unknown) => {
    const { tenantId } = socket.data;
    for (const slug of toSlugs(payload)) void socket.leave(ROOMS.view(tenantId, slug));
    callAck(ack, true);
  });

  // ── Presence ─────────────────────────────────────────────────────────────

  socket.on(SOCKET_COMMANDS.presenceHeartbeat, (payload: unknown) => {
    const ticketId = toId(payload);
    // Only for tickets this socket actually subscribed to — a heartbeat is not
    // a way to register presence on a ticket you were refused.
    if (ticketId !== null && socket.data.tickets.has(ticketId)) {
      presenceHeartbeat(socket, ticketId);
      return;
    }
    // A bare heartbeat refreshes everything this socket has open.
    if (ticketId === null) {
      for (const openTicket of socket.data.tickets) presenceHeartbeat(socket, openTicket);
    }
  });

  socket.on(SOCKET_COMMANDS.typing, (payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) return;
    const body = payload as { ticketId?: unknown; typing?: unknown; editingField?: unknown };
    const ticketId = toId(body.ticketId);
    if (ticketId === null || !socket.data.tickets.has(ticketId)) return;

    const editingField =
      typeof body.editingField === 'string' && body.editingField.length <= 128
        ? body.editingField
        : null;
    presenceTyping(socket, ticketId, body.typing !== false, editingField);
  });

  // ── Teardown ─────────────────────────────────────────────────────────────

  socket.on('disconnect', (reason: string) => {
    presenceLeaveAll(socket);
    logger.debug(
      { userId: socket.data.user.id, socketId: socket.id, reason },
      'Socket disconnected',
    );
  });
}
