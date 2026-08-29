import { create } from 'zustand';

export type SocketStatus = 'connected' | 'disconnected' | 'reconnecting';

interface SocketState {
  status: SocketStatus;
  /** Why the last disconnect happened — shown in the indicator's tooltip. */
  lastError: string | null;
  /** When the connection last came up, for "live since …". */
  connectedAt: string | null;

  setStatus: (status: SocketStatus) => void;
  setLastError: (error: string | null) => void;
}

/**
 * Deliberately tiny and dependency-free: the socket module writes it and the
 * connection indicator reads it. Anything richer here would tempt a component
 * into treating the transport's state as the application's, and a page that
 * blanks itself on a two-second reconnect is worse than one that keeps showing
 * the last good data with an honest badge.
 */
export const useSocketStore = create<SocketState>((set) => ({
  status: 'disconnected',
  lastError: null,
  connectedAt: null,

  setStatus: (status) =>
    set((state) => ({
      status,
      connectedAt: status === 'connected' ? new Date().toISOString() : state.connectedAt,
    })),

  setLastError: (lastError) => set({ lastError }),
}));
