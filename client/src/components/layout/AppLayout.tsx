import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Outlet } from 'react-router-dom';
import { useSocket } from '@/hooks/useSocket';
import { cn } from '@/utils/cn';
import { Header } from './Header';
import { LiveAlerts } from './LiveAlerts';
import { CommandPalette } from './CommandPalette';
import {
  SIDEBAR_COLLAPSED_WIDTH,
  Sidebar,
  setSidebarWidth,
  useSidebarState,
} from './Sidebar';

/**
 * Obli Design v1 — DETACHED topbar + sidebar (design system §4 and §12).
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ Header — 52px, full viewport width           │
 *   ├──────────┬───────────────────────────────────┤
 *   │ Sidebar  │ <Outlet />                        │
 *   │ 260/64px │                                   │
 *   └──────────┴───────────────────────────────────┘
 *
 * The topbar spans the whole width with the sidebar BELOW it, not beside it, so
 * the logo, tenant selector and app switcher stay reachable no matter what the
 * sidebar is doing — pinned, collapsed to 64px, or floating.
 */
export function AppLayout() {
  // Tenant + user socket rooms, joined once for the whole session rather than
  // per page: the queue counters in the sidebar and the SLA toasts have to keep
  // arriving while the agent is deep in a ticket.
  useSocket();

  const { collapsed, floating, width } = useSidebarState();

  // ── Where the body row starts ──────────────────────────────────────────────
  // The floating sidebar is `position: fixed` and must drop from BELOW the
  // topbar, not from y = 0, or it would cover the tenant selector — the one
  // control an agent reaches for when the sidebar is in the way. Measured
  // rather than hard-coded at 52px so a future banner above the row moves it.
  const bodyRowRef = useRef<HTMLDivElement>(null);
  const [topOffset, setTopOffset] = useState(0);

  useEffect(() => {
    const measure = () => {
      if (bodyRowRef.current) setTopOffset(bodyRowRef.current.getBoundingClientRect().top);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // ── Floating sidebar visibility ────────────────────────────────────────────
  const [floatVisible, setFloatVisible] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!floating) setFloatVisible(false);
  }, [floating]);

  useEffect(() => () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
  }, []);

  const showFloat = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setFloatVisible(true);
  }, []);

  // A short grace period: sliding the pointer from the panel to a nav item
  // briefly leaves both elements, and an instant hide would snatch the menu
  // away mid-gesture.
  const hideFloat = useCallback(() => {
    hideTimer.current = setTimeout(() => setFloatVisible(false), 150);
  }, []);

  // ── Resize handle ──────────────────────────────────────────────────────────
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const handleMouseDown = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      dragging.current = true;
      startX.current = event.clientX;
      startWidth.current = width;

      const onMove = (moveEvent: globalThis.MouseEvent) => {
        if (!dragging.current) return;
        setSidebarWidth(startWidth.current + (moveEvent.clientX - startX.current));
      };
      const onUp = () => {
        dragging.current = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      // Without these the drag selects page text and the cursor flickers back
      // to the arrow every time it leaves the 4px handle.
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [width],
  );

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg-primary">
      <Header />

      <div ref={bodyRowRef} className="flex flex-1 overflow-hidden">
        {floating ? (
          <>
            {/* Hover strip on the left edge of the BODY row only — the topbar is
                excluded so the logo and tenant pill stay clickable. */}
            <div
              className="fixed left-0 z-[51] w-2"
              style={{ top: topOffset, height: `calc(100% - ${topOffset}px)` }}
              onMouseEnter={showFloat}
            />

            <div
              className={cn(
                'fixed left-0 z-50 transition-transform duration-200 ease-in-out',
                'shadow-[4px_0_24px_0_rgba(0,0,0,0.35)]',
                floatVisible ? 'translate-x-0' : '-translate-x-full',
              )}
              style={{ width, top: topOffset, height: `calc(100% - ${topOffset}px)` }}
              onMouseEnter={showFloat}
              onMouseLeave={hideFloat}
            >
              <Sidebar />
              <div
                onMouseDown={handleMouseDown}
                className="absolute bottom-0 right-0 top-0 z-10 w-1 cursor-col-resize transition-colors hover:bg-accent/30 active:bg-accent/50"
              />
            </div>
          </>
        ) : (
          <div
            className="relative flex-shrink-0 transition-[width] duration-200"
            style={{ width: collapsed ? SIDEBAR_COLLAPSED_WIDTH : width }}
          >
            <Sidebar />
            {/* Collapsed is a fixed 64px rail — there is nothing to resize. */}
            {!collapsed && (
              <div
                onMouseDown={handleMouseDown}
                className="absolute bottom-0 right-0 top-0 z-10 w-1 cursor-col-resize transition-colors hover:bg-accent/30 active:bg-accent/50"
              />
            )}
          </div>
        )}

        <main className="flex flex-1 flex-col overflow-y-auto">
          <Outlet />
        </main>
      </div>

      {/* Global overlays. Both are fixed-position portals, so they sit outside
          the scroll container and survive every route change. */}
      <LiveAlerts />
      <CommandPalette />
    </div>
  );
}
