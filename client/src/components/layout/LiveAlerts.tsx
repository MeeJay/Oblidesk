import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import type { AlertSeverity, LiveAlert } from '@oblidesk/shared';
import { useLiveAlertsStore } from '@/store/liveAlertsStore';
import { useTenantStore } from '@/store/tenantStore';
import { cn } from '@/utils/cn';

/**
 * A live alert plus the two client-only flags the store keeps on top of the
 * wire shape. `readAt` is the server's truth; `read` is the optimistic flag the
 * store flips before the PATCH lands, and `toastDismissed` hides the toast
 * without marking the alert read (it stays unread in the bell).
 */
export type DeskAlert = LiveAlert & { read?: boolean; toastDismissed?: boolean };

/** Optimistic flag first, server timestamp second. */
export function isAlertRead(alert: DeskAlert): boolean {
  return alert.read ?? alert.readAt !== null;
}

export function countUnreadAlerts(alerts: readonly DeskAlert[]): number {
  return alerts.reduce((total, alert) => (isAlertRead(alert) ? total : total + 1), 0);
}

/**
 * Severity → token classes. HARD RULE 11: the severity accent is a 3px filled
 * strip element down the left edge, never a `border-left`. A border would also
 * fight `shadow-card` for the element's single box-shadow slot.
 */
export const SEVERITY_STYLES: Record<AlertSeverity, { bar: string; text: string; dot: string }> = {
  critical: { bar: 'bg-sla-breach', text: 'text-sla-breach', dot: 'bg-sla-breach' },
  down: { bar: 'bg-sla-breach', text: 'text-sla-breach', dot: 'bg-sla-breach' },
  warning: { bar: 'bg-sla-warn', text: 'text-sla-warn', dot: 'bg-sla-warn' },
  up: { bar: 'bg-status-resolved', text: 'text-status-resolved', dot: 'bg-status-resolved' },
  info: { bar: 'bg-status-new', text: 'text-status-new', dot: 'bg-status-new' },
};

/** Bottom-right stack: a minute. Top-center: ten seconds, newest only. */
const TOAST_LIFETIME_MS = 60_000;
const TOP_CENTER_LIFETIME_MS = 10_000;

interface AlertCardProps {
  alert: DeskAlert;
  opacity?: number;
  lifetimeMs: number;
}

function AlertCard({ alert, opacity = 1, lifetimeMs }: AlertCardProps) {
  const { dismissToast } = useLiveAlertsStore();
  const navigate = useNavigate();
  const styles = SEVERITY_STYLES[alert.severity] ?? SEVERITY_STYLES.info;

  // The timer counts from the alert's own `createdAt`, not from mount. After a
  // reload, an alert that fired 50 s ago gets its remaining 10 s rather than a
  // fresh minute, so a page refresh cannot resurrect a wall of stale toasts.
  useEffect(() => {
    const elapsed = Date.now() - new Date(alert.createdAt).getTime();
    const remaining = Math.max(0, lifetimeMs - elapsed);
    if (remaining === 0) {
      dismissToast(alert.id);
      return;
    }
    const timer = setTimeout(() => dismissToast(alert.id), remaining);
    return () => clearTimeout(timer);
  }, [alert.id, alert.createdAt, lifetimeMs, dismissToast]);

  return (
    <div
      role="status"
      className={cn(
        'animate-fade-in relative flex overflow-hidden rounded-card bg-bg-secondary/95 shadow-card backdrop-blur-md transition-opacity duration-300',
        alert.navigateTo && 'cursor-pointer hover:bg-bg-hover',
      )}
      style={{ opacity }}
      onClick={() => {
        if (alert.navigateTo) navigate(alert.navigateTo);
      }}
    >
      <span className={cn('absolute inset-y-0 left-0 w-[3px]', styles.bar)} aria-hidden />

      <div className="min-w-0 flex-1 py-3 pl-4 pr-8">
        <p className={cn('truncate text-[13px] font-semibold leading-tight', styles.text)}>
          {alert.title}
        </p>
        <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-text-muted">
          {alert.message}
        </p>
      </div>

      <button
        type="button"
        className="absolute right-2 top-2 text-text-muted transition-colors hover:text-text-primary"
        onClick={(event) => {
          event.stopPropagation();
          dismissToast(alert.id);
        }}
        aria-label="Fermer"
      >
        <X size={13} />
      </button>
    </div>
  );
}

/**
 * The toast tray. It is a *view* of the live-alerts store, never its own queue:
 * dismissing a toast here only hides the card — the alert stays in the bell
 * until the agent reads it, because an SLA breach that scrolled past while
 * somebody was on a call must not be lost.
 */
export function LiveAlerts() {
  const { alerts, localEnabled, multiTenantEnabled, position } = useLiveAlertsStore();
  const { currentTenantId } = useTenantStore();

  const lifetimeMs = position === 'top-center' ? TOP_CENTER_LIFETIME_MS : TOAST_LIFETIME_MS;
  const now = Date.now();

  const visible = (alerts as DeskAlert[]).filter((alert) => {
    if (alert.toastDismissed) return false;
    if (now - new Date(alert.createdAt).getTime() >= lifetimeMs) return false;
    // Before the tenant context resolves, treat everything as local so a first
    // alert on a cold load is not silently swallowed.
    const isLocal = currentTenantId != null ? alert.tenantId === currentTenantId : true;
    return isLocal ? localEnabled : multiTenantEnabled;
  });

  if (visible.length === 0) return null;

  if (position === 'top-center') {
    const latest = visible[0];
    return (
      <div className="fixed left-1/2 top-16 z-[90] w-[400px] max-w-[calc(100vw-2rem)] -translate-x-1/2">
        <AlertCard key={latest.id} alert={latest} lifetimeMs={TOP_CENTER_LIFETIME_MS} />
      </div>
    );
  }

  // Bottom-right: newest at the bottom, older stacked above and fading out so
  // an alert storm degrades into a gradient instead of a wall.
  return (
    <div className="fixed bottom-4 right-4 z-[90] flex w-80 max-w-[calc(100vw-2rem)] flex-col-reverse gap-2">
      {visible.slice(0, 10).map((alert, index) => (
        <AlertCard
          key={alert.id}
          alert={alert}
          opacity={Math.max(0.4, 1 - index * 0.15)}
          lifetimeMs={TOAST_LIFETIME_MS}
        />
      ))}
    </div>
  );
}
