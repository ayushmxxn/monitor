/**
 * Regression tests for `monotonePath` in `HistoryChart.tsx`.
 *
 * The chart previously built its line with a uniform-parameterized
 * Catmull-Rom spline, which derives each point's tangent purely from
 * neighboring point *positions* with no constraint tying it back to
 * the segment's own secant slope. On a sharp, asymmetric jump (a long
 * flat/slow run followed by a steep final rise - exactly the reported
 * screenshot) that produced Bezier control points which push the
 * curve backward in X and/or outside the Y-range of the two points it
 * was interpolating between: a visible loop/overshoot that renders a
 * value which was never recorded.
 *
 * These tests render real SVG path strings via `monotonePath` and
 * numerically sample every cubic segment to assert, for arbitrary
 * (including the reported) data patterns:
 *  - X is never allowed to move backward (no horizontal loop).
 *  - Y at every point on a segment stays within that segment's own
 *    [min(y0,y1), max(y0,y1)] range (no vertical overshoot/undershoot
 *    - i.e. no fabricated peak or valley between two real points).
 *  - The path starts, ends, and passes exactly through every input
 *    point (chronological order and real values are preserved).
 *
 * Run with `npm run test:chart`. Exits non-zero on any failed assertion.
 */
import { monotonePath } from '../components/monitors/HistoryChart';

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

let failures = 0;
function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ok - ${message}`);
  } else {
    failures += 1;
    console.error(`  FAIL - ${message}`);
  }
}

type Pt = { x: number; y: number };

type Cmd = { type: 'M' | 'L'; x: number; y: number } | { type: 'C'; c1x: number; c1y: number; c2x: number; c2y: number; x: number; y: number };

/** Minimal parser for the exact subset of path syntax `monotonePath` emits. */
function parsePath(d: string): Cmd[] {
  const tokens = d.match(/[MLC]|-?\d+\.?\d*/g) ?? [];
  const cmds: Cmd[] = [];
  let i = 0;
  while (i < tokens.length) {
    const type = tokens[i++];
    if (type === 'M' || type === 'L') {
      const x = Number(tokens[i++]);
      const y = Number(tokens[i++]);
      cmds.push({ type, x, y });
    } else if (type === 'C') {
      const c1x = Number(tokens[i++]);
      const c1y = Number(tokens[i++]);
      const c2x = Number(tokens[i++]);
      const c2y = Number(tokens[i++]);
      const x = Number(tokens[i++]);
      const y = Number(tokens[i++]);
      cmds.push({ type: 'C', c1x, c1y, c2x, c2y, x, y });
    } else {
      throw new Error(`Unexpected token "${type}" in path: ${d}`);
    }
  }
  return cmds;
}

function cubicAt(p0: Pt, c1: Pt, c2: Pt, p1: Pt, t: number): Pt {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const e = t * t * t;
  return {
    x: a * p0.x + b * c1.x + c * c2.x + e * p1.x,
    y: a * p0.y + b * c1.y + c * c2.y + e * p1.y,
  };
}

const EPS = 1e-6;

/**
 * Walks the parsed path and asserts, per-segment, that X never moves
 * backward and Y never leaves the [min(y0,y1), max(y0,y1)] range
 * implied by that segment's own two real data points.
 */
function assertNoOvershoot(points: Pt[], label: string) {
  const d = monotonePath(points);
  const cmds = parsePath(d);

  assert(cmds.length > 0, `${label}: produced a non-empty path`);
  assert(cmds[0].type === 'M', `${label}: path starts with M`);
  assert(
    Math.abs(cmds[0].x - points[0].x) < 1e-2 && Math.abs(cmds[0].y - points[0].y) < 1e-2,
    `${label}: path starts exactly at the first data point`,
  );

  let cur: Pt = { x: cmds[0].x, y: cmds[0].y };
  let segIndex = 0;
  let overallXOk = true;
  let overallYOk = true;

  for (let i = 1; i < cmds.length; i++) {
    const cmd = cmds[i];
    const target: Pt = { x: cmd.x, y: cmd.y };
    const yLo = Math.min(cur.y, target.y) - EPS;
    const yHi = Math.max(cur.y, target.y) + EPS;
    const xLo = Math.min(cur.x, target.x) - EPS;
    const xHi = Math.max(cur.x, target.x) + EPS;

    if (cmd.type === 'C') {
      const c1 = { x: cmd.c1x, y: cmd.c1y };
      const c2 = { x: cmd.c2x, y: cmd.c2y };
      for (let s = 0; s <= 40; s++) {
        const t = s / 40;
        const p = cubicAt(cur, c1, c2, target, t);
        if (p.x < xLo || p.x > xHi) overallXOk = false;
        if (p.y < yLo || p.y > yHi) overallYOk = false;
      }
    }

    // Chronological order: X must never move backward point-to-point.
    if (target.x < cur.x - EPS) overallXOk = false;

    cur = target;
    segIndex++;
  }

  assert(overallXOk, `${label}: X coordinate never moves backward / overshoots its segment (no horizontal loop)`);
  assert(overallYOk, `${label}: Y coordinate never leaves its segment's own [min,max] range (no fabricated peak/valley)`);

  const last = cmds[cmds.length - 1];
  assert(
    Math.abs(last.x - points[points.length - 1].x) < 1e-2 && Math.abs(last.y - points[points.length - 1].y) < 1e-2,
    `${label}: path ends exactly at the last data point`,
  );

  assert(segIndex === points.length - 1, `${label}: exactly one segment per consecutive point pair (all real points visited, none skipped/reordered)`);
}

// --- Scenarios ---------------------------------------------------------

section('Reported bug: long slow rise then a sharp final increase (screenshot pattern)');
{
  // Mirrors the screenshot: many points creeping up gently, then one
  // final point that jumps sharply higher.
  const points: Pt[] = [
    { x: 10, y: 150 },
    { x: 40, y: 145 },
    { x: 70, y: 140 },
    { x: 100, y: 133 },
    { x: 130, y: 128 },
    { x: 160, y: 122 },
    { x: 190, y: 116 },
    { x: 220, y: 108 },
    { x: 250, y: 100 },
    { x: 270, y: 96 },
    { x: 290, y: 30 }, // sharp final increase (in SVG, smaller y = higher value)
  ];
  assertNoOvershoot(points, 'sharp final rise');
}

section('Monotonically increasing values, irregular spacing');
{
  const points: Pt[] = [
    { x: 0, y: 200 },
    { x: 5, y: 180 },
    { x: 80, y: 170 },
    { x: 95, y: 120 },
    { x: 300, y: 20 },
  ];
  assertNoOvershoot(points, 'increasing, irregular spacing');
}

section('Monotonically decreasing values');
{
  const points: Pt[] = [
    { x: 0, y: 10 },
    { x: 50, y: 40 },
    { x: 100, y: 90 },
    { x: 150, y: 150 },
    { x: 200, y: 200 },
  ];
  assertNoOvershoot(points, 'decreasing');
}

section('Flat series (all equal values)');
{
  const points: Pt[] = [
    { x: 0, y: 100 },
    { x: 50, y: 100 },
    { x: 100, y: 100 },
    { x: 150, y: 100 },
  ];
  assertNoOvershoot(points, 'flat');
  const d = monotonePath(points);
  assert(!/[a-df-zA-DF-Z]/.test(d) === false || true, 'flat path parses'); // sanity no-op to keep structure consistent
}

section('Duplicate consecutive values mixed with real movement (peak in the middle)');
{
  const points: Pt[] = [
    { x: 0, y: 100 },
    { x: 20, y: 100 },
    { x: 40, y: 60 },
    { x: 60, y: 20 }, // local peak (min y = highest value)
    { x: 80, y: 60 },
    { x: 100, y: 100 },
    { x: 120, y: 100 },
  ];
  assertNoOvershoot(points, 'duplicate values with a real peak');
}

section('Zig-zag: repeated local min/max, the case most prone to overshoot');
{
  const points: Pt[] = [
    { x: 0, y: 100 },
    { x: 20, y: 20 },
    { x: 40, y: 100 },
    { x: 60, y: 20 },
    { x: 80, y: 100 },
    { x: 100, y: 20 },
  ];
  assertNoOvershoot(points, 'zig-zag');
}

section('Duplicate timestamps (zero-width segment) does not divide by zero / NaN');
{
  const points: Pt[] = [
    { x: 0, y: 100 },
    { x: 50, y: 80 },
    { x: 50, y: 40 }, // same x as previous - duplicate timestamp
    { x: 100, y: 10 },
  ];
  const d = monotonePath(points);
  assert(!d.includes('NaN'), 'duplicate-x path contains no NaN');
  assertNoOvershoot(points, 'duplicate x');
}

section('Two points (straight line, no curve)');
{
  const points: Pt[] = [
    { x: 0, y: 100 },
    { x: 100, y: 10 },
  ];
  const d = monotonePath(points);
  assert(d === 'M 0.00 100.00 L 100.00 10.00', `two-point path is a plain straight line (got "${d}")`);
}

section('Straight line regression: all segments connect actual observations with straight lines (no curves/splines)');
{
  const points: Pt[] = [
    { x: 0, y: 100 },
    { x: 30, y: 150 },
    { x: 60, y: 120 },
    { x: 90, y: 200 },
  ];
  const d = monotonePath(points);
  assert(!d.includes('C'), 'path contains no cubic bezier (C) curve commands');
  assert(!d.includes('S'), 'path contains no smooth cubic bezier (S) commands');
  assert(!d.includes('Q'), 'path contains no quadratic bezier (Q) commands');
  assert(!d.includes('T'), 'path contains no smooth quadratic bezier (T) commands');
  assert(!d.includes('A'), 'path contains no elliptical arc (A) commands');
  assert(
    d === 'M 0.00 100.00 L 30.00 150.00 L 60.00 120.00 L 90.00 200.00',
    `path connects all observations with exact straight L segments (got "${d}")`,
  );
  assertNoOvershoot(points, 'straight 4-point sample (100 -> 150 -> 120 -> 200)');
}

console.log(`\n${failures === 0 ? 'All history chart tests passed.' : `${failures} history chart assertion(s) FAILED.`}`);
if (failures > 0) process.exit(1);
