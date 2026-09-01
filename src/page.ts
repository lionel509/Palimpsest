/** One page of the scrolling document.
 *
 *  The old view painted a single page into a single canvas and swapped it when
 *  you pressed the arrow. That is how a *reader* works, and it is wrong for a
 *  thing you draw on: a slide's diagram runs past the page break, you want to
 *  see what you wrote on the previous page while you write on this one, and
 *  paging is a click you should never have to make. So the document is now one
 *  scrolling column and every page is a surface of its own — canvas for the
 *  PDF, SVG on top for the markup.
 *
 *  The cost is that a 400-page textbook cannot have 400 live canvases: at
 *  fit-width on a retina display that is several gigabytes of bitmap. So a
 *  surface paints when it comes near the viewport and drops its bitmap when it
 *  leaves. The DOM box stays exactly the right size the whole time, so nothing
 *  jumps and the scrollbar never lies.
 *
 *  A third layer rides along with the bitmap: the PDF's own text, as invisible
 *  spans you can select and copy. It is filled and dropped on exactly the same
 *  schedule, because it is the same kind of cost.
 */

import { PageId } from "./log";
import { PageSize, PdfDocument, baseSize, renderPage } from "./pdf";
import { TextLayer } from "./textlayer";

const SVG_NS = "http://www.w3.org/2000/svg";

export class PageSurface {
  readonly el: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly svg: SVGSVGElement;
  /** The PDF's text, above the markup so that in select mode it sees the press
   *  first — it is the thing you are usually pointing at. */
  readonly text = new TextLayer();
  private readonly badge: HTMLElement;

  /** The scale this surface's bitmap was painted at, or -1 for "not painted". */
  private paintedAt = -1;
  /** Bumped on every paint request so a stale render cannot land after a newer one. */
  private token = 0;
  private task: { cancel: () => void } | null = null;

  constructor(
    public id: PageId,
    public size: PageSize,
  ) {
    this.el = document.createElement("div");
    this.el.addClass("palimpsest-page");
    this.el.dataset.page = id;

    this.canvas = document.createElement("canvas");
    this.canvas.addClass("palimpsest-canvas");
    this.el.appendChild(this.canvas);

    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.addClass("palimpsest-overlay");
    this.el.appendChild(this.svg);

    this.el.appendChild(this.text.el);

    this.badge = document.createElement("div");
    this.badge.addClass("palimpsest-page-badge");
    this.el.appendChild(this.badge);
  }

  /** Position in the current page order, 0-based. */
  setNumber(index: number, total: number): void {
    this.badge.setText(`${index + 1} / ${total}`);
  }

  /** Lay the box out at `scale`, without painting anything into it. */
  layout(scale: number): void {
    const width = Math.round(this.size.width * scale);
    const height = Math.round(this.size.height * scale);
    this.el.style.width = `${width}px`;
    this.el.style.height = `${height}px`;
    this.svg.setAttribute("viewBox", `0 0 ${this.size.width} ${this.size.height}`);
    this.svg.style.width = `${width}px`;
    this.svg.style.height = `${height}px`;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.text.layout(this.size, scale);
  }

  get isPainted(): boolean {
    return this.paintedAt > 0;
  }

  get needsRepaint(): boolean {
    return this.paintedAt < 0;
  }

  /** True when the bitmap is at a resolution too far from the current scale to
   *  keep using. Repainting on every zoom tick would thrash; letting it drift
   *  makes the page visibly soft. */
  staleAt(scale: number): boolean {
    return this.paintedAt > 0 && Math.abs(this.paintedAt - scale) / scale > 0.02;
  }

  async paint(pdf: PdfDocument, scale: number): Promise<void> {
    const mine = ++this.token;
    this.task?.cancel();
    this.task = null;

    const original = /^o(\d+)$/.exec(this.id);
    if (!original) {
      this.paintBlank(scale);
      this.paintedAt = scale;
      return;
    }

    const page = await pdf.getPage(Number(original[1]) + 1);
    if (mine !== this.token) return;

    // The real size may differ from the one assumed at load; correct it before
    // painting so the box and the bitmap cannot disagree.
    const actual = baseSize(page);
    if (Math.abs(actual.width - this.size.width) > 0.5 || Math.abs(actual.height - this.size.height) > 0.5) {
      this.size = actual;
      this.layout(scale);
    }

    await renderPage(page, this.canvas, scale, (cancellable) => {
      this.task = cancellable;
    });
    if (mine !== this.token) return;

    this.task = null;
    this.paintedAt = scale;
    this.el.addClass("is-painted");
  }

  private paintBlank(scale: number): void {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(this.size.width * scale * dpr));
    this.canvas.height = Math.max(1, Math.floor(this.size.height * scale * dpr));
    const context = this.canvas.getContext("2d");
    if (!context) return;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.el.addClass("is-painted");
  }

  /** Drop the bitmap and the text, keep the box. A 1x1 canvas is what actually
   *  frees the memory — clearRect leaves the backing store allocated. */
  release(): void {
    this.text.clear();
    if (this.paintedAt < 0) return;
    this.token++;
    this.task?.cancel();
    this.task = null;
    this.canvas.width = 1;
    this.canvas.height = 1;
    this.paintedAt = -1;
    this.el.removeClass("is-painted");
  }

  destroy(): void {
    this.release();
    this.el.remove();
  }
}
