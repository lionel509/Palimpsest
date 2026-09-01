/** Freehand ink.
 *
 *  A stroke is a list of points with a pressure each. Everything interesting
 *  happens on the way out: a wire-thin polyline looks like a pen plotter, and
 *  what makes ink feel like ink is that its width varies along its length and
 *  its ends taper. So a stroke is not stroked at all — it is drawn as a filled
 *  outline, built by walking a rail up one side of the centreline and back down
 *  the other.
 *
 *  Two rules from the log's design carry over here:
 *
 *  - **One stroke is one event.** The whole point array is committed on
 *    pointer-up, never during the drag, so the timelapse plays a stroke as a
 *    stroke instead of stuttering through 800 intermediate states.
 *  - **Thin before committing.** This is the one shape whose size is not
 *    negligible. A raw stroke arrives with a point per pointermove — hundreds
 *    for a single letter, most of them indistinguishable. `thin` drops the ones
 *    that carry no shape.
 */

import type { Brush } from "./log";

export interface InkPoint {
  x: number;
  y: number;
  /** 0..1. Real, if a stylus reported it; inferred from speed if not. */
  p: number;
}

/** How each nib answers pressure, and whether its ends taper.
 *
 *  `min`/`max` scale the nominal width. A marker is deliberately flat: a felt
 *  tip does not get thinner when you press it lightly, and pretending otherwise
 *  is what makes fake marker strokes look like fake marker strokes. */
const NIBS: Record<Brush, { min: number; max: number; taper: number; caps: "round" | "flat" }> = {
  pen: { min: 0.32, max: 1, taper: 0.18, caps: "round" },
  marker: { min: 1, max: 1, taper: 0, caps: "flat" },
  pencil: { min: 0.55, max: 1, taper: 0.1, caps: "round" },
};

// ------------------------------------------------------------------- storage

/** Points go into the log as a flat, rounded number array. Sub-tenth-of-a-point
 *  precision is below what any display can show and costs real bytes. */
export function packPoints(points: InkPoint[]): number[] {
  const out: number[] = [];
  for (const point of points) {
    out.push(round(point.x, 1), round(point.y, 1), round(point.p, 2));
  }
  return out;
}

export function unpackPoints(flat: number[] | undefined): InkPoint[] {
  if (!flat) return [];
  const out: InkPoint[] = [];
  // Whole triples only. A truncated tail is a damaged log line, and half a
  // point becomes `p: undefined`, which turns the whole stroke into NaN.
  for (let i = 0; i + 3 <= flat.length; i += 3) {
    out.push({ x: flat[i], y: flat[i + 1], p: flat[i + 2] });
  }
  return out;
}

const round = (value: number, places: number): number => {
  const factor = Math.pow(10, places);
  return Math.round(value * factor) / factor;
};

// ------------------------------------------------------------------ thinning

/** Ramer–Douglas–Peucker, keeping the pressure of whichever points survive.
 *
 *  Run once on pointer-up. Running it live would fight the incremental preview
 *  for no benefit — the stroke is only written once. */
export function thin(points: InkPoint[], epsilon: number): InkPoint[] {
  if (points.length <= 2) return points.slice();

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  // Iterative rather than recursive: a long stroke of scribble can nest deeply
  // enough to matter, and a blown stack while drawing is an unforgivable bug.
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop() as [number, number];
    if (last <= first + 1) continue;

    let worst = -1;
    let worstDistance = epsilon;
    for (let i = first + 1; i < last; i++) {
      const distance = pointToSegment(points[i], points[first], points[last]);
      if (distance > worstDistance) {
        worst = i;
        worstDistance = distance;
      }
    }
    if (worst < 0) continue;

    keep[worst] = 1;
    stack.push([first, worst], [worst, last]);
  }

  return points.filter((_, i) => keep[i] === 1);
}

function pointToSegment(p: InkPoint, a: InkPoint, b: InkPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// ------------------------------------------------------------------ pressure

/** Pressure for input that has none.
 *
 *  A mouse and a trackpad report a constant 0.5, so a stroke drawn with one is
 *  a dead straight ribbon. Speed is the usable stand-in: you slow down at the
 *  ends of a deliberate line and through a tight curve, and that is exactly
 *  where a real nib lays down more ink. The smoothing matters as much as the
 *  curve — raw per-event speed is jittery enough to make the stroke lumpy. */
export class SpeedPressure {
  private last: { x: number; y: number; t: number } | null = null;
  private value = 0.5;

  next(x: number, y: number, now: number): number {
    if (!this.last) {
      this.last = { x, y, t: now };
      return this.value;
    }
    const dt = Math.max(1, now - this.last.t);
    const speed = Math.hypot(x - this.last.x, y - this.last.y) / dt; // points per ms
    this.last = { x, y, t: now };

    // ~1.2 pt/ms is a brisk stroke; faster than that is as thin as it gets.
    const target = Math.max(0.15, Math.min(1, 1 - speed / 1.2));
    this.value += (target - this.value) * 0.3;
    return this.value;
  }
}

// ----------------------------------------------------------------- rendering

/** The SVG path for a stroke: a closed outline, not a stroked line. */
export function outlinePath(points: InkPoint[], width: number, brush: Brush): string {
  const nib = NIBS[brush] ?? NIBS.pen;
  const radius = Math.max(0.2, width / 2);

  const centre = smooth(points);
  if (centre.length === 0) return "";
  if (centre.length === 1) return dot(centre[0], radius * nib.max);

  const radii = radiiFor(centre, radius, nib);
  const left: InkPoint[] = [];
  const right: InkPoint[] = [];

  for (let i = 0; i < centre.length; i++) {
    const [nx, ny] = normalAt(centre, i);
    const r = radii[i];
    left.push({ x: centre[i].x + nx * r, y: centre[i].y + ny * r, p: 0 });
    right.push({ x: centre[i].x - nx * r, y: centre[i].y - ny * r, p: 0 });
  }

  const head = centre[0];
  const tail = centre[centre.length - 1];
  const headRadius = radii[0];
  const tailRadius = radii[radii.length - 1];

  let d = `M ${fmt(left[0].x)} ${fmt(left[0].y)}`;
  d += curveThrough(left);

  d +=
    nib.caps === "round"
      ? ` A ${fmt(tailRadius)} ${fmt(tailRadius)} 0 0 1 ${fmt(right[right.length - 1].x)} ${fmt(right[right.length - 1].y)}`
      : ` L ${fmt(right[right.length - 1].x)} ${fmt(right[right.length - 1].y)}`;

  d += curveThrough([...right].reverse());

  d +=
    nib.caps === "round"
      ? ` A ${fmt(headRadius)} ${fmt(headRadius)} 0 0 1 ${fmt(left[0].x)} ${fmt(left[0].y)}`
      : ` L ${fmt(left[0].x)} ${fmt(left[0].y)}`;

  void head;
  void tail;
  return `${d} Z`;
}

/** Quadratics through the midpoints: the classic trick for turning a polyline
 *  into something that does not show its corners. */
function curveThrough(points: InkPoint[]): string {
  let d = "";
  for (let i = 1; i < points.length - 1; i++) {
    const midX = (points[i].x + points[i + 1].x) / 2;
    const midY = (points[i].y + points[i + 1].y) / 2;
    d += ` Q ${fmt(points[i].x)} ${fmt(points[i].y)} ${fmt(midX)} ${fmt(midY)}`;
  }
  const last = points[points.length - 1];
  return `${d} L ${fmt(last.x)} ${fmt(last.y)}`;
}

function dot(point: InkPoint, radius: number): string {
  const r = Math.max(0.4, radius);
  return (
    `M ${fmt(point.x - r)} ${fmt(point.y)}` +
    ` A ${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(point.x + r)} ${fmt(point.y)}` +
    ` A ${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(point.x - r)} ${fmt(point.y)} Z`
  );
}

/** Width along the stroke: pressure, then a taper into each end. */
function radiiFor(points: InkPoint[], radius: number, nib: { min: number; max: number; taper: number }): number[] {
  const lengths = cumulativeLength(points);
  const total = lengths[lengths.length - 1] || 1;
  const taperLength = Math.min(total * 0.4, radius * 12) * (nib.taper * 5);

  return points.map((point, i) => {
    const pressure = nib.min + (nib.max - nib.min) * clamp01(point.p);
    if (taperLength <= 0) return radius * pressure;
    const fromStart = lengths[i];
    const fromEnd = total - lengths[i];
    const ease = Math.min(1, Math.min(fromStart, fromEnd) / taperLength);
    // Square-root easing: blunt enough to look like a nib touching down, rather
    // than the needle point a linear taper gives you.
    return radius * pressure * Math.sqrt(ease === 1 ? 1 : 0.15 + 0.85 * ease);
  });
}

function cumulativeLength(points: InkPoint[]): number[] {
  const out = [0];
  for (let i = 1; i < points.length; i++) {
    out.push(out[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  return out;
}

/** Perpendicular to the local direction, averaged across the neighbours so the
 *  rails do not kink at every sampled point. */
function normalAt(points: InkPoint[], i: number): [number, number] {
  const previous = points[Math.max(0, i - 1)];
  const next = points[Math.min(points.length - 1, i + 1)];
  const dx = next.x - previous.x;
  const dy = next.y - previous.y;
  const length = Math.hypot(dx, dy) || 1;
  return [-dy / length, dx / length];
}

/** A short moving average. Pointer sampling is noisy at the pixel level and the
 *  noise is very visible once a stroke has width. */
function smooth(points: InkPoint[]): InkPoint[] {
  if (points.length <= 2) return points.slice();
  const out: InkPoint[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    out.push({
      x: (points[i - 1].x + points[i].x * 2 + points[i + 1].x) / 4,
      y: (points[i - 1].y + points[i].y * 2 + points[i + 1].y) / 4,
      p: (points[i - 1].p + points[i].p * 2 + points[i + 1].p) / 4,
    });
  }
  out.push(points[points.length - 1]);
  return out;
}

// ------------------------------------------------------------------ geometry

export function inkBounds(points: InkPoint[], width: number): { x: number; y: number; w: number; h: number } {
  if (points.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const pad = Math.max(1, width / 2);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
}

/** Nearest approach of a point to the stroke, for hit testing and the eraser. */
export function distanceToInk(points: InkPoint[], x: number, y: number): number {
  if (points.length === 0) return Infinity;
  if (points.length === 1) return Math.hypot(x - points[0].x, y - points[0].y);
  const probe: InkPoint = { x, y, p: 0 };
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const distance = pointToSegment(probe, points[i - 1], points[i]);
    if (distance < best) best = distance;
  }
  return best;
}

/** Fit a stroke into a new box, for resizing. */
export function scalePoints(
  points: InkPoint[],
  from: { x: number; y: number; w: number; h: number },
  to: { x: number; y: number; w: number; h: number },
): InkPoint[] {
  const sx = from.w === 0 ? 1 : to.w / from.w;
  const sy = from.h === 0 ? 1 : to.h / from.h;
  return points.map((point) => ({
    x: to.x + (point.x - from.x) * sx,
    y: to.y + (point.y - from.y) * sy,
    p: point.p,
  }));
}

export function translatePoints(points: InkPoint[], dx: number, dy: number): InkPoint[] {
  return points.map((point) => ({ x: point.x + dx, y: point.y + dy, p: point.p }));
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const fmt = (value: number): string => (Math.round(value * 100) / 100).toString();
