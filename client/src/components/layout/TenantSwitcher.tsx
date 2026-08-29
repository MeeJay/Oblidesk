import { useEffect, useRef, useState } from 'react';
import { Building2, Check, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTenantStore } from '@/store/tenantStore';
import { cn } from '@/utils/cn';

/** What the chrome needs from a tenant, whatever shape the store holds. */
export interface SwitchableTenant {
  id: number;
  /** The cross-app identity (HARD RULE 13) — every handoff carries this. */
  slug: string;
  name: string;
}

/**
 * The session hands tenants back as `TenantMembership`
 * (`tenantId` / `tenantSlug` / `tenantName`) while `/api/tenants` returns
 * `Tenant` (`id` / `slug` / `name`). The chrome should not care which one the
 * store happens to hold, so both shapes are flattened here once.
 */
export function normalizeTenants(list: readonly unknown[] | undefined | null): SwitchableTenant[] {
  if (!Array.isArray(list)) return [];
  const out: SwitchableTenant[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const id = typeof row.id === 'number' ? row.id : typeof row.tenantId === 'number' ? row.tenantId : null;
    if (id === null) continue;
    out.push({
      id,
      slug: String(row.slug ?? row.tenantSlug ?? ''),
      name: String(row.name ?? row.tenantName ?? row.slug ?? row.tenantSlug ?? id),
    });
  }
  return out;
}

/** The slug of the tenant currently in context, or null. Used for the app handoff. */
export function currentTenantSlug(
  list: readonly unknown[] | undefined | null,
  currentTenantId: number | null | undefined,
): string | null {
  const tenants = normalizeTenants(list);
  const match = tenants.find((tenant) => tenant.id === currentTenantId) ?? tenants[0];
  return match?.slug || null;
}

/**
 * Tenant pill + dropdown, design system §13: `bg-bg-hover`, 7px radius, mono
 * "TENANT" label, name, chevron. No border on the pill (HARD RULE 11); the
 * dropdown is a raised surface with a hairline separator only.
 *
 * Switching does a FULL page navigation rather than a client-side re-render.
 * Half a dozen stores hold tenant-scoped data (tickets, queues, config, SLA
 * clocks, the socket's room membership); refreshing them one at a time leaves a
 * window where the board shows tenant A's tickets under tenant B's queues. A
 * reload is the only reliably clean reset, and it is what the rest of the suite
 * does.
 */
export function TenantSwitcher() {
  const { t } = useTranslation();
  const { currentTenantId, memberships, switchTenant } = useTenantStore();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Hooks must run before any early return (Rules of Hooks).
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

  const list = normalizeTenants(memberships);

  // A single-tenant install has nothing to switch to — hide the control rather
  // than show a dropdown with one entry in it.
  if (list.length <= 1) return null;

  const current = list.find((tenant) => tenant.id === currentTenantId) ?? list[0];

  const handleSwitch = async (tenantId: number) => {
    if (tenantId === currentTenantId || switching) return;
    setSwitching(true);
    setOpen(false);
    try {
      await switchTenant(tenantId);
      window.location.assign('/');
    } catch {
      setSwitching(false);
    }
  };

  return (
    <div className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={switching}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={t('tenant.switchWorkspace', "Changer d'espace de travail")}
        className={cn(
          'flex items-center gap-2 rounded-pill bg-bg-hover px-3 py-1.5 text-[13px] font-medium text-text-primary transition-colors hover:bg-bg-active',
          switching && 'cursor-wait opacity-60',
        )}
      >
        <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
          {t('tenant.label', 'Tenant')}
        </span>
        <span className="max-w-[140px] truncate tracking-[0.04em]">{current?.name ?? '…'}</span>
        <ChevronDown
          size={12}
          className={cn('shrink-0 text-text-muted transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div
          ref={panelRef}
          role="listbox"
          className="animate-fade-in absolute left-0 top-10 z-[60] w-64 overflow-hidden rounded-modal bg-bg-secondary shadow-card"
        >
          <div className="px-3 py-2">
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">
              {t('tenant.switchWorkspace', "Changer d'espace de travail")}
            </p>
          </div>
          <div className="h-px bg-border" />

          <div className="max-h-64 overflow-y-auto py-1">
            {list.map((tenant) => {
              const active = tenant.id === currentTenantId;
              return (
                <button
                  key={tenant.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => void handleSwitch(tenant.id)}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] transition-colors hover:bg-bg-hover',
                    active ? 'font-semibold text-accent' : 'text-text-primary',
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Building2 size={13} className="shrink-0 text-text-muted" />
                    <span className="truncate">{tenant.name}</span>
                    {/* The slug is what every cross-app join uses, so an admin
                        comparing tenants between apps needs to read it here. */}
                    {tenant.slug && (
                      <span className="shrink-0 font-mono text-[10px] text-text-muted">
                        {tenant.slug}
                      </span>
                    )}
                  </span>
                  {active && <Check size={13} className="shrink-0 text-accent" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
