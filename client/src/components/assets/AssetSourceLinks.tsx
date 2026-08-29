/**
 * AssetSourceLinks.tsx — where this machine actually lives, and how old our
 * copy of it is.
 *
 * ── What a source link is ───────────────────────────────────────────────────
 * A row in `ci_source_links` says: "app X holds object Y for this CI, here is
 * the deep link". That is the entire desk-owned claim. The `payload` column
 * next to it is a CACHE of what that app last answered, stamped with
 * `last_fetched_at` — it is NOT the desk's copy of the truth, and this
 * component is where the UI has to say so out loud.
 *
 * The temptation is to render the cached payload as plain facts, because it
 * looks like data and it is already local. That would silently turn a snapshot
 * into an assertion: a disk that was 92% full last Tuesday is not a disk that
 * is 92% full. So the cache is collapsed by default, labelled as a copy, and
 * always shown with the age of the read that produced it. The live sections on
 * the detail page are the ones that go and ask.
 *
 * HARD RULE 11 — no border anywhere here. Depth is a background step.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { ChevronDown, ChevronRight, Database, ExternalLink, Link2Off } from 'lucide-react';
import type { CiSourceLink } from '@oblidesk/shared';
import { formatAbsolute, formatRelative } from '@/components/tickets/SlaChip';

/**
 * The suite's brand colours, per app (design system section 1). A source link
 * may name an app outside the five the live proxy speaks to, so the lookup
 * falls back to the neutral dot rather than dropping the row.
 */
const APP_STYLE: Readonly<Record<string, { name: string; dot: string }>> = {
  obliance: { name: 'Obliance', dot: 'bg-obli-ance' },
  obliview: { name: 'Obliview', dot: 'bg-obli-view' },
  obliguard: { name: 'Obliguard', dot: 'bg-obli-guard' },
  oblimap: { name: 'Oblimap', dot: 'bg-obli-map' },
  obligate: { name: 'Obligate', dot: 'bg-obli-hub' },
};

export function appDisplayName(appType: string): string {
  return APP_STYLE[appType]?.name ?? appType;
}

export function appDotClass(appType: string): string {
  return APP_STYLE[appType]?.dot ?? 'bg-text-muted';
}

export interface AssetSourceLinksProps {
  sources: CiSourceLink[];
  className?: string;
}

export function AssetSourceLinks({ sources, className }: AssetSourceLinksProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <section className={clsx('rounded-card bg-bg-secondary p-5 shadow-card', className)}>
      <header>
        <h2 className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
          <Database size={12} aria-hidden />
          {t('assets.sourceLinks', 'Liens vers les sources')}
        </h2>
        <p className="mt-1.5 text-[11px] leading-snug text-text-muted">
          {t(
            'assets.sourcesNote',
            'Ces applications détiennent la machine. Oblidesk ne garde qu’un lien et une copie datée de leur dernière réponse : pour corriger une valeur, il faut la corriger là-bas.',
          )}
        </p>
      </header>

      {sources.length === 0 ? (
        <div className="mt-3 flex items-start gap-2 rounded-card bg-bg-tertiary p-3">
          <Link2Off size={14} className="mt-0.5 shrink-0 text-text-muted" aria-hidden />
          <p className="text-[12px] leading-snug text-text-muted">
            {t(
              'assets.noSources',
              'Aucune application sœur ne revendique cette machine. Les sections en direct ne peuvent donc rien lire : ce n’est pas une panne, c’est un actif qui n’est rattaché à rien.',
            )}
          </p>
        </div>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {sources.map((source) => (
            <SourceRow key={source.id} source={source} />
          ))}
        </ul>
      )}
    </section>
  );
}

function SourceRow({ source }: { source: CiSourceLink }): JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const payloadKeys = Object.keys(source.payload ?? {});
  const name = appDisplayName(source.appType);

  return (
    <li className="rounded-card bg-bg-tertiary p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={clsx('h-2 w-2 shrink-0 rounded-pill', appDotClass(source.appType))} aria-hidden />
        <span className="text-[13px] font-medium text-text-primary">{name}</span>

        <span className="truncate font-mono text-[11px] text-text-muted" title={source.externalId}>
          {source.externalId}
        </span>

        <span className="flex-1" />

        {source.url ? (
          <a
            href={source.url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 rounded-pill bg-bg-secondary px-2 py-1 text-[11px] text-text-secondary transition-colors hover:text-accent"
          >
            <ExternalLink size={11} aria-hidden />
            {t('assets.openIn', 'Ouvrir dans {{app}}', { app: name })}
          </a>
        ) : (
          <span className="text-[11px] text-text-muted">
            {t('assets.noDeepLink', 'aucun lien direct')}
          </span>
        )}
      </div>

      {source.externalPath && (
        <p className="mt-1 truncate font-mono text-[10px] text-text-muted" title={source.externalPath}>
          {source.externalPath}
        </p>
      )}

      {/* The cache line. Never omitted: a payload with no age is a payload
          pretending to be current. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
        <span className="rounded-pill bg-bg-secondary px-2 py-0.5 text-text-muted">
          {t('assets.cachedCopy', 'copie en cache')}
        </span>
        <span className="font-mono text-text-muted" title={formatAbsolute(source.lastFetchedAt)}>
          {source.lastFetchedAt
            ? `${t('ci.lastRead', 'dernière lecture')} ${formatRelative(source.lastFetchedAt, t)}`
            : t('assets.neverRead', 'jamais lue')}
        </span>

        {payloadKeys.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="inline-flex items-center gap-1 rounded-pill px-1.5 py-0.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-secondary"
            aria-expanded={open}
          >
            {open ? <ChevronDown size={11} aria-hidden /> : <ChevronRight size={11} aria-hidden />}
            {t('assets.showCached', '{{n}} champs mis en cache', { n: payloadKeys.length })}
          </button>
        )}
      </div>

      {open && (
        <dl className="mt-2 flex flex-col gap-1 rounded-card bg-bg-secondary p-2">
          {payloadKeys.slice(0, 24).map((key) => (
            <div key={key} className="flex items-start gap-2 text-[11px]">
              <dt className="w-32 shrink-0 truncate font-mono text-text-muted">{key}</dt>
              <dd className="min-w-0 flex-1 truncate text-text-secondary" title={renderValue(source.payload[key])}>
                {renderValue(source.payload[key])}
              </dd>
            </div>
          ))}
          {payloadKeys.length > 24 && (
            <p className="text-[10px] text-text-muted">
              {t('assets.cachedTruncated', '{{n}} autres champs non affichés', {
                n: payloadKeys.length - 24,
              })}
            </p>
          )}
        </dl>
      )}
    </li>
  );
}

/** The sibling payloads are untyped on purpose: render what arrived. */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export default AssetSourceLinks;
