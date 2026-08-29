/**
 * ConditionBuilder.tsx — the one condition editor in the product.
 *
 * ── Why this file is worth reading before writing another filter UI ─────────
 * Saved views, automation rules, SLA scope and per-target applicability,
 * escalation triggers, field visibility, required-ness and approval routing all
 * express themselves as the SAME `ConditionNode` tree and are answered by the
 * SAME `evaluateCondition` on both sides of the wire. So there is exactly one
 * editor for it. A second one — "just a small filter box for views" — is how a
 * product ends up with two dialects of the same language, one of which
 * evaluates differently from the engine on some Tuesday nobody remembers.
 *
 * ── What the editor may offer is constrained, on purpose ────────────────────
 *   • FIELDS come from the catalogue (`loadFieldCatalogue`), which mirrors the
 *     server's whitelist. A path the server cannot resolve is a clause that
 *     silently evaluates unknown, and an unknown clause makes a rule quietly
 *     never fire.
 *   • OPERATORS are filtered by the field's type: `starts_with` on a timestamp
 *     is not a mistake worth letting somebody make at 18:40 on a Friday.
 *   • VALUES become a select whenever the field has a closed list, so a typo in
 *     a status slug is not the reason an escalation never ran.
 *
 * An EXISTING tree is never silently rewritten by these constraints. If a leaf
 * names a field the catalogue does not know, or an operator this type no longer
 * offers, both are kept, shown, and flagged — because deleting somebody's
 * clause because we no longer recognise it is worse than showing it in red.
 *
 * ── The summary line, and why there are two of them ─────────────────────────
 * Under the tree sit two renderings of the same node:
 *
 *   1. A plain-FRENCH sentence, built here, for the person who has to read back
 *      what they just built without knowing what `changed_to` means.
 *   2. The canonical expression from `describeCondition()` in `@oblidesk/shared`
 *      — the exact string the Why drawer, the audit trail and `decision_log`
 *      show. It is deliberately the shared function's output and not a local
 *      pretty-printer, so an admin recognises tomorrow's audit row as the thing
 *      they wrote today.
 *
 * The two share the value formatter and the field labels, so they can differ in
 * wording but never in content.
 *
 * HARD RULE 11 — depth here is background steps and a hairline rail on nested
 * groups. No card borders.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  ChevronDown,
  CornerDownRight,
  Plus,
  Trash2,
} from 'lucide-react';
import {
  DURATION_OPERATORS,
  LIST_OPERATORS,
  UNARY_OPERATORS,
  describeCondition,
  isAllNode,
  isAnyNode,
  isConditionLeaf,
  isNotNode,
  type ConditionLeaf,
  type ConditionNode,
  type Operator,
} from '@oblidesk/shared';
import {
  OPERATOR_LABELS,
  loadFieldCatalogue,
  operatorsForField,
  type FieldCatalogue,
  type FieldDescriptor,
} from '@/api/rules.api';
import { cn } from '@/utils/cn';

// ═════════════════════════════════════════════════════════════════════════════
// The catalogue hook — one fetch per session, shared by every builder on screen
// ═════════════════════════════════════════════════════════════════════════════

let cataloguePromise: Promise<FieldCatalogue> | null = null;

/** Drop the memo after publishing a field / queue / status so the picker moves. */
export function invalidateFieldCatalogue(): void {
  cataloguePromise = null;
}

/**
 * The field map, fetched once and shared.
 *
 * Four config reads back a picker that appears in half a dozen places at once;
 * doing them per mounted builder would put a dozen requests behind one screen
 * for a list that changes about once a month.
 */
export function useFieldCatalogue(): { catalogue: FieldCatalogue | null; loading: boolean } {
  const [catalogue, setCatalogue] = useState<FieldCatalogue | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    if (!cataloguePromise) cataloguePromise = loadFieldCatalogue();
    cataloguePromise
      .then((result) => {
        if (alive) setCatalogue(result);
      })
      .catch(() => {
        // A builder with no catalogue still edits an existing tree — it just
        // cannot offer a picker. Blanking the screen would be worse.
        cataloguePromise = null;
        if (alive) setCatalogue({ fields: [], byPath: new Map() });
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  return { catalogue, loading };
}

// ═════════════════════════════════════════════════════════════════════════════
// Immutable tree surgery
//
// A path is the list of child indices from the root. `not` has exactly one
// child, addressed as index 0. Every edit rebuilds the spine and shares the
// untouched subtrees, so React re-renders the branch that changed and nothing
// else.
// ═════════════════════════════════════════════════════════════════════════════

export type NodePath = number[];

function childrenOf(node: ConditionNode): ConditionNode[] | null {
  if (isAllNode(node)) return node.all;
  if (isAnyNode(node)) return node.any;
  if (isNotNode(node)) return [node.not];
  return null;
}

function withChildren(node: ConditionNode, children: ConditionNode[]): ConditionNode {
  if (isAllNode(node)) return { all: children };
  if (isAnyNode(node)) return { any: children };
  if (isNotNode(node)) return { not: children[0] ?? { all: [] } };
  return node;
}

function nodeAt(root: ConditionNode, path: NodePath): ConditionNode | null {
  let cursor: ConditionNode = root;
  for (const index of path) {
    const children = childrenOf(cursor);
    if (!children || !children[index]) return null;
    cursor = children[index];
  }
  return cursor;
}

function replaceAt(root: ConditionNode, path: NodePath, next: ConditionNode): ConditionNode {
  if (path.length === 0) return next;
  const [head, ...rest] = path;
  const children = childrenOf(root);
  if (!children || !children[head]) return root;
  const updated = [...children];
  updated[head] = replaceAt(children[head], rest, next);
  return withChildren(root, updated);
}

function removeAt(root: ConditionNode, path: NodePath): ConditionNode {
  if (path.length === 0) return { all: [] };
  const parentPath = path.slice(0, -1);
  const index = path[path.length - 1];
  const parent = nodeAt(root, parentPath);
  if (!parent) return root;

  // Emptying a NOT leaves the group meaningless rather than half-deleted, so
  // the whole NOT goes with its child.
  if (isNotNode(parent)) return removeAt(root, parentPath);

  const children = childrenOf(parent);
  if (!children) return root;
  const updated = children.filter((_, position) => position !== index);
  return replaceAt(root, parentPath, withChildren(parent, updated));
}

function appendAt(root: ConditionNode, path: NodePath, child: ConditionNode): ConditionNode {
  const parent = nodeAt(root, path);
  if (!parent) return root;
  const children = childrenOf(parent);
  if (!children || isNotNode(parent)) return root;
  return replaceAt(root, path, withChildren(parent, [...children, child]));
}

/** A fresh leaf, pointed at the first field the catalogue offers. */
function newLeaf(fields: readonly FieldDescriptor[]): ConditionLeaf {
  const first = fields[0];
  return { field: first?.path ?? 'status_category', op: 'eq', value: '' };
}

/** True when the tree matches everything — `{all: []}` and friends. */
export function isAlwaysTrue(node: ConditionNode | null | undefined): boolean {
  if (!node) return true;
  if (isAllNode(node)) return node.all.length === 0;
  return false;
}

// ═════════════════════════════════════════════════════════════════════════════
// Rendering the tree as French
// ═════════════════════════════════════════════════════════════════════════════

function formatScalar(value: unknown, field: FieldDescriptor | undefined): string {
  if (value === undefined || value === null) return '—';
  if (Array.isArray(value)) {
    return value.map((entry) => formatScalar(entry, field)).join(', ');
  }
  if (typeof value === 'boolean') return value ? 'vrai' : 'faux';
  const asString = String(value);
  const choice = field?.choices?.find((entry) => entry.value === asString);
  return choice ? choice.label : asString;
}

/**
 * The readable French line.
 *
 * It walks the same tree `describeCondition()` walks and formats values through
 * the same helper; only the connectives and the operator phrases are French.
 * Keeping it here rather than in `@oblidesk/shared` is deliberate: the shared
 * function is the CANONICAL rendering that goes into `decision_log` and must
 * not drift per locale, while this one is prose for a screen.
 */
export function conditionSummaryFr(
  node: ConditionNode | null | undefined,
  catalogue: FieldCatalogue | null,
  depth = 0,
): string {
  if (!node) return 'toujours';
  if (depth > 12) return '…';

  const label = (path: string) => catalogue?.byPath.get(path)?.label ?? path;

  if (isAllNode(node)) {
    if (node.all.length === 0) return 'toujours';
    const parts = node.all.map((child) => conditionSummaryFr(child, catalogue, depth + 1));
    return parts.length > 1 ? `(${parts.join(' ET ')})` : parts[0];
  }
  if (isAnyNode(node)) {
    if (node.any.length === 0) return 'jamais';
    const parts = node.any.map((child) => conditionSummaryFr(child, catalogue, depth + 1));
    return parts.length > 1 ? `(${parts.join(' OU ')})` : parts[0];
  }
  if (isNotNode(node)) {
    return `NON ${conditionSummaryFr(node.not, catalogue, depth + 1)}`;
  }
  if (isConditionLeaf(node)) {
    const field = catalogue?.byPath.get(node.field);
    const phrase = OPERATOR_LABELS[node.op] ?? node.op;
    if ((UNARY_OPERATORS as readonly string[]).includes(node.op)) {
      return `${label(node.field)} ${phrase}`;
    }
    return `${label(node.field)} ${phrase} ${formatScalar(node.value, field)}`;
  }
  return 'condition illisible';
}

// ═════════════════════════════════════════════════════════════════════════════
// Value editors
// ═════════════════════════════════════════════════════════════════════════════

const CONTROL =
  'h-8 rounded-md bg-bg-tertiary px-2 text-[13px] text-text-primary outline-none '
  + 'focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-50';

interface ValueEditorProps {
  leaf: ConditionLeaf;
  field: FieldDescriptor | undefined;
  disabled: boolean;
  onChange: (value: unknown) => void;
}

function ValueEditor({ leaf, field, disabled, onChange }: ValueEditorProps): JSX.Element | null {
  const { t } = useTranslation();

  if ((UNARY_OPERATORS as readonly string[]).includes(leaf.op)) return null;

  const isList = (LIST_OPERATORS as readonly string[]).includes(leaf.op);
  const isDuration = (DURATION_OPERATORS as readonly string[]).includes(leaf.op);

  // ── a duration: "90", "2h", "3d 4h" ────────────────────────────────────────
  if (isDuration) {
    return (
      <input
        type="text"
        disabled={disabled}
        value={typeof leaf.value === 'string' || typeof leaf.value === 'number' ? String(leaf.value) : ''}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t('conditions.durationPlaceholder', '2h, 90, 3d 4h…')}
        className={cn(CONTROL, 'w-[150px] font-mono')}
        aria-label={t('conditions.value', 'Valeur')}
      />
    );
  }

  // ── a closed list, multi-select ────────────────────────────────────────────
  if (isList && field?.choices && field.choices.length > 0) {
    const selected = Array.isArray(leaf.value) ? leaf.value.map(String) : [];
    return (
      <div className="flex flex-wrap items-center gap-1">
        {field.choices.map((choice) => {
          const active = selected.includes(choice.value);
          return (
            <button
              key={choice.value}
              type="button"
              disabled={disabled}
              onClick={() =>
                onChange(
                  active
                    ? selected.filter((entry) => entry !== choice.value)
                    : [...selected, choice.value],
                )
              }
              className={cn(
                'h-7 rounded-pill px-2.5 text-[12px] transition-colors',
                active
                  ? 'bg-accent/15 text-accent'
                  : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover',
              )}
            >
              {choice.label}
            </button>
          );
        })}
      </div>
    );
  }

  // ── a free list ────────────────────────────────────────────────────────────
  if (isList) {
    const asText = Array.isArray(leaf.value) ? leaf.value.map(String).join(', ') : '';
    return (
      <input
        type="text"
        disabled={disabled}
        value={asText}
        onChange={(event) =>
          onChange(
            event.target.value
              .split(',')
              .map((entry) => entry.trim())
              .filter((entry) => entry !== ''),
          )
        }
        placeholder={t('conditions.listPlaceholder', 'valeur1, valeur2…')}
        className={cn(CONTROL, 'min-w-[200px] flex-1')}
        aria-label={t('conditions.value', 'Valeur')}
      />
    );
  }

  // ── a closed list, single pick ─────────────────────────────────────────────
  if (field?.choices && field.choices.length > 0) {
    return (
      <select
        disabled={disabled}
        value={typeof leaf.value === 'string' ? leaf.value : ''}
        onChange={(event) => onChange(event.target.value)}
        className={cn(CONTROL, 'min-w-[160px] appearance-none pr-6')}
        aria-label={t('conditions.value', 'Valeur')}
      >
        <option value="">{t('conditions.pickValue', 'Choisir…')}</option>
        {field.choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
    );
  }

  if (field?.kind === 'boolean') {
    return (
      <select
        disabled={disabled}
        value={leaf.value === true ? 'true' : leaf.value === false ? 'false' : ''}
        onChange={(event) => onChange(event.target.value === '' ? '' : event.target.value === 'true')}
        className={cn(CONTROL, 'w-[120px] appearance-none pr-6')}
        aria-label={t('conditions.value', 'Valeur')}
      >
        <option value="">{t('conditions.pickValue', 'Choisir…')}</option>
        <option value="true">{t('common.yes', 'Oui')}</option>
        <option value="false">{t('common.no', 'Non')}</option>
      </select>
    );
  }

  if (field?.kind === 'number') {
    return (
      <input
        type="number"
        disabled={disabled}
        value={typeof leaf.value === 'number' ? leaf.value : typeof leaf.value === 'string' ? leaf.value : ''}
        onChange={(event) => onChange(event.target.value === '' ? '' : Number(event.target.value))}
        className={cn(CONTROL, 'w-[140px] font-mono')}
        aria-label={t('conditions.value', 'Valeur')}
      />
    );
  }

  if (field?.kind === 'timestamp') {
    return (
      <input
        type="datetime-local"
        disabled={disabled}
        value={typeof leaf.value === 'string' ? leaf.value.slice(0, 16) : ''}
        onChange={(event) => onChange(event.target.value)}
        className={cn(CONTROL, 'w-[210px] font-mono')}
        aria-label={t('conditions.value', 'Valeur')}
      />
    );
  }

  return (
    <input
      type="text"
      disabled={disabled}
      value={typeof leaf.value === 'string' || typeof leaf.value === 'number' ? String(leaf.value) : ''}
      onChange={(event) => onChange(event.target.value)}
      className={cn(CONTROL, 'min-w-[180px] flex-1')}
      aria-label={t('conditions.value', 'Valeur')}
    />
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// One leaf
// ═════════════════════════════════════════════════════════════════════════════

interface LeafRowProps {
  leaf: ConditionLeaf;
  catalogue: FieldCatalogue | null;
  disabled: boolean;
  onChange: (next: ConditionLeaf) => void;
  onRemove: () => void;
}

function LeafRow({ leaf, catalogue, disabled, onChange, onRemove }: LeafRowProps): JSX.Element {
  const { t } = useTranslation();
  const field = catalogue?.byPath.get(leaf.field);
  const operators = operatorsForField(field);

  // A field or operator the catalogue no longer offers is SHOWN, not dropped.
  const unknownField = catalogue !== null && catalogue.fields.length > 0 && field === undefined;
  const unknownOperator = !operators.includes(leaf.op);

  const grouped = useMemo(() => {
    const groups = new Map<string, FieldDescriptor[]>();
    for (const entry of catalogue?.fields ?? []) {
      const list = groups.get(entry.group) ?? [];
      list.push(entry);
      groups.set(entry.group, list);
    }
    return [...groups.entries()];
  }, [catalogue]);

  function changeField(path: string) {
    const nextField = catalogue?.byPath.get(path);
    const allowed = operatorsForField(nextField);
    // Keep the operator when the new type still supports it; otherwise take the
    // first legal one rather than leaving a clause that can never be true.
    const op = allowed.includes(leaf.op) ? leaf.op : allowed[0];
    const keepsValue = op === leaf.op && nextField?.kind === field?.kind;
    onChange({ field: path, op, value: keepsValue ? leaf.value : '' });
  }

  function changeOperator(op: Operator) {
    const wasUnary = (UNARY_OPERATORS as readonly string[]).includes(leaf.op);
    const isUnary = (UNARY_OPERATORS as readonly string[]).includes(op);
    const wasList = (LIST_OPERATORS as readonly string[]).includes(leaf.op);
    const isList = (LIST_OPERATORS as readonly string[]).includes(op);

    let value = leaf.value;
    if (isUnary) value = undefined;
    else if (wasUnary) value = '';
    else if (isList && !wasList) value = leaf.value === '' || leaf.value === undefined ? [] : [leaf.value];
    else if (!isList && wasList) value = Array.isArray(leaf.value) ? (leaf.value[0] ?? '') : '';

    onChange({ field: leaf.field, op, value });
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md bg-bg-secondary px-2 py-1.5">
      <select
        disabled={disabled}
        value={leaf.field}
        onChange={(event) => changeField(event.target.value)}
        className={cn(
          CONTROL,
          'min-w-[190px] max-w-[260px] appearance-none pr-6',
          unknownField && 'text-sla-warn',
        )}
        aria-label={t('conditions.field', 'Champ')}
      >
        {unknownField && (
          <option value={leaf.field}>
            {leaf.field} : {t('conditions.unknownField', 'champ inconnu')}
          </option>
        )}
        {grouped.map(([group, entries]) => (
          <optgroup key={group} label={group}>
            {entries.map((entry) => (
              <option key={entry.path} value={entry.path}>
                {entry.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>

      <select
        disabled={disabled}
        value={leaf.op}
        onChange={(event) => changeOperator(event.target.value as Operator)}
        className={cn(CONTROL, 'min-w-[150px] appearance-none pr-6', unknownOperator && 'text-sla-warn')}
        aria-label={t('conditions.operator', 'Opérateur')}
      >
        {unknownOperator && <option value={leaf.op}>{leaf.op}</option>}
        {operators.map((op) => (
          <option key={op} value={op}>
            {t(`conditions.op.${op}`, OPERATOR_LABELS[op] ?? op)}
          </option>
        ))}
      </select>

      <ValueEditor
        leaf={leaf}
        field={field}
        disabled={disabled}
        onChange={(value) => onChange({ ...leaf, value })}
      />

      {field?.help && (
        <span className="text-[11px] text-text-muted" title={field.help}>
          ⓘ
        </span>
      )}

      <button
        type="button"
        disabled={disabled}
        onClick={onRemove}
        title={t('conditions.removeClause', 'Supprimer cette condition')}
        aria-label={t('conditions.removeClause', 'Supprimer cette condition')}
        className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-priority-p1"
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// A group — all / any / not
// ═════════════════════════════════════════════════════════════════════════════

interface GroupProps {
  node: ConditionNode;
  path: NodePath;
  catalogue: FieldCatalogue | null;
  disabled: boolean;
  depth: number;
  maxDepth: number;
  isRoot: boolean;
  onEdit: (path: NodePath, next: ConditionNode) => void;
  onRemove: (path: NodePath) => void;
  onAppend: (path: NodePath, child: ConditionNode) => void;
}

function GroupNode(props: GroupProps): JSX.Element {
  const { node, path, catalogue, disabled, depth, maxDepth, isRoot, onEdit, onRemove, onAppend } = props;
  const { t } = useTranslation();

  const children = childrenOf(node) ?? [];
  const mode: 'all' | 'any' | 'not' = isAnyNode(node) ? 'any' : isNotNode(node) ? 'not' : 'all';

  const connector =
    mode === 'all'
      ? t('conditions.all', 'TOUTES les conditions')
      : mode === 'any'
        ? t('conditions.any', 'AU MOINS UNE condition')
        : t('conditions.not', 'AUCUNE des conditions (NON)');

  return (
    <div
      className={cn(
        'rounded-lg',
        isRoot ? 'bg-bg-secondary p-2.5' : 'bg-bg-tertiary/60 p-2',
      )}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        {mode !== 'not' ? (
          <div className="flex overflow-hidden rounded-pill bg-bg-tertiary" role="group">
            {(['all', 'any'] as const).map((option) => (
              <button
                key={option}
                type="button"
                disabled={disabled}
                aria-pressed={mode === option}
                onClick={() =>
                  onEdit(path, option === 'all' ? { all: children } : { any: children })
                }
                className={cn(
                  'h-7 px-3 text-[12px] font-medium transition-colors',
                  mode === option
                    ? 'bg-accent text-bg-primary'
                    : 'text-text-secondary hover:bg-bg-hover',
                )}
              >
                {option === 'all' ? t('conditions.andShort', 'ET') : t('conditions.orShort', 'OU')}
              </button>
            ))}
          </div>
        ) : (
          <span className="rounded-pill bg-priority-p2-bg px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-priority-p2">
            {t('conditions.notShort', 'NON')}
          </span>
        )}

        <span className="text-[12px] text-text-muted">{connector}</span>

        <div className="ml-auto flex items-center gap-1">
          {mode !== 'not' && (
            <>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onAppend(path, newLeaf(catalogue?.fields ?? []))}
                className="flex h-7 items-center gap-1 rounded-md bg-bg-tertiary px-2 text-[12px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
              >
                <Plus size={12} />
                {t('conditions.addClause', 'Condition')}
              </button>
              {depth < maxDepth && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onAppend(path, { all: [] })}
                  className="flex h-7 items-center gap-1 rounded-md bg-bg-tertiary px-2 text-[12px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
                  title={t('conditions.addGroupHelp', 'Un sous-groupe permet de mélanger ET et OU.')}
                >
                  <CornerDownRight size={12} />
                  {t('conditions.addGroup', 'Groupe')}
                </button>
              )}
              {depth < maxDepth && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onAppend(path, { not: { all: [] } })}
                  className="flex h-7 items-center gap-1 rounded-md bg-bg-tertiary px-2 text-[12px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
                >
                  <Plus size={12} />
                  {t('conditions.notShort', 'NON')}
                </button>
              )}
            </>
          )}
          {!isRoot && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onRemove(path)}
              title={t('conditions.removeGroup', 'Supprimer ce groupe')}
              aria-label={t('conditions.removeGroup', 'Supprimer ce groupe')}
              className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-priority-p1"
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </div>

      {children.length === 0 ? (
        <p className="px-1 py-1.5 text-[12px] text-text-muted">
          {mode === 'any'
            ? t('conditions.emptyAny', 'Groupe vide : aucune condition ne peut correspondre, la règle ne partira jamais.')
            : t('conditions.emptyAll', 'Groupe vide : la condition est toujours vraie.')}
        </p>
      ) : (
        // The rail is a background strip, not a CSS border (HARD RULE 11).
        <div className={cn('space-y-1.5', !isRoot && 'relative pl-2.5')}>
          {!isRoot && <span className="absolute inset-y-0 left-0 w-px bg-border" aria-hidden />}
          {children.map((child, index) => {
            const childPath = [...path, index];
            if (isConditionLeaf(child)) {
              return (
                <LeafRow
                  key={`${childPath.join('.')}-${child.field}-${index}`}
                  leaf={child}
                  catalogue={catalogue}
                  disabled={disabled}
                  onChange={(next) => onEdit(childPath, next)}
                  onRemove={() => onRemove(childPath)}
                />
              );
            }
            return (
              <GroupNode
                key={childPath.join('.')}
                {...props}
                node={child}
                path={childPath}
                depth={depth + 1}
                isRoot={false}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// The builder
// ═════════════════════════════════════════════════════════════════════════════

export interface ConditionBuilderProps {
  value: ConditionNode | null;
  onChange: (next: ConditionNode | null) => void;
  /** Pass a shared catalogue to avoid a second fetch; omit to fetch one. */
  catalogue?: FieldCatalogue | null;
  disabled?: boolean;
  /** Shown above the tree. Already translated. */
  label?: string;
  /** What an empty tree means here — "always", or "the whole desk". */
  emptyMeaning?: string;
  maxDepth?: number;
  className?: string;
}

export function ConditionBuilder({
  value,
  onChange,
  catalogue: providedCatalogue,
  disabled = false,
  label,
  emptyMeaning,
  maxDepth = 4,
  className,
}: ConditionBuilderProps): JSX.Element {
  const { t } = useTranslation();
  const fetched = useFieldCatalogue();
  const catalogue = providedCatalogue ?? fetched.catalogue;

  // A leaf at the root is legal in the wire format but impossible to add a
  // sibling to, so the editor always works on a group and unwraps on the way
  // out. `normalizeCondition` on the server collapses the wrapper again, so
  // this costs nothing in the stored body.
  const root: ConditionNode = useMemo(() => {
    if (!value) return { all: [] };
    if (isConditionLeaf(value)) return { all: [value] };
    return value;
  }, [value]);

  const emit = useCallback(
    (next: ConditionNode) => {
      if (isAllNode(next) && next.all.length === 0) {
        onChange(null);
        return;
      }
      onChange(next);
    },
    [onChange],
  );

  const handleEdit = useCallback(
    (path: NodePath, next: ConditionNode) => emit(replaceAt(root, path, next)),
    [emit, root],
  );
  const handleRemove = useCallback((path: NodePath) => emit(removeAt(root, path)), [emit, root]);
  const handleAppend = useCallback(
    (path: NodePath, child: ConditionNode) => emit(appendAt(root, path, child)),
    [emit, root],
  );

  const summary = useMemo(() => conditionSummaryFr(value, catalogue), [value, catalogue]);

  /**
   * The canonical expression — the SAME function the Why drawer and
   * `decision_log` render with, so what an admin reads here is what they will
   * recognise in an audit row tomorrow.
   */
  const canonical = useMemo(
    () =>
      describeCondition(value, {
        fieldLabel: (field) => catalogue?.byPath.get(field)?.label ?? field,
        formatValue: (raw, field) => formatScalar(raw, catalogue?.byPath.get(field)),
      }),
    [value, catalogue],
  );

  const unknownFields = useMemo(() => {
    if (!catalogue || catalogue.fields.length === 0) return [];
    const missing: string[] = [];
    const walk = (node: ConditionNode | null | undefined) => {
      if (!node) return;
      if (isConditionLeaf(node)) {
        if (!catalogue.byPath.has(node.field) && !missing.includes(node.field)) missing.push(node.field);
        return;
      }
      for (const child of childrenOf(node) ?? []) walk(child);
    };
    walk(value);
    return missing;
  }, [value, catalogue]);

  return (
    <div className={cn('space-y-2', className)}>
      {label && (
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-medium uppercase tracking-wide text-text-muted">{label}</span>
          {fetched.loading && !providedCatalogue && (
            <span className="text-[11px] text-text-muted">
              {t('conditions.loadingFields', 'Chargement des champs…')}
            </span>
          )}
        </div>
      )}

      <GroupNode
        node={root}
        path={[]}
        catalogue={catalogue}
        disabled={disabled}
        depth={0}
        maxDepth={maxDepth}
        isRoot
        onEdit={handleEdit}
        onRemove={handleRemove}
        onAppend={handleAppend}
      />

      {unknownFields.length > 0 && (
        <div className="flex items-start gap-2 rounded-md bg-sla-warn-bg px-2.5 py-2 text-[12px] text-sla-warn">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            {t(
              'conditions.unknownFieldsWarning',
              'Ces champs ne sont plus connus du serveur : la condition les évaluera comme « inconnu », ce qui la rend fausse.',
            )}{' '}
            <span className="font-mono">{unknownFields.join(', ')}</span>
          </span>
        </div>
      )}

      {/* The read-back. Two renderings, one tree. */}
      <div className="rounded-md bg-bg-tertiary/60 px-2.5 py-2">
        <p className="text-[13px] leading-relaxed text-text-primary">
          <span className="text-text-muted">
            {t('conditions.summaryPrefix', 'Cette condition se lit :')}{' '}
          </span>
          {isAlwaysTrue(value)
            ? emptyMeaning ?? t('conditions.always', 'toujours vraie : elle ne filtre rien')
            : summary}
        </p>
        {!isAlwaysTrue(value) && (
          <details className="mt-1">
            <summary className="cursor-pointer text-[11px] text-text-muted hover:text-text-secondary">
              <ChevronDown size={11} className="mr-1 inline" />
              {t('conditions.canonical', 'Expression telle qu’elle apparaîtra dans le journal des décisions')}
            </summary>
            <code className="mt-1 block break-all font-mono text-[11px] text-text-secondary">{canonical}</code>
          </details>
        )}
      </div>
    </div>
  );
}

export default ConditionBuilder;
