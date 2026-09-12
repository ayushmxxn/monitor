import type { SemanticValueType } from "@/lib/monitors/semanticValue";
import type { MonitorCheck } from "@/lib/monitors/types";
import { playSound } from "@/lib/ui/sound";
import { cn } from "@/lib/utils";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";

interface HistoryChartProps {
  history: MonitorCheck[];
  /**
   * Called with the exact hovered reading while the user scrubs, and
   * with `null` when the pointer leaves (or the hovered reading goes
   * away), so the parent can show that reading live and fall back to
   * the latest otherwise. Always a real recorded point - never an
   * interpolated value.
   */
  onScrub?: (reading: ScrubbedReading | null) => void;
  range?: RangeKey;
  onRangeChange?: (range: RangeKey) => void;
}

/** One real recorded reading surfaced while scrubbing. */
export interface ScrubbedReading {
  raw: string;
  checkedAt: number;
}

export type RangeKey = "24h" | "7d" | "30d";

export interface RangeOption {
  key: RangeKey;
  label: string;
  ms: number;
  description: string;
}

export const RANGE_OPTIONS: RangeOption[] = [
  {
    key: "24h",
    label: "24H",
    ms: 24 * 60 * 60 * 1000,
    description: "past 24 hours",
  },
  {
    key: "7d",
    label: "7D",
    ms: 7 * 24 * 60 * 60 * 1000,
    description: "past 7 days",
  },
  {
    key: "30d",
    label: "30D",
    ms: 30 * 24 * 60 * 60 * 1000,
    description: "past 30 days",
  },
];

/** Below this many usable points a line reads as noise, not a trend - show the empty state instead. */
export const MIN_POINTS_TO_CHART = 3;

// SVG coordinate space. `chartWidth` (state, tracked live via
// ResizeObserver below) always matches the container's real pixel
// width 1:1 - the viewBox is sized to it directly rather than a fixed
// logical width stretched via `preserveAspectRatio="none"`. That
// distinction matters: a fixed logical width stretched to fit a
// panel that can be resized anywhere from 300px to 720px (see
// `MIN_WIDTH`/`MAX_WIDTH` in `components/panel/Panel.tsx`) scales X
// and Y independently, which quietly squashes or stretches every
// `<text>` glyph and the hover-point circle sideways - exactly the
// "cramped"/illegible axis text this component previously produced on
// a narrow panel. Keeping the viewBox 1:1 with real pixels means
// nothing inside the SVG is ever non-uniformly scaled, at any panel
// width. `CHART_H` stays fixed real pixels either way (set again as
// the `height` attribute), so vertical hover math is unaffected by
// this.
const DEFAULT_CHART_W = 300;
const MIN_CHART_W = 120;
const CHART_H = 180;
const PAD_TOP = 18;
const PAD_BOTTOM = 24;
const PAD_X = 10;
const PLOT_H = CHART_H - PAD_TOP - PAD_BOTTOM;

interface ChartPoint {
  x: number;
  y: number;
  checkedAt: number;
  raw: string;
}

export interface SplineSegment {
  p0: { x: number; y: number };
  p1: { x: number; y: number };
  c1: { x: number; y: number };
  c2: { x: number; y: number };
}

export interface SplineData {
  linePath: string;
  segments: SplineSegment[];
}

/**
 * Computes a smooth Fritsch-Carlson monotone cubic spline (`C`) and its
 * segment control points. Passes exactly through every input point preserving
 * exact recorded values while preventing overshoot or loops.
 */
export function computeSpline(points: { x: number; y: number }[]): SplineData {
  const n = points.length;
  if (n === 0) return { linePath: "", segments: [] };
  if (n === 1) {
    return {
      linePath: `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`,
      segments: [],
    };
  }
  if (n === 2) {
    return {
      linePath: `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)} L ${points[1].x.toFixed(2)} ${points[1].y.toFixed(2)}`,
      segments: [
        {
          p0: points[0],
          p1: points[1],
          c1: points[0],
          c2: points[1],
        },
      ],
    };
  }

  const dx: number[] = [];
  const dy: number[] = [];
  const slopes: number[] = [];

  for (let i = 0; i < n - 1; i++) {
    const deltax = points[i + 1].x - points[i].x;
    const deltay = points[i + 1].y - points[i].y;
    dx.push(deltax);
    dy.push(deltay);
    slopes.push(deltax === 0 ? 0 : deltay / deltax);
  }

  const m: number[] = new Array(n).fill(0);

  m[0] = slopes[0];
  m[n - 1] = slopes[n - 2];

  for (let i = 1; i < n - 1; i++) {
    if (slopes[i - 1] * slopes[i] <= 0) {
      m[i] = 0;
    } else {
      const hPrev = dx[i - 1];
      const hNext = dx[i];
      if (hPrev + hNext === 0) {
        m[i] = 0;
      } else {
        m[i] = (hPrev * slopes[i] + hNext * slopes[i - 1]) / (hPrev + hNext);
      }
    }
  }

  for (let i = 0; i < n - 1; i++) {
    if (slopes[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
    } else {
      const alpha = m[i] / slopes[i];
      const beta = m[i + 1] / slopes[i];
      if (alpha < 0) m[i] = 0;
      if (beta < 0) m[i + 1] = 0;
      const hyp = alpha * alpha + beta * beta;
      if (hyp > 9) {
        const tau = 3 / Math.sqrt(hyp);
        m[i] = tau * alpha * slopes[i];
        m[i + 1] = tau * beta * slopes[i];
      }
    }
  }

  const segments: SplineSegment[] = [];
  let d = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const deltax = dx[i];

    if (deltax === 0) {
      d += ` L ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`;
      segments.push({ p0, p1, c1: p0, c2: p1 });
      continue;
    }

    const c1x = p0.x + deltax / 3;
    const c1y = p0.y + (m[i] * deltax) / 3;
    const c2x = p1.x - deltax / 3;
    const c2y = p1.y - (m[i + 1] * deltax) / 3;

    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`;
    segments.push({
      p0,
      p1,
      c1: { x: c1x, y: c1y },
      c2: { x: c2x, y: c2y },
    });
  }

  return { linePath: d, segments };
}

/**
 * Builds an SVG path string that connects recorded observations using a smooth
 * Fritsch-Carlson monotone cubic spline (`C`).
 */
export function monotonePath(points: { x: number; y: number }[]): string {
  return computeSpline(points).linePath;
}

/**
 * Continuously evaluates the exact vertical position on the monotone cubic
 * spline curve for any horizontal position `targetX`.
 */
export function getYOnSpline(
  points: { x: number; y: number }[],
  segments: SplineSegment[],
  targetX: number,
): number {
  if (points.length === 0) return 0;
  if (points.length === 1) return points[0].y;

  const minX = points[0].x;
  const maxX = points[points.length - 1].x;
  const clampedX = Math.max(minX, Math.min(maxX, targetX));

  if (segments.length === 0) {
    const dx = points[points.length - 1].x - points[0].x;
    if (dx === 0) return points[0].y;
    const t = (clampedX - points[0].x) / dx;
    return points[0].y + t * (points[points.length - 1].y - points[0].y);
  }

  let seg = segments[segments.length - 1];
  for (let i = 0; i < segments.length; i++) {
    if (clampedX <= segments[i].p1.x || i === segments.length - 1) {
      seg = segments[i];
      break;
    }
  }

  const dx = seg.p1.x - seg.p0.x;
  if (dx <= 0) return seg.p1.y;

  const t = Math.max(0, Math.min(1, (clampedX - seg.p0.x) / dx));
  const mt = 1 - t;
  return (
    mt * mt * mt * seg.p0.y +
    3 * mt * mt * t * seg.c1.y +
    3 * mt * t * t * seg.c2.y +
    t * t * t * seg.p1.y
  );
}

/** Compact axis label, format chosen by how wide the visible range is. */
function formatTick(timestamp: number, range: RangeKey): string {
  const date = new Date(timestamp);
  if (range === "24h") {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric" }).format(date);
  }
  if (range === "7d") {
    return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(
      date,
    );
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
}

/** Overall direction of the visible range: first vs. last recorded value. Drives the line color. */
export type ChartTrend = "up" | "down" | "flat";

export type NumericCheck = MonitorCheck & {
  semanticValue: NonNullable<MonitorCheck["semanticValue"]>;
};

/** Restricts history to chronological, valid numeric checks of consistent semantic type. */
export function getChartablePoints(history: MonitorCheck[]): NumericCheck[] {
  const chronological = [...history].reverse();
  const numeric = chronological.filter(
    (entry): entry is NumericCheck =>
      entry.error === null &&
      entry.semanticValue !== null &&
      entry.semanticValue.normalized !== null &&
      Number.isFinite(entry.semanticValue.normalized),
  );
  if (numeric.length === 0) return [];
  const referenceType: SemanticValueType =
    numeric[numeric.length - 1].semanticValue.type;
  return numeric.filter((entry) => entry.semanticValue.type === referenceType);
}

/** Picks the narrowest range that still has at least two points to plot, defaulting to '30d' if sparse. */
export function pickDefaultRange(points: NumericCheck[]): RangeKey {
  const now = Date.now();
  for (const opt of RANGE_OPTIONS) {
    const count = points.filter((p) => now - p.checkedAt <= opt.ms).length;
    if (count >= 2) return opt.key;
  }
  return "30d";
}

/**
 * Index of the real recorded point nearest to a horizontal chart
 * position. Scrubbing always lands on an actual observation - values
 * are never interpolated between two readings. Ties keep the earlier
 * (leftmost) point so the result is deterministic.
 */
export function nearestPointIndex(
  points: { x: number }[],
  userX: number,
): number {
  let nearest = 0;
  let nearestDist = Infinity;
  points.forEach((p, i) => {
    const dist = Math.abs(p.x - userX);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = i;
    }
  });
  return nearest;
}

export const HistoryChart = memo(function HistoryChart({
  history,
  onScrub,
  range: propRange,
  onRangeChange,
}: HistoryChartProps) {
  const [hoverPos, setHoverPos] = useState<{
    x: number;
    y: number;
    index: number;
  } | null>(null);
  const lastAudioIndexRef = useRef<number | null>(null);

  // Tracks the chart container's real pixel width live, including
  // while the panel is being drag-resized (see `Panel.tsx`) - not just
  // at mount. A plain `useRef` + one-shot `useEffect` would miss both
  // that live resize and the transition from the "no data"/"not
  // enough points" early-return states (which don't render this
  // container at all) into the real chart once history arrives; a
  // callback ref sidesteps both by (re)attaching the observer whenever
  // the underlying DOM node itself changes.
  const [chartWidth, setChartWidth] = useState(DEFAULT_CHART_W);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const measureRef = useCallback((node: HTMLDivElement | null) => {
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    if (!node) return;
    if (node.clientWidth > 0) setChartWidth(node.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width && width > 0) {
        setChartWidth((prev) =>
          Math.abs(prev - width) < 1 ? prev : Math.round(width),
        );
      }
    });
    observer.observe(node);
    resizeObserverRef.current = observer;
  }, []);

  // Oldest -> newest, numeric-only, and restricted to the most recent
  // reading's semantic type - so a monitor that briefly extracted the
  // wrong text ("$49" one check, "87%" the next) never plots two
  // incomparable units on the same line.
  const allPoints = useMemo<NumericCheck[]>(
    () => getChartablePoints(history),
    [history],
  );

  const [internalRange, setInternalRange] = useState<RangeKey>(() =>
    pickDefaultRange(allPoints),
  );
  const range = propRange ?? internalRange;

  const handleRangeChange = useCallback(
    (newRange: RangeKey) => {
      setInternalRange(newRange);
      onRangeChange?.(newRange);
    },
    [onRangeChange],
  );

  const filtered = useMemo(() => {
    const opt = RANGE_OPTIONS.find((o) => o.key === range) ?? RANGE_OPTIONS[0];
    const cutoff = Date.now() - opt.ms;
    return allPoints.filter((entry) => entry.checkedAt >= cutoff);
  }, [allPoints, range]);

  const chartW = Math.max(chartWidth, MIN_CHART_W);

  const chart = useMemo(() => {
    if (filtered.length < 2) return null;

    const values = filtered.map((e) => e.semanticValue.normalized as number);
    const times = filtered.map((e) => e.checkedAt);
    let minV = Math.min(...values);
    let maxV = Math.max(...values);
    if (minV === maxV) {
      // Flat series - open up headroom so the line doesn't hug an edge.
      minV -= Math.abs(minV) * 0.1 || 1;
      maxV += Math.abs(maxV) * 0.1 || 1;
    } else {
      const headroom = (maxV - minV) * 0.15;
      minV -= headroom;
      maxV += headroom;
    }

    const minT = times[0];
    const maxT = times[times.length - 1];
    const spanT = maxT - minT || 1;

    const points: ChartPoint[] = filtered.map((entry) => {
      const t = entry.checkedAt;
      const v = entry.semanticValue.normalized as number;
      const x = PAD_X + ((t - minT) / spanT) * (chartW - PAD_X * 2);
      const y = PAD_TOP + (1 - (v - minV) / (maxV - minV)) * PLOT_H;
      return { x, y, checkedAt: t, raw: entry.value ?? "" };
    });

    const { linePath, segments } = computeSpline(points);

    const firstV = values[0];
    const lastV = values[values.length - 1];
    const trend: ChartTrend =
      lastV > firstV ? "up" : lastV < firstV ? "down" : "flat";

    const tickCount = 3;
    const ticks = Array.from({ length: tickCount }, (_, i) => {
      const frac = i / (tickCount - 1);
      return {
        x: PAD_X + frac * (chartW - PAD_X * 2),
        label: formatTick(minT + frac * spanT, range),
      };
    });

    return { points, linePath, segments, ticks, trend };
  }, [filtered, range, chartW]);

  function handleMove(event: MouseEvent<SVGSVGElement>) {
    if (!chart) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const userX = ((event.clientX - rect.left) / rect.width) * chartW;
    const minX = chart.points[0].x;
    const maxX = chart.points[chart.points.length - 1].x;
    const clampedX = Math.max(minX, Math.min(maxX, userX));
    const y = getYOnSpline(chart.points, chart.segments, clampedX);
    const index = nearestPointIndex(chart.points, userX);
    if (index !== lastAudioIndexRef.current) {
      lastAudioIndexRef.current = index;
      const at = Math.max(
        0,
        Math.min(1, 1 - (chart.points[index].y - PAD_TOP) / PLOT_H),
      );
      playSound("drag", { at, gap: 60 });
    }
    setHoverPos({ x: clampedX, y, index });
  }

  function handleLeave() {
    lastAudioIndexRef.current = null;
    setHoverPos(null);
  }

  const scrubbed =
    hoverPos !== null ? (chart?.points[hoverPos.index] ?? null) : null;

  // Surface the exact hovered reading to the parent (which shows it
  // live in the value header) and report `null` when the pointer
  // leaves or the reading goes away, so the header falls back to the
  // latest. `scrubbed` is always a real recorded point or null.
  useEffect(() => {
    onScrub?.(
      scrubbed ? { raw: scrubbed.raw, checkedAt: scrubbed.checkedAt } : null,
    );
  }, [scrubbed, onScrub]);
  // The marker ring sits at the newest reading at rest; while the user
  // scrubs, it follows continuously along the trend line with the cursor.
  // Only one marker ring exists at any time.
  const latest =
    chart && hoverPos === null ? chart.points[chart.points.length - 1] : null;
  // Line + rings follow the visible range's overall direction, using the
  // same up/down register as the value-change text elsewhere in the UI.
  const trendStrokeClass =
    chart?.trend === "up"
      ? "stroke-emerald-600 dark:stroke-emerald-400"
      : chart?.trend === "down"
        ? "stroke-red-700 dark:stroke-red-400"
        : "stroke-foreground/70";

  if (history.length === 0) {
    return (
      <p className="py-6 text-center text-[11.5px] text-muted-foreground">
        No checks yet. History appears here once this monitor runs.
      </p>
    );
  }

  if (allPoints.length < MIN_POINTS_TO_CHART) {
    return (
      <div className="flex flex-col items-center gap-1 py-7 text-center">
        <p className="text-[11.5px] text-muted-foreground">
          Not enough numeric readings yet to chart.
        </p>
        <p className="text-[10.5px] text-muted-foreground/70">
          A trend line appears after a few more checks.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div ref={measureRef} className="relative overflow-hidden">
        {!chart ? (
          <div
            className="flex items-center justify-center"
            style={{ height: CHART_H }}
          >
            <p className="text-[11px] text-muted-foreground">
              No data in this range
            </p>
          </div>
        ) : (
          <div key={range} className="relative">
            <svg
              viewBox={`0 0 ${chartW} ${CHART_H}`}
              width="100%"
              height={CHART_H}
              className="block"
              role="img"
              aria-label="Value history chart"
              onMouseMove={handleMove}
              onMouseLeave={handleLeave}
            >
              <path
                d={chart.linePath}
                fill="none"
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                pathLength={1}
                className={cn("animate-chart-line", trendStrokeClass)}
              />

              {latest && (
                <circle
                  cx={latest.x}
                  cy={latest.y}
                  r={5.5}
                  fill="hsl(var(--background))"
                  strokeWidth={2.5}
                  data-testid="history-chart-latest"
                  className={trendStrokeClass}
                />
              )}

              {hoverPos && (
                <g
                  className="pointer-events-none"
                  data-testid="history-chart-guide"
                >
                  <line
                    x1={hoverPos.x}
                    x2={hoverPos.x}
                    y1={PAD_TOP}
                    y2={PAD_TOP + PLOT_H}
                    strokeOpacity={0.45}
                    strokeWidth={1}
                    className={trendStrokeClass}
                  />
                  <circle
                    cx={hoverPos.x}
                    cy={hoverPos.y}
                    r={5.5}
                    fill="hsl(var(--background))"
                    strokeWidth={2.5}
                    className={trendStrokeClass}
                  />
                </g>
              )}

              {chart.ticks.map((tick, i) => (
                <text
                  key={i}
                  x={tick.x}
                  y={CHART_H - 6}
                  textAnchor={
                    i === 0
                      ? "start"
                      : i === chart.ticks.length - 1
                        ? "end"
                        : "middle"
                  }
                  className="animate-chart-fade fill-muted-foreground tabular-nums"
                  style={{ fontSize: 9.5 }}
                >
                  {tick.label}
                </text>
              ))}
            </svg>
          </div>
        )}
      </div>

      <div className="mt-2 flex items-center justify-end px-2.5">
        <div
          role="group"
          aria-label="Time range"
          className="inline-flex items-center gap-0.5 rounded-lg border border-black/[0.04] bg-muted/60 p-0.5 dark:border-white/[0.06]"
        >
          {RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              type="button"
              // Switching range re-cuts the visible points, so any
              // in-flight scrub is dropped and the header falls back
              // to the latest reading.
              onClick={() => {
                handleRangeChange(opt.key);
                setHoverPos(null);
              }}
              aria-pressed={range === opt.key}
              className={cn(
                "rounded-md px-2.5 py-0.5 text-[11px] tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                range === opt.key
                  ? "bg-background font-semibold text-foreground shadow-xs"
                  : "font-normal text-muted-foreground hover:text-foreground",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
});
