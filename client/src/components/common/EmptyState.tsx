import type { ReactNode } from 'react';
import { cn } from '@/utils/cn';

interface EmptyStateProps {
  /** A lucide icon element, typically at size 22. */
  icon?: ReactNode;
  /** Already-translated. */
  title: string;
  /** Already-translated. One sentence explaining what would put rows here. */
  description?: string;
  /** Primary action — a <Button> or a <Link>. */
  action?: ReactNode;
  /** Quieter escape hatch next to the action ("clear the filters"). */
  secondaryAction?: ReactNode;
  /** Drop the surface and padding for use inside an already-carded panel. */
  compact?: boolean;
  className?: string;
}

/**
 * The blank slate for a queue, a saved view, a CI's ticket history or a search
 * with no hits. Deliberately quiet: an empty queue is good news in a service
 * desk, so this must not look like an error.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  secondaryAction,
  compact = false,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'gap-2 py-8' : 'gap-3 rounded-card bg-bg-secondary px-6 py-14 shadow-card',
        className,
      )}
    >
      {icon && (
        <div className="flex h-11 w-11 items-center justify-center rounded-[9px] bg-bg-tertiary text-text-muted">
          {icon}
        </div>
      )}

      <div className="max-w-md space-y-1">
        <p className="text-[15px] font-semibold text-text-primary">{title}</p>
        {description && (
          <p className="text-[13px] leading-relaxed text-text-muted">{description}</p>
        )}
      </div>

      {(action || secondaryAction) && (
        <div className="mt-1 flex items-center gap-2">
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}
