/**
 * useSocket.ts — the one place server events become client state.
 *
 * Mounted ONCE, from the app layout. Not per page: a second mount means a
 * second handler on every event, which means an arrival counted twice and a
 * toast raised twice. Every listener is torn down on cleanup for the same
 * reason.
 *
 * What it does NOT do is refetch. An event that carries the whole row patches
 * the store directly; a round trip per socket frame turns a busy queue into a
 * self-inflicted load test. `ticket:updated` deliberately ships the full row so
 * a list can patch in place, and that is what we use it for.
 */

import { useEffect } from 'react';
import { SOCKET_EVENTS } from '@oblidesk/shared';
import { onSocket } from '@/socket';
import { useAuthStore } from '@/store/authStore';
import { useLiveAlertsStore } from '@/store/liveAlertsStore';
import { useTicketStore } from '@/store/ticketStore';
import { useViewStore } from '@/store/viewStore';
import { useSocketStore } from '@/store/socketStore';

export interface UseSocketOptions {
  /** Raise a toast for a live alert. Supplied by the layout that owns toasts. */
  onLiveAlert?: (title: string, message: string, navigateTo: string | null) => void;
  /** An SLA breach on any ticket in this tenant. */
  onSlaBreach?: (ticketId: number, number: string, targetSlug: string) => void;
  /** A ticket was assigned to the signed-in agent. */
  onAssignedToMe?: (ticketId: number, number: string, subject: string) => void;
  /** A config object was published — pages holding config should re-read. */
  onConfigPublished?: (kind: string, slug: string) => void;
}

export function useSocket(options: UseSocketOptions = {}): void {
  const session = useAuthStore((state) => state.session);
  const status = useSocketStore((state) => state.status);
  const { onLiveAlert, onSlaBreach, onAssignedToMe, onConfigPublished } = options;

  useEffect(() => {
    // Re-registering on every reconnect is deliberate: `onSocket` binds to the
    // live socket instance, and a reconnect after a sleep builds a new one.
    if (!session || status !== 'connected') return;

    const currentUserId = session.user.id;

    // Every handler reads `getState()` at fire time rather than capturing a
    // snapshot here: the store this effect saw at mount is not the store the
    // frame arrives against, and a captured one silently writes to a stale copy.
    const unsubscribes = [
      // ── Tickets ─────────────────────────────────────────────────────────
      onSocket(SOCKET_EVENTS.ticketCreated, (event) => {
        useTicketStore.getState().noteArrival(event.ticket, 'created');
      }),

      onSocket(SOCKET_EVENTS.ticketUpdated, (event) => {
        // Our own echo: the optimistic path already has this row, and the
        // server's copy is what `patchTicket` stored on success.
        useTicketStore.getState().noteArrival(event.ticket, 'updated');
      }),

      onSocket(SOCKET_EVENTS.ticketDeleted, (event) => {
        useTicketStore.getState().noteRemoval(event.ticketId);
      }),

      onSocket(SOCKET_EVENTS.ticketStatusChanged, (event) => {
        // Category, not slug — the badge and every engine key off the category
        // (HARD RULE 5). The full row follows in `ticket:updated`; this keeps
        // the chip honest in the gap between the two frames.
        const store = useTicketStore.getState();
        const existing = store.byId[event.ticketId];
        if (!existing) return;
        store.upsert({
          ...existing,
          statusSlug: event.toStatusSlug,
          statusCategory: event.toCategory,
          rowVersion: event.rowVersion,
        });
      }),

      onSocket(SOCKET_EVENTS.ticketAssigned, (event) => {
        const store = useTicketStore.getState();
        const existing = store.byId[event.ticketId];
        if (existing) {
          store.upsert({
            ...existing,
            assigneeId: event.toAssigneeId,
            assignmentGroupId: event.assignmentGroupId,
          });
        }
        if (event.toAssigneeId === currentUserId && event.actorId !== currentUserId) {
          onAssignedToMe?.(event.ticketId, event.number, event.subject);
        }
      }),

      // ── SLA ─────────────────────────────────────────────────────────────
      onSocket(SOCKET_EVENTS.slaTick, (event) => {
        const store = useTicketStore.getState();
        const existing = store.byId[event.ticketId];
        if (!existing) return;
        // The nearest due date is denormalised onto the row for sorting; keep
        // the countdown chip in step without a refetch per tick.
        const nearest = event.instances
          .filter((instance) => instance.running && instance.dueAt)
          .sort((a, b) => a.dueAt.localeCompare(b.dueAt))[0];
        store.upsert({ ...existing, dueAt: nearest?.dueAt ?? existing.dueAt });
      }),

      onSocket(SOCKET_EVENTS.slaBreached, (event) => {
        onSlaBreach?.(event.ticketId, event.number, event.targetSlug);
      }),

      // ── Counters ────────────────────────────────────────────────────────
      onSocket(SOCKET_EVENTS.viewCounters, (event) => {
        useViewStore.getState().applyCounters(event.counts);
      }),

      // ── Notifications ───────────────────────────────────────────────────
      onSocket(SOCKET_EVENTS.notificationNew, (event) => {
        // The bell is the durable surface; the toast is a view of it. Store
        // first so an alert survives a dismissed pop-up.
        useLiveAlertsStore.getState().receive(event.alert);
        onLiveAlert?.(event.alert.title, event.alert.message, event.alert.navigateTo);
      }),

      // ── Configuration ───────────────────────────────────────────────────
      onSocket(SOCKET_EVENTS.configPublished, (event) => {
        // A published view changes the sidebar; anything else is the page's
        // business, so it is handed up rather than acted on here.
        if (event.kind === 'view') void useViewStore.getState().loadViews();
        onConfigPublished?.(event.kind, event.slug);
      }),
    ];

    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [session, status, onLiveAlert, onSlaBreach, onAssignedToMe, onConfigPublished]);
}

export default useSocket;
