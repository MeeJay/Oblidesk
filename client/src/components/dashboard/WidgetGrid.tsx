/**
 * WidgetGrid.tsx — the 12-column board: placement, drag, resize, compaction.
 *
 * ── Reading is not editing ───────────────────────────────────────────────────
 * The grid is inert until someone presses "Modifier". No drag sensors, no
 * handles, no resize corner, no selection ring. A dashboard people read every
 * morning must not rearrange itself because a trackpad slipped, and "I moved
 * something and I don't know what" is the fastest way to make a board
 * untrustworthy. `editing` gates the sensors themselves — not just the cursor.
 *
 * ── Why CSS grid and not absolute positioning ────────────────────────────────
 * Widget positions are `(x, y, w, h)` on a 12-column grid, which is exactly
 * what `grid-column: <x+1> / span <w>` expresses. The browser then owns the
 * row heights, the gaps and the reflow, and the layout survives a font change
 * or a zoom without a single recalculation in JS. Only the LIVE drag is
 * translated in JS, because that has to follow the pointer.
 *
 * ── Compaction ───────────────────────────────────────────────────────────────
 * After every drop the layout is normalised: the dragged widget keeps the cell
 * it was dropped on, everything it now overlaps is pushed down, then the whole
 * board floats up. That is one predictable rule, applied the same way every
 * time, and it makes overlapping widgets structurally impossible — which
 * matters because the server stores `(x, y, w, h)` and would happily persist
 * two widgets on top of each other forever.
 *
 * ── Narrow screens ───────────────────────────────────────────────────────────
 * Below ~700px a 12-column grid is a column of slivers. The board stacks each
 * widget full-width in reading order and editing is unavailable — an honest
 * "not here" rather than a drag target three pixels wide.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { GripVertical, Trash2 } from 'lucide-react';
import { cn } from '@/utils/cn';

// ═════════════════════════════════════════════════════════════════════════════
// Layout maths
// ═════════════════════════════════════════════════════════════════════════════

export interface GridItem {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const GRID_COLUMNS = 12;
export const GRID_ROW_HEIGHT = 84;
export const GRID_GAP = 12;
/** Below this the 12-column grid stops being readable and the board stacks. */
export const GRID_STACK_BREAKPOINT = 700;

const clampInt = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.round(value), min), max);
};

function overlaps(a: GridItem, b: GridItem): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * Clamp, de-overlap and float up — in that order.
 *
 * `priorityId` is the widget the user just dropped: it keeps the cell it landed
 * on and everything else moves around it. Without that, dropping a widget onto
 * an occupied cell would push the DRAGGED one away instead, and the drop would
 * feel like it was refused.
 */
export function normalizeLayout(
  items: GridItem[],
  columns: number = GRID_COLUMNS,
  priorityId?: number,
): GridItem[] {
  const clamped = items.map((item) => {
    const w = clampInt(item.w, 1, columns);
    return {
      id: item.id,
      w,
      h: Math.max(Math.round(item.h) || 1, 1),
      x: clampInt(item.x, 0, columns - w),
      y: Math.max(Math.round(item.y) || 0, 0),
    };
  });

  const order = [...clamped].sort((a, b) => {
    if (a.id === priorityId) return -1;
    if (b.id === priorityId) return 1;
    if (a.y !== b.y) return a.y - b.y;
    return a.x - b.x;
  });

  // Pass 1 — push down out of any collision, in placement order.
  const placed: GridItem[] = [];
  for (const item of order) {
    const next = { ...item };
    // A board with a hundred widgets would still terminate: each step moves
    // strictly downward and the placed set is finite.
    while (placed.some((other) => overlaps(next, other))) next.y += 1;
    placed.push(next);
  }

  // Pass 2 — float up. Compaction is what stops a board from growing a hole
  // every time a widget is deleted.
  const compacted: GridItem[] = [];
  for (const item of [...placed].sort((a, b) => (a.y !== b.y ? a.y - b.y : a.x - b.x))) {
    const next = { ...item };
    while (next.y > 0) {
      const lifted = { ...next, y: next.y - 1 };
      if (compacted.some((other) => overlaps(lifted, other))) break;
      next.y = lifted.y;
    }
    compacted.push(next);
  }

  return compacted;
}

/** The next free cell for a widget of this size — where "Add" drops it. */
export function nextFreeSlot(
  items: GridItem[],
  size: { w: number; h: number },
  columns: number = GRID_COLUMNS,
): { x: number; y: number } {
  const w = clampInt(size.w, 1, columns);
  const h = Math.max(size.h, 1);
  const maxY = items.reduce((max, item) => Math.max(max, item.y + item.h), 0);

  for (let y = 0; y <= maxY; y += 1) {
    for (let x = 0; x <= columns - w; x += 1) {
      const candidate = { id: -1, x, y, w, h };
      if (!items.some((item) => overlaps(candidate, item))) return { x, y };
    }
  }
  return { x: 0, y: maxY };
}

function itemStyle(item: GridItem, stacked: boolean): CSSProperties {
  if (stacked) return { gridColumn: '1 / -1' };
  return {
    gridColumn: `${item.x + 1} / span ${item.w}`,
    gridRow: `${item.y + 1} / span ${item.h}`,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// One cell
// ═════════════════════════════════════════════════════════════════════════════

interface GridCellProps {
  item: GridItem;
  stacked: boolean;
  editing: boolean;
  selected: boolean;
  /** Live pixel offset while THIS cell is being dragged. */
  moveTransform: { x: number; y: number } | null;
  /** Live pixel growth while THIS cell is being resized. */
  resizeDelta: { w: number; h: number } | null;
  onSelect: () => void;
  onRemove: () => void;
  removeLabel: string;
  moveLabel: string;
  resizeLabel: string;
  children: ReactNode;
}

function GridCell({
  item,
  stacked,
  editing,
  selected,
  moveTransform,
  resizeDelta,
  onSelect,
  onRemove,
  removeLabel,
  moveLabel,
  resizeLabel,
  children,
}: GridCellProps) {
  const move = useDraggable({ id: `move:${item.id}`, disabled: !editing || stacked });
  const resize = useDraggable({ id: `resize:${item.id}`, disabled: !editing || stacked });

  const dragging = moveTransform !== null || resizeDelta !== null;

  const style: CSSProperties = {
    ...itemStyle(item, stacked),
    minHeight: stacked ? undefined : 0,
    ...(moveTransform
      ? {
          transform: `translate3d(${moveTransform.x}px, ${moveTransform.y}px, 0)`,
          zIndex: 30,
        }
      : {}),
    ...(resizeDelta
      ? {
          // Grow visually from the same top-left corner the grid pinned.
          width: `calc(100% + ${resizeDelta.w}px)`,
          height: `calc(100% + ${resizeDelta.h}px)`,
          zIndex: 30,
        }
      : {}),
  };

  return (
    <div
      ref={move.setNodeRef}
      style={style}
      className={cn(
        'relative min-w-0',
        dragging && 'pointer-events-none select-none opacity-90 shadow-glow',
      )}
      onPointerDownCapture={editing ? onSelect : undefined}
    >
      {/* HARD RULE 11 — the selection cue is an accent RING (a shadow), never a
          border: a border would change the box size and shift the layout by a
          pixel every time a widget is selected. */}
      <div
        className={cn(
          'h-full w-full overflow-hidden rounded-card transition-shadow',
          selected && editing && 'ring-2 ring-accent/70',
        )}
      >
        {children}
      </div>

      {editing && !stacked && (
        <>
          <button
            type="button"
            aria-label={moveLabel}
            title={moveLabel}
            {...move.listeners}
            {...move.attributes}
            className={cn(
              'absolute left-1.5 top-1.5 z-10 flex h-6 w-6 items-center justify-center rounded-[7px]',
              'bg-bg-active text-text-muted shadow-card transition-colors',
              'hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
              'cursor-grab active:cursor-grabbing',
            )}
          >
            <GripVertical size={13} />
          </button>

          <button
            type="button"
            aria-label={removeLabel}
            title={removeLabel}
            onClick={(event) => {
              event.stopPropagation();
              onRemove();
            }}
            className={cn(
              'absolute right-1.5 top-1.5 z-10 flex h-6 w-6 items-center justify-center rounded-[7px]',
              'bg-bg-active text-text-muted shadow-card transition-colors',
              'hover:bg-priority-p1/20 hover:text-priority-p1',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
            )}
          >
            <Trash2 size={12} />
          </button>

          {/* The resize corner. A 16px target in the bottom-right, which is
              where every grid editor has put one for thirty years. */}
          <button
            type="button"
            aria-label={resizeLabel}
            title={resizeLabel}
            {...resize.listeners}
            {...resize.attributes}
            className={cn(
              'absolute bottom-0.5 right-0.5 z-10 h-4 w-4 cursor-nwse-resize rounded-[4px]',
              'bg-accent/25 transition-colors hover:bg-accent/50',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
            )}
          />
        </>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// The grid
// ═════════════════════════════════════════════════════════════════════════════

interface WidgetGridProps {
  items: GridItem[];
  editing: boolean;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  /** Fired once per drop, with the whole normalised layout. */
  onLayoutChange: (next: GridItem[]) => void;
  onRemove: (id: number) => void;
  renderItem: (id: number) => ReactNode;
  columns?: number;
  rowHeight?: number;
  gap?: number;
  /** Rendered when the tab holds no widgets. */
  empty?: ReactNode;
  className?: string;
}

export function WidgetGrid({
  items,
  editing,
  selectedId,
  onSelect,
  onLayoutChange,
  onRemove,
  renderItem,
  columns = GRID_COLUMNS,
  rowHeight = GRID_ROW_HEIGHT,
  gap = GRID_GAP,
  empty,
  className,
}: WidgetGridProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  /** The cell being dragged, and where it would land. */
  const [drag, setDrag] = useState<{
    id: number;
    mode: 'move' | 'resize';
    pixels: { x: number; y: number };
    ghost: GridItem;
  } | null>(null);

  useLayoutEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    setWidth(node.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  const stacked = width > 0 && width < GRID_STACK_BREAKPOINT;
  const columnWidth = width > 0 ? (width - gap * (columns - 1)) / columns : 0;

  // 4px of travel before a drag starts, so a click on the handle is still a
  // click and the widget under it can still be selected.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);

  const parseId = (raw: string): { mode: 'move' | 'resize'; id: number } | null => {
    const [mode, rest] = raw.split(':');
    const id = Number(rest);
    if (!Number.isInteger(id) || (mode !== 'move' && mode !== 'resize')) return null;
    return { mode, id };
  };

  const ghostFor = useCallback(
    (mode: 'move' | 'resize', item: GridItem, delta: { x: number; y: number }): GridItem => {
      if (columnWidth <= 0) return item;
      const stepX = columnWidth + gap;
      const stepY = rowHeight + gap;

      if (mode === 'move') {
        const x = clampInt(item.x + Math.round(delta.x / stepX), 0, columns - item.w);
        const y = Math.max(item.y + Math.round(delta.y / stepY), 0);
        return { ...item, x, y };
      }

      const w = clampInt(item.w + Math.round(delta.x / stepX), 1, columns - item.x);
      const h = Math.max(item.h + Math.round(delta.y / stepY), 1);
      return { ...item, w, h };
    },
    [columnWidth, gap, rowHeight, columns],
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const parsed = parseId(String(event.active.id));
      if (!parsed) return;
      const item = byId.get(parsed.id);
      if (!item) return;
      onSelect(parsed.id);
      setDrag({ id: parsed.id, mode: parsed.mode, pixels: { x: 0, y: 0 }, ghost: item });
    },
    [byId, onSelect],
  );

  const handleDragMove = useCallback(
    (event: DragMoveEvent) => {
      const parsed = parseId(String(event.active.id));
      if (!parsed) return;
      const item = byId.get(parsed.id);
      if (!item) return;
      setDrag({
        id: parsed.id,
        mode: parsed.mode,
        pixels: { x: event.delta.x, y: event.delta.y },
        ghost: ghostFor(parsed.mode, item, event.delta),
      });
    },
    [byId, ghostFor],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const parsed = parseId(String(event.active.id));
      setDrag(null);
      if (!parsed) return;
      const item = byId.get(parsed.id);
      if (!item) return;

      const moved = ghostFor(parsed.mode, item, event.delta);
      if (moved.x === item.x && moved.y === item.y && moved.w === item.w && moved.h === item.h) {
        return;
      }

      const next = normalizeLayout(
        items.map((entry) => (entry.id === parsed.id ? moved : entry)),
        columns,
        parsed.id,
      );
      onLayoutChange(next);
    },
    [byId, columns, ghostFor, items, onLayoutChange],
  );

  // Leaving edit mode with a drag in flight would strand the ghost on screen.
  useEffect(() => {
    if (!editing) setDrag(null);
  }, [editing]);

  const rows = useMemo(
    () => items.reduce((max, item) => Math.max(max, item.y + item.h), 1),
    [items],
  );

  const ordered = useMemo(
    () => [...items].sort((a, b) => (a.y !== b.y ? a.y - b.y : a.x - b.x)),
    [items],
  );

  const gridStyle: CSSProperties = stacked
    ? { display: 'grid', gridTemplateColumns: '1fr', gap }
    : {
        display: 'grid',
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gridAutoRows: `${rowHeight}px`,
        gridTemplateRows: `repeat(${rows}, ${rowHeight}px)`,
        gap,
      };

  const body = (
    <div ref={containerRef} className={cn('relative w-full', className)}>
      {items.length === 0 ? (
        empty
      ) : (
        <div style={gridStyle}>
          {/* The landing rectangle. Dashed, accent, behind everything — it is
              the only thing that tells you where a drop will actually put the
              widget once compaction has had its say. */}
          {drag && !stacked && (
            <div
              aria-hidden
              style={{ ...itemStyle(drag.ghost, false), zIndex: 0 }}
              className="pointer-events-none rounded-card bg-accent/[0.07] outline-2 outline-dashed outline-accent/40"
            />
          )}

          {ordered.map((item) => (
            <GridCell
              key={item.id}
              item={item}
              stacked={stacked}
              editing={editing}
              selected={selectedId === item.id}
              moveTransform={drag && drag.id === item.id && drag.mode === 'move' ? drag.pixels : null}
              resizeDelta={
                drag && drag.id === item.id && drag.mode === 'resize'
                  ? { w: drag.pixels.x, h: drag.pixels.y }
                  : null
              }
              onSelect={() => onSelect(item.id)}
              onRemove={() => onRemove(item.id)}
              removeLabel={t('dashboard.grid.remove', 'Retirer cet élément')}
              moveLabel={t('dashboard.grid.move', 'Déplacer')}
              resizeLabel={t('dashboard.grid.resize', 'Redimensionner')}
            >
              {renderItem(item.id)}
            </GridCell>
          ))}
        </div>
      )}

      {editing && stacked && items.length > 0 && (
        <p className="mt-3 rounded-card bg-bg-tertiary px-3 py-2 text-[12px] text-text-muted">
          {t(
            'dashboard.grid.tooNarrow',
            'L’écran est trop étroit pour la grille à 12 colonnes : les éléments sont empilés et la disposition n’est pas modifiable ici.',
          )}
        </p>
      )}
    </div>
  );

  // The sensors themselves are only mounted in edit mode — see the header.
  if (!editing || stacked) return body;

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setDrag(null)}
    >
      {body}
    </DndContext>
  );
}

export default WidgetGrid;
