/** Getting a PDF onto a canvas.
 *
 *  Obsidian already ships pdf.js for its own viewer and exposes it as
 *  `window.pdfjsLib` with the worker wired up, so we borrow that rather than
 *  bundling a second copy and hand-rolling worker plumbing.
 *
 *  It is loaded lazily, though — the global does not exist until something has
 *  opened a PDF — so `loadPdfjs` falls back to importing the module straight
 *  from Obsidian's asset path.
 *
 *  This is an internal path and could move in a future Obsidian release. That
 *  is a deliberate, contained bet: it is one function, and the failure mode is
 *  a clear error rather than corrupted data. Hooking Obsidian's built-in PDF
 *  *view* would be the unsafe version of this idea.
 */

const PDFJS_MODULE = "app://obsidian.md/lib/pdfjs/pdf.min.mjs";
const PDFJS_WORKER = "app://obsidian.md/lib/pdfjs/pdf.worker.min.mjs";

/** esbuild rewrites a literal `import()` under `format: "cjs"`; this keeps it
 *  a real dynamic import at runtime. */
const dynamicImport = new Function("url", "return import(url);") as (url: string) => Promise<unknown>;

/* eslint-disable @typescript-eslint/no-explicit-any */
type PdfjsLib = any;
export type PdfDocument = any;
export type PdfPage = any;
export type PdfViewport = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

let cached: PdfjsLib | null = null;

export async function loadPdfjs(): Promise<PdfjsLib> {
  if (cached) return cached;

  const existing = (window as unknown as { pdfjsLib?: PdfjsLib }).pdfjsLib;
  if (existing) {
    cached = existing;
    return cached;
  }

  const mod = (await dynamicImport(PDFJS_MODULE)) as PdfjsLib;
  const lib = mod?.getDocument ? mod : mod?.default;
  if (!lib?.getDocument) {
    throw new Error("Palimpsest: could not load Obsidian's pdf.js. Open any PDF once, then reopen this file.");
  }
  if (lib.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc) {
    lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  }
  cached = lib;
  return cached;
}

export async function openPdf(bytes: ArrayBuffer): Promise<PdfDocument> {
  const pdfjs = await loadPdfjs();
  // pdf.js takes ownership of the buffer it is handed, so give it a copy —
  // otherwise the vault's ArrayBuffer is detached and a reload reads zero bytes.
  return await pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise;
}

/** Page dimensions in points, at zoom 1 — the space annotations are stored in. */
export interface PageSize {
  width: number;
  height: number;
}

export function baseSize(page: PdfPage): PageSize {
  const viewport = page.getViewport({ scale: 1 });
  return { width: viewport.width, height: viewport.height };
}

/** Render a page into a canvas at `scale`, sharpened for the display.
 *
 *  `onTask` receives the render task so the caller can cancel it. Scrolling
 *  fast through a long document queues a lot of these, and a page that has left
 *  the viewport should stop rendering rather than finish into a canvas nobody
 *  is looking at.
 */
export async function renderPage(
  page: PdfPage,
  canvas: HTMLCanvasElement,
  scale: number,
  onTask?: (task: { cancel: () => void }) => void,
): Promise<void> {
  const dpr = window.devicePixelRatio || 1;
  const viewport = page.getViewport({ scale: scale * dpr });

  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
  canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;

  const context = canvas.getContext("2d");
  if (!context) throw new Error("Palimpsest: no 2d canvas context");

  const task = page.render({ canvasContext: context, viewport });
  onTask?.(task);
  try {
    await task.promise;
  } catch (error) {
    // A cancelled render is the normal outcome of scrolling, not a failure.
    const name = (error as { name?: string })?.name;
    if (name !== "RenderingCancelledException") throw error;
  }
}

/** A small bitmap of a page for the thumbnail rail. */
export async function renderThumb(page: PdfPage, canvas: HTMLCanvasElement, width: number): Promise<void> {
  const base = page.getViewport({ scale: 1 });
  await renderPage(page, canvas, width / base.width);
}

/** Page sizes without rendering anything.
 *
 *  Every page's box has to be the right size before any of them are painted, or
 *  the scrollbar is a guess and jumps as you scroll. For a long document that is
 *  a lot of page objects to open just to read two numbers, so past `cap` pages
 *  we assume the first page's size and correct each box when it actually paints.
 */
export async function pageSizes(pdf: PdfDocument, cap = 250): Promise<PageSize[]> {
  const first = baseSize(await pdf.getPage(1));
  const count = pdf.numPages as number;
  if (count > cap) return new Array(count).fill(first);

  const sizes: PageSize[] = new Array(count).fill(first);
  const batch = 32;
  for (let start = 1; start < count; start += batch) {
    const end = Math.min(count, start + batch);
    const pages = await Promise.all(
      Array.from({ length: end - start }, (_, i) => pdf.getPage(start + i + 1)),
    );
    pages.forEach((page, i) => {
      sizes[start + i] = baseSize(page);
    });
  }
  return sizes;
}

/** The PDF's own text, positioned in the same coordinate space annotations use:
 *  points, origin top-left, y down.
 *
 *  pdf.js reports each run in PDF user space, which is y-up from the bottom of
 *  the page and may carry a rotation. `viewport.transform` is the matrix that
 *  undoes both, so composing the two is the whole conversion.
 *
 *  Two consumers, one geometry: `Cmd F` paints these boxes as match highlights,
 *  and the selectable text layer lays a transparent span over each one. They
 *  have to agree, or finding a word and selecting the same word would light up
 *  two different rectangles.
 */
export interface TextRun {
  str: string;
  /** Glyph box: `y` is the top of the ascenders, not the baseline. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** CSS font stack, for a span that has to end up the run's width. */
  font: string;
  /** Rotation in radians; 0 for ordinary horizontal text. */
  angle: number;
  /** This run ends a line in the PDF's own text flow. */
  eol: boolean;
}

/** Where the glyph box sits above the baseline, as a fraction of the font size,
 *  when the PDF's font descriptor does not say. pdf.js falls back to the same
 *  number, for the same reason: measuring the real ascent means loading the
 *  font first. */
const DEFAULT_ASCENT = 0.8;

interface RawStyle {
  fontFamily?: string;
  ascent?: number;
  vertical?: boolean;
}

export async function textRuns(page: PdfPage): Promise<TextRun[]> {
  const pdfjs = await loadPdfjs();
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const styles = (content.styles ?? {}) as Record<string, RawStyle>;
  const out: TextRun[] = [];

  type Item = { str?: string; transform?: number[]; width?: number; height?: number; fontName?: string; hasEOL?: boolean };
  for (const item of content.items as Item[]) {
    if (!item.str || !item.transform) continue;
    const m = pdfjs.Util.transform(viewport.transform, item.transform) as number[];
    const style = styles[item.fontName ?? ""] ?? {};
    const h = Math.hypot(m[2], m[3]) || item.height || 10;
    const angle = Math.atan2(m[1], m[0]) + (style.vertical ? Math.PI / 2 : 0);
    // The matrix lands on the baseline and the box hangs above it. Rotated text
    // hangs along its own up-vector, which is what the sin/cos pair is for.
    const rise = h * (style.ascent && style.ascent > 0 ? style.ascent : DEFAULT_ASCENT);

    out.push({
      str: item.str,
      x: angle === 0 ? m[4] : m[4] + rise * Math.sin(angle),
      y: angle === 0 ? m[5] - rise : m[5] - rise * Math.cos(angle),
      w: item.width ?? 0,
      h,
      // The real font is only installed if pdf.js has already painted this page
      // with it, so every stack ends in something that certainly exists.
      font: style.fontFamily ? `${style.fontFamily}, sans-serif` : "sans-serif",
      angle,
      eol: item.hasEOL === true,
    });
  }
  return out;
}
