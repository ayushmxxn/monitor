import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { EmptyState } from '@/components/layout/EmptyState';
import { MonitorCard } from './MonitorCard';
import type { Monitor } from '@/lib/monitors/types';
import {
  applyOrder,
  computeInsertionIndex,
  moveId,
  sameIdOrder,
  toOrderRect,
  type InsertionItem,
} from '@/lib/monitors/order';

interface MonitorListProps {
  monitors: Monitor[];
  onDelete: (id: string) => Promise<boolean>;
  onOpen: (id: string) => void;
  emptyAction?: React.ReactNode;
  /**
   * Called with the new visible order (ids) after a drop or keyboard
   * move. The caller persists it (see Panel's filtered→global merge);
   * resolving `false` rolls the UI back to the prop order.
   */
  onReorder?: (orderedIds: string[]) => Promise<boolean> | boolean | void;
}

const DRAG_THRESHOLD_PX = 6;
const TOUCH_HOLD_MS = 250;
const TOUCH_SLOP_PX = 10;
const FLIP_MS = 150;
const FLIP_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';
const GRID_GAP_PX = 8;

interface DragState {
  activeId: string;
  /** Full visible order including the active id at `insertionIndex`. */
  orderedIds: string[];
  insertionIndex: number;
  activeLeft: number;
  activeTop: number;
  activeWidth: number;
  activeHeight: number;
}

interface DragSession {
  activeId: string;
  pointerId: number;
  pointerType: string;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  hasStarted: boolean;
  cancelled: boolean;
  longPressTimer: ReturnType<typeof setTimeout> | null;
  rafId: number | null;
  onMove: ((e: PointerEvent) => void) | null;
  onUp: ((e: PointerEvent) => void) | null;
  onCancel: ((e: PointerEvent) => void) | null;
  onKey: ((e: KeyboardEvent) => void) | null;
}

function isNoDragTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return !!target.closest('[data-no-drag], a, input, select, textarea, [role="dialog"]');
}

function prefersReducedMotion(): boolean {
  try {
    return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** The panel's home screen: monitors as a two-column bento grid rather than a list, so every value is visible without scrolling through rows of text. */
export function MonitorList({ monitors, onDelete, onOpen, emptyAction, onReorder }: MonitorListProps) {
  const [optimisticIds, setOptimisticIds] = useState<string[] | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const containerRef = useRef<HTMLDivElement | null>(null);
  const itemEls = useRef(new Map<string, HTMLDivElement>());
  const floatingEl = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<DragSession | null>(null);
  const prevRectsRef = useRef<Map<string, DOMRect> | null>(null);
  const suppressClickRef = useRef(false);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;

  const monitorById = useMemo(() => new Map(monitors.map((m) => [m.id, m] as const)), [monitors]);
  const baseIds = useMemo(() => monitors.map((m) => m.id), [monitors]);

  // Latest-values refs so the single-drag window listeners (created once
  // at pointer-down and removed at pointer-up) never go stale across
  // re-renders mid-drag.
  const effectiveIdsRef = useRef<string[]>([]);
  const monitorByIdRef = useRef(monitorById);
  const onReorderRef = useRef(onReorder);
  monitorByIdRef.current = monitorById;
  onReorderRef.current = onReorder;

  // Optimistic order applied over the latest prop objects, so live value
  // updates still flow through while a just-dropped order awaits the
  // storage round-trip. New arrivals append; deletions drop out.
  const effectiveMonitors = useMemo(() => {
    if (!optimisticIds) return monitors;
    return applyOrder(monitors, optimisticIds);
  }, [monitors, optimisticIds]);
  const effectiveIds = useMemo(() => effectiveMonitors.map((m) => m.id), [effectiveMonitors]);
  effectiveIdsRef.current = effectiveIds;

  // Storage caught up (or nothing pending): drop the optimistic overlay
  // so the prop order is authoritative again.
  useEffect(() => {
    if (!optimisticIds) return;
    if (sameIdOrder(baseIds, optimisticIds)) {
      setOptimisticIds(null);
      return;
    }
    const baseSet = new Set(baseIds);
    const optimisticSet = new Set(optimisticIds);
    let setsEqual = baseSet.size === optimisticSet.size;
    if (setsEqual) {
      for (const id of baseSet) {
        if (!optimisticSet.has(id)) {
          setsEqual = false;
          break;
        }
      }
    }
    if (!setsEqual) {
      // External add/remove while a reorder was pending: keep our
      // committed order, splicing arrivals in at the end.
      const merged = applyOrder(monitors, optimisticIds);
      setOptimisticIds(merged.map((m) => m.id));
    }
  }, [baseIds, monitors, optimisticIds]);

  // If the actively dragged monitor disappears mid-drag, bail out rather
  // than dropping a stale order.
  useEffect(() => {
    if (drag && !monitorById.has(drag.activeId)) {
      cancelDragVisual();
      cleanupSession();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, monitorById]);

  const handleOpen = useCallback(
    (id: string) => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      onOpen(id);
    },
    [onOpen],
  );

  function setItemRef(id: string) {
    return (el: HTMLDivElement | null) => {
      if (el) itemEls.current.set(id, el);
      else itemEls.current.delete(id);
    };
  }

  function capturePrevRects(excludeId: string): Map<string, DOMRect> {
    const map = new Map<string, DOMRect>();
    for (const [id, el] of itemEls.current) {
      if (id === excludeId) continue;
      try {
        map.set(id, el.getBoundingClientRect());
      } catch {
        // Ignore measurement failures; that item just won't animate.
      }
    }
    return map;
  }

  function readFlowItems(excludeId: string, order: string[]): InsertionItem[] {
    const items: InsertionItem[] = [];
    for (const id of order) {
      if (id === excludeId) continue;
      const el = itemEls.current.get(id);
      if (!el) continue;
      try {
        const r = el.getBoundingClientRect();
        items.push({
          id,
          rect: toOrderRect({
            left: r.left,
            top: r.top,
            right: r.right,
            bottom: r.bottom,
            width: r.width,
            height: r.height,
          }),
        });
      } catch {
        // Skip unmeasurable items.
      }
    }
    return items;
  }

  function updateFloatingTransform(dx: number, dy: number) {
    const el = floatingEl.current;
    if (el) {
      el.style.transform = `translate(${dx}px, ${dy}px) scale(1.02)`;
    }
  }

  function restoreBody() {
    try {
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      (document.body.style as CSSStyleDeclaration & { touchAction?: string }).touchAction = '';
    } catch {
      // Ignore (unmounted / non-DOM test env).
    }
  }

  function clearItemTransforms() {
    for (const el of itemEls.current.values()) {
      try {
        el.style.transition = '';
        el.style.transform = '';
      } catch {
        // Ignore.
      }
    }
  }

  function cleanupSession() {
    const s = sessionRef.current;
    if (s?.longPressTimer) {
      clearTimeout(s.longPressTimer);
      s.longPressTimer = null;
    }
    if (s?.rafId != null) {
      try {
        cancelAnimationFrame(s.rafId);
      } catch {
        // Ignore.
      }
      s.rafId = null;
    }
    // Remove the exact listener instances registered for this drag
    // session (they were created at pointer-down, so identity is stable
    // even though the component re-rendered mid-drag).
    try {
      if (s?.onMove) window.removeEventListener('pointermove', s.onMove);
      if (s?.onUp) window.removeEventListener('pointerup', s.onUp);
      if (s?.onCancel) window.removeEventListener('pointercancel', s.onCancel);
      if (s?.onKey) window.removeEventListener('keydown', s.onKey, true);
    } catch {
      // Ignore.
    }
    sessionRef.current = null;
    restoreBody();
  }

  function cancelDragVisual() {
    prevRectsRef.current = null;
    setDrag(null);
    clearItemTransforms();
  }

  function startDrag(session: DragSession) {
    if (session.hasStarted || session.cancelled) return;
    const current = dragRef.current;
    if (current) return;
    const activeEl = itemEls.current.get(session.activeId);
    if (!activeEl) {
      cleanupSession();
      return;
    }
    let rect: DOMRect;
    try {
      rect = activeEl.getBoundingClientRect();
    } catch {
      cleanupSession();
      return;
    }
    if (rect.width === 0 && rect.height === 0) {
      cleanupSession();
      return;
    }
    session.hasStarted = true;
    const latestIds = effectiveIdsRef.current;
    const order = latestIds.includes(session.activeId) ? [...latestIds] : [...latestIds];
    const insertionIndex = order.indexOf(session.activeId);
    prevRectsRef.current = null;
    setDrag({
      activeId: session.activeId,
      orderedIds: order,
      insertionIndex: insertionIndex === -1 ? 0 : insertionIndex,
      activeLeft: rect.left,
      activeTop: rect.top,
      activeWidth: rect.width,
      activeHeight: rect.height,
    });
    try {
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'grabbing';
      (document.body.style as CSSStyleDeclaration & { touchAction?: string }).touchAction = 'none';
    } catch {
      // Ignore.
    }
    const dx = session.lastX - session.startX;
    const dy = session.lastY - session.startY;
    requestAnimationFrame(() => updateFloatingTransform(dx, dy));
  }

  function scheduleInsertionCompute() {
    const s = sessionRef.current;
    if (!s || !s.hasStarted || s.cancelled || s.rafId != null) return;
    s.rafId = requestAnimationFrame(() => {
      if (sessionRef.current) sessionRef.current.rafId = null;
      const d = dragRef.current;
      const sess = sessionRef.current;
      if (!d || !sess || sess.cancelled) return;
      const dx = sess.lastX - sess.startX;
      const dy = sess.lastY - sess.startY;
      updateFloatingTransform(dx, dy);
      const flow = readFlowItems(d.activeId, d.orderedIds);
      // No measurable siblings (single card): nothing to reorder.
      if (flow.length === 0) return;
      const nextIndex = computeInsertionIndex(sess.lastX, sess.lastY, flow, GRID_GAP_PX);
      if (nextIndex === d.insertionIndex) return;
      prevRectsRef.current = capturePrevRects(d.activeId);
      setDrag({
        ...d,
        orderedIds: moveId(d.orderedIds, d.activeId, nextIndex),
        insertionIndex: nextIndex,
      });
    });
  }

  function finishDrop(commit: boolean) {
    const d = dragRef.current;
    const sess = sessionRef.current;
    const activeId = d?.activeId ?? sess?.activeId;
    const finalIds = d?.orderedIds;
    const latestIds = effectiveIdsRef.current;
    const moved = !!d && !!finalIds && !sameIdOrder(finalIds, latestIds);
    // Always suppress the click that the pointer-up would otherwise
    // synthesize on the card's open button — a drag is not a tap, even
    // when it ends back where it started.
    if (d) {
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 250);
    }
    prevRectsRef.current = null;
    setDrag(null);
    clearItemTransforms();
    cleanupSession();
    if (!commit || !d || !finalIds || !activeId) return;
    if (!moved) return;
    // Optimistic snap: render the dropped order immediately; the
    // effect above clears it once storage echoes back.
    setOptimisticIds([...finalIds]);
    const pos = finalIds.indexOf(activeId) + 1;
    const name = monitorByIdRef.current.get(activeId)?.name ?? 'Monitor';
    setAnnouncement(`${name} moved to position ${pos} of ${finalIds.length}.`);
    try {
      const result = onReorderRef.current?.([...finalIds]);
      if (result && typeof (result as Promise<boolean>).then === 'function') {
        void (result as Promise<boolean>).then((ok) => {
          if (ok === false) setOptimisticIds(null);
        });
      }
    } catch {
      setOptimisticIds(null);
    }
  }

  function handleWindowMove(e: PointerEvent) {
    const s = sessionRef.current;
    if (!s || e.pointerId !== s.pointerId) return;
    s.lastX = e.clientX;
    s.lastY = e.clientY;
    if (s.cancelled) return;
    if (!s.hasStarted) {
      const dx = e.clientX - s.startX;
      const dy = e.clientY - s.startY;
      const dist = Math.hypot(dx, dy);
      if (s.pointerType === 'touch') {
        // Pre-hold movement means a scroll, not a drag: stand down so
        // the panel keeps scrolling naturally.
        if (dist > TOUCH_SLOP_PX) {
          s.cancelled = true;
          if (s.longPressTimer) {
            clearTimeout(s.longPressTimer);
            s.longPressTimer = null;
          }
        }
        return;
      }
      if (dist > DRAG_THRESHOLD_PX) startDrag(s);
      return;
    }
    scheduleInsertionCompute();
  }

  function handleWindowUp(e: PointerEvent) {
    const s = sessionRef.current;
    if (!s || e.pointerId !== s.pointerId) return;
    if (!s.hasStarted || s.cancelled) {
      cleanupSession();
      return;
    }
    s.lastX = e.clientX;
    s.lastY = e.clientY;
    // Flush one last insertion compute synchronously so the drop uses
    // the pointer's final position, not the last rAF tick's.
    const d = dragRef.current;
    if (d && !prefersReducedMotion()) {
      try {
        const flow = readFlowItems(d.activeId, d.orderedIds);
        if (flow.length > 0) {
          const nextIndex = computeInsertionIndex(e.clientX, e.clientY, flow, GRID_GAP_PX);
          if (nextIndex !== d.insertionIndex) {
            const finalIds = moveId(d.orderedIds, d.activeId, nextIndex);
            suppressClickRef.current = true;
            window.setTimeout(() => {
              suppressClickRef.current = false;
            }, 250);
            setDrag(null);
            clearItemTransforms();
            cleanupSession();
            if (!sameIdOrder(finalIds, effectiveIdsRef.current)) {
              setOptimisticIds([...finalIds]);
              const pos = finalIds.indexOf(d.activeId) + 1;
              const name = monitorByIdRef.current.get(d.activeId)?.name ?? 'Monitor';
              setAnnouncement(`${name} moved to position ${pos} of ${finalIds.length}.`);
              try {
                const result = onReorderRef.current?.([...finalIds]);
                if (result && typeof (result as Promise<boolean>).then === 'function') {
                  void (result as Promise<boolean>).then((ok) => {
                    if (ok === false) setOptimisticIds(null);
                  });
                }
              } catch {
                setOptimisticIds(null);
              }
            }
            return;
          }
        }
      } catch {
        // Fall through to the standard drop path.
      }
    }
    finishDrop(true);
  }

  function handleWindowCancel(e: PointerEvent) {
    const s = sessionRef.current;
    if (!s || e.pointerId !== s.pointerId) return;
    // Touch scroll stole the gesture (or the OS cancelled it): revert,
    // don't persist, don't suppress — there is no click coming.
    prevRectsRef.current = null;
    setDrag(null);
    clearItemTransforms();
    cleanupSession();
  }

  function handleWindowKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && sessionRef.current?.hasStarted) {
      e.preventDefault();
      e.stopPropagation();
      // Cancel: revert to the pre-drag order. Mark cancelled so the
      // eventual pointer-up becomes a no-op instead of a drop.
      if (sessionRef.current) sessionRef.current.cancelled = true;
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 250);
      prevRectsRef.current = null;
      setDrag(null);
      clearItemTransforms();
    }
  }

  // FLIP: animate non-dragged cards from their pre-reorder rect to the
  // new one. Fast (150ms) ease-out, no bounce — just enough to read as
  // movement rather than a jump. Skipped under reduced motion (snap).
  useLayoutEffect(() => {
    if (!drag) return;
    const prev = prevRectsRef.current;
    prevRectsRef.current = null;
    if (!prev || prev.size === 0) return;
    if (prefersReducedMotion()) return;
    for (const [id, el] of itemEls.current) {
      if (id === drag.activeId) continue;
      const old = prev.get(id);
      if (!old) continue;
      let now: DOMRect;
      try {
        now = el.getBoundingClientRect();
      } catch {
        continue;
      }
      const dx = old.left - now.left;
      const dy = old.top - now.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      try {
        el.style.transition = 'none';
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        void el.offsetWidth;
        el.style.transition = `transform ${FLIP_MS}ms ${FLIP_EASING}`;
        el.style.transform = '';
      } catch {
        // Ignore; the card still ends up in the right place.
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.orderedIds]);

  // Floating card follows the pointer without transition (predictable,
  // no lag); only its lift (scale + subtle shadow) is constant.
  useLayoutEffect(() => {
    if (!drag) return;
    const s = sessionRef.current;
    if (s) {
      updateFloatingTransform(s.lastX - s.startX, s.lastY - s.startY);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.activeId]);

  useEffect(() => {
    return () => {
      const s = sessionRef.current;
      if (s?.longPressTimer) clearTimeout(s.longPressTimer);
      if (s?.rafId != null) {
        try {
          cancelAnimationFrame(s.rafId);
        } catch {
          // Ignore.
        }
      }
      restoreBody();
    };
  }, []);

  function handleItemPointerDown(id: string) {
    return (e: React.PointerEvent<HTMLDivElement>) => {
      if (sessionRef.current) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (isNoDragTarget(e.target)) return;
      if (effectiveIdsRef.current.length <= 1) return;
      const session: DragSession = {
        activeId: id,
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        hasStarted: false,
        cancelled: false,
        longPressTimer: null,
        rafId: null,
        onMove: null,
        onUp: null,
        onCancel: null,
        onKey: null,
      };
      // Per-session listener instances so removal matches exactly even
      // after mid-drag re-renders (component-scope functions would be
      // new identities each render and leak).
      session.onMove = (ev: PointerEvent) => handleWindowMove(ev);
      session.onUp = (ev: PointerEvent) => handleWindowUp(ev);
      session.onCancel = (ev: PointerEvent) => handleWindowCancel(ev);
      session.onKey = (ev: KeyboardEvent) => handleWindowKey(ev);
      sessionRef.current = session;
      try {
        if (session.onMove) window.addEventListener('pointermove', session.onMove);
        if (session.onUp) window.addEventListener('pointerup', session.onUp);
        if (session.onCancel) window.addEventListener('pointercancel', session.onCancel);
        if (session.onKey) window.addEventListener('keydown', session.onKey, true);
      } catch {
        sessionRef.current = null;
        return;
      }
      if (e.pointerType === 'touch') {
        // Long-press to drag on touch so plain scrolls keep working:
        // movement before the hold cancels (it's a scroll).
        session.longPressTimer = setTimeout(() => {
          const s = sessionRef.current;
          if (!s || s.cancelled || s.hasStarted) return;
          s.longPressTimer = null;
          startDrag(s);
        }, TOUCH_HOLD_MS);
      }
    };
  }

  function handleItemKeyDown(id: string) {
    return (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const latestIds = effectiveIdsRef.current;
      const order = dragRef.current?.orderedIds ?? latestIds;
      const from = order.indexOf(id);
      if (from === -1) return;
      let delta: number | null = null;
      let edge: number | null = null;
      if (e.key === 'ArrowLeft') delta = -1;
      else if (e.key === 'ArrowRight') delta = 1;
      else if (e.key === 'ArrowUp') delta = -2;
      else if (e.key === 'ArrowDown') delta = 2;
      else if (e.key === 'Home') edge = 0;
      else if (e.key === 'End') edge = order.length - 1;
      else return;
      e.preventDefault();
      e.stopPropagation();
      if (dragRef.current) return;
      const next = edge != null ? moveId(order, id, edge) : moveId(order, id, from + (delta ?? 0));
      if (sameIdOrder(next, order)) return;
      suppressClickRef.current = false;
      setOptimisticIds([...next]);
      const pos = next.indexOf(id) + 1;
      const name = monitorByIdRef.current.get(id)?.name ?? 'Monitor';
      setAnnouncement(`${name} moved to position ${pos} of ${next.length}.`);
      try {
        const result = onReorderRef.current?.([...next]);
        if (result && typeof (result as Promise<boolean>).then === 'function') {
          void (result as Promise<boolean>).then((ok) => {
            if (ok === false) setOptimisticIds(null);
          });
        }
      } catch {
        setOptimisticIds(null);
      }
    };
  }

  if (monitors.length === 0) {
    return (
      <EmptyState
        icon={
          // `browser.runtime.getURL`, not a bare "/icon/128.png" - this
          // renders inside the panel's content-script shadow root,
          // injected onto an arbitrary page, so a root-relative path
          // would resolve against *that page's* origin (a broken
          // image) rather than the extension's.
          <img
            src={browser.runtime.getURL('/icon/128.png')}
            alt=""
            className="h-11 w-11"
          />
        }
        title="No monitors yet"
        description="Add a monitor to start watching a value on any website. Everything stays on this device."
        action={emptyAction}
      />
    );
  }

  const isDragging = drag != null;
  const renderIds = drag ? drag.orderedIds : effectiveIds;
  const activeMonitor = drag ? (monitorById.get(drag.activeId) ?? null) : null;

  return (
    <>
      <div
        ref={containerRef}
        className="grid grid-cols-2 gap-2"
        data-monitor-grid
      >
        {renderIds.map((id, index) => {
          const monitor = monitorById.get(id) ?? effectiveMonitors.find((m) => m.id === id);
          if (!monitor) return null;
          if (drag && id === drag.activeId) {
            // Insertion placeholder: same footprint as the dragged card
            // (measured height), dashed + muted — clearly a gap, never a
            // card, no pulse or bounce.
            return (
              <div
                key={id}
                aria-hidden
                data-placeholder-for={id}
                className="min-w-0 rounded-lg border border-dashed border-border bg-muted/40"
                style={{ height: drag.activeHeight || undefined }}
              />
            );
          }
          return (
            <div
              key={monitor.id}
              ref={setItemRef(monitor.id)}
              data-drag-id={monitor.id}
              onPointerDown={handleItemPointerDown(monitor.id)}
              onKeyDown={handleItemKeyDown(monitor.id)}
              // `min-w-0` overrides the grid item's default automatic
              // minimum width, which is otherwise based on its content's
              // min-content size. MonitorCard's value uses `truncate`
              // (white-space: nowrap + ellipsis), and nowrap text's
              // min-content is its full, unwrapped width - without this,
              // a long value (e.g. "340k subscribers") forces this grid
              // item wider than its column to fit that full width, so the
              // card overflows the panel instead of the text inside it
              // ellipsizing. This is what actually lets `truncate` take
              // effect rather than just clipping.
              //
              // `touch-pan-y` keeps vertical panel scrolling alive on
              // touch while a horizontal intent still reaches the
              // pointer handlers; once a touch drag actually starts the
              // body is locked to `touch-action: none` until drop.
              className="animate-enter-up min-w-0 touch-pan-y"
              style={{
                animationDelay: `${Math.min(index, 8) * 25}ms`,
                cursor: isDragging ? 'inherit' : undefined,
              }}
            >
              <MonitorCard monitor={monitor} onDelete={onDelete} onOpen={handleOpen} />
            </div>
          );
        })}
      </div>

      {/* Floating dragged card: the real card, lifted out of flow to
          follow the pointer. Slight scale + one subtle shadow layer —
          elevation without flash. `pointer-events: none` so insertion
          math always sees the grid underneath, never the floater. */}
      {drag && activeMonitor && (
        <div
          ref={floatingEl}
          aria-hidden
          className="pointer-events-none fixed z-50 min-w-0 rounded-lg shadow-md"
          style={{
            left: drag.activeLeft,
            top: drag.activeTop,
            width: drag.activeWidth,
            height: drag.activeHeight,
            transform: 'translate(0px, 0px) scale(1.02)',
          }}
        >
          <div className="h-full w-full overflow-hidden rounded-lg">
            <MonitorCard monitor={activeMonitor} onDelete={onDelete} onOpen={() => {}} />
          </div>
        </div>
      )}

      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </>
  );
}
