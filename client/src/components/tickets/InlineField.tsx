/**
 * InlineField.tsx — one field, edited in place, saved on its own.
 *
 * ── HARD RULE 12, stated as behaviour ────────────────────────────────────────
 * This component NEVER validates required-ness. Not on blur, not on submit, not
 * "just a warning". An agent may leave the resolution notes empty, the assignee
 * unset and the CI unlinked all day, and every one of those edits saves.
 *
 * Required-ness is a property of a STATE TRANSITION, and it is enforced in
 * exactly one place — the shared evaluator, run by the server on
 * `POST /api/tickets/:id/transition` and by TransitionInspector on the same
 * data. A second, softer copy of that rule living here is how the two drift:
 * the field starts refusing to save something the transition would have
 * accepted, and the agent learns to fight the form instead of the incident.
 *
 * What this component MAY do is TELL the agent that a field is required for a
 * move they are likely to make. `requiredForTransition` renders an informational
 * marker. It never blocks, never colours the input red, and never prevents a
 * save.
 *
 * ── One field, one request ───────────────────────────────────────────────────
 * Each save is its own PATCH carrying only the key that changed, plus the base
 * `row_version` (HARD RULE 7). Batching two fields into one request would make
 * a conflict on one of them lose the other, and the agent would have no way to
 * tell which half landed.
 *
 * ── Presence ─────────────────────────────────────────────────────────────────
 * Focus announces the field to the ticket room, blur clears it. That is what
 * lets PresenceBar say "Marie modifie le même champ que vous" BEFORE the 409
 * rather than after it.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Check, Loader2, Lock, RotateCcw } from 'lucide-react';

export type InlineFieldType =
  | 'text'
  | 'textarea'
  | 'select'
  | 'number'
  | 'date'
  | 'datetime'
  | 'readonly';

export interface InlineFieldOption {
  value: string;
  label: string;
  /** Rendered small and muted after the label — a category, a rank, a group. */
  hint?: string;
  disabled?: boolean;
}

export interface InlineFieldProps {
  /**
   * The ticket field path — `subject`, `assigneeId`, `data.site_code`. Doubles
   * as the presence key, so two agents in the same field are detectable.
   */
  field: string;
  label: string;
  value: string | number | null | undefined;
  type?: InlineFieldType;
  options?: InlineFieldOption[];
  placeholder?: string;
  helpText?: string;
  /**
   * Purely informational (see the header). Renders a marker, never a block.
   */
  requiredForTransition?: string | null;
  readOnly?: boolean;
  /** Name of another agent currently in this field — a warning, not a lock. */
  contendedBy?: string | null;
  /** Multiline rows when `type === 'textarea'`. */
  rows?: number;
  /** Save the new value. Reject to surface the server's own message. */
  onSave: (value: string | null) => Promise<void>;
  onFocusField?: (field: string) => void;
  onBlurField?: (field: string) => void;
  className?: string;
  /** Compact rail layout (label above, tight) vs. inline header layout. */
  layout?: 'stacked' | 'inline';
  /**
   * Header treatment: the control becomes a large, chrome-less title and the
   * label survives for screen readers only. Same autosave discipline — the
   * ticket subject is a field like any other, it just does not look like one.
   */
  titleMode?: boolean;
}

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

function toEditable(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

export default function InlineField({
  field,
  label,
  value,
  type = 'text',
  options,
  placeholder,
  helpText,
  requiredForTransition,
  readOnly = false,
  contendedBy,
  rows = 4,
  onSave,
  onFocusField,
  onBlurField,
  className,
  layout = 'stacked',
  titleMode = false,
}: InlineFieldProps): JSX.Element {
  const { t } = useTranslation();
  const inputId = useId();
  const [draft, setDraft] = useState(() => toEditable(value));
  const [focused, setFocused] = useState(false);
  const [state, setState] = useState<SaveState>({ kind: 'idle' });
  const savedTimer = useRef<number | null>(null);

  // The server is the source of truth. A value that moved underneath us (a
  // rule fired, another agent saved) replaces the draft — UNLESS we are in the
  // field, in which case stealing the caret mid-sentence would be worse than
  // being briefly out of date. The next blur reconciles.
  useEffect(() => {
    if (!focused) setDraft(toEditable(value));
  }, [value, focused]);

  useEffect(
    () => () => {
      if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    },
    [],
  );

  const flash = useCallback(() => {
    setState({ kind: 'saved' });
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    savedTimer.current = window.setTimeout(() => setState({ kind: 'idle' }), 1_600);
  }, []);

  const commit = useCallback(
    async (next: string) => {
      const normalised = next.trim();
      if (normalised === toEditable(value).trim()) {
        setState({ kind: 'idle' });
        return;
      }

      setState({ kind: 'saving' });
      try {
        // Empty string means "clear the field", not "refuse to save".
        await onSave(normalised === '' ? null : normalised);
        flash();
      } catch (error: unknown) {
        const message =
          error instanceof Error && error.message
            ? error.message
            : t('field.saveFailed', 'Enregistrement impossible.');
        setState({ kind: 'error', message });
        // Keep the draft: the agent's text is the one thing we must not lose.
      }
    },
    [flash, onSave, t, value],
  );

  const handleFocus = useCallback(() => {
    setFocused(true);
    onFocusField?.(field);
  }, [field, onFocusField]);

  const handleBlur = useCallback(() => {
    setFocused(false);
    onBlurField?.(field);
    void commit(draft);
  }, [commit, draft, field, onBlurField]);

  const revert = useCallback(() => {
    setDraft(toEditable(value));
    setState({ kind: 'idle' });
  }, [value]);

  const dirty = draft !== toEditable(value);

  // ── Control ──────────────────────────────────────────────────────────────
  const controlClasses = clsx(
    'w-full rounded-card text-text-primary transition-colors',
    'placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent',
    titleMode
      ? 'bg-transparent px-1 py-0.5 font-display text-[24px] font-semibold leading-tight hover:bg-bg-hover'
      : 'bg-bg-tertiary px-2.5 py-1.5 text-[13px]',
    readOnly && 'cursor-not-allowed opacity-60',
    state.kind === 'error' && 'ring-1 ring-sla-breach',
  );

  const control = ((): JSX.Element => {
    if (readOnly || type === 'readonly') {
      return (
        <div
          id={inputId}
          className="min-h-[30px] rounded-card bg-bg-tertiary/60 px-2.5 py-1.5 text-[13px] text-text-secondary"
        >
          {draft || <span className="text-text-muted">—</span>}
        </div>
      );
    }

    if (type === 'select') {
      return (
        <select
          id={inputId}
          className={controlClasses}
          value={draft}
          onFocus={handleFocus}
          onBlur={() => {
            setFocused(false);
            onBlurField?.(field);
          }}
          onChange={(event) => {
            const next = event.target.value;
            setDraft(next);
            // A select has no meaningful "still typing" state: commit at once.
            void commit(next);
          }}
        >
          <option value="">{placeholder ?? t('field.none', '— aucun —')}</option>
          {(options ?? []).map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.hint ? `${option.label} · ${option.hint}` : option.label}
            </option>
          ))}
        </select>
      );
    }

    if (type === 'textarea') {
      return (
        <textarea
          id={inputId}
          className={clsx(controlClasses, 'resize-y font-sans leading-relaxed')}
          rows={rows}
          value={draft}
          placeholder={placeholder}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              revert();
              (event.target as HTMLTextAreaElement).blur();
            }
            // Ctrl/Cmd+Enter saves without leaving the field.
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void commit(draft);
            }
          }}
        />
      );
    }

    return (
      <input
        id={inputId}
        type={type === 'number' ? 'number' : type === 'date' ? 'date' : type === 'datetime' ? 'datetime-local' : 'text'}
        className={clsx(controlClasses, type === 'number' && 'font-mono tabular-nums')}
        value={draft}
        placeholder={placeholder}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void commit(draft);
            (event.target as HTMLInputElement).blur();
          }
          if (event.key === 'Escape') {
            event.stopPropagation();
            revert();
            (event.target as HTMLInputElement).blur();
          }
        }}
      />
    );
  })();

  return (
    <div
      className={clsx(
        layout === 'inline' ? 'flex items-center gap-2' : 'flex flex-col gap-1',
        className,
      )}
    >
      <label
        htmlFor={inputId}
        className={clsx(
          'flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted',
          layout === 'inline' && 'w-28 shrink-0',
          // Screen readers keep the label; the header does not need to show it.
          titleMode && 'sr-only',
        )}
      >
        <span className="truncate">{label}</span>

        {/* Informational only. See the file header — it never blocks a save. */}
        {requiredForTransition && (
          <span
            className="text-accent"
            title={t(
              'field.requiredAtTransition',
              'Requis pour « {{transition}} ». Vous pouvez enregistrer sans le remplir.',
              { transition: requiredForTransition },
            )}
          >
            *
          </span>
        )}

        {contendedBy && (
          <span
            className="inline-flex items-center gap-1 text-sla-warn"
            title={t('field.contended', '{{name}} modifie ce champ en ce moment', {
              name: contendedBy,
            })}
          >
            <Lock size={10} aria-hidden />
          </span>
        )}
      </label>

      <div className="relative min-w-0 flex-1">
        {control}

        {/* Save state sits inside the field's own row: an agent editing six
            fields must be able to see WHICH one failed without reading a toast
            stack that has already moved on. */}
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
          {state.kind === 'saving' && (
            <Loader2 size={13} className="animate-spin text-text-muted" aria-hidden />
          )}
          {state.kind === 'saved' && <Check size={13} className="text-sla-ok" aria-hidden />}
        </span>
      </div>

      {state.kind === 'error' && (
        <div className="flex items-start gap-1.5 text-[11px] text-sla-breach">
          <AlertCircle size={12} className="mt-0.5 shrink-0" aria-hidden />
          <span className="flex-1">{state.message}</span>
          <button
            type="button"
            onClick={() => void commit(draft)}
            className="shrink-0 rounded-pill px-1.5 py-0.5 text-text-secondary hover:bg-bg-hover"
          >
            {t('common.retry', 'Réessayer')}
          </button>
        </div>
      )}

      {dirty && state.kind !== 'saving' && state.kind !== 'error' && (
        <button
          type="button"
          onClick={revert}
          className="flex items-center gap-1 self-start rounded-pill px-1.5 py-0.5 text-[11px] text-text-muted hover:bg-bg-hover hover:text-text-secondary"
        >
          <RotateCcw size={10} aria-hidden />
          {t('field.revert', 'Annuler la modification')}
        </button>
      )}

      {helpText && state.kind !== 'error' && (
        <p className="text-[11px] leading-snug text-text-muted">{helpText}</p>
      )}
    </div>
  );
}
