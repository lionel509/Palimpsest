/** Covers, and the practice loop they exist for.
 *
 *  A worked solution is worth exactly nothing until you have tried the problem.
 *  So a cover is an opaque patch you drop over the answer: the page still reads
 *  as the page, minus the part you are supposed to produce yourself.
 *
 *  Three decisions shape everything here.
 *
 *  1. **A cover is an ordinary logged object.** It moves, resizes, restyles,
 *     tombstones and scrubs like every other shape, because it *is* every other
 *     shape — the only thing that makes it a cover is that it paints opaque and
 *     the log paints in order. Covering an answer costs one line in the log.
 *
 *  2. **Lifting one is not an edit.** Peeking is view state, held by the view
 *     and thrown away when the document closes. Logged, it would flood the
 *     history with "opened, closed, opened" and turn the timelapse into a
 *     flickering mess — and, worse, a document reopened tomorrow would come back
 *     showing every answer you had ever checked. Nothing to hide is the one
 *     state a study aid must never persist. So the answers are covered again
 *     every time you open the file, which is the whole point of the feature.
 *
 *  3. **Your attempt belongs to the cover you wrote it on.** That is what makes
 *     it a post-it rather than a rectangle: lifting the cover can fade the
 *     working so the real answer reads through it, moving the cover carries the
 *     working along, and "let me do these again" can wipe every attempt on the
 *     document without disturbing a single cover.
 *
 *  Pure geometry and pure counting, in page points, so it can be tested without
 *  a document.
 */

import { Mark, Obj, PageId } from "./log";
import { Box } from "./selection";

/** The dog-ear you lift a cover by, and the tick and cross you grade it with,
 *  in *screen* pixels — divided by the zoom at the call site so they stay the
 *  same size to the hand at every zoom. A control that shrinks with the
 *  document is a control you cannot hit on a thumbnail-sized page. */
export const PEEL = 15;
export const MARK_BUTTON = 17;

/** Padding round a cover made from a text selection.
 *
 *  A selection's boxes stop at the glyphs; a cover flush with them leaves the
 *  ascenders and descenders of the first and last lines poking out, which is
 *  both ugly and legible. Two points is enough to swallow them and not enough
 *  to reach the line above. */
export const SELECTION_PAD = 2;

export const isAttempt = (obj: Obj): boolean => obj.on !== undefined;

/** The dog-ear, at the cover's top-right.
 *
 *  Clamped to half the cover in each direction so a one-line answer's cover
 *  does not come out as one big corner, and floored so that a cover small
 *  enough to make it useless still gets something to aim at. */
export function peelCorner(box: Box, scale: number): Box {
  const wanted = PEEL / Math.max(scale, 0.0001);
  const size = Math.max(6, Math.min(wanted, box.w / 2, box.h / 2));
  return { x: box.x + box.w - size, y: box.y, w: size, h: size };
}

/** Tick and cross, straddling the cover's bottom edge at the right.
 *
 *  Straddling rather than sitting inside: a cover over a one-line answer is
 *  sixteen points tall and has no inside to speak of, and one that grew buttons
 *  only when it was big enough would be a control that comes and goes. Half in
 *  and half out is the same shape at every size, and it reads as belonging to
 *  the cover rather than to the page under it.
 */
export function markZones(box: Box, scale: number): { right: Box; wrong: Box } {
  const size = MARK_BUTTON / Math.max(scale, 0.0001);
  const gap = size * 0.25;
  const y = box.y + box.h - size / 2;
  const wrongX = box.x + box.w - size - gap * 0.5;
  return {
    right: { x: wrongX - size - gap, y, w: size, h: size },
    wrong: { x: wrongX, y, w: size, h: size },
  };
}

export type Zone = "peel" | "right" | "wrong";

const inside = (box: Box, x: number, y: number): boolean =>
  x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;

/** Which of a cover's own controls a point lands on, if any.
 *
 *  Worked out from the geometry rather than from `event.target`, for the same
 *  reason the resize handles are: the PDF's text layer sits above the overlay
 *  and takes the press first, so the element under the pointer is never the one
 *  the gesture was aimed at.
 *
 *  The tick and cross only exist while the cover is lifted, because grading an
 *  answer you have not looked at is not a thing anybody wants to do by accident.
 */
export function hitZone(box: Box, scale: number, x: number, y: number, peeked: boolean): Zone | null {
  if (peeked) {
    const zones = markZones(box, scale);
    if (inside(zones.right, x, y)) return "right";
    if (inside(zones.wrong, x, y)) return "wrong";
  }
  return inside(peelCorner(box, scale), x, y) ? "peel" : null;
}

/** The cover a new mark lands on, if it lands on one: topmost first, so drawing
 *  on a cover that overlaps another writes on the one you can see. */
export function coverAt(objects: Obj[], page: PageId, x: number, y: number): Obj | null {
  for (let i = objects.length - 1; i >= 0; i--) {
    const obj = objects[i];
    if (obj.type !== "cover" || obj.page !== page) continue;
    if (inside({ x: obj.g.x ?? 0, y: obj.g.y ?? 0, w: obj.g.w ?? 0, h: obj.g.h ?? 0 }, x, y)) return obj;
  }
  return null;
}

/** Everything written on any of these covers. */
export function attemptsOn(objects: Obj[], covers: Iterable<string>): Obj[] {
  const owners = new Set(covers);
  return objects.filter((obj) => obj.on !== undefined && owners.has(obj.on));
}

/** A selection turned into *one* cover per page, not one per line.
 *
 *  The highlighter goes line by line, because a highlight follows the words and
 *  the gaps between lines are page you did not mark. A cover is the opposite: it
 *  hides a region, and per-line covers would leave the page showing through the
 *  leading — stripes of visible answer between the bands, which is both the
 *  wrong look and, for a two-line formula, enough to read.
 */
export function unionCover(boxes: Box[], pad = SELECTION_PAD): Box | null {
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
  return { x: left - pad, y: top - pad, w: right - left + pad * 2, h: bottom - top + pad * 2 };
}

export interface Tally {
  covers: number;
  /** Covers with something written on them: problems you have had a go at. */
  tried: number;
  right: number;
  wrong: number;
}

export function tally(objects: Obj[]): Tally {
  const written = new Set<string>();
  for (const obj of objects) {
    if (obj.on !== undefined) written.add(obj.on);
  }

  const out: Tally = { covers: 0, tried: 0, right: 0, wrong: 0 };
  for (const obj of objects) {
    if (obj.type !== "cover") continue;
    out.covers++;
    if (written.has(obj.id)) out.tried++;
    if (obj.st.mark === "right") out.right++;
    else if (obj.st.mark === "wrong") out.wrong++;
  }
  return out;
}

/** What the status bar says, or null when this document is not a problem set
 *  and the readout would be a row of zeroes taking up space. */
export function tallyLabel(counts: Tally): string | null {
  if (counts.covers === 0) return null;
  const parts = [`${counts.covers} covered`];
  if (counts.right) parts.push(`${counts.right} right`);
  if (counts.wrong) parts.push(`${counts.wrong} wrong`);
  const graded = counts.right + counts.wrong;
  if (counts.tried > graded) parts.push(`${counts.tried - graded} to check`);
  return parts.join(" · ");
}

/** The covers a "do these again" reset applies to.
 *
 *  `"wrong"` is the one that earns its keep: a second pass over the four you
 *  got wrong is worth more than a second pass over all forty, and picking them
 *  out by hand is the chore that stops you doing it.
 */
export function resetTargets(objects: Obj[], which: "all" | "wrong"): Obj[] {
  return objects.filter((obj) => obj.type === "cover" && (which === "all" || obj.st.mark === "wrong"));
}

/** How a cover's grade reads in prose, for the companion note. */
export const markLabel = (mark: Mark | undefined): string =>
  mark === "right" ? "right" : mark === "wrong" ? "wrong" : "not checked";
