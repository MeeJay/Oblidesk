/**
 * PortalLoginPage — `/portal/login`
 *
 * One field, one button, one sentence afterwards. There is no password here and
 * there never will be: a requester's password would get reused, would need its
 * own reset flow, and would turn "somebody left the company" into a support
 * ticket. The link in the mail is the credential, and it is single-use,
 * fifteen-minute, hashed at rest and rate-limited per ADDRESS.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 *  THE SCREEN SAYS THE SAME THING WHETHER OR NOT THE ADDRESS EXISTS.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * `requestMagicLink` answers identically in every branch — unknown tenant,
 * unknown address, deactivated contact, portal disabled, rate limited — and the
 * point of that uniformity is lost the moment the client re-introduces the
 * distinction. "No account for that address" would make this form a free
 * customer list: an attacker submits addresses and reads the difference between
 * the two answers to learn who a supplier's customers are.
 *
 * So the only failure this page renders is a failure to ASK: a dead network, a
 * 5xx. "We could not reach the server" and "we asked and are telling you
 * nothing" are genuinely different facts, and the second one is the one that
 * must never vary.
 *
 * ── The tenant ──────────────────────────────────────────────────────────────
 * The sign-in endpoint needs a tenant SLUG (HARD RULE 13 — never a numeric id),
 * because at this instant there is no session to carry one. A customer knows
 * their supplier's name, not a slug, so it normally arrives in the link the
 * supplier sent (`/portal/login?tenant=acme`) and is remembered afterwards.
 * When neither is available the field is asked for plainly rather than guessed:
 * guessing wrong produces the same silent success as everything else here,
 * which would be indistinguishable from a mail that never arrived.
 */

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Building2, MailCheck, Send, WifiOff } from 'lucide-react';

import { portalApi } from '@/api/portal.api';
import { ApiError } from '@/api/client';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';

import { PortalBrand, PortalCard, PortalFooter, PortalShell } from './PortalFrame';

/** A path we are willing to hand back to the server as a landing target. */
function safeNext(candidate: string | null): string | null {
  if (!candidate) return null;
  // Same three refusals the server applies, applied here too so a hostile value
  // never even leaves the browser: absolute URLs, protocol-relative URLs,
  // backslash and newline smuggling.
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return null;
  if (candidate.includes('\\') || /[\r\n]/.test(candidate)) return null;
  return candidate.slice(0, 512);
}

export function PortalLoginPage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();

  const urlTenant = (searchParams.get('tenant') ?? '').trim().toLowerCase();
  const next = useMemo(() => safeNext(searchParams.get('next')), [searchParams]);

  // Read once per mount, not per render: `rememberedTenantSlug()` touches
  // localStorage, which throws outright in some privacy modes.
  const remembered = useMemo(() => portalApi.rememberedTenantSlug(), []);

  const [tenantSlug, setTenantSlug] = useState(() => urlTenant || remembered);
  // Shown collapsed when we already know the workspace: a customer who followed
  // their supplier's link should not have to read a field they cannot improve.
  const [editingTenant, setEditingTenant] = useState(() => !(urlTenant || remembered));

  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [transportError, setTransportError] = useState('');

  // A slug in the URL wins over the remembered one: the supplier's own link is
  // the most recent statement about where this person belongs.
  useEffect(() => {
    if (!urlTenant) return;
    setTenantSlug(urlTenant);
    setEditingTenant(false);
  }, [urlTenant]);

  const canSubmit = email.trim().includes('@') && tenantSlug.trim() !== '' && !sending;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;

    setSending(true);
    setTransportError('');

    try {
      await portalApi.requestLink({
        tenantSlug,
        email,
        // Carried into the mail so a deep link survives the round trip through
        // an inbox. The server validates it a second time before writing it.
        next,
      });
      // Remembered only on a request that actually reached the server. Storing
      // it optimistically would pin a typo into localStorage and make every
      // later attempt fail silently for a reason nothing on screen explains.
      portalApi.rememberTenantSlug(tenantSlug);
      setSent(true);
    } catch (error) {
      // Reached only when the request could not be MADE. Everything the server
      // answers is a success, on purpose — see the header.
      setTransportError(
        error instanceof ApiError && error.status === 0
          ? t('portal.auth.unreachable', 'The server is unreachable. Check your connection and try again.')
          : t('portal.auth.requestFailed', 'The sign-in link could not be requested. Try again in a moment.'),
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <PortalShell center>
      <div className="w-full max-w-sm space-y-6">
        <PortalBrand
          tenantSlug={tenantSlug || null}
          subtitle={
            sent
              ? undefined
              : t(
                  'portal.auth.subtitle',
                  'Enter your e-mail address and we will send you a sign-in link. No password needed.',
                )
          }
        />

        {sent ? (
          // ── Sent ──────────────────────────────────────────────────────────
          // Note what this does NOT say: it does not say an account was found.
          // It says what was done with the address, which is true either way.
          <PortalCard className="space-y-4 text-center">
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-card bg-accent/12 text-accent">
              <MailCheck size={20} />
            </div>
            <div className="space-y-1.5">
              <p className="text-[15px] font-semibold text-text-primary">
                {t('portal.auth.sentTitle', 'Check your inbox')}
              </p>
              <p className="text-[13px] leading-relaxed text-text-secondary">
                {t(
                  'portal.auth.sentBody',
                  'If {{email}} is registered on this support portal, a sign-in link is on its way. It expires in 15 minutes and can be used once.',
                  { email: email.trim() },
                )}
              </p>
              <p className="text-[12px] leading-relaxed text-text-muted">
                {t(
                  'portal.auth.sentSpam',
                  'Nothing after a few minutes? Check your spam folder, then ask for a new link.',
                )}
              </p>
            </div>


            <Button
              variant="ghost"
              size="sm"
              fullWidth
              onClick={() => {
                setSent(false);
              }}
            >
              {t('portal.auth.useAnotherAddress', 'Use a different address')}
            </Button>
          </PortalCard>
        ) : (
          // ── Ask ───────────────────────────────────────────────────────────
          <form onSubmit={submit} className="space-y-4 rounded-card bg-bg-secondary p-5 shadow-card">
            {editingTenant ? (
              <Input
                label={t('portal.auth.workspace', 'Support workspace')}
                hint={t(
                  'portal.auth.workspaceHint',
                  'The short name your supplier used in the link they sent you.',
                )}
                icon={<Building2 size={14} />}
                value={tenantSlug}
                onChange={(e) => setTenantSlug(e.target.value.trim().toLowerCase())}
                placeholder={t('portal.auth.workspacePlaceholder', 'acme')}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                maxLength={64}
              />
            ) : (
              <div className="flex items-center gap-2 rounded-pill bg-bg-tertiary px-3 py-1.5">
                <Building2 size={13} className="shrink-0 text-text-muted" />
                <span className="flex-1 truncate font-mono text-[12px] text-text-secondary">
                  {tenantSlug}
                </span>
                <button
                  type="button"
                  onClick={() => setEditingTenant(true)}
                  className="shrink-0 text-[11px] text-text-muted transition-colors hover:text-text-primary"
                >
                  {t('portal.auth.changeWorkspace', 'Change')}
                </button>
              </div>
            )}

            <Input
              label={t('portal.auth.email', 'E-mail address')}
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('portal.auth.emailPlaceholder', 'you@company.com')}
              autoFocus
              maxLength={254}
            />

            {transportError && (
              <p className="flex items-start gap-2 rounded-card bg-sla-breach-bg px-3 py-2 text-[12px] leading-relaxed text-sla-breach">
                <WifiOff size={13} className="mt-0.5 shrink-0" />
                <span>{transportError}</span>
              </p>
            )}

            <Button
              type="submit"
              fullWidth
              loading={sending}
              disabled={!canSubmit}
              icon={<Send size={14} />}
            >
              {t('portal.auth.submit', 'Send me a sign-in link')}
            </Button>

            <p className="text-center text-[11px] leading-relaxed text-text-muted">
              {t(
                'portal.auth.privacyNote',
                'The link works once and expires after 15 minutes.',
              )}
            </p>
          </form>
        )}
      </div>

      <PortalFooter />
    </PortalShell>
  );
}

export default PortalLoginPage;
