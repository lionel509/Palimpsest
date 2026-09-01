/** Turning a text selection into marks on the page.
 *
 *  The browser hands a selection back as a pile of client rects — one per text
 *  run it touches, so a single line of a slide is a dozen of them. Written
 *  straight into the log that would be a dozen highlight objects for one drag:
 *  a dozen visible seams, a dozen things to click, and a dozen lines in the
 *  file. Everything here is the arithmetic that folds that pile back into one
 *  mark per line.
 *
 *  Pure geometry, in page points, so it can be tested without a document.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Two rects belong to the same line when their vertical spans overlap by more
 *  than a third of the shorter one.
 *
 *  Measuring against the shorter box is what lets a superscript, an inline
 *  formula or a raised footnote mark join the line it hangs off rather than
 *  becoming a line of its own — an exponent overlaps its own line by well under
 *  half its height. A third is still nowhere near reachable by two consecutive
 *  lines of body text, whose boxes do not overlap at all at any normal leading.
 */
function sharesLine(a: Box, b: Box): boolean {
  const overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return overlap * 3 > Math.min(a.h, b.h);
}

/** How far apart two rects on the same line may be and still be one mark, as a
 *  multiple of the line's height. Word spacing is a fraction of a line's
 *  height; a column gutter is several times it. That gap is the whole reason a
 *  highlight dragged down one column of a two-column paper does not come out as
 *  a set of stripes across the gutter. */
const GAP = 0.6;

function absorb(into: Box, box: Box): void {
  const right = Math.max(into.x + into.w, box.x + box.w);
  const bottom = Math.max(into.y + into.h, box.y + box.h);
  into.x = Math.min(into.x, box.x);
  into.y = Math.min(into.y, box.y);
  into.w = right - into.x;
  into.h = bottom - into.y;
}

/** One box per run of text on one line. */
export function mergeLines(boxes: Box[]): Box[] {
  const lines: Box[][] = [];
  for (const box of boxes) {
    // Grouping against the line's first rect rather than its running union:
    // the union grows to cover a tall superscript, and a band that keeps
    // growing eventually swallows the line below it.
    const line = lines.find((candidate) => sharesLine(candidate[0], box));
    if (line) line.push(box);
    else lines.push([box]);
  }

  const out: Box[] = [];
  for (const line of lines) {
    line.sort((a, b) => a.x - b.x);
    let run: Box | null = null;
    for (const box of line) {
      if (run && box.x - (run.x + run.w) <= Math.min(run.h, box.h) * GAP) {
        absorb(run, box);
        continue;
      }
      run = { ...box };
      out.push(run);
    }
  }

  // Reading order, so the log lists a highlight's pieces the way you made them.
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}

export interface Rule {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** An underline goes just below the baseline, not on the floor of the box: the
 *  box includes the descender space, and a rule drawn down there reads as a
 *  line under the *line* rather than under the words. */
export function underlineOf(box: Box): Rule {
  const y = box.y + box.h * 0.92;
  return { x1: box.x, y1: y, x2: box.x + box.w, y2: y };
}

/** Through the middle of the x-height, which is a little above the middle of
 *  the box — the box is measured from the top of the ascenders. */
export function strikeOf(box: Box): Rule {
  const y = box.y + box.h * 0.55;
  return { x1: box.x, y1: y, x2: box.x + box.w, y2: y };
}
