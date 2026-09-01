/** The PDF's own text, as selectable DOM over the page.
 *
 *  Palimpsest paints pages to a canvas, and a canvas has no text in it: for the
 *  first two builds you could draw on a slide but not select a word of it, and
 *  copying a definition out meant leaving for Obsidian's viewer. So every page
 *  near the viewport carries a layer of transparent, exactly-placed spans — the
 *  same trick pdf.js's own viewer uses. The browser then does the selecting,
 *  the copying and the double-click-a-word; all we have to do is put the glyph
 *  boxes in the right places.
 *
 *  Two things make it land on the ink rather than near it:
 *
 *  1. **The layer is laid out in points and scaled by CSS.** A span's `left`
 *     and `font-size` are page coordinates and never change; zooming rewrites
 *     one `transform` on the container. So a zoom costs one style write per
 *     page instead of re-measuring every run on it.
 *  2. **Each span is stretched to the width the PDF says it is.** The document's
 *     real font is usually not installed, so a fallback sets the same string at
 *     the wrong width and the selection drifts further right with every word.
 *     Measuring once and applying `scaleX` pins each box back onto its ink.
 *
 *  Measure everything, then write everything. Interleaving the two makes the
 *  browser re-lay-out the page once per run, which on a dense slide is the
 *  difference between imperceptible and a visible hitch.
 */

import { PageSize, TextRun } from "./pdf";

export class TextLayer {
  readonly el: HTMLElement;

  /** Bumped on every claim and every clear, so a page that scrolled away while
   *  its text was being fetched cannot be filled in behind us. */
  private token = 0;
  private status: "empty" | "pending" | "built" = "empty";

  constructor() {
    this.el = document.createElement("div");
    this.el.addClass("palimpsest-textlayer");
  }

  get isEmpty(): boolean {
    return this.status === "empty";
  }

  /** Take the layer before an await; hand the token back to `build`. */
  begin(): number {
    this.status = "pending";
    return ++this.token;
  }

  layout(size: PageSize, scale: number): void {
    this.el.style.width = `${size.width}px`;
    this.el.style.height = `${size.height}px`;
    this.el.style.transform = `scale(${scale})`;
  }

  build(token: number, runs: TextRun[]): void {
    if (token !== this.token) return;
    this.el.empty();

    const spans: HTMLElement[] = [];
    const kept: TextRun[] = [];
    for (const run of runs) {
      if (!run.str) continue;
      const span = this.el.createSpan({ text: run.str });
      span.style.left = `${run.x}px`;
      span.style.top = `${run.y}px`;
      span.style.fontSize = `${run.h}px`;
      span.style.fontFamily = run.font;
      spans.push(span);
      kept.push(run);
      // Absolutely positioned spans carry no line structure of their own, so
      // without this a copied paragraph comes back as one unbroken line.
      if (run.eol) this.el.createEl("br");
    }

    // The container is scaled by CSS, so client rects come back in screen
    // pixels. Recovering the factor from the box we set ourselves is steadier
    // than being told the zoom: it cannot go stale between the two.
    const declared = parseFloat(this.el.style.width);
    const painted = this.el.getBoundingClientRect().width;
    const scale = declared > 0 && painted > 0 ? painted / declared : 1;

    const widths = spans.map((span) => span.getBoundingClientRect().width / scale);
    spans.forEach((span, index) => {
      const run = kept[index];
      const parts: string[] = [];
      if (run.angle !== 0) parts.push(`rotate(${(run.angle * 180) / Math.PI}deg)`);
      if (run.w > 0 && widths[index] > 0) parts.push(`scaleX(${run.w / widths[index]})`);
      if (parts.length) span.style.transform = parts.join(" ");
    });

    this.status = "built";
  }

  clear(): void {
    if (this.status === "empty") return;
    this.token++;
    this.status = "empty";
    this.el.empty();
  }
}
