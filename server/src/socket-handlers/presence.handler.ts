/**
 * presence.handler.ts — collision detection.
 *
 * "Marie is also looking at this ticket, and she is typing in the Resolution
 * field." That sentence is the whole feature, and it is what stops two agents
 * writing contradictory replies to the same requester ninety seconds apart.
 *
 * ── Why an in-memory Map and no table ──────────────────────────────────────
 * Presence is ephemeral by definition: it is true for as long as a socket keeps
 * saying so and false the instant it stops. Persisting it would mean writing a
 * row every PRESENCE_HEARTBEAT_MS per open ticket per agent — a continuous
 * write load whose only product is data that is worthless the moment the
 * process restarts. Worse, a crashed server would leave the table asserting
 * that six agents are still on a ticket nobody has open, and the UI would show
 * a collision warning that never clears. A Map that dies with the process is
 * not a limitation here; it is the correct lifetime.
 *
 * The consequence, stated plainly: with more than one server replica each sees
 * only its own sockets. That is acceptable for what presence is (a hint, not a
 * lock) and it is why the ACTUAL protection against lost edits is
 * `tickets.row_version` (HARD RULE 7), which is transactional and does survive
 * a restart. Presence warns; row_version enforces.
 *
 * ── Lifecycle ──────────────────────────────────────────────────────────────
 *   join       when a socket subscribes to `ticket:<id>`
 *   heartbeat  every PRESENCE_HEARTBEAT_MS (15s) from the client
 *   expire     after PRESENCE_TTL_MS (30s) without one — so a dropped beat
 *              does not make an agent flicker out of the collision bar
 *   typing     a separate, shorter TYPING_TTL_MS (6s) flag on the same entry
 *   leave      on unsubscribe or disconnect
 *
 * Every one of those broadcasts the ticket's full viewer list, because a
 * partial diff would let a dropped frame leave a phantom viewer on screen
 * forever.
 */
import {
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_TTL_MS,
  SOCKET_EVENTS,
  TYPING_TTL_MS,
} from '@oblidesk/shared';
import type { TicketPresenceEvent } from '@oblidesk/shared';
import { logger } from '../utils/logger';
import { emitToTicket, envelope, type DeskSocket } from '../socket';

interface PresenceEntry {
  socketId: string;
  userId: number;
  username: string;
  displayName: string | null;
  avatar: string | null;
  tenantId: number;
  /** Last heartbeat (or join). Entry expires PRESENCE_TTL_MS after this. */
  lastSeen: number;
  /** Last typing signal, 0 when never. Expires after TYPING_TTL_MS. */
  typingAt: number;
  /** Field slug the user is editing, so the UI can grey it out for others. */
  editingField: string | null;
}

/**
 * ticketId → socketId → entry.
 *
 * Keyed by SOCKET, not by user: one agent with the ticket open in two tabs is
 * two entries that collapse into one viewer at render time. Keying by user
 * would make closing one tab evict the other.
 */
const byTicket = new Map<number, Map<string, PresenceEntry>>();

let sweeper: NodeJS.Timeout | null = null;

// ═════════════════════════════════════════════════════════════════════════════
// Reading
// ═════════════════════════════════════════════════════════════════════════════

/** The viewer list for a ticket, collapsed per user and sorted for stability. */
export function getViewers(ticketId: number): TicketPresenceEvent['viewers'] {
  const entries = byTicket.get(ticketId);
  if (!entries || entries.size === 0) return [];

  const now = Date.now();
  const perUser = new Map<number, TicketPresenceEvent['viewers'][number]>();

  for (const entry of entries.values()) {
    if (now - entry.lastSeen > PRESENCE_TTL_MS) continue;
    const typing = entry.typingAt > 0 && now - entry.typingAt <= TYPING_TTL_MS;
    const existing = perUser.get(entry.userId);
    if (existing) {
      // Two tabs: the ticket is "being typed in" if either one is.
      existing.typing = existing.typing || typing;
      existing.editingField = existing.editingField ?? (typing ? entry.editingField : null);
      continue;
    }
    perUser.set(entry.userId, {
      userId: entry.userId,
      username: entry.username,
      displayName: entry.displayName,
      avatar: entry.avatar,
      typing,
      editingField: typing ? entry.editingField : null,
    });
  }

  return [...perUser.values()].sort((a, b) => a.userId - b.userId);
}

/** The tenant a ticket's presence belongs to, for the event envelope. */
function tenantOf(ticketId: number): number | null {
  const entries = byTicket.get(ticketId);
  if (!entries) return null;
  for (const entry of entries.values()) return entry.tenantId;
  return null;
}

/** Broadcast the current viewer list to everybody in the ticket room. */
export function broadcastPresence(ticketId: number, tenantId?: number): void {
  const tenant = tenantId ?? tenantOf(ticketId);
  if (tenant === null) return;

  const payload: TicketPresenceEvent = {
    ...envelope(tenant),
    ticketId,
    viewers: getViewers(ticketId),
  };
  emitToTicket(ticketId, SOCKET_EVENTS.ticketPresence, payload);
}

// ═════════════════════════════════════════════════════════════════════════════
// Writing
// ═════════════════════════════════════════════════════════════════════════════

/** A socket has opened a ticket. Authorisation happened before we got here. */
export function presenceJoin(socket: DeskSocket, ticketId: number): void {
  let entries = byTicket.get(ticketId);
  if (!entries) {
    entries = new Map<string, PresenceEntry>();
    byTicket.set(ticketId, entries);
  }

  const { user, tenantId } = socket.data;
  entries.set(socket.id, {
    socketId: socket.id,
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    avatar: user.avatar,
    tenantId,
    lastSeen: Date.now(),
    typingAt: 0,
    editingField: null,
  });

  broadcastPresence(ticketId, tenantId);
}

/** A socket has closed a ticket (or disconnected). */
export function presenceLeave(socket: DeskSocket, ticketId: number): void {
  const entries = byTicket.get(ticketId);
  if (!entries) return;

  const removed = entries.delete(socket.id);
  const tenantId = socket.data.tenantId;
  if (entries.size === 0) byTicket.delete(ticketId);
  if (removed) broadcastPresence(ticketId, tenantId);
}

/** Every ticket this socket had open — used on disconnect. */
export function presenceLeaveAll(socket: DeskSocket): void {
  for (const ticketId of [...socket.data.tickets]) presenceLeave(socket, ticketId);
  socket.data.tickets.clear();
}

/**
 * Keep-alive. Refreshes `lastSeen` and does NOT broadcast — a heartbeat that
 * changed nothing is not news, and broadcasting one per agent per 15s per
 * ticket would turn a quiet ticket into a chat channel.
 */
export function presenceHeartbeat(socket: DeskSocket, ticketId: number): void {
  const entry = byTicket.get(ticketId)?.get(socket.id);
  if (!entry) {
    // The socket believes it is subscribed and we do not — trust the socket
    // (it holds the authorised subscription) and re-register.
    if (socket.data.tickets.has(ticketId)) presenceJoin(socket, ticketId);
    return;
  }
  entry.lastSeen = Date.now();
}

/**
 * Typing / field-focus signal.
 *
 * Broadcasts only on a CHANGE — starting to type, stopping, or moving to a
 * different field. A client that sends `typing: true` on every keystroke
 * therefore produces one frame, not one per character.
 */
export function presenceTyping(
  socket: DeskSocket,
  ticketId: number,
  typing: boolean,
  editingField: string | null,
): void {
  const entry = byTicket.get(ticketId)?.get(socket.id);
  if (!entry) return;

  const now = Date.now();
  const wasTyping = entry.typingAt > 0 && now - entry.typingAt <= TYPING_TTL_MS;
  const fieldChanged = (entry.editingField ?? null) !== (editingField ?? null);

  entry.lastSeen = now;
  entry.typingAt = typing ? now : 0;
  entry.editingField = typing ? editingField ?? null : null;

  if (wasTyping !== typing || (typing && fieldChanged)) {
    broadcastPresence(ticketId, entry.tenantId);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Expiry sweeper
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A socket that dies without a clean disconnect (laptop lid, tunnel drop) never
 * sends a leave. The sweeper is what makes presence self-healing: it runs at
 * half the heartbeat interval and evicts anything past PRESENCE_TTL_MS, and it
 * separately notices a typing flag that has gone stale so the "…is typing"
 * hint cannot get stuck on screen.
 */
export function startPresenceSweeper(): void {
  if (sweeper) return;

  sweeper = setInterval(() => {
    const now = Date.now();
    for (const [ticketId, entries] of byTicket) {
      let changed = false;
      let tenantId: number | null = null;

      for (const [socketId, entry] of entries) {
        tenantId ??= entry.tenantId;
        if (now - entry.lastSeen > PRESENCE_TTL_MS) {
          entries.delete(socketId);
          changed = true;
          continue;
        }
        if (entry.typingAt > 0 && now - entry.typingAt > TYPING_TTL_MS) {
          entry.typingAt = 0;
          entry.editingField = null;
          changed = true;
        }
      }

      if (entries.size === 0) {
        byTicket.delete(ticketId);
        if (changed && tenantId !== null) {
          // Tell whoever is still in the room that the last viewer left.
          emitToTicket(ticketId, SOCKET_EVENTS.ticketPresence, {
            ...envelope(tenantId),
            ticketId,
            viewers: [],
          });
        }
        continue;
      }

      if (changed) broadcastPresence(ticketId, tenantId ?? undefined);
    }
  }, Math.max(1_000, Math.floor(PRESENCE_HEARTBEAT_MS / 2)));

  sweeper.unref();
  logger.debug({ ttlMs: PRESENCE_TTL_MS }, 'Presence sweeper started');
}

export function stopPresenceSweeper(): void {
  if (!sweeper) return;
  clearInterval(sweeper);
  sweeper = null;
  byTicket.clear();
}

/** Diagnostics for /api/system. */
export function presenceStats(): { tickets: number; entries: number } {
  let entries = 0;
  for (const map of byTicket.values()) entries += map.size;
  return { tickets: byTicket.size, entries };
}
