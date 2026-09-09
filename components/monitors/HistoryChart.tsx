import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { SemanticValueType } from '@/lib/monitors/semanticValue';
import type { MonitorCheck } from '@/lib/monitors/types';
import { calculateValueChange } from '@/lib/monitors/changeSummary';

interface HistoryChartProps {
  history: MonitorCheck[];
}

type RangeKey = '24h' | '7d' | '30d' | 'all';

const RANGE_OPTIONS: { key: RangeKey; label: string; ms: number | null }[] = [
  { key: '24h', label: '24H', ms: 24 * 60 * 60 * 1000 },
  { key: '7d', label: '7D', ms: 7 * 24 * 60 * 60 * 1000 },
  { key: '30d', label: '30D', ms: 30 * 24 * 60 * 60 * 1000 },
  { key: 'all', label: 'All', ms: null },
];

/** Below this many usable points a line reads as noise, not a trend - show the empty state instead. */
const MIN_POINTS_TO_CHART = 3;

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
// the `height` attribute), so vertical hover math and tooltip
// placement are unaffected by this.
const DEFAULT_CHART_W = 300;
const MIN_CHART_W = 120;
const CHART_H = 168;
const PAD_TOP = 18;
const PAD_BOTTOM = 24;
const PAD_X = 10;
const PLOT_H = CHART_H - PAD_TOP - PAD_BOTTOM;
/** Minimum gap kept between the tooltip and the chart's own edges, so it's never flush against - let alone past - the panel's border. */
const TOOLTIP_EDGE_GAP = 6;
/** Minimum gap kept between the tooltip and the hovered point itself. */
const TOOLTIP_POINT_GAP = 10;

function clampNum(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

interface ChartPoint {
  x: number;
  y: number;
  checkedAt: number;
  raw: string;
  changeSummary?: string | null;
}

/**
 * Builds an SVG path string that connects recorded observations using straight
 * line segments (`L`). No bezier curves, splines, or smoothing are used,
 * ensuring every segment directly represents recorded values.
 */
export function monotonePath(points: { x: number; y: number }[]): string {
  const n = points.length;
  if (n === 0) return '';
  let d = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let i = 1; i < n; i++) {
    d += ` L ${points[i].x.toFixed(2)} ${points[i].y.toFixed(2)}`;
  }
  return d;
}

/** Compact axis label, format chosen by how wide the visible range is. */
function formatTick(timestamp: number, range: RangeKey): string {
  const date = new Date(timestamp);
  if (range === '24h') {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).format(date);
  }
  if (range === '7d') {
    return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

type NumericCheck = MonitorCheck & { semanticValue: NonNullable<MonitorCheck['semanticValue']> };

/** Picks the narrowest range that still has at least two points to plot, so the chart opens showing a real trend rather than a flat "All". */
function pickDefaultRange(points: NumericCheck[]): RangeKey {
  const now = Date.now();
  for (const opt of RANGE_OPTIONS) {
    if (opt.ms === null) continue;
    const count = points.filter((p) => now - p.checkedAt <= opt.ms!).length;
    if (count >= 2) return opt.key;
  }
  return 'all';
}

export const HistoryChart = memo(function HistoryChart({ history }: HistoryChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

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
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width && width > 0) {
        setChartWidth((prev) => (Math.abs(prev - width) < 1 ? prev : Math.round(width)));
      }
    });
    observer.observe(node);
    resizeObserverRef.current = observer;
  }, []);

  // Oldest -> newest, numeric-only, and restricted to the most recent
  // reading's semantic type - so a monitor that briefly extracted the
  // wrong text ("$49" one check, "87%" the next) never plots two
  // incomparable units on the same line.
  const allPoints = useMemo<NumericCheck[]>(() => {
    const chronological = [...history].reverse();
    const numeric = chronological.filter(
      (entry): entry is NumericCheck =>
        entry.error === null &&
        entry.semanticValue !== null &&
        entry.semanticValue.normalized !== null &&
        Number.isFinite(entry.semanticValue.normalized),
    );
    if (numeric.length === 0) return [];
    const referenceType: SemanticValueType = numeric[numeric.length - 1].semanticValue.type;
    return numeric.filter((entry) => entry.semanticValue.type === referenceType);
  }, [history]);

  const [range, setRange] = useState<RangeKey>(() => pickDefaultRange(allPoints));

  const filtered = useMemo(() => {
    const opt = RANGE_OPTIONS.find((o) => o.key === range)!;
    if (opt.ms === null) return allPoints;
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

    const points: ChartPoint[] = filtered.map((entry, idx) => {
      const t = entry.checkedAt;
      const v = entry.semanticValue.normalized as number;
      const x = PAD_X + ((t - minT) / spanT) * (chartW - PAD_X * 2);
      const y = PAD_TOP + (1 - (v - minV) / (maxV - minV)) * PLOT_H;

      let changeSummary: string | null = null;
      if (idx > 0) {
        const prevEntry = filtered[idx - 1];
        const change = calculateValueChange(
          prevEntry.value,
          prevEntry.semanticValue,
          entry.value ?? '',
          entry.semanticValue,
        );
        if (change.hasChange) {
          changeSummary = change.summaryText;
        }
      }

      return { x, y, checkedAt: t, raw: entry.value ?? '', changeSummary };
    });

    const linePath = monotonePath(points);
    const floorY = PAD_TOP + PLOT_H;
    const areaPath = `${linePath} L ${points[points.length - 1].x.toFixed(2)} ${floorY} L ${points[0].x.toFixed(2)} ${floorY} Z`;

    const tickCount = 3;
    const ticks = Array.from({ length: tickCount }, (_, i) => {
      const frac = i / (tickCount - 1);
      return { x: PAD_X + frac * (chartW - PAD_X * 2), label: formatTick(minT + frac * spanT, range) };
    });

    return { points, linePath, areaPath, ticks };
  }, [filtered, range, chartW]);

  function handleMove(event: MouseEvent<SVGSVGElement>) {
    if (!chart) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const userX = ((event.clientX - rect.left) / rect.width) * chartW;
    let nearest = 0;
    let nearestDist = Infinity;
    chart.points.forEach((p, i) => {
      const dist = Math.abs(p.x - userX);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = i;
      }
    });
    setHoverIndex(nearest);
  }

  const hovered = hoverIndex !== null ? chart?.points[hoverIndex] ?? null : null;

  // Measured on every hover change (not just on mount) since the same
  // tooltip DOM node persists across hovers - its content (and
  // therefore its size) changes without ever unmounting, so a
  // mount-only ref wouldn't re-measure a longer/shorter value or date
  // as the user moves across points.
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [tooltipSize, setTooltipSize] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    if (!hovered) {
      setTooltipSize(null);
      return;
    }
    const el = tooltipRef.current;
    if (!el) return;
    setTooltipSize({ width: el.offsetWidth, height: el.offsetHeight });
  }, [hovered?.checkedAt, hovered?.raw]);

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
        <p className="text-[11.5px] text-muted-foreground">Not enough numeric readings yet to chart.</p>
        <p className="text-[10.5px] text-muted-foreground/70">A trend line appears after a few more checks.</p>
      </div>
    );
  }

  // Pixel-exact clamping (not percentage-based) against the chart's own
  // real measured width/height, using the tooltip's own measured size -
  // the only way to guarantee it never extends past the container
  // regardless of panel width, value length, or date format. Flips
  // below the point instead of above whenever there isn't enough room
  // above within the chart itself (a high value near the top of the
  // plot), rather than letting it go negative and clip.
  let tooltipLeft = 0;
  let tooltipTop = 0;
  if (hovered && tooltipSize) {
    tooltipLeft = clampNum(
      hovered.x - tooltipSize.width / 2,
      TOOLTIP_EDGE_GAP,
      chartW - tooltipSize.width - TOOLTIP_EDGE_GAP,
    );
    const above = hovered.y - tooltipSize.height - TOOLTIP_POINT_GAP;
    tooltipTop =
      above >= TOOLTIP_EDGE_GAP
        ? above
        : clampNum(hovered.y + TOOLTIP_POINT_GAP, TOOLTIP_EDGE_GAP, CHART_H - tooltipSize.height - TOOLTIP_EDGE_GAP);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-end">
        <div className="inline-flex items-center gap-0.5 rounded-md bg-muted p-0.5">
          {RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => setRange(opt.key)}
              className={cn(
                'rounded-[5px] px-1.5 py-0.5 text-[10.5px] font-medium transition-colors',
                range === opt.key
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div ref={measureRef} className="relative overflow-hidden">
        {!chart ? (
          <div className="flex items-center justify-center" style={{ height: CHART_H }}>
            <p className="text-[11px] text-muted-foreground">No data in this range</p>
          </div>
        ) : (
          <div key={range} className="relative">
            <svg
              viewBox={`0 0 ${chartW} ${CHART_H}`}
              width="100%"
              height={CHART_H}
              className="block"
              onMouseMove={handleMove}
              onMouseLeave={() => setHoverIndex(null)}
            >
              <defs>
                <linearGradient id="historyChartFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(var(--foreground))" stopOpacity="0.14" />
                  <stop offset="100%" stopColor="hsl(var(--foreground))" stopOpacity="0" />
                </linearGradient>
              </defs>

              {/* Very subtle grid - three reference lines, no numbers (per the minimal-Y-axis brief). */}
              {[0, 0.5, 1].map((frac) => (
                <line
                  key={frac}
                  x1={0}
                  x2={chartW}
                  y1={PAD_TOP + PLOT_H * frac}
                  y2={PAD_TOP + PLOT_H * frac}
                  stroke="hsl(var(--border))"
                  strokeWidth={1}
                  opacity={0.6}
                />
              ))}

              <path d={chart.areaPath} fill="url(#historyChartFill)" className="animate-chart-area" />
              <path
                d={chart.linePath}
                fill="none"
                stroke="hsl(var(--foreground))"
                strokeOpacity={0.75}
                strokeWidth={1.75}
                strokeLinecap="round"
                strokeLinejoin="round"
                pathLength={1}
                className="animate-chart-line"
              />

              {hovered && (
                <g className="pointer-events-none">
                  <line
                    x1={hovered.x}
                    x2={hovered.x}
                    y1={PAD_TOP}
                    y2={PAD_TOP + PLOT_H}
                    stroke="hsl(var(--foreground))"
                    strokeOpacity={0.15}
                    strokeWidth={1}
                  />
                  <circle
                    cx={hovered.x}
                    cy={hovered.y}
                    r={3.5}
                    fill="hsl(var(--background))"
                    stroke="hsl(var(--foreground))"
                    strokeWidth={1.5}
                  />
                </g>
              )}

              {chart.ticks.map((tick, i) => (
                <text
                  key={i}
                  x={tick.x}
                  y={CHART_H - 6}
                  textAnchor={i === 0 ? 'start' : i === chart.ticks.length - 1 ? 'end' : 'middle'}
                  className="animate-chart-fade fill-muted-foreground"
                  style={{ fontSize: 9.5 }}
                >
                  {tick.label}
                </text>
              ))}
            </svg>

            {hovered && (
              <div
                ref={tooltipRef}
                className="pointer-events-none absolute z-10 max-w-[85%] whitespace-nowrap rounded-md border border-black/[0.06] bg-popover px-2 py-1.5 shadow-md"
                // Hidden (rather than positioned at a guessed 0,0) until
                // its real size has been measured and the fully
                // edge-clamped position computed - avoids a one-frame
                // flash of an overflowing tooltip before that math runs.
                style={
                  tooltipSize
                    ? { left: tooltipLeft, top: tooltipTop, visibility: 'visible' }
                    : { left: 0, top: 0, visibility: 'hidden' }
                }
              >
                <div className="flex items-center gap-1.5">
                  <p className="truncate text-[12px] font-semibold tabular-nums text-foreground">{hovered.raw}</p>
                  {hovered.changeSummary && (
                    <span className="text-[10.5px] font-medium text-muted-foreground">
                      ({hovered.changeSummary})
                    </span>
                  )}
                </div>
                <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                  {formatDateTime(hovered.checkedAt)}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
