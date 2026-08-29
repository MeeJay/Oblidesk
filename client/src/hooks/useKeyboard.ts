/**
 * useKeyboard.ts — the remappable keymap.
 *
 * A service desk is a keyboard tool: an agent working a queue should never have
 * to reach for the mouse to triage. Three rules make that safe rather than
 * hostile:
 *
 *  1. UNMODIFIED KEYS NEVER FIRE INSIDE A TEXT FIELD. `n` means "new note" on
 *     the queue and the letter n inside the composer. The check is on the event
 *     target, not on a global "is a modal open" flag, because the composer is
 *     not a modal and the flag would be wrong exactly when it matters.
 *
 *  2. BINDINGS ARE DATA. The map lives in localStorage under
 *     STORAGE_KEYS.keymap and every action resolves through it. A hard-coded
 *     `if (e.key === 'j')` is a binding nobody can change.
 *
 *  3. A HANDLER THAT IS NOT SUPPLIED DOES NOTHING — and, crucially, does not
 *     swallow the key. Preventing default for an action the page did not
 *     implement is how a browser shortcut disappears for no reason.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { STORAGE_KEYS } from '@oblidesk/shared';

// ═════════════════════════════════════════════════════════════════════════════
// Actions
// ═════════════════════════════════════════════════════════════════════════════

export const KEYBOARD_ACTIONS = [
  'navigateDown',
  'navigateUp',
  'open',
  'reply',
  'note',
  'assign',
  'assignToMe',
  'edit',
  'snooze',
  'resolve',
  'toggleSelect',
  'selectAll',
  'refresh',
  'search',
  'commandPalette',
  'newTicket',
  'toggleSidebar',
  'toggleDensity',
  'nextView',
  'previousView',
  'showHelp',
] as const;

export type KeyboardAction = (typeof KEYBOARD_ACTIONS)[number];

/**
 * `mod` is Cmd on macOS and Ctrl everywhere else — one binding, right on both.
 * Order inside a chord is fixed (`mod+shift+alt+key`) so two spellings of the
 * same chord can never both be stored.
 */
export type KeyBinding = string;

export const DEFAULT_KEYMAP: Readonly<Record<KeyboardAction, KeyBinding>> = {
  navigateDown: 'j',
  navigateUp: 'k',
  open: 'o',
  reply: 'r',
  note: 'n',
  assign: 'a',
  assignToMe: 'shift+a',
  edit: 'e',
  snooze: 's',
  resolve: 'shift+r',
  toggleSelect: 'x',
  selectAll: 'mod+a',
  refresh: 'mod+shift+r',
  search: '/',
  commandPalette: 'mod+k',
  newTicket: 'c',
  toggleSidebar: 'mod+b',
  toggleDensity: 'shift+d',
  nextView: ']',
  previousView: '[',
  showHelp: '?',
};

/** Inline English fallbacks — always paired with the key in `t()`. */
export const ACTION_LABEL_KEYS: Readonly<Record<KeyboardAction, { key: string; fallback: string }>> = {
  navigateDown: { key: 'keyboard.action.navigateDown', fallback: 'Next ticket' },
  navigateUp: { key: 'keyboard.action.navigateUp', fallback: 'Previous ticket' },
  open: { key: 'keyboard.action.open', fallback: 'Open ticket' },
  reply: { key: 'keyboard.action.reply', fallback: 'Public reply' },
  note: { key: 'keyboard.action.note', fallback: 'Work note' },
  assign: { key: 'keyboard.action.assign', fallback: 'Assign' },
  assignToMe: { key: 'keyboard.action.assignToMe', fallback: 'Assign to me' },
  edit: { key: 'keyboard.action.edit', fallback: 'Edit fields' },
  snooze: { key: 'keyboard.action.snooze', fallback: 'Snooze' },
  resolve: { key: 'keyboard.action.resolve', fallback: 'Resolve' },
  toggleSelect: { key: 'keyboard.action.toggleSelect', fallback: 'Select row' },
  selectAll: { key: 'keyboard.action.selectAll', fallback: 'Select all loaded' },
  refresh: { key: 'keyboard.action.refresh', fallback: 'Refresh queue' },
  search: { key: 'keyboard.action.search', fallback: 'Search' },
  commandPalette: { key: 'keyboard.action.commandPalette', fallback: 'Command palette' },
  newTicket: { key: 'keyboard.action.newTicket', fallback: 'New ticket' },
  toggleSidebar: { key: 'keyboard.action.toggleSidebar', fallback: 'Toggle sidebar' },
  toggleDensity: { key: 'keyboard.action.toggleDensity', fallback: 'Toggle density' },
  nextView: { key: 'keyboard.action.nextView', fallback: 'Next view' },
  previousView: { key: 'keyboard.action.previousView', fallback: 'Previous view' },
  showHelp: { key: 'keyboard.action.showHelp', fallback: 'Keyboard shortcuts' },
};

// ═════════════════════════════════════════════════════════════════════════════
// Binding parsing
// ═════════════════════════════════════════════════════════════════════════════

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Normalise an event into the canonical binding spelling. */
export function bindingOf(event: KeyboardEvent): KeyBinding {
  const parts: string[] = [];
  const mod = IS_MAC ? event.metaKey : event.ctrlKey;
  if (mod) parts.push('mod');
  // The "other" modifier is kept distinct so Ctrl on a Mac is not silently
  // treated as Cmd — they are different keys and users bind them differently.
  if (IS_MAC ? event.ctrlKey : event.metaKey) parts.push('ctrl');
  if (event.shiftKey) parts.push('shift');
  if (event.altKey) parts.push('alt');

  let key = event.key;
  if (key === ' ') key = 'space';
  else if (key.length === 1) key = key.toLowerCase();
  else key = key.toLowerCase();

  // `?` already carries Shift on most layouts; keeping both would mean the
  // stored binding never matches what the user actually pressed.
  if (key === '?' ) {
    return parts.filter((part) => part !== 'shift').concat('?').join('+');
  }

  parts.push(key);
  return parts.join('+');
}

/** Human spelling for the help overlay: 'mod+k' → '⌘ K' / 'Ctrl K'. */
export function describeBinding(binding: KeyBinding): string {
  return binding
    .split('+')
    .map((part) => {
      if (part === 'mod') return IS_MAC ? '⌘' : 'Ctrl';
      if (part === 'ctrl') return IS_MAC ? '⌃' : 'Ctrl';
      if (part === 'shift') return IS_MAC ? '⇧' : 'Shift';
      if (part === 'alt') return IS_MAC ? '⌥' : 'Alt';
      if (part === 'space') return 'Space';
      if (part === 'arrowup') return '↑';
      if (part === 'arrowdown') return '↓';
      if (part === 'arrowleft') return '←';
      if (part === 'arrowright') return '→';
      if (part === 'escape') return 'Esc';
      if (part === 'enter') return '⏎';
      return part.length === 1 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1);
    })
    .join(IS_MAC ? ' ' : ' + ');
}

function hasModifier(binding: KeyBinding): boolean {
  return /^(mod|ctrl|alt)\+/.test(binding) || binding.includes('+mod') || binding.includes('+ctrl') || binding.includes('+alt');
}

/**
 * Is the event coming from somewhere the user is typing? Includes shadow-DOM
 * hosts via `composedPath`, because a rich-text editor may live in one and a
 * single-letter shortcut firing inside a reply is the failure this prevents.
 */
function isTypingTarget(event: KeyboardEvent): boolean {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
  for (const node of path) {
    if (!(node instanceof HTMLElement)) continue;
    const tag = node.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (node.isContentEditable) return true;
    if (node.getAttribute('role') === 'textbox') return true;
  }
  return false;
}

// ═════════════════════════════════════════════════════════════════════════════
// Persistence
// ═════════════════════════════════════════════════════════════════════════════

export type Keymap = Record<KeyboardAction, KeyBinding>;

function loadKeymap(): Keymap {
  const map: Keymap = { ...DEFAULT_KEYMAP };
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.keymap);
    if (!raw) return map;
    const stored = JSON.parse(raw) as Partial<Record<string, unknown>>;
    for (const action of KEYBOARD_ACTIONS) {
      const value = stored[action];
      // Only known actions and string bindings survive: a keymap written by a
      // newer build must never leave this one with an undefined binding.
      if (typeof value === 'string' && value.length > 0) map[action] = value;
    }
  } catch {
    // Unreadable or corrupt — the defaults are always a working keymap.
  }
  return map;
}

function saveKeymap(map: Keymap): void {
  try {
    // Store only the overrides, so a future change to a default reaches users
    // who never remapped that action.
    const overrides: Record<string, string> = {};
    for (const action of KEYBOARD_ACTIONS) {
      if (map[action] !== DEFAULT_KEYMAP[action]) overrides[action] = map[action];
    }
    localStorage.setItem(STORAGE_KEYS.keymap, JSON.stringify(overrides));
  } catch {
    // Storage blocked — the remap holds for this session only.
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Hooks
// ═════════════════════════════════════════════════════════════════════════════

export interface KeymapApi {
  keymap: Keymap;
  setBinding: (action: KeyboardAction, binding: KeyBinding) => void;
  resetBinding: (action: KeyboardAction) => void;
  resetAll: () => void;
  /** Actions already bound to this chord, excluding `except`. */
  conflictsOf: (binding: KeyBinding, except?: KeyboardAction) => KeyboardAction[];
}

/** The editable keymap, for the shortcuts settings panel. */
export function useKeymap(): KeymapApi {
  const [keymap, setKeymap] = useState<Keymap>(loadKeymap);

  const setBinding = useCallback((action: KeyboardAction, binding: KeyBinding) => {
    setKeymap((current) => {
      const next = { ...current, [action]: binding };
      saveKeymap(next);
      return next;
    });
  }, []);

  const resetBinding = useCallback((action: KeyboardAction) => {
    setKeymap((current) => {
      const next = { ...current, [action]: DEFAULT_KEYMAP[action] };
      saveKeymap(next);
      return next;
    });
  }, []);

  const resetAll = useCallback(() => {
    const next: Keymap = { ...DEFAULT_KEYMAP };
    saveKeymap(next);
    setKeymap(next);
  }, []);

  const conflictsOf = useCallback(
    (binding: KeyBinding, except?: KeyboardAction) =>
      KEYBOARD_ACTIONS.filter((action) => action !== except && keymap[action] === binding),
    [keymap],
  );

  return { keymap, setBinding, resetBinding, resetAll, conflictsOf };
}

export type KeyboardHandlers = Partial<Record<KeyboardAction, (event: KeyboardEvent) => void>>;

export interface UseKeyboardOptions {
  /** Suspend every binding — a modal that owns the keyboard sets this. */
  disabled?: boolean;
  /**
   * Also fire inside text fields. Only ever for chords: enabling it for a bare
   * letter makes the composer unusable.
   */
  allowInInputs?: boolean;
  /** Escape is special: it is not remappable and always reaches the handler. */
  onEscape?: (event: KeyboardEvent) => void;
}

/**
 * Bind the supplied handlers to the user's keymap for as long as the component
 * is mounted. Pass only the actions this screen actually implements — an absent
 * handler leaves the key alone rather than eating it.
 */
export function useKeyboard(handlers: KeyboardHandlers, options: UseKeyboardOptions = {}): Keymap {
  const { disabled = false, allowInInputs = false, onEscape } = options;
  const [keymap] = useState<Keymap>(loadKeymap);

  // Callers pass an object literal, so it is a new reference every render.
  // Holding it in a ref keeps the document listener registered once instead of
  // being torn down and rebuilt on each keystroke-driven re-render.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;

  // Rebuild the lookup only when the bindings change, not on every render.
  const byBinding = useMemo(() => {
    const out = new Map<KeyBinding, KeyboardAction>();
    for (const action of KEYBOARD_ACTIONS) out.set(keymap[action], action);
    return out;
  }, [keymap]);

  useEffect(() => {
    if (disabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      if (event.key === 'Escape') {
        escapeRef.current?.(event);
        return;
      }

      const binding = bindingOf(event);
      const action = byBinding.get(binding);
      if (!action) return;

      const handler = handlersRef.current[action];
      // No handler → no preventDefault. Swallowing a key the page does not
      // implement is how Ctrl+A stops selecting text for no visible reason.
      if (!handler) return;

      if (isTypingTarget(event) && !allowInInputs && !hasModifier(binding)) return;

      event.preventDefault();
      handler(event);
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [disabled, allowInInputs, byBinding]);

  return keymap;
}

export default useKeyboard;
