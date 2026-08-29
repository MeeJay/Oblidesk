/**
 * NotFoundPage — the SPA catch-all.
 *
 * Deliberately offers a way OUT rather than a way back: "return" would send a
 * person to the URL that just failed. The desk's home is the ticket board.
 */

import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Compass } from 'lucide-react';
import { Button } from '@/components/common/Button';

export function NotFoundPage() {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-8 text-center">
      <Compass size={40} className="text-accent" />
      <h1 className="font-display text-6xl font-semibold tracking-wide text-text-muted">
        {t('notFound.title', '404')}
      </h1>
      <p className="text-lg text-text-secondary">
        {t('notFound.message', "Cette page n'existe pas.")}
      </p>
      <Link to="/">
        <Button variant="secondary">{t('notFound.goHome', "Retour à l'accueil")}</Button>
      </Link>
    </div>
  );
}

export default NotFoundPage;
