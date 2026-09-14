/**
 * Monitor ordering helpers.
 *
 * The monitors list (`local:monitors`) is an ordered array — its array
 * order *is* the home-screen order. Reordering therefore never needs a
 * separate order key or a schema migration: persisting a new order is
 * just writing the same monitors back in a different sequence, and
 * restoring after reload is just reading them back (creation appends,
 * updates replace in place, deletes filter — all order-preserving, see
 * `lib/monitors/store.ts`).
 *
 * Everything here is pure (no `chrome.*`, no React) so the insertion
 * math and the filtered→global merge are directly unit-testable.
 */

export interface OrderRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

export function toOrderRect(rect: {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}): OrderRect {
  return {
    ...rect,
    centerX: rect.left + rect.width / 2,
    centerY: rect.top + rect.height / 2,
  };
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(length - 1, Math.max(0, index));
}

/**
 * Moves `activeId` to `toIndex` within `ids`, returning a new array.
 * `toIndex` is clamped. Unknown ids and no-ops return a copy unchanged
 * in content (never mutates the input).
 */
export function moveId(ids: string[], activeId: string, toIndex: number): string[] {
  const from = ids.indexOf(activeId);
  if (from === -1) return [...ids];
  const clamped = Math.min(ids.length - 1, Math.max(0, toIndex));
  if (clamped === from) return [...ids];
  const next = [...ids];
  next.splice(from, 1);
  next.splice(clamped, 0, activeId);
  return next;
}

/** Moves `activeId` by `delta` positions (negative = toward the start). */
export function moveIdByDelta(ids: string[], activeId: string, delta: number): string[] {
  const from = ids.indexOf(activeId);
  if (from === -1) return [...ids];
  return moveId(ids, activeId, from + delta);
}

/**
 * Reorders `monitors` to match `orderedIds`. Monitors missing from
 * `orderedIds` (e.g. created concurrently on another surface) are
 * appended in their original relative order so a reorder can never drop
 * data; ids in `orderedIds` with no matching monitor are ignored.
 */
export function applyOrder<T extends { id: string }>(monitors: T[], orderedIds: string[]): T[] {
  if (monitors.length === 0) return [];
  const byId = new Map(monitors.map((m) => [m.id, m] as const));
  const seen = new Set<string>();
  const next: T[] = [];
  for (const id of orderedIds) {
    const m = byId.get(id);
    if (m && !seen.has(id)) {
      seen.add(id);
      next.push(m);
    }
  }
  for (const m of monitors) {
    if (!seen.has(m.id)) next.push(m);
  }
  return next;
}

/**
 * Merges a reorder performed on a visible (possibly filtered) subset
 * back into the full global order.
 *
 * Visible items keep occupying the same *slots* they already held —
 * only which visible id sits in which slot changes. Non-visible items
 * never move. When nothing is filtered (`visibleOrderedIds` covers the
 * whole list) this degenerates to exactly `visibleOrderedIds`.
 *
 * Example: global [A,B,C,D], visible [B,D] reordered to [D,B] →
 * slots of {B,D} are indices [1,3], so global becomes [A,D,C,B].
 */
export function mergeVisibleOrder(globalIds: string[], visibleOrderedIds: string[]): string[] {
  const globalSet = new Set(globalIds);
  const knownVisible = visibleOrderedIds.filter((id) => globalSet.has(id));
  if (knownVisible.length === 0) return [...globalIds];
  const visibleSet = new Set(knownVisible);
  const slots: number[] = [];
  for (let i = 0; i < globalIds.length; i++) {
    if (visibleSet.has(globalIds[i]!)) slots.push(i);
  }
  // Lengths always match here (slots = positions of exactly these ids),
  // but guard anyway so a stale caller can never blank the list.
  if (slots.length !== knownVisible.length) {
    const placed = applyOrder(
      globalIds.map((id) => ({ id })),
      knownVisible,
    ).map((m) => m.id);
    void placed;
    return [...globalIds];
  }
  const next = [...globalIds];
  for (let k = 0; k < slots.length; k++) {
    next[slots[k]!] = knownVisible[k]!;
  }
  // Ids the caller reordered that we have never seen (shouldn't happen
  // — visible is always a subset of global) are appended rather than
  // dropped, so no reorder can lose a monitor.
  for (const id of visibleOrderedIds) {
    if (!globalSet.has(id) && !next.includes(id)) next.push(id);
  }
  return next;
}

export interface InsertionItem {
  id: string;
  rect: OrderRect;
}

/**
 * Predicts the insertion index for a pointer at (`pointerX`, `pointerY`)
 * over a 2-column grid whose non-dragged items are `items` (in their
 * current visual order, dragged item excluded).
 *
 * Returns an index in `0..items.length` — the position the dragged card
 * would occupy if dropped right now.
 *
 * How it stays predictable: the pointer first selects a *row* by Y
 * (above a row → its start, inside a row → X decides, in a gap/below →
 * the boundary, which is the same index from either side), then X picks
 * within that row by crossing item *centers* (left half → before,
 * right half → after). No distance-to-nearest heuristics, so small
 * pointer jitter near a center flips at most one slot and never jumps
 * across rows.
 */
export function computeInsertionIndex(
  pointerX: number,
  pointerY: number,
  items: InsertionItem[],
  gap = 8,
): number {
  if (items.length === 0) return 0;

  const ROW_TOLERANCE_PX = 4;
  const halfGap = gap / 2;

  interface Row {
    top: number;
    bottom: number;
    startIndex: number;
    items: InsertionItem[];
  }

  // Group into visual rows by `top` (grid aligns row tops exactly;
  // the tolerance only absorbs subpixel rounding).
  const rows: Row[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const last = rows[rows.length - 1];
    if (last && Math.abs(item.rect.top - last.top) <= ROW_TOLERANCE_PX) {
      last.items.push(item);
      last.bottom = Math.max(last.bottom, item.rect.bottom);
      last.top = Math.min(last.top, item.rect.top);
    } else {
      rows.push({
        top: item.rect.top,
        bottom: item.rect.bottom,
        startIndex: i,
        items: [item],
      });
    }
  }
  // Within a row, order left→right so X comparisons are positional,
  // not order-dependent.
  for (const row of rows) {
    row.items.sort((a, b) => a.rect.left - b.rect.left);
  }

  for (const row of rows) {
    // Pointer is above this row's band (or in the gap just above it):
    // insert at this row's start. This is the same index as the end of
    // the previous row, so gap positions are unambiguous.
    if (pointerY < row.top) {
      return row.startIndex;
    }
    if (pointerY <= row.bottom + halfGap) {
      // Inside the row's vertical band: X decides.
      if (pointerY > row.bottom) {
        // In the gap just below the row: end of this row.
        return row.startIndex + row.items.length;
      }
      const sorted = row.items;
      if (sorted.length === 1) {
        return pointerX < sorted[0]!.rect.centerX
          ? row.startIndex
          : row.startIndex + 1;
      }
      // Two columns (the grid never renders more): before the left
      // card, between the two, or after the right card — flipping only
      // when the pointer crosses a card's center.
      const left = sorted[0]!.rect;
      const right = sorted[1]!.rect;
      if (pointerX < left.centerX) return row.startIndex;
      if (pointerX < right.centerX) return row.startIndex + 1;
      return row.startIndex + 2;
    }
    // Pointer is below this row (beyond gap/2): keep scanning.
  }
  return items.length;
}

/** Equality on id sequences (used to skip no-op storage writes). */
export function sameIdOrder(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Clamped index helper for keyboard moves (exported for tests). */
export function clampMoveIndex(from: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return clampIndex(from + delta, length);
}
