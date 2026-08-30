/**
 * PortalFrame.tsx — the calm surface every portal screen sits on.
 *
 * ── A customer is not an agent ──────────────────────────────────────────────
 * The desk's chrome is built for someone who lives in it eight hours a day: a
 * queue rail, a command palette, a tenant switcher, fifteen sidebar entries.
 * None of that helps the person on the other side of the ticket, who arrives
 * roughly four times a year, from a link in an e-mail, to do exactly one thing.
 * So the portal has no sidebar, no palette and no switcher — one column, a
 * heading, and the action they came for.
 *
 * It is emphatically NOT a second design language. The tokens, the radii, the
 * card shadow and the accent are the desk's, so a customer who also uses
 * another Obli* app recognises the family and an operator who theme-switches in
 * Obligate sees the portal follow (the theme key is shared suite-wide and read
 * before first paint in `index.html`).
 *
 * ── Depth without borders (HARD RULE 11) ────────────────────────────────────
 * The ambient glow behind the content is a radial gradient at 6% accent, not an
 * outline; the header's under-line is a 1px background element, not a
 * `border-bottom`; cards are the `bg-secondary` step plus `shadow-card`. There
 * is no `border:` anywhere in this module and there must not be one added.
 */

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { Logo } from '@/components/common/Logo';
import { cn } from '@/utils/cn';

interface PortalShellProps {
  children: ReactNode;
  /** Vertically centre the content — the sign-in and verify screens. */
  center?: boolean;
  className?: string;
}

/**
 * The page. Paints the background explicitly rather than inheriting it: the
 * portal is often the first Oblidesk page a browser has ever loaded, and a
 * transparent body would show whatever the host painted underneath.
 */
export function PortalShell({ children, center = false, className }: PortalShellProps) {
  return (
    <div className="relative min-h-screen bg-bg-primary text-text-primary">
      {/* Ambient accent, fixed so it does not scroll away from a long ticket.
          `pointer-events-none` because decoration must never eat a click. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-0"
        style={{
          background:
            'radial-gradient(1100px 560px at 50% -12%, rgb(var(--c-accent) / 0.09), transparent 68%)',
        }}
      />
      <div
        className={cn(
          'relative z-10 flex min-h-screen flex-col',
          center && 'items-center justify-center px-4 py-10',
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}

interface PortalBrandProps {
  /** The desk's own name for itself, when the tenant is known. */
  tenantSlug?: string | null;
  /** One quiet sentence under the wordmark. Already translated. */
  subtitle?: string;
  className?: string;
}

/**
 * The mark, the product name and one line of context.
 *
 * The tenant SLUG is shown, not a numeric id (HARD RULE 13 is about identity
 * joins, but the same reasoning applies to what a human is asked to recognise:
 * "acme" is something a customer can check against the mail they were sent, and
 * "4" is not).
 */
export function PortalBrand({ tenantSlug, subtitle, className }: PortalBrandProps) {
  const { t } = useTranslation();

  return (
    <div className={cn('text-center', className)}>
      <Logo className="mx-auto justify-center" size={44} markOnly />
      <h1 className="mt-3 font-display text-2xl font-semibold tracking-wide text-text-primary">
        {t('portal.title', 'Support portal')}
      </h1>
      {tenantSlug ? (
        <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.18em] text-text-muted">
          {tenantSlug}
        </p>
      ) : null}
      {subtitle ? (
        <p className="mx-auto mt-2 max-w-sm text-[13px] leading-relaxed text-text-secondary">
          {subtitle}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A card. One place, so the surface step and the radius cannot drift between
 * the five screens — and so nobody adds a border to just one of them.
 */
export function PortalCard({
  children,
  className,
  as = 'div',
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'section';
}) {
  const Tag = as;
  return (
    <Tag className={cn('rounded-card bg-bg-secondary p-5 shadow-card', className)}>{children}</Tag>
  );
}

/**
 * The strip that separates the header from the content.
 *
 * A `<div>` with a background rather than a `border-bottom`: the border tokens
 * exist for hairline rules, but writing an actual `border:` on chrome is the
 * habit HARD RULE 11 is trying to break, and a background element is the same
 * pixel with none of the ambiguity.
 */
export function PortalRule({ className }: { className?: string }) {
  return <div aria-hidden className={cn('h-px w-full bg-border/70', className)} />;
}

/**
 * The footer line. It exists to answer "am I in the right place?" — the desk's
 * name and a way back to the list — and nothing else. No links to the agent
 * application: a customer clicking through to `/login` and meeting an
 * identifier-and-password form they have no account for reads as being locked
 * out of their own supplier's support.
 */
export function PortalFooter({
  signedIn = false,
  className,
}: {
  signedIn?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();

  return (
    // No `mt-auto` by default. The signed-in layout pushes it to the bottom of a
    // full-height column; the centred sign-in screens keep it in the stack,
    // where an auto margin would fight `justify-center` and win, dragging the
    // form back to the top of the viewport.
    <footer className={cn('px-4 py-8 text-center', className)}>
      {signedIn ? (
        <Link
          to="/portal"
          className="font-mono text-[11px] uppercase tracking-[0.16em] text-text-muted transition-colors hover:text-text-secondary"
        >
          {t('portal.myRequests', 'My requests')}
        </Link>
      ) : (
        <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-text-muted">
          {t('portal.title', 'Support portal')}
        </p>
      )}
    </footer>
  );
}
