/** Geometry for picking up more than one object at a time.
 *
 *  Everything a multi-selection can do is defined by one rectangle: the box
 *  around the things you have picked up. Dragging its corner scales all of them
 *  from the old box into the new one, so the only arithmetic that matters is
 *  "where does this rectangle go when that one moves", and it lives here rather
 *  than in the view.
 *
 *  Pure, in page points, so it can be tested without a document.
 */

import { Box } from "./selection";

export interface Point {
  x: number;
  y: number;
}

/** Nothing may be resized to nothing: a zero-width box has no direction left to
 *  drag it back out by. */
const MIN = 1;

export function unionBox(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const box of boxes) {
    left = Math.min(left, box.x);
    top = Math.min(top, box.y);
    right = Math.max(right, box.x + box.w);
    bottom = Math.max(bottom, box.y + box.h);
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** Where a box lands when the box around it is dragged from `from` to `to`.
 *
 *  This is the whole of a group resize: every member keeps its position and
 *  size *relative to the frame*, which is what makes scaling six shapes feel
 *  like scaling one picture rather than six independent things. */
export function remap(box: Box, from: Box, to: Box): Box {
  const sx = from.w > 0 ? to.w / from.w : 1;
  const sy = from.h > 0 ? to.h / from.h : 1;
  return {
    x: to.x + (box.x - from.x) * sx,
    y: to.y + (box.y - from.y) * sy,
    w: box.w * sx,
    h: box.h * sy,
  };
}

export interface ResizeOptions {
  /** Shift: keep the original proportions. Corners only — an edge handle has
   *  only one axis to give, and forcing the other one turns a nudge of a
   *  rectangle's side into a jump. */
  aspect?: boolean;
  /** Alt: grow about the centre instead of about the opposite corner. */
  centre?: boolean;
}

/** The new box when `handle` is dragged to (x, y).
 *
 *  Handle names are compass points, so which edges move is read straight off
 *  the name: `nw` moves the top and the left, `e` moves only the right.
 */
export function resizeBox(from: Box, handle: string, x: number, y: number, opts: ResizeOptions = {}): Box {
  const west = handle.includes("w");
  const east = handle.includes("e");
  const north = handle.includes("n");
  const south = handle.includes("s");

  let left = west ? x : from.x;
  let right = east ? x : from.x + from.w;
  let top = north ? y : from.y;
  let bottom = south ? y : from.y + from.h;

  if (opts.aspect && from.w > 0 && from.h > 0 && (west || east) && (north || south)) {
    // Whichever axis the pointer stretched further is the one that wins, so the
    // box follows the hand rather than fighting it.
    const ratio = from.w / from.h;
    const width = Math.abs(right - left);
    const height = Math.abs(bottom - top);
    if (width / ratio >= height) {
      const wanted = width / ratio;
      if (north) top = bottom - wanted;
      else bottom = top + wanted;
    } else {
      const wanted = height * ratio;
      if (west) left = right - wanted;
      else right = left + wanted;
    }
  }

  if (opts.centre) {
    const cx = from.x + from.w / 2;
    const cy = from.y + from.h / 2;
    if (west || east) {
      const reach = Math.abs((west ? left : right) - cx);
      left = cx - reach;
      right = cx + reach;
    }
    if (north || south) {
      const reach = Math.abs((north ? top : bottom) - cy);
      top = cy - reach;
      bottom = cy + reach;
    }
  }

  return {
    x: Math.min(left, right),
    y: Math.min(top, bottom),
    w: Math.max(MIN, Math.abs(right - left)),
    h: Math.max(MIN, Math.abs(bottom - top)),
  };
}

/** A text box has one real degree of freedom: the width it wraps at. Its height
 *  follows from the wrapping, so a grip that claimed to set the height would be
 *  lying about what letting go will do.
 *
 *  So every grip does the same thing — the ones on the right edge move the
 *  right edge, the ones on the left move the left — and it has corners because
 *  that is where a hand goes looking for a resize, not because a corner can do
 *  anything a side cannot.
 */
export function resizeTextWidth(box: Box, handle: string, x: number, min = 24): { x: number; w: number } {
  if (handle.includes("e")) return { x: box.x, w: Math.max(min, x - box.x) };
  const right = box.x + box.w;
  return { x: Math.min(x, right - min), w: Math.max(min, right - x) };
}

/** The single factor a piece of type takes when its box is scaled from `from`
 *  to `to`.
 *
 *  A font size is one number, so even a non-uniform squash has to be answered
 *  with one. The square root of the area ratio changes the type by as much as
 *  the box changed overall, and it is exactly the scale factor whenever the
 *  scale *was* uniform — which is every corner drag on a text box, and most
 *  drags of a group.
 */
export function typeFactor(from: Box, to: Box): number {
  const fx = from.w > 0 ? to.w / from.w : 1;
  const fy = from.h > 0 ? to.h / from.h : 1;
  return Math.sqrt(Math.max(0.000001, fx * fy));
}

/** Below four points type stops being readable and above four hundred it stops
 *  being a document; a drag that overshoots should hit a wall, not produce a
 *  box you then cannot find the handles of. Tenths, because the log is read by
 *  people and `13.700000000000001` helps nobody. */
export function clampSize(size: number): number {
  return Math.round(Math.min(400, Math.max(4, size)) * 10) / 10;
}

/** Ray casting, counting crossings of a horizontal line to the right.
 *
 *  A lasso is drawn open and used closed — the last point joins the first,
 *  which this does implicitly by pairing every vertex with its predecessor
 *  around the loop. */
export function pointInPolygon(x: number, y: number, poly: Point[]): boolean {
  if (poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    const straddles = a.y > y !== b.y > y;
    if (straddles && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Is this object caught by a lasso?
 *
 *  By its centre, not by touching it and not by enclosing it whole. Touching
 *  means a lasso drawn near a long arrow picks the arrow up, which is not what
 *  the gesture looked like; enclosing whole means a lasso round a paragraph of
 *  a diagram misses the one line that pokes out. The centre is the point you
 *  were actually aiming at, and it is the rule Illustrator's own lasso settled
 *  on for the same reason.
 */
export function caughtBy(box: Box, poly: Point[]): boolean {
  return pointInPolygon(box.x + box.w / 2, box.y + box.h / 2, poly);
}

/** The four corners of a drag, as a polygon — the lasso's straight-sided form,
 *  for when what you want is a row of shapes rather than a shape of shapes. */
export function marquee(x0: number, y0: number, x1: number, y1: number): Point[] {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}
