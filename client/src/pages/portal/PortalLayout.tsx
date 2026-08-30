/**
 * PortalLayout.tsx — the chrome around every SIGNED-IN portal screen.
 *
 * Mounted as the element of a parent `<Route>`, so the provider and the header
 * survive navigation between the list, one ticket and the new-request form.
 * That is not a micro-optimisation: remounting the provider on every click
 * would re-run the `/me` probe each time and make the whole portal flash a
 * spinner between two of its own pages.
 *
 * ── What is deliberately absent ─────────────────────────────────────────────
 * No tenant switcher: a portal contact belongs to exactly one tenant, pinned in
 * the session by the token they burned, and offering a control that cannot
 * change anything is worse than offering nothing. No notification bell, no
 * presence, no command palette — a customer visits four times a year and has
 * nothing to learn a shortcut for. The header carries three things: where they
 * are, who they are, and the way out.
 */

import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LogOut, Plus } from 'lucide-react';

import { Logo } from '@/components/common/Logo';
import { Button } from '@/components/common/Button';
import { cn } from '@/utils/cn';

import { PortalFooter, PortalRule, PortalShell } from './PortalFrame';
import { PortalGuard, PortalSessionProvider, usePortalSession } from './PortalSession';

function PortalHeader() {
  const { t } = useTranslation();
  const { me, signOut } = usePortalSession();
  const location = useLocation();

  // The identity line prefers the name the desk holds; an address is a fallback
  // and never the only thing on screen, because "you are signed in as
  // someone@example.com" is the sentence that tells a shared-inbox user they
  // are about to file a ticket as a colleague.
  const who = me?.displayName?.trim() || me?.email || '';
  const onNewRequest = location.pathname === '/portal/new';

  return (
    <header className="sticky top-0 z-20 bg-bg-primary/85 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-3xl items-center gap-3 px-4">
        <Link
          to="/portal"
          className="flex items-center gap-2 rounded-pill px-1 py-1 transition-colors hover:bg-bg-hover"
          title={t('portal.myRequests', 'My requests')}
        >
          <Logo size={22} markOnly />
          <span className="font-display text-[15px] font-semibold tracking-wide text-text-primary">
            {t('portal.title', 'Support portal')}
          </span>
        </Link>

        <span className="flex-1" />

        {!onNewRequest && (
          <Link to="/portal/new" className="hidden sm:block">
            <Button size="sm" variant="primary" icon={<Plus size={14} />}>
              {t('portal.newRequest', 'New request')}
            </Button>
          </Link>
        )}

        {who && (
          <span
            className="hidden max-w-[13rem] truncate rounded-pill bg-bg-tertiary px-2.5 py-1 text-[12px] text-text-secondary md:block"
            title={me?.email ?? undefined}
          >
            {who}
          </span>
        )}

        <button
          type="button"
          onClick={() => void signOut()}
          aria-label={t('portal.signOut', 'Sign out')}
          title={t('portal.signOut', 'Sign out')}
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-pill text-text-muted',
            'transition-colors hover:bg-bg-hover hover:text-text-primary',
          )}
        >
          <LogOut size={15} />
        </button>
      </div>
      <PortalRule />
    </header>
  );
}

export function PortalLayout() {
  return (
    <PortalSessionProvider>
      <PortalShell>
        <PortalHeader />
        <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
          {/* The gate renders the child route. Putting it INSIDE the chrome
              rather than around it means a customer whose session died sees the
              portal's own header while being sent back to sign in, instead of
              the page collapsing to a bare spinner that reads as a crash. */}
          <PortalGuard />
        </main>
        <PortalFooter signedIn className="mt-auto" />
      </PortalShell>
    </PortalSessionProvider>
  );
}

export default PortalLayout;
