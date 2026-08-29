/**
 * socket-handlers/index.ts — one place where a connected socket is wired up.
 *
 * `socket.ts` owns the server, authentication and the emit helpers; this
 * directory owns what a socket may ASK for. Keeping the two apart means the
 * authorisation predicates (`canJoinTicket`, `canJoinBoard`) live next to the
 * session they authorise, while the command surface can grow without the
 * server file growing with it.
 *
 * Adding a handler module: export a `register…Handlers(io, socket)` from it and
 * call it below. Do not register listeners from anywhere else — a listener
 * attached in a service is a listener nobody finds when a command starts
 * misbehaving.
 */
import type { Server as SocketIOServer } from 'socket.io';
import type { DeskSocket } from '../socket';
import { registerTicketHandlers } from './ticket.handler';
import { startPresenceSweeper, stopPresenceSweeper } from './presence.handler';

let sweeperStarted = false;

/** Attach every command handler to a freshly connected, authenticated socket. */
export function registerSocketHandlers(io: SocketIOServer, socket: DeskSocket): void {
  // The sweeper is process-wide, not per socket, and is started lazily so a
  // server with no realtime traffic never arms a timer it does not need.
  if (!sweeperStarted) {
    startPresenceSweeper();
    sweeperStarted = true;
  }

  registerTicketHandlers(io, socket);
}

/** Stop the process-wide timers. Called from the graceful-shutdown path. */
export function shutdownSocketHandlers(): void {
  stopPresenceSweeper();
  sweeperStarted = false;
}

export { registerTicketHandlers } from './ticket.handler';
export {
  broadcastPresence,
  getViewers,
  presenceStats,
  startPresenceSweeper,
  stopPresenceSweeper,
} from './presence.handler';
