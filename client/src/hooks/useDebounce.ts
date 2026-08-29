/**
 * useDebounce.ts — the three debounce shapes the desk actually needs.
 *
 * They are not interchangeable and picking the wrong one is a real bug:
 *   • `useDebounce(value)`   — a derived value, for search-as-you-type.
 *   • `useDebouncedCallback` — a trailing call, for inline-field autosave.
 *   • `useThrottledCallback` — a leading call at a floor, for typing pings and
 *     scroll-driven counters, where the FIRST event must go out immediately.
 *
 * Every one of them cancels on unmount. A debounced save that fires after the
 * ticket detail has closed writes to a row nobody is looking at, and the toast
 * it raises lands on an unrelated screen.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** The value, `delay` ms after it stopped changing. */
export function useDebounce<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}

export interface DebouncedFn<A extends unknown[]> {
  (...args: A): void;
  /** Drop a pending call — the field was reverted, the dialog was cancelled. */
  cancel: () => void;
  /** Run a pending call right now — the agent hit Save, or the row lost focus. */
  flush: () => void;
  /** Is a call waiting? Drives the "unsaved" dot on an inline field. */
  pending: () => boolean;
}

/**
 * Trailing-edge debounce. The callback is read from a ref, so a closure over
 * fresh props is used at fire time rather than the one captured when the timer
 * was set — the classic autosave bug where the field saves its previous value.
 */
export function useDebouncedCallback<A extends unknown[]>(
  callback: (...args: A) => void,
  delay = 500,
): DebouncedFn<A> {
  const callbackRef = useRef(callback);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const argsRef = useRef<A | null>(null);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    argsRef.current = null;
  }, []);

  const flush = useCallback(() => {
    if (timerRef.current === null || argsRef.current === null) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
    const args = argsRef.current;
    argsRef.current = null;
    callbackRef.current(...args);
  }, []);

  // Unmount cancels rather than flushes: a component that went away did not
  // ask for its last keystroke to be committed.
  useEffect(() => cancel, [cancel]);

  return useMemo(() => {
    const fn = ((...args: A) => {
      argsRef.current = args;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const pendingArgs = argsRef.current;
        argsRef.current = null;
        if (pendingArgs) callbackRef.current(...pendingArgs);
      }, delay);
    }) as DebouncedFn<A>;

    fn.cancel = cancel;
    fn.flush = flush;
    fn.pending = () => timerRef.current !== null;
    return fn;
  }, [delay, cancel, flush]);
}

/**
 * Leading-edge throttle: fires immediately, then at most once per `interval`.
 * Typing indicators need this — a trailing debounce would show "is typing"
 * only after the agent stopped, which is precisely backwards.
 */
export function useThrottledCallback<A extends unknown[]>(
  callback: (...args: A) => void,
  interval = 1_000,
): (...args: A) => void {
  const callbackRef = useRef(callback);
  const lastRunRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  return useCallback(
    (...args: A) => {
      const now = Date.now();
      const elapsed = now - lastRunRef.current;

      if (elapsed >= interval) {
        lastRunRef.current = now;
        callbackRef.current(...args);
        return;
      }
      // Keep the LAST call inside the window, so the final state of a burst is
      // never the one that gets dropped.
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        lastRunRef.current = Date.now();
        callbackRef.current(...args);
      }, interval - elapsed);
    },
    [interval],
  );
}

/** A stable ref that always holds the latest value. Used by the hooks above. */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
