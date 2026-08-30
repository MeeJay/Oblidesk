/**
 * PortalVerifyPage — `/portal/verify?token=…&next=…`
 *
 * The landing page of the link in the mail. It has no UI worth the name: it
 * burns the token, opens the session and gets out of the way. What it does need
 * to get right is a short list of hazards, all of them about a single-use
 * credential sitting in a URL.
 *
 * ── Burned exactly once ─────────────────────────────────────────────────────
 * The server's burn is one atomic statement, so two concurrent presentations
 * cannot both succeed — and a mail client's link prefetcher racing the human is
 * not hypothetical, it happens constantly. This page must not add a THIRD
 * presentation of its own: React 18's StrictMode runs effects twice in
 * development, and without the ref guard the second run would spend the token
 * the first one just consumed and land the developer on "this link is invalid"
 * every single time.
 *
 * ── The token must leave the history ────────────────────────────────────────
 * Navigation on success is `replace`, not a push. A pushed entry leaves the
 * token in the back stack, where pressing Back re-runs this page against an
 * already-burned token and tells a signed-in customer their link is invalid.
 *
 * ── One honest 401 ──────────────────────────────────────────────────────────
 * Expired, replayed, forged and truncated-by-a-mail-client are answered
 * identically by `verifyMagicLink`, and that is right: distinguishing them
 * would tell whoever is holding a token which kind of wrong it is. So the
 * failure state offers the only action that ever helps — ask for a new link —
 * and carries `next` across so the deep link still survives the second round
 * trip.
 */

import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
// `Link` is react-router's here, so lucide's chain glyph is imported under its
// numbered name rather than aliased into a second `Link` nobody can read.
import { Link2, ShieldAlert } from 'lucide-react';

import { portalApi } from '@/api/portal.api';
import { isInObliTools, setAuthToken } from '@/api/client';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';

import { PortalBrand, PortalCard, PortalFooter, PortalShell } from './PortalFrame';

/** Path-only, same-origin. The server checks this too; both checks are cheap. */
function safeNext(candidate: string | null): string {
  if (!candidate) return '/portal';
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return '/portal';
  if (candidate.includes('\\') || /[\r\n]/.test(candidate)) return '/portal';
  // A link that lands anywhere but the portal is not a portal link. The server
  // already refuses an absolute URL; this refuses a same-origin one that would
  // drop a requester into the agent application, where every route 401s.
  if (!candidate.startsWith('/portal')) return '/portal';
  return candidate.slice(0, 512);
}

export function PortalVerifyPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const token = searchParams.get('token') ?? '';
  const next = safeNext(searchParams.get('next'));

  const [failed, setFailed] = useState(!token);
  const burned = useRef(false);

  useEffect(() => {
    if (!token || burned.current) return;
    burned.current = true;

    void (async () => {
      try {
        const result = await portalApi.verify(token);

        // The desktop shell hosts the app cross-site, where Chrome drops the
        // session cookie; the server hands the session id back in the body for
        // exactly that case and `api/client.ts` replays it as `X-Auth-Token`.
        // In an ordinary browser the cookie is already set and this is a no-op.
        if (isInObliTools && result.token) setAuthToken(result.token);

        // The slug comes back from the burned token, which is the authoritative
        // statement of where this contact belongs — better than whatever the
        // sign-in form was told.
        portalApi.rememberTenantSlug(result.tenantSlug);

        navigate(next, { replace: true });
      } catch {
        setFailed(true);
      }
    })();
  }, [navigate, next, token]);

  if (!failed) {
    return (
      <PortalShell center>
        <div className="w-full max-w-sm space-y-6">
          <PortalBrand
            subtitle={t('portal.verify.working', 'Opening your session…')}
          />
          <div className="flex justify-center py-4">
            <LoadingSpinner size="lg" label={t('portal.verify.working', 'Opening your session…')} />
          </div>
        </div>
      </PortalShell>
    );
  }

  return (
    <PortalShell center>
      <div className="w-full max-w-sm space-y-6">
        <PortalBrand />

        <PortalCard className="space-y-4 text-center">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-card bg-sla-breach-bg text-sla-breach">
            <ShieldAlert size={20} />
          </div>

          <div className="space-y-1.5">
            <p className="text-[15px] font-semibold text-text-primary">
              {t('portal.verify.deadTitle', 'This sign-in link no longer works')}
            </p>
            <p className="text-[13px] leading-relaxed text-text-secondary">
              {t(
                'portal.verify.deadBody',
                'A link works once and expires after 15 minutes. Ask for a new one and it will arrive in a few seconds.',
              )}
            </p>
          </div>

          <Link
            to={`/portal/login${next !== '/portal' ? `?next=${encodeURIComponent(next)}` : ''}`}
            className="block"
          >
            <Button fullWidth icon={<Link2 size={14} />}>
              {t('portal.verify.requestAnother', 'Send me a new link')}
            </Button>
          </Link>
        </PortalCard>
      </div>

      <PortalFooter />
    </PortalShell>
  );
}

export default PortalVerifyPage;
