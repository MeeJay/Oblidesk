/**
 * Composer.tsx — three modes, and no way to confuse them.
 *
 * ── The failure this file is built around ────────────────────────────────────
 * An agent writes "le client raconte n'importe quoi, on ferme" into what they
 * believe is a work note, and it goes out by email. Every desk has that story.
 * The usual cause is a checkbox: a small square somewhere that was ticked, or
 * was not, and looked identical either way.
 *
 * So there is no checkbox. There are three MODES, and the mode owns the whole
 * composer's appearance:
 *
 *   Réponse publique  ordinary surface, accent send button, "→ demandeur"
 *   Note interne      amber tint, amber left rule, padlock, "non visible"
 *   Résolution        accent-tinted, and it does not post a journal entry at
 *                     all — it fires a state TRANSITION (HARD RULE 12), which
 *                     is the only place required-ness is enforced
 *
 * Switching mode repaints the entire box. Sending shows the destination in the
 * button itself. And the two conversational modes keep SEPARATE drafts, so
 * flipping to internal to check something never carries the public text over.
 *
 * ── Macros preview before they fire ──────────────────────────────────────────
 * A macro is a bundle of field changes plus a canned message. Applying one
 * blind is how a ticket silently changes queue, priority and assignee in one
 * click that the agent cannot undo because they never saw it. So the picker
 * shows EVERY change it will make — field, old value, new value — and nothing
 * happens until the agent confirms.
 *
 * ── Drafts survive everything ────────────────────────────────────────────────
 * `STORAGE_KEYS.composerDrafts`, keyed by tenant + user + ticket + mode. The
 * tenant is in the key on purpose: an admin switching tenants must not find
 * another customer's half-written reply in the box.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent as ReactClipboardEvent, CSSProperties } from 'react';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import {
  AtSign,
  Bot,
  Braces,
  CheckCircle2,
  Code2,
  Eye,
  ImagePlus,
  Loader2,
  Lock,
  Paperclip,
  Send,
  Sparkles,
  X,
} from 'lucide-react';
import { LIMITS, STORAGE_KEYS } from '@oblidesk/shared';
import type {
  Attachment,
  AttachmentUploadResult,
  ConfigObject,
  MacroBody,
  TicketJournalEntry,
  TicketWithRelations,
  User,
} from '@oblidesk/shared';
import apiClient from '@/api/client';

export type ComposerMode = 'public' | 'internal' | 'resolution';

const INTERNAL_AMBER = '#f5a623';

interface ModeSpec {
  id: ComposerMode;
  key: string;
  fallback: string;
  hintKey: string;
  hintFallback: string;
  icon: typeof Send;
}

const MODES: readonly ModeSpec[] = [
  {
    id: 'public',
    key: 'composer.mode.public',
    fallback: 'Réponse publique',
    hintKey: 'composer.hint.public',
    hintFallback: 'Envoyée au demandeur par courriel et visible sur le portail.',
    icon: Send,
  },
  {
    id: 'internal',
    key: 'composer.mode.internal',
    fallback: 'Note interne',
    hintKey: 'composer.hint.internal',
    hintFallback: 'Visible des agents uniquement. Jamais envoyée au demandeur.',
    icon: Lock,
  },
  {
    id: 'resolution',
    key: 'composer.mode.resolution',
    fallback: 'Résolution',
    hintKey: 'composer.hint.resolution',
    hintFallback:
      'Renseigne les notes de résolution puis déclenche la transition. Les champs obligatoires sont vérifiés à ce moment-là.',
    icon: CheckCircle2,
  },
];

// ═════════════════════════════════════════════════════════════════════════════
// Drafts
// ═════════════════════════════════════════════════════════════════════════════

interface DraftRecord {
  body: string;
  attachmentIds: number[];
  updatedAt: string;
}

type DraftMap = Record<string, DraftRecord>;

/** Drop drafts nobody will come back to, so the bag cannot grow without bound. */
const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function readDrafts(): DraftMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.composerDrafts);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as DraftMap;
    const cutoff = Date.now() - DRAFT_TTL_MS;
    const kept: DraftMap = {};
    for (const [key, record] of Object.entries(parsed)) {
      if (Date.parse(record.updatedAt) >= cutoff) kept[key] = record;
    }
    return kept;
  } catch {
    // A corrupt or blocked store must not take the composer down with it.
    return {};
  }
}

function writeDraft(key: string, record: DraftRecord | null): void {
  try {
    const drafts = readDrafts();
    if (record === null || record.body.trim() === '') delete drafts[key];
    else drafts[key] = record;
    localStorage.setItem(STORAGE_KEYS.composerDrafts, JSON.stringify(drafts));
  } catch {
    // Storage full or unavailable: the draft is a convenience, not a promise.
  }
}

/** Tenant is part of the identity — see the header. */
function draftKey(
  tenantId: number | null,
  userId: number | null,
  ticketId: number,
  mode: ComposerMode,
): string {
  return `${tenantId ?? 0}:${userId ?? 0}:${ticketId}:${mode}`;
}

// ═════════════════════════════════════════════════════════════════════════════
// Canned-response variables
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `{{ticket.number}}` style placeholders, resolved against the open ticket.
 *
 * An unknown placeholder is left VERBATIM rather than replaced with an empty
 * string: "Bonjour ," reads as a bug the agent will send anyway, whereas
 * "Bonjour {{requester.firstName}}," is obviously unfinished.
 */
export function renderTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : match,
  );
}

function templateVars(ticket: TicketWithRelations, me: User | null): Record<string, string> {
  const requester = ticket.requesterContact?.displayName ?? ticket.requesterContact?.email ?? '';
  return {
    'ticket.number': ticket.number,
    'ticket.subject': ticket.subject,
    'ticket.status': ticket.statusSlug,
    'ticket.priority': ticket.prioritySlug,
    'ticket.queue': ticket.queueSlug,
    'requester.name': requester,
    'requester.email': ticket.requesterContact?.email ?? '',
    'organization.name': ticket.organization?.name ?? '',
    'agent.name': me?.displayName ?? me?.username ?? '',
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Macro preview
// ═════════════════════════════════════════════════════════════════════════════

export interface MacroChange {
  /** Ticket field path the macro will write. */
  field: string;
  /** Human label for the field. */
  label: string;
  from: string;
  to: string;
  /** Patch fragment for `PATCH /api/tickets/:id`, when the action maps to one. */
  patch: Record<string, unknown> | null;
  /** Actions we understand but cannot preview as a field change. */
  note: string | null;
}

const ACTION_LABELS: Record<string, { field: string; label: string; patchKey?: string }> = {
  set_priority: { field: 'prioritySlug', label: 'Priorité', patchKey: 'prioritySlug' },
  move_to_queue: { field: 'queueSlug', label: 'File', patchKey: 'queueSlug' },
  assign_to_user: { field: 'assigneeId', label: 'Responsable' },
  assign_to_group: { field: 'assignmentGroupId', label: 'Groupe' },
  set_status: { field: 'statusSlug', label: 'Statut' },
  add_tag: { field: 'tags', label: 'Étiquette' },
  add_watcher: { field: 'watchers', label: 'Observateur' },
};

/**
 * Turn a macro body into the list of changes an agent must be able to read
 * BEFORE anything happens.
 *
 * `set_status` is deliberately previewed but NOT patched: a status move is a
 * transition, and a transition has guards and required fields. A macro that
 * quietly bypassed the evaluator would be a hole straight through HARD RULE 12.
 */
export function previewMacro(body: MacroBody, ticket: TicketWithRelations): MacroChange[] {
  const changes: MacroChange[] = [];

  for (const action of body.actions ?? []) {
    if (action.disabled) continue;
    const spec = ACTION_LABELS[action.type];
    const params = action.params ?? {};

    if (!spec) {
      changes.push({
        field: action.type,
        label: action.type,
        from: '',
        to: '',
        patch: null,
        note: `Action « ${action.type} » exécutée côté serveur.`,
      });
      continue;
    }

    const to = String(
      params.slug ?? params.value ?? params.username ?? params.groupSlug ?? params.tag ?? '',
    );
    const from = String(
      (ticket as unknown as Record<string, unknown>)[spec.field] ?? '',
    );

    changes.push({
      field: spec.field,
      label: spec.label,
      from,
      to,
      patch: spec.patchKey && to ? { [spec.patchKey]: to } : null,
      note:
        action.type === 'set_status'
          ? 'Le changement de statut passera par l’évaluateur de transition, pas par la macro.'
          : spec.patchKey
            ? null
            : 'Appliqué côté serveur.',
    });
  }

  return changes;
}

// ═════════════════════════════════════════════════════════════════════════════
// Component
// ═════════════════════════════════════════════════════════════════════════════

export interface ComposerProps {
  ticket: TicketWithRelations;
  tenantId: number | null;
  me: User | null;
  /** A journal entry landed — the parent merges it into the spine. */
  onPosted: (entry: TicketJournalEntry) => void;
  /**
   * Resolution mode does not post: it hands the notes to the parent, which
   * fires the transition through the evaluator.
   */
  onResolve: (input: { resolutionMd: string; resolutionCode: string | null }) => Promise<void>;
  /** Apply the field half of a macro, after the agent confirmed the preview. */
  onApplyMacro?: (patch: Record<string, unknown>) => Promise<void>;
  /** Typing signal for the presence room. */
  onTyping?: (typing: boolean) => void;
  /** Text pushed in from "citer" on a journal entry. */
  quoted?: { text: string; token: number } | null;
  className?: string;
}

export default function Composer({
  ticket,
  tenantId,
  me,
  onPosted,
  onResolve,
  onApplyMacro,
  onTyping,
  quoted,
  className,
}: ComposerProps): JSX.Element {
  const { t } = useTranslation();
  const [mode, setMode] = useState<ComposerMode>('public');
  const [body, setBody] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(0);
  const [preview, setPreview] = useState(false);
  const [resolutionCode, setResolutionCode] = useState('');

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const typingTimer = useRef<number | null>(null);

  const spec = MODES.find((option) => option.id === mode) ?? MODES[0];
  const key = draftKey(tenantId, me?.id ?? null, ticket.id, mode);

  // ── Draft: load on mode/ticket change, save on every edit ────────────────
  useEffect(() => {
    const record = readDrafts()[key];
    setBody(record?.body ?? '');
    setAttachments([]);
    setError(null);
    setPreview(false);
  }, [key]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      writeDraft(key, {
        body,
        attachmentIds: attachments.map((a) => a.id),
        updatedAt: new Date().toISOString(),
      });
    }, 400);
    return () => window.clearTimeout(handle);
  }, [body, attachments, key]);

  // ── Quoted text from the journal ─────────────────────────────────────────
  useEffect(() => {
    if (!quoted) return;
    setBody((current) => `${quoted.text}\n\n${current}`);
    textareaRef.current?.focus();
  }, [quoted]);

  // ── Typing signal, throttled ─────────────────────────────────────────────
  const signalTyping = useCallback(() => {
    if (!onTyping) return;
    onTyping(true);
    if (typingTimer.current !== null) window.clearTimeout(typingTimer.current);
    typingTimer.current = window.setTimeout(() => onTyping(false), 3_000);
  }, [onTyping]);

  useEffect(
    () => () => {
      if (typingTimer.current !== null) window.clearTimeout(typingTimer.current);
    },
    [],
  );

  // ── Insertion at the caret ───────────────────────────────────────────────
  const insertAtCaret = useCallback((text: string) => {
    const node = textareaRef.current;
    if (!node) {
      setBody((current) => current + text);
      return;
    }
    const start = node.selectionStart ?? node.value.length;
    const end = node.selectionEnd ?? start;
    setBody((current) => current.slice(0, start) + text + current.slice(end));
    requestAnimationFrame(() => {
      node.focus();
      const caret = start + text.length;
      node.setSelectionRange(caret, caret);
    });
  }, []);

  // ── Attachments (paste, drop, picker) ────────────────────────────────────
  const uploadFiles = useCallback(
    async (files: readonly File[], inline: boolean) => {
      if (files.length === 0) return;
      setUploading((count) => count + files.length);
      try {
        const form = new FormData();
        for (const file of files.slice(0, LIMITS.attachmentsPerMessage)) {
          form.append('files', file, file.name || 'capture.png');
        }
        form.append('entityType', 'ticket');
        form.append('entityId', String(ticket.id));

        const response = await apiClient.post<{ success: boolean; data: AttachmentUploadResult[] }>(
          '/attachments',
          form,
          { headers: { 'Content-Type': 'multipart/form-data' } },
        );

        const uploaded = (response.data.data ?? []).map((entry) => entry.attachment);
        setAttachments((current) => [...current, ...uploaded]);

        if (inline) {
          // A pasted screenshot belongs where the caret is, as markdown, so the
          // agent can see it in the rendered reply rather than as a footer file.
          for (const attachment of uploaded) {
            insertAtCaret(`\n![${attachment.filename}](/api/attachments/${attachment.id}/download)\n`);
          }
        }
      } catch (cause: unknown) {
        setError(
          cause instanceof Error
            ? cause.message
            : t('composer.uploadFailed', 'Envoi de la pièce jointe impossible.'),
        );
      } finally {
        setUploading((count) => Math.max(0, count - files.length));
      }
    },
    [insertAtCaret, t, ticket.id],
  );

  const handlePaste = useCallback(
    (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
      const files = [...(event.clipboardData?.files ?? [])];
      const images = files.filter((file) => file.type.startsWith('image/'));
      if (images.length === 0) return;
      event.preventDefault();
      void uploadFiles(images, true);
    },
    [uploadFiles],
  );

  // ── Mentions ─────────────────────────────────────────────────────────────
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionResults, setMentionResults] = useState<User[]>([]);
  const [mentionUnavailable, setMentionUnavailable] = useState(false);

  useEffect(() => {
    if (mentionQuery === null || mentionQuery.length < 1) {
      setMentionResults([]);
      return undefined;
    }
    let alive = true;
    const handle = window.setTimeout(() => {
      apiClient
        .get<{ success: boolean; data: User[] }>('/users', {
          params: { q: mentionQuery, limit: 6, isActive: true },
        })
        .then((response) => {
          if (alive) setMentionResults(response.data.data ?? []);
        })
        .catch(() => {
          // Listing users is admin/manager-only. An agent gets 403 — say so
          // once and stop asking, rather than pretending nobody matched.
          if (alive) {
            setMentionUnavailable(true);
            setMentionResults([]);
          }
        });
    }, 200);
    return () => {
      alive = false;
      window.clearTimeout(handle);
    };
  }, [mentionQuery]);

  const handleChange = useCallback(
    (value: string) => {
      setBody(value);
      signalTyping();

      const node = textareaRef.current;
      const caret = node?.selectionStart ?? value.length;
      const upto = value.slice(0, caret);
      const match = /@([\w.-]{0,30})$/.exec(upto);
      setMentionQuery(match && !mentionUnavailable ? match[1] : null);
    },
    [mentionUnavailable, signalTyping],
  );

  const applyMention = useCallback(
    (user: User) => {
      const node = textareaRef.current;
      const caret = node?.selectionStart ?? body.length;
      const upto = body.slice(0, caret);
      const replaced = upto.replace(/@([\w.-]{0,30})$/, `@${user.username} `);
      setBody(replaced + body.slice(caret));
      setMentionQuery(null);
      requestAnimationFrame(() => node?.focus());
    },
    [body],
  );

  // ── Macros ───────────────────────────────────────────────────────────────
  const [macroOpen, setMacroOpen] = useState(false);
  const [macros, setMacros] = useState<Array<ConfigObject<'macro'>>>([]);
  const [macrosState, setMacrosState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [selectedMacro, setSelectedMacro] = useState<ConfigObject<'macro'> | null>(null);

  useEffect(() => {
    if (!macroOpen || macros.length > 0 || macrosState === 'loading') return;
    setMacrosState('loading');
    apiClient
      .get<{ success: boolean; data: Array<ConfigObject<'macro'>> }>('/config', {
        params: { kind: 'macro', status: 'published', limit: 100 },
      })
      .then((response) => {
        setMacros(response.data.data ?? []);
        setMacrosState('idle');
      })
      .catch(() => setMacrosState('error'));
  }, [macroOpen, macros.length, macrosState]);

  const macroChanges = useMemo(
    () => (selectedMacro ? previewMacro(selectedMacro.body, ticket) : []),
    [selectedMacro, ticket],
  );

  const vars = useMemo(() => templateVars(ticket, me), [ticket, me]);

  const confirmMacro = useCallback(async () => {
    if (!selectedMacro) return;
    const macro = selectedMacro.body;

    // Text first: if a field patch fails, the agent still has the message.
    if (macro.journal?.bodyMd) {
      const rendered = renderTemplate(macro.journal.bodyMd, vars);
      setBody((current) => (current.trim() ? `${current}\n\n${rendered}` : rendered));
      setMode(macro.journal.visibility === 'internal' ? 'internal' : 'public');
    }

    const patch: Record<string, unknown> = {};
    for (const change of macroChanges) if (change.patch) Object.assign(patch, change.patch);
    if (Object.keys(patch).length > 0 && onApplyMacro) {
      try {
        await onApplyMacro(patch);
      } catch (cause: unknown) {
        setError(
          cause instanceof Error
            ? cause.message
            : t('composer.macroFailed', 'La macro n’a pas pu modifier le ticket.'),
        );
      }
    }

    setSelectedMacro(null);
    setMacroOpen(false);
  }, [macroChanges, onApplyMacro, selectedMacro, t, vars]);

  // ── Send ─────────────────────────────────────────────────────────────────
  const canSend = body.trim().length > 0 && !sending && uploading === 0;

  const send = useCallback(async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);

    try {
      if (mode === 'resolution') {
        await onResolve({
          resolutionMd: body,
          resolutionCode: resolutionCode.trim() || null,
        });
      } else {
        const response = await apiClient.post<{ success: boolean; data: TicketJournalEntry }>(
          `/tickets/${ticket.id}/journal`,
          {
            kind: mode === 'internal' ? 'work_note' : 'public_reply',
            // Sent EXPLICITLY, never inferred from the kind — the server column
            // and the UI mode must agree by construction, not by convention.
            visibility: mode === 'internal' ? 'internal' : 'public',
            bodyMd: body,
            attachmentIds: attachments.map((attachment) => attachment.id),
          },
        );
        onPosted(response.data.data);
      }

      setBody('');
      setAttachments([]);
      setResolutionCode('');
      writeDraft(key, null);
      onTyping?.(false);
    } catch (cause: unknown) {
      setError(
        cause instanceof Error ? cause.message : t('composer.sendFailed', 'Envoi impossible.'),
      );
    } finally {
      setSending(false);
    }
  }, [
    attachments,
    body,
    canSend,
    key,
    mode,
    onPosted,
    onResolve,
    onTyping,
    resolutionCode,
    t,
    ticket.id,
  ]);

  // ── Surface per mode ─────────────────────────────────────────────────────
  const SendIcon = spec.icon;
  const surface: CSSProperties | undefined =
    mode === 'internal'
      ? {
          boxShadow: `inset 3px 0 0 0 ${INTERNAL_AMBER}, var(--shadow-card)`,
          background:
            'linear-gradient(0deg, rgba(245,166,35,0.06), rgba(245,166,35,0.06)), rgb(var(--c-bg-secondary))',
        }
      : mode === 'resolution'
        ? {
            boxShadow: 'inset 3px 0 0 0 rgb(var(--c-accent)), var(--shadow-card)',
            background:
              'linear-gradient(0deg, rgba(34,184,245,0.06), rgba(34,184,245,0.06)), rgb(var(--c-bg-secondary))',
          }
        : undefined;

  return (
    <div
      className={clsx('rounded-card bg-bg-secondary p-3 shadow-card', className)}
      style={surface}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        void uploadFiles([...event.dataTransfer.files], false);
      }}
    >
      {/* ── Mode switch ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-1.5">
        {MODES.map((option) => {
          const Icon = option.icon;
          const active = option.id === mode;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => setMode(option.id)}
              aria-pressed={active}
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-[12px] font-medium transition-colors',
                !active && 'text-text-muted hover:bg-bg-hover hover:text-text-secondary',
                active && option.id === 'public' && 'bg-bg-active text-text-primary',
                active && option.id === 'resolution' && 'bg-accent/18 text-accent',
              )}
              style={
                active && option.id === 'internal'
                  ? { background: 'rgba(245,166,35,0.18)', color: INTERNAL_AMBER }
                  : undefined
              }
            >
              <Icon size={13} aria-hidden />
              {t(option.key, option.fallback)}
            </button>
          );
        })}

        <span className="flex-1" />

        <button
          type="button"
          onClick={() => setMacroOpen((open) => !open)}
          className="inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1.5 text-[12px] text-text-muted hover:bg-bg-hover hover:text-text-secondary"
          title={t('composer.macros', 'Macros et réponses types')}
        >
          <Sparkles size={13} aria-hidden />
          {t('composer.macrosShort', 'Macros')}
        </button>
      </div>

      {/* The mode's consequence, in words, always on screen. */}
      <p
        className={clsx(
          'mt-1.5 text-[11px] leading-snug',
          mode === 'internal' ? 'text-[#f5a623]' : mode === 'resolution' ? 'text-accent' : 'text-text-muted',
        )}
      >
        {t(spec.hintKey, spec.hintFallback)}
      </p>

      {/* ── Macro picker + preview ──────────────────────────────────────── */}
      {macroOpen && (
        <div className="mt-2 rounded-card bg-bg-tertiary p-2.5">
          {macrosState === 'loading' && (
            <p className="flex items-center gap-2 text-[12px] text-text-muted">
              <Loader2 size={12} className="animate-spin" aria-hidden />
              {t('composer.macrosLoading', 'Chargement des macros…')}
            </p>
          )}
          {macrosState === 'error' && (
            <p className="text-[12px] text-sla-breach">
              {t('composer.macrosFailed', 'Les macros sont indisponibles.')}
            </p>
          )}
          {macrosState === 'idle' && macros.length === 0 && (
            <p className="text-[12px] text-text-muted">
              {t('composer.macrosEmpty', 'Aucune macro publiée pour ce locataire.')}
            </p>
          )}

          {!selectedMacro && macros.length > 0 && (
            <ul className="flex flex-col gap-1">
              {macros.map((macro) => (
                <li key={macro.slug}>
                  <button
                    type="button"
                    onClick={() => setSelectedMacro(macro)}
                    className="flex w-full items-center gap-2 rounded-card px-2 py-1.5 text-left text-[12px] text-text-secondary hover:bg-bg-hover"
                  >
                    <Bot size={12} className="shrink-0 text-text-muted" aria-hidden />
                    <span className="flex-1 truncate">{macro.name}</span>
                    <span className="shrink-0 font-mono text-[10px] text-text-muted">
                      {macro.slug}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* The preview. Nothing has happened yet at this point. */}
          {selectedMacro && (
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium text-text-primary">
                  {selectedMacro.name}
                </span>
                <span className="font-mono text-[10px] text-text-muted">{selectedMacro.slug}</span>
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={() => setSelectedMacro(null)}
                  className="rounded-pill p-1 text-text-muted hover:bg-bg-hover"
                  aria-label={t('common.close', 'Fermer')}
                >
                  <X size={13} />
                </button>
              </div>

              <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
                {t('composer.macroWillChange', 'Cette macro va modifier')}
              </p>

              {macroChanges.length === 0 ? (
                <p className="mt-1 text-[12px] text-text-muted">
                  {t('composer.macroNoFields', 'Aucun champ : uniquement le message ci-dessous.')}
                </p>
              ) : (
                <ul className="mt-1 flex flex-col gap-1">
                  {macroChanges.map((change, index) => (
                    <li
                      key={`${change.field}-${index}`}
                      className="flex flex-wrap items-center gap-1.5 rounded-card bg-bg-secondary px-2 py-1.5 text-[12px]"
                    >
                      <span className="text-text-secondary">{change.label}</span>
                      <span className="font-mono text-text-muted line-through">
                        {change.from || '∅'}
                      </span>
                      <span className="text-text-muted">→</span>
                      <span className="font-mono text-accent">{change.to || '∅'}</span>
                      {change.note && (
                        <span className="w-full text-[11px] text-text-muted">{change.note}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {selectedMacro.body.journal?.bodyMd && (
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-card bg-bg-secondary p-2 font-mono text-[11px] text-text-secondary">
                  {renderTemplate(selectedMacro.body.journal.bodyMd, vars)}
                </pre>
              )}

              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedMacro(null)}
                  className="rounded-pill px-3 py-1.5 text-[12px] text-text-muted hover:bg-bg-hover"
                >
                  {t('common.cancel', 'Annuler')}
                </button>
                <button
                  type="button"
                  onClick={() => void confirmMacro()}
                  className="rounded-pill bg-accent px-3 py-1.5 text-[12px] font-medium text-bg-primary hover:bg-accent-hover"
                >
                  {t('composer.macroApply', 'Appliquer la macro')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── The text ────────────────────────────────────────────────────── */}
      <div className="relative mt-2">
        {preview ? (
          <div className="min-h-[7rem] whitespace-pre-wrap rounded-card bg-bg-tertiary p-2.5 text-[13px] leading-relaxed text-text-primary">
            {body || t('composer.previewEmpty', 'Rien à prévisualiser.')}
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            value={body}
            onChange={(event) => handleChange(event.target.value)}
            onPaste={handlePaste}
            onBlur={() => onTyping?.(false)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void send();
              }
              if (event.key === 'Escape' && mentionQuery !== null) {
                event.stopPropagation();
                setMentionQuery(null);
              }
            }}
            rows={6}
            placeholder={
              mode === 'internal'
                ? t('composer.placeholderInternal', 'Note interne : markdown, ```code```, collez une capture…')
                : mode === 'resolution'
                  ? t('composer.placeholderResolution', 'Ce qui a été fait, et pourquoi ça règle le problème…')
                  : t('composer.placeholderPublic', 'Réponse au demandeur : markdown, ```code```, collez une capture…')
            }
            className="w-full resize-y rounded-card bg-bg-tertiary p-2.5 font-sans text-[13px] leading-relaxed text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
          />
        )}

        {/* Mention list */}
        {mentionQuery !== null && mentionResults.length > 0 && (
          <ul className="absolute bottom-2 left-2 z-10 w-64 overflow-hidden rounded-card bg-bg-secondary shadow-card">
            {mentionResults.map((user) => (
              <li key={user.id}>
                <button
                  type="button"
                  onClick={() => applyMention(user)}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-text-secondary hover:bg-bg-hover"
                >
                  <AtSign size={12} className="text-text-muted" aria-hidden />
                  <span className="flex-1 truncate">{user.displayName ?? user.username}</span>
                  <span className="font-mono text-[10px] text-text-muted">{user.username}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Resolution code, only where it means something ──────────────── */}
      {mode === 'resolution' && (
        <input
          value={resolutionCode}
          onChange={(event) => setResolutionCode(event.target.value)}
          placeholder={t('composer.resolutionCode', 'Code de résolution (facultatif)')}
          className="mt-2 w-full rounded-card bg-bg-tertiary px-2.5 py-1.5 font-mono text-[12px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
        />
      )}

      {/* ── Attachments ─────────────────────────────────────────────────── */}
      {(attachments.length > 0 || uploading > 0) && (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {attachments.map((attachment) => (
            <li
              key={attachment.id}
              className="inline-flex items-center gap-1.5 rounded-pill bg-bg-tertiary px-2 py-1 text-[11px] text-text-secondary"
            >
              <Paperclip size={11} aria-hidden />
              <span className="max-w-[14rem] truncate">{attachment.filename}</span>
              <button
                type="button"
                onClick={() =>
                  setAttachments((current) => current.filter((a) => a.id !== attachment.id))
                }
                aria-label={t('composer.removeAttachment', 'Retirer la pièce jointe')}
                className="text-text-muted hover:text-text-primary"
              >
                <X size={11} />
              </button>
            </li>
          ))}
          {uploading > 0 && (
            <li className="inline-flex items-center gap-1.5 rounded-pill bg-bg-tertiary px-2 py-1 text-[11px] text-text-muted">
              <Loader2 size={11} className="animate-spin" aria-hidden />
              {t('composer.uploading', '{{count}} envoi(s) en cours', { count: uploading })}
            </li>
          )}
        </ul>
      )}

      {error && (
        <p role="alert" className="mt-2 text-[12px] text-sla-breach">
          {error}
        </p>
      )}

      {/* ── Toolbar + send ──────────────────────────────────────────────── */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => insertAtCaret('\n```\n\n```\n')}
          className="rounded-pill p-1.5 text-text-muted hover:bg-bg-hover hover:text-text-secondary"
          title={t('composer.codeBlock', 'Bloc de code')}
        >
          <Code2 size={14} />
        </button>
        <button
          type="button"
          onClick={() => insertAtCaret('{{requester.name}}')}
          className="rounded-pill p-1.5 text-text-muted hover:bg-bg-hover hover:text-text-secondary"
          title={t('composer.variable', 'Insérer une variable')}
        >
          <Braces size={14} />
        </button>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="rounded-pill p-1.5 text-text-muted hover:bg-bg-hover hover:text-text-secondary"
          title={t('composer.attach', 'Joindre un fichier')}
        >
          <ImagePlus size={14} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            void uploadFiles([...(event.target.files ?? [])], false);
            event.target.value = '';
          }}
        />
        <button
          type="button"
          onClick={() => setPreview((value) => !value)}
          aria-pressed={preview}
          className={clsx(
            'rounded-pill p-1.5 hover:bg-bg-hover',
            preview ? 'text-accent' : 'text-text-muted hover:text-text-secondary',
          )}
          title={t('composer.preview', 'Aperçu')}
        >
          <Eye size={14} />
        </button>

        {mentionUnavailable && (
          <span className="text-[11px] text-text-muted">
            {t('composer.mentionsUnavailable', 'Mentions indisponibles (droits insuffisants).')}
          </span>
        )}

        <span className="flex-1" />

        <span className="font-mono text-[10px] text-text-muted">
          {t('composer.shortcut', 'Ctrl/⌘ + Entrée')}
        </span>

        <button
          type="button"
          onClick={() => void send()}
          disabled={!canSend}
          className={clsx(
            'inline-flex items-center gap-1.5 rounded-pill px-3.5 py-1.5 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
            mode === 'internal'
              ? 'text-bg-primary'
              : 'bg-accent text-bg-primary hover:bg-accent-hover',
          )}
          style={mode === 'internal' ? { background: INTERNAL_AMBER } : undefined}
        >
          {sending ? (
            <Loader2 size={13} className="animate-spin" aria-hidden />
          ) : (
            <SendIcon size={13} aria-hidden />
          )}
          {/* The destination is written on the button — the last chance to
              notice you are about to email a work note. */}
          {mode === 'public'
            ? t('composer.sendPublic', 'Envoyer au demandeur')
            : mode === 'internal'
              ? t('composer.sendInternal', 'Enregistrer la note interne')
              : t('composer.sendResolution', 'Résoudre le ticket')}
        </button>
      </div>
    </div>
  );
}
