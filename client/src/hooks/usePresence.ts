/**
 * usePresence.ts — who else is on this ticket, and what they are touching.
 *
 * This is collision avoidance, not a social feature. Two agents replying to the
 * same customer at the same time is the failure it exists to prevent, so the
 * data it surfaces is deliberately narrow: who is here, who is typing, and
 * which field somebody is editing right now.
 *
 * Mechanics worth knowing:
 *   • Joining the ticket room IS registering presence — the server derives it
 *     from the subscription, so there is no separate "I am here" call to forget.
 *   • The heartbeat lives in the socket module and beats for every open ticket
 *     at half the TTL, so one dropped beat does not make an agent flicker out.
 *   • Typing pings are throttled on the LEADING edge. A trailing debounce would
 *     announce "is typing" only once the agent stopped, which is backwards.
 *   • The viewer list drops the signed-in user: an agent does not need to be
 *     told they are looking at the ticket they are looking at.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { SOCKET_EVENTS, TYPING_TTL_MS } from '@oblidesk/shared';
import { onSocket, sendTyping, subscribeTicket, unsubscribeTicket } from '@/socket';
import { useAuthStore } from '@/store/authStore';
import { useSocketStore } from '@/store/socketStore';
import { useThrottledCallback } from './useDebounce';

export interface Viewer {
  userId: number;
  username: string;
  displayName: string | null;
  avatar: string | null;
  typing: boolean;
  /** Field slug this viewer is editing — the UI greys it for everyone else. */
  editingField: string | null;
}

export interface PresenceApi {
  /** Everyone on the ticket except the signed-in user. */
  viewers: Viewer[];
  /** Those actively typing right now. */
  typing: Viewer[];
  /** `fieldSlug → viewer` for the fields somebody else has open. */
  editingFields: Record<string, Viewer>;
  /** True while the ticket room is joined. False means presence is unknown. */
  joined: boolean;
  /** Announce that this agent is typing (throttled). */
  notifyTyping: (editingField?: string | null) => void;
  /** Announce that this agent stopped. Always send it on blur and on unmount. */
  notifyStoppedTyping: () => void;
  /** Is another agent editing this field right now? */
  isFieldLocked: (fieldSlug: string) => Viewer | null;
}

const EMPTY: Viewer[] = [];

export function usePresence(ticketId: number | null): PresenceApi {
  const currentUserId = useAuthStore((state) => state.session?.user.id ?? null);
  const status = useSocketStore((state) => state.status);

  const [viewers, setViewers] = useState<Viewer[]>(EMPTY);
  const [joined, setJoined] = useState(false);

  // ── Room membership ───────────────────────────────────────────────────────
  useEffect(() => {
    if (ticketId === null || status !== 'connected') {
      setJoined(false);
      setViewers(EMPTY);
      return;
    }

    let active = true;
    void subscribeTicket(ticketId).then((ack) => {
      if (!active) return;
      // A refusal is reported, not swallowed: a presence bar that silently
      // shows nobody looks exactly like a ticket nobody else has open.
      setJoined(ack.ok);
    });

    return () => {
      active = false;
      setJoined(false);
      setViewers(EMPTY);
      // Tell the room we left rather than waiting for the TTL to expire us —
      // a ghost viewer is a collision warning nobody can act on.
      sendTyping(ticketId, false, null);
      void unsubscribeTicket(ticketId);
    };
  }, [ticketId, status]);

  // ── Frames ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (ticketId === null || status !== 'connected') return;

    const offPresence = onSocket(SOCKET_EVENTS.ticketPresence, (event) => {
      if (event.ticketId !== ticketId) return;
      setViewers(event.viewers);
    });

    const offTyping = onSocket(SOCKET_EVENTS.ticketTyping, (event) => {
      if (event.ticketId !== ticketId) return;
      // A typing frame is a delta on a viewer we already know about. If the
      // full presence frame has not arrived yet, adopt the sender rather than
      // dropping the signal — a late roster must not hide a live collision.
      setViewers((current) => {
        const index = current.findIndex((viewer) => viewer.userId === event.userId);
        if (index === -1) {
          if (!event.typing) return current;
          return [
            ...current,
            {
              userId: event.userId,
              username: event.username,
              displayName: event.displayName,
              avatar: null,
              typing: true,
              editingField: event.editingField,
            },
          ];
        }
        const next = [...current];
        next[index] = { ...next[index], typing: event.typing, editingField: event.editingField };
        return next;
      });
    });

    return () => {
      offPresence();
      offTyping();
    };
  }, [ticketId, status]);

  // ── Typing decay ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!viewers.some((viewer) => viewer.typing)) return;
    // The server expires typing on its own clock, but a dropped "stopped"
    // frame would leave a stale "is typing" on screen forever. Decay locally
    // at the same TTL so the indicator can only ever be too quiet, never a lie.
    const timer = setTimeout(() => {
      setViewers((current) =>
        current.map((viewer) => (viewer.typing ? { ...viewer, typing: false } : viewer)),
      );
    }, TYPING_TTL_MS);
    return () => clearTimeout(timer);
  }, [viewers]);

  // ── Outbound ──────────────────────────────────────────────────────────────
  const emitTyping = useThrottledCallback((editingField: string | null) => {
    if (ticketId === null) return;
    sendTyping(ticketId, true, editingField);
  }, 2_000);

  const notifyTyping = useCallback(
    (editingField: string | null = null) => emitTyping(editingField),
    [emitTyping],
  );

  const notifyStoppedTyping = useCallback(() => {
    if (ticketId === null) return;
    sendTyping(ticketId, false, null);
  }, [ticketId]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const others = useMemo(
    () => viewers.filter((viewer) => viewer.userId !== currentUserId),
    [viewers, currentUserId],
  );

  const typing = useMemo(() => others.filter((viewer) => viewer.typing), [others]);

  const editingFields = useMemo(() => {
    const out: Record<string, Viewer> = {};
    for (const viewer of others) {
      if (viewer.editingField) out[viewer.editingField] = viewer;
    }
    return out;
  }, [others]);

  const isFieldLocked = useCallback(
    (fieldSlug: string) => editingFields[fieldSlug] ?? null,
    [editingFields],
  );

  return { viewers: others, typing, editingFields, joined, notifyTyping, notifyStoppedTyping, isFieldLocked };
}

export default usePresence;
