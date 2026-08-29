import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/utils/cn';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'full';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Already-translated title. */
  title?: ReactNode;
  /** Quiet line under the title — the ticket key, the config slug, a count. */
  subtitle?: ReactNode;
  children: ReactNode;
  /** Pinned action row at the bottom; scrolling happens above it. */
  footer?: ReactNode;
  size?: ModalSize;
  /** Translated aria-label for the close button. */
  closeLabel?: string;
  /** Set false for a destructive confirm you want the user to answer. */
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  /** Hide the header chrome entirely (the command palette draws its own). */
  bare?: boolean;
  className?: string;
}

const SIZES: Record<ModalSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  full: 'max-w-[min(1100px,calc(100vw-3rem))]',
};

/**
 * Dialog rendered into a portal on <body> so it escapes the sidebar's
 * `overflow-hidden` and the main column's scroll container.
 *
 * HARD RULE 11 — the panel has no border. It reads as a separate plane through
 * `bg-bg-secondary` over a blurred scrim plus `shadow-card`. Focus is moved into
 * the panel on open and returned to the trigger on close, and Tab is trapped, so
 * a keyboard user is never left tabbing through the page behind the scrim.
 */
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  size = 'md',
  closeLabel = 'Fermer',
  closeOnBackdrop = true,
  closeOnEscape = true,
  bare = false,
  className,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);

  const focusables = useCallback((): HTMLElement[] => {
    if (!panelRef.current) return [];
    return Array.from(
      panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.offsetParent !== null || el === document.activeElement);
  }, []);

  useEffect(() => {
    if (!open) return;

    restoreFocusTo.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Focus the first control, or the panel itself when there is none.
    const raf = requestAnimationFrame(() => {
      const items = focusables();
      (items[0] ?? panelRef.current)?.focus();
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && closeOnEscape) {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      restoreFocusTo.current?.focus?.();
    };
  }, [open, closeOnEscape, onClose, focusables]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-bg-primary/70 px-4 py-[8vh] backdrop-blur-sm"
      onMouseDown={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={cn(
          'animate-scale-in flex w-full flex-col overflow-hidden rounded-modal bg-bg-secondary shadow-card outline-none',
          'max-h-[84vh]',
          SIZES[size],
          className,
        )}
      >
        {!bare && (title || subtitle) && (
          <div className="flex shrink-0 items-start gap-3 px-5 pb-3 pt-4">
            <div className="min-w-0 flex-1">
              {title && (
                <h2 className="truncate font-display text-[19px] font-semibold leading-tight text-text-primary">
                  {title}
                </h2>
              )}
              {subtitle && (
                <p className="mt-0.5 truncate font-mono text-[11px] uppercase tracking-[0.12em] text-text-muted">
                  {subtitle}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={closeLabel}
              title={closeLabel}
              className="-mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-pill text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
            >
              <X size={16} />
            </button>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-1">{children}</div>

        {footer && (
          <div className="flex shrink-0 items-center justify-end gap-2 bg-bg-tertiary/50 px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
