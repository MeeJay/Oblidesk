import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, CheckCheck, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Toggle } from '@/components/common/Toggle';
import { useLiveAlertsStore } from '@/store/liveAlertsStore';
import { useTenantStore } from '@/store/tenantStore';
import { cn } from '@/utils/cn';
import {
  SEVERITY_STYLES,
  countUnreadAlerts,
  isAlertRead,
  type DeskAlert,
} from './LiveAlerts';

/** Relative time, translated. Intentionally coarse — this is a glance surface. */
function useTimeAgo() {
  const { t } = useTranslation();
  return (iso: string): string => {
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (seconds < 60) return t('time.secondsAgo', 'il y a {{count}} s', { count: seconds });
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return t('time.minutesAgo', 'il y a {{count}} min', { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('time.hoursAgo', 'il y a {{count}} h', { count: hours });
    return t('time.daysAgo', 'il y a {{count}} j', { count: Math.floor(hours / 24) });
  };
}

interface AlertRowProps {
  alert: DeskAlert;
  showTenantBadge: boolean;
  onOpen: (alert: DeskAlert) => void;
  onRemove: (id: number) => void;
}

function AlertRow({ alert, showTenantBadge, onOpen, onRemove }: AlertRowProps) {
  const { t } = useTranslation();
  const timeAgo = useTimeAgo();
  const styles = SEVERITY_STYLES[alert.severity] ?? SEVERITY_STYLES.info;
  const read = isAlertRead(alert);

  return (
    <div
      className={cn(
        'relative flex items-start gap-3 py-3 pl-4 pr-8 transition-colors',
        read ? 'opacity-45' : 'opacity-100',
        alert.navigateTo && 'cursor-pointer hover:bg-bg-hover',
      )}
      onClick={() => onOpen(alert)}
    >
      {/* Severity strip — a filled element, not a border (HARD RULE 11). */}
      <span className={cn('absolute inset-y-0 left-0 w-[3px]', styles.bar)} aria-hidden />

      <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', styles.dot)} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className={cn('truncate text-[13px] font-semibold', styles.text)}>{alert.title}</p>
          {!read && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
        </div>
        <p className="mt-0.5 line-clamp-2 text-[12px] text-text-muted">{alert.message}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-[10px] text-text-muted">{timeAgo(alert.createdAt)}</span>
          {showTenantBadge && alert.tenantName && (
            <span className="rounded-pill bg-accent/15 px-1.5 py-0.5 font-mono text-[10px] font-medium text-accent">
              {alert.tenantName}
            </span>
          )}
        </div>
      </div>

      <button
        type="button"
        className="absolute right-2 top-3 shrink-0 text-text-muted transition-colors hover:text-text-primary"
        onClick={(event) => {
          event.stopPropagation();
          onRemove(alert.id);
        }}
        title={t('notifications.dismiss', 'Ecarter')}
        aria-label={t('notifications.dismiss', 'Ecarter')}
      >
        <X size={12} />
      </button>
    </div>
  );
}

type Tab = 'local' | 'global';

/**
 * The bell. Holds SLA warnings and breaches, alert-spine bindings, approval
 * requests and assignment notices — everything that also flashes past as a
 * toast, so a notice missed while the agent was on a call is still here.
 *
 * Dismissing a row here removes it for good; that is the difference between
 * this and `LiveAlerts`, where dismissing only hides the toast.
 */
export function NotificationCenter() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('local');

  const {
    alerts,
    localEnabled,
    multiTenantEnabled,
    setLocalEnabled,
    setMultiTenantEnabled,
    markAlertRead,
    markAllRead,
    removeAlert,
    clearAll,
  } = useLiveAlertsStore();

  const { currentTenantId, memberships } = useTenantStore();
  const navigate = useNavigate();
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const all = alerts as DeskAlert[];
  const isMultiTenant = memberships.length > 1;
  const localAlerts = all.filter((alert) => alert.tenantId === currentTenantId);
  const tabAlerts = tab === 'global' ? all : localAlerts;

  const totalUnread = countUnreadAlerts(all);
  const localUnread = countUnreadAlerts(localAlerts);

  useEffect(() => {
    if (!isMultiTenant && tab === 'global') setTab('local');
  }, [isMultiTenant, tab]);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (
        panelRef.current &&
        !panelRef.current.contains(event.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const handleOpenAlert = async (alert: DeskAlert) => {
    await markAlertRead(alert.id);

    // Cross-tenant: switch the session, then do a HARD navigation. A
    // client-side navigate() would leave every tenant-scoped store holding the
    // previous tenant's rows behind the new tenant's chrome.
    if (alert.tenantId && alert.tenantId !== currentTenantId) {
      await useTenantStore.getState().switchTenant(alert.tenantId);
      setOpen(false);
      window.location.assign(alert.navigateTo ?? '/');
      return;
    }

    if (alert.navigateTo) {
      setOpen(false);
      navigate(alert.navigateTo);
    }
  };

  const popupsOn = localEnabled || multiTenantEnabled;

  return (
    <div className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        title={t('notifications.title', 'Notifications')}
        aria-label={t('notifications.title', 'Notifications')}
        aria-expanded={open}
        className="relative flex h-7 w-7 items-center justify-center rounded-pill transition-colors hover:bg-bg-hover"
      >
        <Bell size={15} className={popupsOn ? 'text-accent' : 'text-text-muted'} />
        {totalUnread > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-sla-breach px-1 font-mono text-[10px] font-bold leading-none text-white">
            {totalUnread > 99 ? '99+' : totalUnread}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          className="animate-fade-in absolute right-0 top-9 z-[60] w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-modal bg-bg-secondary shadow-card"
        >
          <div className="space-y-2 px-4 py-3">
            <div className="flex items-center justify-between">
              <h3 className="text-[13px] font-semibold text-text-primary">
                {t('notifications.title', 'Notifications')}
              </h3>
              <div className="flex items-center gap-2">
                {tabAlerts.some((alert) => !isAlertRead(alert)) && (
                  <button
                    type="button"
                    onClick={() => void markAllRead()}
                    title={t('notifications.markAllRead', 'Tout marquer comme lu')}
                    aria-label={t('notifications.markAllRead', 'Tout marquer comme lu')}
                    className="text-text-muted transition-colors hover:text-text-primary"
                  >
                    <CheckCheck size={14} />
                  </button>
                )}
                {tabAlerts.length > 0 && (
                  <button
                    type="button"
                    onClick={clearAll}
                    title={t('notifications.clearAll', 'Tout effacer')}
                    aria-label={t('notifications.clearAll', 'Tout effacer')}
                    className="text-text-muted transition-colors hover:text-text-primary"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  title={t('common.close', 'Fermer')}
                  aria-label={t('common.close', 'Fermer')}
                  className="text-text-muted transition-colors hover:text-text-primary"
                >
                  <X size={14} />
                </button>
              </div>
            </div>

            {isMultiTenant && (
              <div className="flex gap-0.5 rounded-pill bg-bg-tertiary p-0.5">
                {(['local', 'global'] as const).map((key) => {
                  const count = key === 'local' ? localUnread : totalUnread;
                  const active = tab === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setTab(key)}
                      className={cn(
                        'flex-1 rounded-[5px] py-1 text-[11px] transition-colors',
                        active
                          ? 'bg-bg-active font-medium text-text-primary'
                          : 'text-text-muted hover:text-text-secondary',
                      )}
                    >
                      {key === 'local'
                        ? t('notifications.tabLocal', 'Ce tenant')
                        : t('notifications.tabGlobal', 'Tous les tenants')}
                      {count > 0 && <span className="ml-1 font-mono opacity-80">({count})</span>}
                    </button>
                  );
                })}
              </div>
            )}

            {tab === 'local' ? (
              <Toggle
                checked={localEnabled}
                onChange={setLocalEnabled}
                labelFirst
                label={
                  localEnabled
                    ? t('notifications.popupsOn', 'Pop-ups actives')
                    : t('notifications.popupsOff', 'Pop-ups desactivees')
                }
              />
            ) : (
              isMultiTenant && (
                <Toggle
                  checked={multiTenantEnabled}
                  onChange={setMultiTenantEnabled}
                  labelFirst
                  label={
                    multiTenantEnabled
                      ? t('notifications.popupsAllOn', 'Pop-ups multi-tenant actives')
                      : t('notifications.popupsAllOff', 'Pop-ups multi-tenant desactivees')
                  }
                />
              )
            )}
          </div>

          <div className="h-px bg-border" />

          <div className="max-h-96 divide-y divide-border/60 overflow-y-auto">
            {tabAlerts.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-10 text-text-muted">
                <Bell size={22} className="opacity-30" />
                <p className="text-[13px]">
                  {t('notifications.empty', 'Aucune notification')}
                </p>
              </div>
            ) : (
              tabAlerts.map((alert) => (
                <AlertRow
                  key={alert.id}
                  alert={alert}
                  showTenantBadge={tab === 'global' && alert.tenantId !== currentTenantId}
                  onOpen={(a) => void handleOpenAlert(a)}
                  onRemove={removeAlert}
                />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
