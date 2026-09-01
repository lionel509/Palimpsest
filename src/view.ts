/** The markup view.
 *
 *  A scrolling document, not a slide projector. Every page in the replayed
 *  order is a live surface in one column; you scroll it, you zoom it, and you
 *  draw on whichever page is under the pointer. The old one-page-at-a-time
 *  model is gone along with its next-page arrow.
 *
 *  Three things here are worth knowing before changing anything:
 *
 *  1. **Shape elements are persistent.** `syncOverlay` reconciles the SVG
 *     against the replayed objects by id instead of emptying it and rebuilding.
 *     That is a performance win on a busy page, but it is really a correctness
 *     fix: the old code tore the overlay down inside `pointerup`, which detached
 *     the very node the gesture had landed on, and a browser will not dispatch
 *     `click`/`dblclick` when that happens. Double-click-to-edit-text could
 *     never fire. Do not reintroduce a full rebuild on a pointer event.
 *
 *  2. **One user action is one undo.** `append` takes a list and writes it as a
 *     single batch, so erasing eight strokes takes one Cmd-Z, not eight.
 *
 *  3. **Nothing here ever rewrites the log.** Undo appends inverses, restore
 *     appends a diff. The file only ever grows.
 *
 *  4. **The PDF's own text is a real DOM layer over each page**, and in select
 *     mode it is the topmost thing under the pointer. So the press lands there
 *     first and is handed down to the overlay only when a shape is underneath.
 *     Anything that used to read `event.target` to decide what was grabbed had
 *     to stop: `handleAt` works it out from the geometry instead.
 */

import { FileView, Menu, Notice, TFile, WorkspaceLeaf, setIcon, setTooltip } from "obsidian";
import type PalimpsestPlugin from "./main";
import {
  Brush,
  CreateEvent,
  DocEvent,
  Geom,
  LogEvent,
  Mark,
  Obj,
  PageId,
  ShapeType,
  Style,
  inverseOf,
  isCover,
  isInk,
  isLineLike,
  mintId,
  newDocEvent,
  parseLog,
  rectFromDrag,
  replay,
  serialise,
} from "./log";
import { PageSize, PdfDocument, TextRun, openPdf, pageSizes, renderThumb, textRuns } from "./pdf";
import { PageSurface } from "./page";
import { Box, mergeLines, strikeOf, underlineOf } from "./selection";
import {
  Point,
  caughtBy,
  clampSize,
  marquee,
  remap,
  resizeBox,
  resizeTextWidth,
  typeFactor,
  unionBox,
} from "./group";
import {
  InkPoint,
  SpeedPressure,
  distanceToInk,
  inkBounds,
  outlinePath,
  packPoints,
  scalePoints,
  thin,
  translatePoints,
  unpackPoints,
} from "./ink";
import { LINE_HEIGHT, TEXT_FONT, cssFont, layout as layoutText } from "./text";
import { Version, byDay, groupVersions, restoreTo, timeLabel } from "./history";
import { openPuck, readableOn, shade } from "./colour";
import {
  Tally,
  Zone,
  attemptsOn,
  coverAt,
  hitZone,
  markZones,
  peelCorner,
  resetTargets,
  tally,
  tallyLabel,
  unionCover,
} from "./study";

export const VIEW_TYPE_PALIMPSEST = "palimpsest-view";
export const PALIMPSEST_EXT = "palimpsest";

const SVG_NS = "http://www.w3.org/2000/svg";

type Tool =
  | "select"
  | "lasso"
  | "pan"
  | "pen"
  | "marker"
  | "pencil"
  | "eraser"
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "text"
  | "highlight"
  | "cover";

const INK_TOOLS: Record<string, Brush> = { pen: "pen", marker: "marker", pencil: "pencil" };

interface ToolSpec {
  tool: Tool;
  icon: string;
  label: string;
  key: string;
  group: number;
}

const TOOLS: ToolSpec[] = [
  { tool: "select", icon: "mouse-pointer-2", label: "Select text and objects", key: "V", group: 0 },
  { tool: "lasso", icon: "lasso-select", label: "Lasso several objects (Alt drags a box)", key: "Q", group: 0 },
  { tool: "pan", icon: "hand", label: "Pan (or hold space)", key: "space", group: 0 },

  { tool: "pen", icon: "pen-tool", label: "Pen", key: "P", group: 1 },
  { tool: "marker", icon: "paintbrush", label: "Marker", key: "B", group: 1 },
  { tool: "pencil", icon: "pencil", label: "Pencil", key: "N", group: 1 },
  { tool: "eraser", icon: "eraser", label: "Eraser", key: "E", group: 1 },

  { tool: "highlight", icon: "highlighter", label: "Highlight", key: "H", group: 2 },
  { tool: "text", icon: "type", label: "Text", key: "T", group: 2 },
  { tool: "cover", icon: "sticky-note", label: "Cover an answer, and work it out yourself", key: "C", group: 2 },

  { tool: "rect", icon: "square", label: "Rectangle", key: "R", group: 3 },
  { tool: "ellipse", icon: "circle", label: "Circle", key: "O", group: 3 },
  { tool: "line", icon: "minus", label: "Line", key: "L", group: 3 },
  { tool: "arrow", icon: "arrow-right", label: "Arrow", key: "A", group: 3 },
];

/** Each tool remembers its own colour, width and opacity, the way every drawing
 *  app does — a 16pt marker and a 2pt pen are not the same setting wearing a
 *  different hat, and having one clobber the other is maddening. */
const DEFAULT_STYLES: Record<string, Style> = {
  pen: { stroke: "#9061ff", w: 2.4, brush: "pen", opacity: 1 },
  eraser: { stroke: "#8b8b8b", w: 16 },
  marker: { stroke: "#d29922", w: 14, brush: "marker", opacity: 0.4 },
  pencil: { stroke: "#1f2328", w: 1.6, brush: "pencil", opacity: 0.85 },
  highlight: { stroke: "#f2e14c", opacity: 0.35 },
  // The paper colour rides in `stroke` rather than `fill` so that the puck, the
  // quick swatches and the recent-colours list all reach it without knowing
  // covers exist — every one of them writes `stroke`. What it *paints* is the
  // fill; `applyShape` is the one place that has to know the difference.
  cover: { stroke: "#ffe9a3", opacity: 1 },
  text: { stroke: "#9061ff", size: 14 },
  rect: { stroke: "#e5534b", w: 2, fill: null },
  ellipse: { stroke: "#9061ff", w: 2, fill: null },
  line: { stroke: "#1f2328", w: 2 },
  arrow: { stroke: "#9061ff", w: 2 },
};

const QUICK_COLOURS = ["#9061ff", "#e5534b", "#3fb950", "#d29922", "#2f81f7", "#1f2328"];

/** What a selection of the PDF's own text can be turned into.
 *
 *  A highlight takes the highlighter's colour and a rule takes the line tool's,
 *  because a hairline in highlighter yellow is not an underline anybody wanted.
 */
type MarkKind = "highlight" | "underline" | "strike";

const MARKS: { kind: MarkKind; icon: string; label: string }[] = [
  { kind: "highlight", icon: "highlighter", label: "Highlight" },
  { kind: "underline", icon: "underline", label: "Underline" },
  { kind: "strike", icon: "strikethrough", label: "Strikethrough" },
];

const HANDLE_CURSORS: Record<string, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  start: "grab",
  end: "grab",
};

const isMac = (): boolean => navigator.platform.toLowerCase().includes("mac");

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 8;
const ZOOM_STOPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];

/** How far outside the viewport a page still gets painted, as a multiple of the
 *  viewport height. One screen either way keeps a fast scroll ahead of itself
 *  without holding a whole textbook in memory. */
const PAINT_MARGIN = 1;

const THUMB_WIDTH = 108;

type FitMode = "width" | "page" | "free";
type ViewMode = "single" | "spread";

/** Shift-drag: square off a box, or snap a line to 45°. */
function constrain(type: ShapeType, x0: number, y0: number, x: number, y: number): { x: number; y: number } {
  if (isLineLike(type)) {
    const dx = x - x0;
    const dy = y - y0;
    const angle = (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI) / 4;
    const length = Math.hypot(dx, dy);
    return { x: x0 + Math.cos(angle) * length, y: y0 + Math.sin(angle) * length };
  }
  const side = Math.max(Math.abs(x - x0), Math.abs(y - y0));
  return { x: x0 + Math.sign(x - x0 || 1) * side, y: y0 + Math.sign(y - y0 || 1) * side };
}

/** What a drag does to one object: a new geometry, and — when the type is being
 *  scaled along with the box — the style that has to change with it. The two
 *  travel together because they are one edit and have to be one log line, or
 *  scrubbing back would land between a box and the size of the words in it. */
interface Patch {
  g: Geom;
  /** Only ever the type size, today. `samePatch` assumes that. */
  st?: Style;
}

/** What a pointer drag is currently doing.
 *
 *  `move` and `scale` carry a *list*, because a selection is a list: one object
 *  is the same code path with one member, which is the only way the two can
 *  stay in step. Each carries the geometries it started from, so a drag is
 *  always computed from where it began rather than accumulated frame by frame —
 *  accumulating drifts, and it makes an aborted drag unrecoverable. */
type Drag =
  | { kind: "draw"; surface: PageSurface; type: ShapeType; x0: number; y0: number; x1: number; y1: number }
  | { kind: "ink"; surface: PageSurface; points: InkPoint[]; el: SVGPathElement; speed: SpeedPressure; stylus: boolean }
  | { kind: "erase"; surface: PageSurface; hits: Set<string> }
  | {
      kind: "move";
      surface: PageSurface;
      objs: Obj[];
      starts: Geom[];
      dx: number;
      dy: number;
      /** Which member was actually pressed, and whether the press was additive:
       *  together they decide whether a click that moved nothing should narrow
       *  the selection down to that one object. */
      pressed: string;
      additive: boolean;
    }
  | { kind: "resize"; surface: PageSurface; obj: Obj; handle: string; g: Geom }
  | { kind: "scale"; surface: PageSurface; handle: string; from: Box; objs: Obj[]; starts: Geom[] }
  | { kind: "lasso"; surface: PageSurface; points: Point[]; el: SVGPathElement; x0: number; y0: number; box: boolean }
  | { kind: "pan"; x: number; y: number; left: number; top: number };

export class PalimpsestView extends FileView {
  allowNoFile = false;

  private events: LogEvent[] = [];
  private header: DocEvent | null = null;

  /** The two files this view is about. `logFile` is null until there is
   *  something to write, which is the whole point of opening a PDF here being
   *  free. Everything that writes goes through `ensureLog`. */
  private pdfFile: TFile | null = null;
  private logFile: TFile | null = null;

  private pdf: PdfDocument | null = null;
  private pdfPageCount = 0;
  private sizes: PageSize[] = [];

  private surfaces: PageSurface[] = [];
  private order: PageId[] = [];

  private scale = 1;
  private fit: FitMode = "width";
  private viewMode: ViewMode = "single";
  private currentPage = 0;

  private tool: Tool = "select";
  private styles: Record<string, Style> = structuredClone(DEFAULT_STYLES);
  private recents: string[] = [...QUICK_COLOURS];
  /** The selection, as a list. Always on one page: every group operation is
   *  defined by the box around the members, and a box spanning two pages of a
   *  scrolling column is not a box. */
  private selected: string[] = [];

  /** Covers currently lifted, by id.
   *
   *  Deliberately *not* in the log. A peek is a thing you do while reading, not
   *  an edit to the document: logged, every check of an answer would be two
   *  lines in the history and a flicker in the timelapse — and a problem set
   *  reopened next week would come back with every answer you had ever looked
   *  at already showing. Held here, the answers are covered again every time the
   *  file opens, which is the entire point. */
  private peeked = new Set<string>();

  /** How far along the timeline we are looking. null means "now". */
  private historyAt: number | null = null;
  private historyOpen = false;
  private chosenVersion: Version | null = null;

  /** Batches of event indices, so one gesture is one undo. */
  private undoStack: number[][] = [];
  private redoStack: number[][] = [];

  private undoButton: HTMLButtonElement | null = null;
  private redoButton: HTMLButtonElement | null = null;
  private deleteButton: HTMLButtonElement | null = null;

  private spaceHeld = false;

  private drag: Drag | null = null;
  /** True while a press that began a text selection is still down. The bar over
   *  a selection waits for the button to come up; one that follows the pointer
   *  mid-drag is a panel in the way of the thing you are selecting. */
  private selectionDragging = false;
  private selectionQueued = false;
  private editor: HTMLTextAreaElement | null = null;
  private closePuck: (() => void) | null = null;

  /** Unique per view, so two open documents cannot fight over SVG def ids. */
  private readonly uid = Math.random().toString(36).slice(2, 8);

  private rootEl!: HTMLElement;
  private toolbarEl!: HTMLElement;
  private historyBarEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private railEl!: HTMLElement;
  private stageEl!: HTMLElement;
  private docEl!: HTMLElement;
  private panelEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private findEl!: HTMLElement;
  private selectionBarEl!: HTMLElement;
  private pageInputEl!: HTMLInputElement;
  private pageTotalEl!: HTMLElement;
  private zoomLabelEl!: HTMLElement;
  private selectionCountEl!: HTMLElement;
  private studyEl!: HTMLElement;
  private studyLabelEl!: HTMLElement;
  private studyButton!: HTMLButtonElement;
  private puckEl!: HTMLButtonElement;
  private sizeLabelEl!: HTMLElement;
  private styleGroupEl!: HTMLElement;

  private watchingDisk = false;
  private watchingSelection = false;
  private lastFitWidth = 0;
  private scrollQueued = false;
  private railQueued = false;
  private lastWrite = 0;

  private plugin: PalimpsestPlugin;
  private plainAction: HTMLElement | null = null;
  private noteAction: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: PalimpsestPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_PALIMPSEST;
  }

  getDisplayText(): string {
    return this.file ? this.file.basename : "Palimpsest";
  }

  getIcon(): string {
    return "pen-line";
  }

  /** Either half of the pair opens here.
   *
   *  Opening the **PDF** is the normal way in: the tab keeps the PDF's name,
   *  the file explorer highlights the PDF, and the log stays an implementation
   *  detail — created on your first mark, not on arrival. Opening the `.palimpsest`
   *  log directly still works, for when you click one in the file explorer. */
  canAcceptExtension(extension: string): boolean {
    return extension === PALIMPSEST_EXT || extension === "pdf";
  }

  // ---------------------------------------------------------------- lifecycle

  async onLoadFile(file: TFile): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("palimpsest-root");
    this.rootEl = this.contentEl;
    this.buildChrome();

    this.undoStack = [];
    this.redoStack = [];
    this.selected = [];
    // Opening the document puts every cover back down. See `peeked`.
    this.peeked.clear();
    this.historyAt = null;

    // A leaf can open a second document without ever being destroyed, so
    // everything keyed to *this* document has to be cleared by hand.
    this.pool.clear();
    this.thumbs.clear();
    this.railBuilt = false;
    this.runsCache.clear();
    this.matches = [];
    this.matchAt = -1;
    this.surfaces = [];
    this.offsets = [];
    this.currentPage = 0;
    this.selectionDragging = false;
    this.invalidate();

    let pdfFile: TFile | null;

    if (file.extension === "pdf") {
      pdfFile = file;
      const beside = this.app.vault.getAbstractFileByPath(this.plugin.logPathFor(file));
      this.logFile = beside instanceof TFile ? beside : null;
      this.header = { v: 1, type: "doc", ts: Date.now(), pdf: file.path };
      this.events = this.logFile ? this.readLog(await this.app.vault.read(this.logFile)) : [];
    } else {
      this.logFile = file;
      const parsed = parseLog(await this.app.vault.read(file));
      this.header = parsed.header;
      this.events = parsed.events;
      if (parsed.bad.length) {
        new Notice(`Palimpsest: skipped ${parsed.bad.length} unreadable line(s) — see line ${parsed.bad[0]}`);
      }
      if (!this.header) {
        this.showError("This file has no `doc` header line, so there is no PDF to mark up.");
        return;
      }
      pdfFile = this.resolvePdf(this.header.pdf, file);
      if (!pdfFile) {
        this.showError(`Cannot find the PDF this markup belongs to: ${this.header.pdf}`);
        return;
      }
    }
    this.pdfFile = pdfFile;

    try {
      const bytes = await this.app.vault.readBinary(pdfFile);
      this.pdf = await openPdf(bytes);
      this.pdfPageCount = this.pdf.numPages;
      this.sizes = await pageSizes(this.pdf);
    } catch (error) {
      this.showError(`Could not open the PDF: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    this.addPlainPdfAction(pdfFile);
    this.addNoteAction(pdfFile);
    this.collectRecents();

    await this.rebuildDocument();
    this.applyFit("width");
    this.syncTimelineChrome();

    // obsidian-git and vault sync rewrite files underneath an open view. If the
    // log changes on disk and it was not us, reload rather than append onto a
    // stale picture of the file and produce a log with two competing tails.
    //
    // Bound once per view, not once per file: registerEvent only unhooks when
    // the view is destroyed, and a leaf outlives the documents opened in it.
    if (this.watchingDisk) return;
    this.watchingDisk = true;
    this.registerEvent(
      this.app.vault.on("modify", (changed) => {
        if (changed.path !== this.logFile?.path) return;
        if (Date.now() - this.lastWrite < 1500) return;
        void this.reloadFromDisk();
      }),
    );
  }

  private readLog(text: string): LogEvent[] {
    const parsed = parseLog(text);
    if (parsed.bad.length) {
      new Notice(`Palimpsest: skipped ${parsed.bad.length} unreadable line(s) — see line ${parsed.bad[0]}`);
    }
    return parsed.events;
  }

  private async reloadFromDisk(): Promise<void> {
    if (!this.logFile) return;
    const parsed = parseLog(await this.app.vault.read(this.logFile));
    if (parsed.events.length === this.events.length) return;
    this.events = parsed.events;
    this.undoStack = [];
    this.redoStack = [];
    new Notice("Palimpsest: the markup changed on disk — reloaded.");
    await this.rebuildDocument();
    this.syncTimelineChrome();
  }

  /** The PDF cannot carry tags or links itself; a companion note can. */
  private addNoteAction(pdf: TFile): void {
    if (this.noteAction) return;
    this.noteAction = this.addAction("links-coming-in", "Sync the note for this PDF (tags and links)", () => {
      void this.plugin.syncNote(pdf);
    });
  }

  /** Obsidian's viewer still has the outline, the embedded links and the PDF's
   *  own annotations. One button, so neither viewer is a trap. */
  private addPlainPdfAction(pdf: TFile): void {
    if (this.plainAction) return;
    this.plainAction = this.addAction("file-text", "Open the plain PDF (outline, embedded links)", () => {
      this.plugin.showPlainOnce(pdf.path);
      // Not `openFile`: this leaf may already hold this very PDF, and asking
      // for a file it already has is a no-op. Name the view instead.
      void this.leaf.setViewState({ type: "pdf", state: { file: pdf.path }, active: true });
    });
  }

  async onUnloadFile(): Promise<void> {
    this.closePuck?.();
    this.closePuck = null;
    this.editor?.remove();
    this.editor = null;
    for (const surface of this.surfaces) surface.destroy();
    this.surfaces = [];
    if (this.pdf) {
      this.pdf.destroy?.();
      this.pdf = null;
    }
    this.events = [];
    this.pdfFile = null;
    this.logFile = null;
    this.plainAction?.remove();
    this.plainAction = null;
    this.noteAction?.remove();
    this.noteAction = null;
    this.contentEl.empty();
  }

  /** The PDF is normally the same basename next to the log; the header path wins. */
  private resolvePdf(path: string, log: TFile): TFile | null {
    const byPath = this.app.vault.getAbstractFileByPath(path);
    if (byPath instanceof TFile) return byPath;

    const sibling = log.parent ? `${log.parent.path === "/" ? "" : `${log.parent.path}/`}${log.basename}.pdf` : null;
    if (sibling) {
      const found = this.app.vault.getAbstractFileByPath(sibling);
      if (found instanceof TFile) return found;
    }
    return null;
  }

  private showError(message: string): void {
    this.stageEl.empty();
    this.stageEl.createDiv({ cls: "palimpsest-error", text: message });
  }

  // ------------------------------------------------------------------- chrome

  private buildChrome(): void {
    this.toolbarEl = this.contentEl.createDiv({ cls: "palimpsest-toolbar" });
    this.historyBarEl = this.contentEl.createDiv({ cls: "palimpsest-historybar" });
    this.findEl = this.contentEl.createDiv({ cls: "palimpsest-find" });

    this.bodyEl = this.contentEl.createDiv({ cls: "palimpsest-body" });
    this.railEl = this.bodyEl.createDiv({ cls: "palimpsest-rail" });
    this.stageEl = this.bodyEl.createDiv({ cls: "palimpsest-stage" });
    this.docEl = this.stageEl.createDiv({ cls: "palimpsest-doc" });
    this.panelEl = this.bodyEl.createDiv({ cls: "palimpsest-panel" });

    this.selectionBarEl = this.bodyEl.createDiv({ cls: "palimpsest-selectionbar" });
    this.statusEl = this.contentEl.createDiv({ cls: "palimpsest-status" });

    this.contentEl.appendChild(this.buildDefs());
    this.buildToolbar();
    this.buildHistoryBar();
    this.buildFindBar();
    this.buildSelectionBar();
    this.buildStatusBar();

    // Selection lives on the document, not on any element of ours, so this is
    // the only signal that catches a keyboard selection and a click that
    // collapses one as well as the drag that made it.
    //
    // Bound once per view, not once per file: `registerDomEvent` only unhooks
    // when the view is destroyed, and a leaf outlives the documents opened in
    // it. Same reasoning as the disk watch in `onLoadFile`.
    if (!this.watchingSelection) {
      this.watchingSelection = true;
      this.registerDomEvent(document, "selectionchange", () => this.scheduleSelectionBar());
      this.registerDomEvent(document, "pointerup", () => {
        if (!this.selectionDragging) return;
        this.selectionDragging = false;
        this.scheduleSelectionBar();
      });
    }

    this.registerDomEvent(this.stageEl, "wheel", (event: WheelEvent) => this.onWheel(event), { passive: false });
    this.registerDomEvent(this.stageEl, "scroll", () => this.onScroll());
    this.registerDomEvent(this.contentEl, "keydown", (event) => this.onKeyDown(event));
    this.registerDomEvent(this.contentEl, "keyup", (event) => this.onKeyUp(event));
    this.contentEl.tabIndex = -1;

    // Space-drag panning, and middle-button panning, both from the stage.
    this.registerDomEvent(this.stageEl, "pointerdown", (event: PointerEvent) => {
      if (event.button !== 1 && !(this.spaceHeld || this.tool === "pan")) return;
      event.preventDefault();
      this.drag = {
        kind: "pan",
        x: event.clientX,
        y: event.clientY,
        left: this.stageEl.scrollLeft,
        top: this.stageEl.scrollTop,
      };
      this.stageEl.setPointerCapture(event.pointerId);
    });
    this.registerDomEvent(this.stageEl, "pointermove", (event: PointerEvent) => {
      if (this.drag?.kind !== "pan") return;
      this.stageEl.scrollLeft = this.drag.left - (event.clientX - this.drag.x);
      this.stageEl.scrollTop = this.drag.top - (event.clientY - this.drag.y);
    });
    this.registerDomEvent(this.stageEl, "pointerup", (event: PointerEvent) => {
      if (this.drag?.kind !== "pan") return;
      this.drag = null;
      this.stageEl.releasePointerCapture?.(event.pointerId);
    });

    // Fit when the stage's width actually changes — which covers the first
    // layout, a window resize, and Obsidian's own sidebars opening. Watching
    // `window.resize` alone misses all but the middle one, and a tab opened in
    // the background has no width to fit to at load.
    const observer = new ResizeObserver(() => {
      const width = this.stageEl.clientWidth;
      if (width === 0 || width === this.lastFitWidth) return;
      this.lastFitWidth = width;
      if (this.fit !== "free") this.applyFit(this.fit);
      else this.paintVisible();
    });
    observer.observe(this.stageEl);
    this.register(() => observer.disconnect());
  }

  /** One set of SVG defs for the whole view, referenced by every page's overlay.
   *  Ids carry the view's uid so two open documents cannot collide. */
  private buildDefs(): SVGSVGElement {
    const holder = document.createElementNS(SVG_NS, "svg");
    holder.addClass("palimpsest-defs");
    holder.setAttribute("width", "0");
    holder.setAttribute("height", "0");
    const defs = document.createElementNS(SVG_NS, "defs");

    const marker = document.createElementNS(SVG_NS, "marker");
    marker.setAttribute("id", this.arrowId);
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "9");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "6");
    marker.setAttribute("markerHeight", "6");
    marker.setAttribute("orient", "auto-start-reverse");
    marker.setAttribute("markerUnits", "strokeWidth");
    const head = document.createElementNS(SVG_NS, "path");
    head.setAttribute("d", "M 0 1 L 10 5 L 0 9 z");
    // Inherits whatever the line is stroked with, so one marker serves every colour.
    head.setAttribute("fill", "context-stroke");
    marker.appendChild(head);
    defs.appendChild(marker);

    // Pencil tooth. A pencil that is merely a thinner pen reads as a pen, and
    // the grain is most of what tells the two apart at a glance.
    const grain = document.createElementNS(SVG_NS, "filter");
    grain.setAttribute("id", this.grainId);
    grain.setAttribute("x", "-20%");
    grain.setAttribute("y", "-20%");
    grain.setAttribute("width", "140%");
    grain.setAttribute("height", "140%");
    const turbulence = document.createElementNS(SVG_NS, "feTurbulence");
    turbulence.setAttribute("type", "fractalNoise");
    turbulence.setAttribute("baseFrequency", "0.9");
    turbulence.setAttribute("numOctaves", "3");
    turbulence.setAttribute("result", "noise");
    const displace = document.createElementNS(SVG_NS, "feDisplacementMap");
    displace.setAttribute("in", "SourceGraphic");
    displace.setAttribute("in2", "noise");
    displace.setAttribute("scale", "1.6");
    displace.setAttribute("xChannelSelector", "R");
    displace.setAttribute("yChannelSelector", "G");
    grain.appendChild(turbulence);
    grain.appendChild(displace);
    defs.appendChild(grain);

    holder.appendChild(defs);
    return holder;
  }

  private get arrowId(): string {
    return `palimpsest-arrow-${this.uid}`;
  }

  private get grainId(): string {
    return `palimpsest-grain-${this.uid}`;
  }

  private buildToolbar(): void {
    const history = this.toolbarEl.createDiv({ cls: "palimpsest-group" });
    this.undoButton = this.iconButton(history, "undo-2", "Undo", "Mod Z", () => void this.undo());
    this.redoButton = this.iconButton(history, "redo-2", "Redo", "Mod Shift Z", () => void this.redo());
    // The Delete key was the only way to remove anything, which is no way at
    // all if you have not been told about it.
    this.deleteButton = this.iconButton(history, "trash-2", "Delete the selection", "Del", () =>
      void this.deleteSelection(),
    );

    let group = -1;
    let container: HTMLElement = this.toolbarEl;
    for (const entry of TOOLS) {
      if (entry.group !== group) {
        group = entry.group;
        this.separator();
        container = this.toolbarEl.createDiv({ cls: "palimpsest-group" });
      }
      const button = this.iconButton(container, entry.icon, entry.label, entry.key, () => this.pickTool(entry.tool));
      button.dataset.tool = entry.tool;
    }

    this.separator();

    this.styleGroupEl = this.toolbarEl.createDiv({ cls: "palimpsest-group palimpsest-style" });

    this.puckEl = this.styleGroupEl.createEl("button", {
      cls: "palimpsest-puck-button",
      attr: { "aria-label": "Colour, size and opacity" },
    });
    this.puckEl.createDiv({ cls: "palimpsest-puck-dot" });
    this.puckEl.onclick = () => this.togglePuck();

    for (const colour of QUICK_COLOURS) {
      const swatch = this.styleGroupEl.createEl("button", {
        cls: "palimpsest-swatch",
        attr: { "aria-label": colour },
      });
      swatch.style.background = colour;
      swatch.dataset.colour = colour;
      swatch.onclick = () => this.setColour(colour);
    }

    this.sizeLabelEl = this.styleGroupEl.createSpan({ cls: "palimpsest-label palimpsest-size", text: "" });

    const right = this.toolbarEl.createDiv({ cls: "palimpsest-group palimpsest-right" });
    const pages = this.iconButton(right, "panel-left", "Page thumbnails", "Mod \\", () => this.toggleRail());
    pages.dataset.toggle = "rail";
    const find = this.iconButton(right, "search", "Find in document", "Mod F", () => this.toggleFind());
    find.dataset.toggle = "find";
    const clock = this.iconButton(right, "history", "Version history", "", () => this.toggleHistory());
    clock.dataset.toggle = "history";
  }

  private buildHistoryBar(): void {
    const back = this.historyBarEl.createEl("button", { cls: "palimpsest-back" });
    setIcon(back.createSpan(), "arrow-left");
    back.createSpan({ text: "Back to editing" });
    back.onclick = () => this.closeHistory();

    this.historyBarEl.createDiv({ cls: "palimpsest-historybar-title", text: "Version history" });

    const restore = this.historyBarEl.createEl("button", {
      cls: "mod-cta palimpsest-restore",
      text: "Restore this version",
    });
    restore.onclick = () => void this.restoreChosen();
  }

  private buildStatusBar(): void {
    const left = this.statusEl.createDiv({ cls: "palimpsest-group" });
    this.iconButton(left, "chevron-up", "Previous page", "", () => this.goToPage(this.currentPage - 1));
    this.pageInputEl = left.createEl("input", {
      cls: "palimpsest-page-input",
      attr: { type: "text", inputmode: "numeric", "aria-label": "Page number" },
    });
    this.pageTotalEl = left.createSpan({ cls: "palimpsest-label", text: "of 0" });
    this.selectionCountEl = left.createSpan({ cls: "palimpsest-label palimpsest-count", text: "" });
    this.iconButton(left, "chevron-down", "Next page", "", () => this.goToPage(this.currentPage + 1));

    this.pageInputEl.onchange = () => {
      const wanted = parseInt(this.pageInputEl.value, 10);
      if (Number.isFinite(wanted)) this.goToPage(wanted - 1);
      else this.syncStatus();
    };
    this.pageInputEl.onkeydown = (event) => {
      event.stopPropagation();
      if (event.key === "Enter") this.pageInputEl.blur();
    };

    // How the practice is going, on a document that has any. Hidden entirely
    // otherwise — see `syncStudy`.
    this.studyEl = this.statusEl.createDiv({ cls: "palimpsest-group palimpsest-study" });
    setIcon(this.studyEl.createSpan({ cls: "palimpsest-study-icon" }), "sticky-note");
    this.studyLabelEl = this.studyEl.createSpan({ cls: "palimpsest-label" });
    this.studyButton = this.iconButton(this.studyEl, "eye", "Show every answer", "", () => this.setAllPeeked(true));

    const right = this.statusEl.createDiv({ cls: "palimpsest-group palimpsest-right" });

    const mode = right.createEl("select", { cls: "palimpsest-select dropdown" });
    for (const [value, label] of [
      ["single", "Single column"],
      ["spread", "Two pages"],
    ] as const) {
      mode.createEl("option", { value, text: label });
    }
    mode.onchange = () => {
      this.viewMode = mode.value as ViewMode;
      this.docEl.toggleClass("is-spread", this.viewMode === "spread");
      this.applyFit(this.fit === "free" ? "width" : this.fit);
    };

    this.iconButton(right, "zoom-out", "Zoom out", "Mod -", () => this.zoomStep(-1));
    this.zoomLabelEl = right.createSpan({ cls: "palimpsest-label palimpsest-zoom", text: "100%" });
    this.zoomLabelEl.onclick = () => this.applyFit(this.fit === "width" ? "page" : "width");
    setTooltip(this.zoomLabelEl, "Fit width / fit page");
    this.iconButton(right, "zoom-in", "Zoom in", "Mod +", () => this.zoomStep(1));
  }

  private iconButton(
    parent: HTMLElement,
    icon: string,
    label: string,
    shortcut: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const hint = shortcut ? `${label}  ${shortcut.replace("Mod", isMac() ? "⌘" : "Ctrl")}` : label;
    const button = parent.createEl("button", { cls: "palimpsest-tool", attr: { "aria-label": hint } });
    setIcon(button, icon);
    setTooltip(button, hint);
    button.onclick = onClick;
    return button;
  }

  private separator(parent: HTMLElement = this.toolbarEl): void {
    parent.createDiv({ cls: "palimpsest-sep" });
  }

  // -------------------------------------------------------------------- tools

  private get styleOf(): Style {
    const key = this.styleKey(this.tool);
    if (!this.styles[key]) this.styles[key] = { stroke: QUICK_COLOURS[0], w: 2 };
    return this.styles[key];
  }

  private styleKey(tool: Tool): string {
    return tool === "select" || tool === "pan" || tool === "lasso" ? "pen" : tool;
  }

  private pickTool(tool: Tool): void {
    // Reaching for the highlighter with words already selected means highlight
    // *those words*. Picking the tool up instead would throw the selection away
    // and ask you to draw by hand the box you had just chosen exactly.
    if (tool === "highlight" && !this.readOnly && this.hasTextSelection()) {
      void this.markSelection("highlight");
      return;
    }
    // Same rule for the cover, and it is the fast way to set a worked-solutions
    // PDF up: select the answer, press C, scroll on.
    if (tool === "cover" && !this.readOnly && this.hasTextSelection()) {
      void this.coverSelection();
      return;
    }
    this.commitEditor();
    this.tool = tool;
    if (tool !== "select" && tool !== "lasso") {
      this.selected = [];
      this.clearTextSelection();
    }
    this.syncToolbar();
    this.syncOverlays();
  }

  private setColour(colour: string): void {
    this.styleOf.stroke = colour;
    this.remember(colour);
    this.syncToolbar();
    if (this.selected.length) void this.applyStyleToSelection({ stroke: colour });
  }

  private remember(colour: string): void {
    this.recents = [colour, ...this.recents.filter((c) => c !== colour)].slice(0, 12);
  }

  /** Seed the recents from what is already on the page, so reopening a document
   *  picks up where you left off rather than showing six defaults. */
  private collectRecents(): void {
    const used = new Map<string, number>();
    for (const obj of replay(this.events, this.pdfPageCount).objects) {
      const stroke = obj.st.stroke;
      if (stroke) used.set(stroke, (used.get(stroke) ?? 0) + 1);
    }
    const ranked = [...used.entries()].sort((a, b) => b[1] - a[1]).map(([colour]) => colour);
    this.recents = [...ranked, ...QUICK_COLOURS.filter((c) => !ranked.includes(c))].slice(0, 12);
  }

  /** What the style controls are talking about.
   *
   *  With something selected, they mean *that*: choosing a text box and moving
   *  the size control has to change that box's type, not the pen's width, and
   *  the puck has to open showing the number it is about to change. With
   *  nothing selected they mean the tool in hand, as they always did. */
  private get styleTarget(): { style: Style; isText: boolean } {
    const chosen = this.chosen(this.state().objects);
    if (chosen.length) return { style: chosen[0].st, isText: chosen.every((obj) => obj.type === "text") };
    return { style: this.styleOf, isText: this.tool === "text" };
  }

  private togglePuck(): void {
    if (this.closePuck) {
      this.closePuck();
      this.closePuck = null;
      return;
    }
    // Read from whatever is selected; write back to the tool as well, so the
    // next thing you draw picks up the size you just chose.
    const target = this.styleTarget;
    const style = this.styleOf;
    const isText = target.isText;
    this.closePuck = openPuck(this.puckEl, {
      colour: target.style.stroke ?? QUICK_COLOURS[0],
      opacity: target.style.opacity ?? 1,
      size: isText ? (target.style.size ?? 14) : (target.style.w ?? 2),
      recents: this.recents,
      showOpacity: !isText,
      onColour: (hex) => this.setColour(hex),
      onOpacity: (value) => {
        style.opacity = value;
        this.syncToolbar();
        if (this.selected.length) void this.applyStyleToSelection({ opacity: value });
      },
      onSize: (value) => {
        if (isText) style.size = value;
        else style.w = value;
        this.syncToolbar();
        if (this.selected.length) void this.applyStyleToSelection(isText ? { size: value } : { w: value });
      },
    });
  }

  private syncToolbar(): void {
    this.toolbarEl.findAll(".palimpsest-tool").forEach((button) => {
      const element = button as HTMLElement;
      if (element.dataset.tool) element.toggleClass("is-active", element.dataset.tool === this.tool);
      if (element.dataset.toggle === "rail") element.toggleClass("is-active", this.rootEl.hasClass("is-rail"));
      if (element.dataset.toggle === "find") element.toggleClass("is-active", this.rootEl.hasClass("is-find"));
      if (element.dataset.toggle === "history") element.toggleClass("is-active", this.historyOpen);
    });

    const { style, isText } = this.styleTarget;
    const dot = this.puckEl.querySelector(".palimpsest-puck-dot") as HTMLElement | null;
    if (dot) {
      dot.style.background = style.stroke ?? QUICK_COLOURS[0];
      dot.style.opacity = String(style.opacity ?? 1);
    }
    this.styleGroupEl.findAll(".palimpsest-swatch").forEach((button) => {
      const element = button as HTMLElement;
      element.toggleClass("is-active", element.dataset.colour === style.stroke);
    });
    this.sizeLabelEl.setText(isText ? `${style.size ?? 14} pt` : `${style.w ?? 2} pt`);

    // Colour and size mean nothing with no tool in hand and nothing selected.
    const idle = this.tool === "select" || this.tool === "pan" || this.tool === "lasso";
    this.styleGroupEl.toggleClass("is-dim", idle && this.selected.length === 0);
    this.deleteButton?.toggleClass("is-disabled", this.selected.length === 0 || this.readOnly);
    this.syncSelectionCount();
    this.rootEl.dataset.tool = this.tool;
    this.syncHistoryButtons();
  }

  // ----------------------------------------------------------------- document

  /** Replay is not free on a long log and the pointer handlers ask for it
   *  constantly, so it is memoised against the only two things that change it. */
  private stateCache: { length: number; at: number | null; value: ReturnType<typeof replay> } | null = null;

  /** Editing is off while the history panel is open, whichever version is
   *  selected. Gating on `historyAt` alone let you draw on the live document
   *  from inside the history view, with the toolbar hidden. */
  private get readOnly(): boolean {
    return this.historyOpen || this.historyAt !== null;
  }

  private state(): ReturnType<typeof replay> {
    const length = this.events.length;
    const at = this.historyAt;
    if (this.stateCache && this.stateCache.length === length && this.stateCache.at === at) {
      return this.stateCache.value;
    }
    const value = replay(this.events, this.pdfPageCount, at ?? undefined);
    this.stateCache = { length, at, value };
    return value;
  }

  private invalidate(): void {
    this.stateCache = null;
  }

  private sizeOf(id: PageId): PageSize {
    const original = /^o(\d+)$/.exec(id);
    if (original) return this.sizes[Number(original[1])] ?? this.sizes[0] ?? { width: 612, height: 792 };
    return this.sizes[0] ?? { width: 612, height: 792 };
  }

  private pool = new Map<PageId, PageSurface>();
  private offsets: { top: number; bottom: number }[] = [];

  /** Bring the column of pages in line with the replayed page order. */
  private async rebuildDocument(): Promise<void> {
    if (!this.pdf) return;
    const { order } = this.state();
    this.order = order;

    const live = new Set(order);
    for (const [id, surface] of this.pool) {
      if (live.has(id)) continue;
      surface.destroy();
      this.pool.delete(id);
    }

    this.surfaces = order.map((id) => {
      let surface = this.pool.get(id);
      if (!surface) {
        surface = new PageSurface(id, this.sizeOf(id));
        this.bindSurface(surface);
        this.pool.set(id, surface);
      }
      return surface;
    });

    // Re-append in order. Appending a node already in the right place is a
    // no-op in every engine, so this is cheap even on a long document.
    this.surfaces.forEach((surface, index) => {
      this.docEl.appendChild(surface.el);
      surface.setNumber(index, order.length);
    });

    this.layoutAll();
    this.syncOverlays();
    this.paintVisible();
    this.scheduleRail();
    this.syncStatus();
  }

  private layoutAll(): void {
    for (const surface of this.surfaces) surface.layout(this.scale);
    this.offsets = this.surfaces.map((surface) => ({
      top: surface.el.offsetTop,
      bottom: surface.el.offsetTop + surface.el.offsetHeight,
    }));
    // The bar is placed against the viewport, so a zoom moves the words out
    // from under it.
    this.scheduleSelectionBar();
  }

  private onScroll(): void {
    if (this.scrollQueued) return;
    this.scrollQueued = true;
    window.requestAnimationFrame(() => {
      this.scrollQueued = false;
      this.paintVisible();
      this.trackCurrentPage();
      this.scheduleSelectionBar();
    });
  }

  private paintVisible(): void {
    if (!this.pdf) return;
    const height = this.stageEl.clientHeight;
    const top = this.stageEl.scrollTop - height * PAINT_MARGIN;
    const bottom = this.stageEl.scrollTop + height * (1 + PAINT_MARGIN);

    for (let i = 0; i < this.surfaces.length; i++) {
      const surface = this.surfaces[i];
      const box = this.offsets[i];
      if (!box) continue;
      const visible = box.bottom >= top && box.top <= bottom;
      if (visible) {
        if (surface.needsRepaint || surface.staleAt(this.scale)) void surface.paint(this.pdf, this.scale);
        if (surface.text.isEmpty) void this.fillTextLayer(surface);
      } else {
        surface.release();
      }
    }
  }

  private trackCurrentPage(): void {
    const line = this.stageEl.scrollTop + 8;
    let current = 0;
    for (let i = 0; i < this.offsets.length; i++) {
      if (this.offsets[i].bottom > line) {
        current = i;
        break;
      }
      current = i;
    }
    if (current === this.currentPage) return;
    this.currentPage = current;
    this.syncStatus();
    this.markRailCurrent();
  }

  private goToPage(index: number): void {
    const clamped = Math.max(0, Math.min(index, this.surfaces.length - 1));
    const box = this.offsets[clamped];
    if (!box) return;
    this.stageEl.scrollTop = box.top - 14;
    this.currentPage = clamped;
    this.syncStatus();
    this.markRailCurrent();
  }

  private syncStatus(): void {
    this.pageInputEl.value = String(this.currentPage + 1);
    this.pageTotalEl.setText(`of ${this.surfaces.length}`);
    this.zoomLabelEl.setText(`${Math.round(this.scale * 100)}%`);
  }

  // --------------------------------------------------------------------- zoom

  private onWheel(event: WheelEvent): void {
    if (!event.ctrlKey && !event.metaKey) return; // plain scroll still scrolls
    event.preventDefault();
    // Trackpad pinch arrives as a fine-grained ctrl+wheel; a mouse wheel as
    // coarse steps. Scaling by the delta keeps both feeling proportionate.
    const factor = Math.exp(-event.deltaY / 340);
    this.setScale(this.scale * factor, event);
  }

  private zoomStep(direction: number): void {
    const stops = ZOOM_STOPS;
    const next =
      direction > 0
        ? (stops.find((stop) => stop > this.scale + 0.001) ?? ZOOM_MAX)
        : ([...stops].reverse().find((stop) => stop < this.scale - 0.001) ?? ZOOM_MIN);
    this.setScale(next);
  }

  private setScale(value: number, anchor?: { clientX: number; clientY: number }): void {
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
    if (Math.abs(clamped - this.scale) < 0.0005) return;

    // Keep whatever is under the pointer under the pointer. Zooming to the
    // top-left corner is the thing that makes a viewer feel homemade.
    const rect = this.stageEl.getBoundingClientRect();
    const ax = anchor ? anchor.clientX - rect.left : this.stageEl.clientWidth / 2;
    const ay = anchor ? anchor.clientY - rect.top : this.stageEl.clientHeight / 2;
    const beforeX = this.stageEl.scrollLeft + ax;
    const beforeY = this.stageEl.scrollTop + ay;
    const ratio = clamped / this.scale;

    this.scale = clamped;
    this.fit = "free";
    this.moveEditorWithZoom();
    this.layoutAll();
    this.stageEl.scrollLeft = beforeX * ratio - ax;
    this.stageEl.scrollTop = beforeY * ratio - ay;
    this.syncOverlays();
    this.paintVisible();
    this.syncStatus();
  }

  private applyFit(mode: FitMode): void {
    if (mode === "free" || this.surfaces.length === 0) return;
    const columns = this.viewMode === "spread" ? 2 : 1;
    const gutter = 28 * columns + 24;
    const availableWidth = this.stageEl.clientWidth - gutter;
    const availableHeight = this.stageEl.clientHeight - 34;
    if (availableWidth <= 0) return;

    const widest = this.surfaces.reduce((max, surface) => Math.max(max, surface.size.width), 1);
    const tallest = this.surfaces.reduce((max, surface) => Math.max(max, surface.size.height), 1);

    const byWidth = availableWidth / columns / widest;
    const scale = mode === "width" ? byWidth : Math.min(byWidth, availableHeight / tallest);

    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
    this.lastFitWidth = this.stageEl.clientWidth;
    const keep = this.currentPage;
    this.scale = clamped;
    this.layoutAll();
    this.fit = mode;
    this.goToPage(keep);
    this.syncOverlays();
    this.paintVisible();
    this.syncStatus();
  }

  // ------------------------------------------------------------------ writing

  /** The only way anything reaches the file.
   *
   *  Takes a list, and writes it as one batch: erasing eight strokes or
   *  restoring a version is a single act and has to be a single undo. */
  private async append(events: LogEvent | LogEvent[], track: "user" | "undo" | "redo" = "user"): Promise<void> {
    const list = Array.isArray(events) ? events : [events];
    if (list.length === 0) return;

    const log = await this.ensureLog();
    // `this.file` may be the PDF. Appending JSONL to it would destroy the one
    // thing this plugin promises never to touch, so check what we are holding.
    if (!log || log.extension !== PALIMPSEST_EXT) return;

    const indices = list.map((_, offset) => this.events.length + offset);
    this.events.push(...list);
    this.invalidate();

    this.lastWrite = Date.now();
    await this.app.vault.append(log, `${list.map(serialise).join("\n")}\n`);
    this.lastWrite = Date.now();

    if (track === "user") {
      this.undoStack.push(indices);
      this.redoStack.length = 0;
    } else if (track === "undo") {
      this.redoStack.push(indices);
    } else {
      this.undoStack.push(indices);
    }

    const touchesPages = list.some((event) => event.type.startsWith("page."));
    if (touchesPages) await this.rebuildDocument();
    else this.syncOverlays();

    this.syncTimelineChrome();
    this.syncHistoryButtons();
  }

  /** The sidecar, created the first time there is something to put in it.
   *
   *  Opening a PDF in Palimpsest writes nothing. That is what makes "open every
   *  PDF here" a reasonable default rather than a way to litter a course folder
   *  with empty logs for every slide deck you glanced at. */
  private async ensureLog(): Promise<TFile | null> {
    if (this.logFile) return this.logFile;
    const pdf = this.pdfFile;
    if (!pdf) return null;

    const path = this.plugin.logPathFor(pdf);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      this.logFile = existing;
      return existing;
    }
    try {
      this.logFile = await this.app.vault.create(path, newLogContents(pdf.path));
    } catch (error) {
      new Notice(`Palimpsest: could not create ${path} — ${error instanceof Error ? error.message : error}`);
      return null;
    }
    return this.logFile;
  }

  private syncHistoryButtons(): void {
    this.undoButton?.toggleClass("is-disabled", this.undoStack.length === 0);
    this.redoButton?.toggleClass("is-disabled", this.redoStack.length === 0);
    this.deleteButton?.toggleClass("is-disabled", this.selected.length === 0 || this.readOnly);
  }

  /** Undo by appending the inverse. Popping the last line would be simpler and
   *  would throw away the history the whole plugin is for. */
  private async undo(): Promise<void> {
    if (this.readOnly) {
      new Notice("Palimpsest: you are looking at the version history. Go back to editing first.");
      return;
    }
    const batch = this.undoStack.pop();
    if (!batch) {
      new Notice("Palimpsest: nothing to undo.");
      return;
    }
    // Reverse order: the last thing done is the first thing taken back.
    const inverses: LogEvent[] = [];
    for (const index of [...batch].reverse()) {
      const inverse = inverseOf(this.events, index, this.pdfPageCount);
      if (inverse) inverses.push(inverse);
    }
    if (inverses.length === 0) {
      new Notice("Palimpsest: that edit cannot be undone.");
      return;
    }
    this.selected = [];
    await this.append(inverses, "undo");
  }

  private async redo(): Promise<void> {
    if (this.readOnly) return;
    const batch = this.redoStack.pop();
    if (!batch) {
      new Notice("Palimpsest: nothing to redo.");
      return;
    }
    const inverses: LogEvent[] = [];
    for (const index of [...batch].reverse()) {
      const inverse = inverseOf(this.events, index, this.pdfPageCount);
      if (inverse) inverses.push(inverse);
    }
    if (inverses.length === 0) return;
    this.selected = [];
    await this.append(inverses, "redo");
  }

  private async applyStyleToSelection(patch: Style): Promise<void> {
    if (this.selected.length === 0 || this.readOnly) return;
    const ts = Date.now();
    // Restyling six shapes is one thing you did, so it is one line of undo.
    await this.append(this.selected.map((ref) => ({ id: mintId(), ts, type: "obj.edit" as const, ref, st: patch })));
  }

  // ---------------------------------------------------------------- rendering

  private syncOverlays(): void {
    const { objects } = this.state();
    const byPage = new Map<PageId, Obj[]>();
    for (const obj of objects) {
      const list = byPage.get(obj.page);
      if (list) list.push(obj);
      else byPage.set(obj.page, [obj]);
    }
    for (const surface of this.surfaces) this.syncOverlay(surface, byPage.get(surface.id) ?? []);
    this.rootEl.toggleClass("is-history", this.historyAt !== null);
    this.rootEl.toggleClass("is-readonly", this.readOnly);
    this.syncStudy(objects);
  }

  /** Reconcile one page's overlay against the objects that belong on it.
   *
   *  Elements persist across updates and are matched by id. This is not just
   *  faster than emptying the SVG — it is what makes double-click work at all,
   *  because a node detached during a gesture kills the click that follows. */
  private syncOverlay(surface: PageSurface, objects: Obj[]): void {
    const svg = surface.svg;
    const wanted = new Set(objects.map((obj) => obj.id));

    for (const child of Array.from(svg.children)) {
      const id = (child as SVGElement).dataset?.id;
      if (id && !wanted.has(id)) child.remove();
    }

    let previous: Element | null = null;
    for (const obj of objects) {
      const selector = `[data-id="${cssEscape(obj.id)}"]`;
      let element = svg.querySelector(selector) as SVGGraphicsElement | null;
      if (element && element.tagName !== tagFor(obj.type)) {
        element.remove();
        element = null;
      }
      if (!element) {
        element = document.createElementNS(SVG_NS, tagFor(obj.type)) as SVGGraphicsElement;
        element.dataset.id = obj.id;
        element.addClass("palimpsest-shape");
      }
      this.applyShape(element, obj);
      // Working written on a cover fades when that cover is lifted, so the
      // answer underneath is the clear thing and your attempt is a ghost over
      // it. A CSS `opacity` rather than the attribute the shape sets for
      // itself: presentation attributes lose to any rule, so this composites on
      // top of whatever the stroke's own opacity already was.
      element.toggleClass("is-under-peek", obj.on !== undefined && this.peeked.has(obj.on));

      const shouldFollow: Node | null = previous ? previous.nextSibling : svg.firstChild;
      if (element !== shouldFollow) svg.insertBefore(element, shouldFollow);
      previous = element;
    }

    this.paintSelection(surface, objects);
  }

  private applyShape(element: SVGGraphicsElement, obj: Obj): void {
    const g = obj.g;
    const stroke = obj.st.stroke ?? QUICK_COLOURS[0];
    const width = obj.st.w ?? 2;
    element.removeClass("palimpsest-highlight");
    element.removeClass("palimpsest-text");
    element.removeClass("palimpsest-ink");
    element.removeClass("palimpsest-cover");
    element.style.removeProperty("filter");

    switch (obj.type) {
      case "cover":
        this.applyCover(element, obj);
        return;
      case "rect":
      case "highlight": {
        set(element, {
          x: g.x ?? 0,
          y: g.y ?? 0,
          width: Math.max(0, g.w ?? 0),
          height: Math.max(0, g.h ?? 0),
        });
        if (obj.type === "highlight") {
          element.setAttribute("fill", stroke);
          element.setAttribute("stroke", "none");
          element.setAttribute("opacity", String(obj.st.opacity ?? 0.35));
          element.addClass("palimpsest-highlight");
        } else {
          element.setAttribute("fill", obj.st.fill ?? "none");
          element.setAttribute("stroke", stroke);
          element.setAttribute("stroke-width", String(width));
          element.setAttribute("opacity", String(obj.st.opacity ?? 1));
        }
        return;
      }
      case "ellipse": {
        set(element, {
          cx: (g.x ?? 0) + (g.w ?? 0) / 2,
          cy: (g.y ?? 0) + (g.h ?? 0) / 2,
          rx: Math.max(0, (g.w ?? 0) / 2),
          ry: Math.max(0, (g.h ?? 0) / 2),
        });
        element.setAttribute("fill", obj.st.fill ?? "none");
        element.setAttribute("stroke", stroke);
        element.setAttribute("stroke-width", String(width));
        element.setAttribute("opacity", String(obj.st.opacity ?? 1));
        return;
      }
      case "line":
      case "arrow": {
        set(element, { x1: g.x1 ?? 0, y1: g.y1 ?? 0, x2: g.x2 ?? 0, y2: g.y2 ?? 0 });
        element.setAttribute("stroke", stroke);
        element.setAttribute("stroke-width", String(width));
        element.setAttribute("stroke-linecap", "round");
        element.setAttribute("opacity", String(obj.st.opacity ?? 1));
        if (obj.type === "arrow") element.setAttribute("marker-end", `url(#${this.arrowId})`);
        else element.removeAttribute("marker-end");
        return;
      }
      case "ink": {
        const points = unpackPoints(g.p);
        element.setAttribute("d", outlinePath(points, width, obj.st.brush ?? "pen"));
        element.setAttribute("fill", stroke);
        element.setAttribute("fill-opacity", String(obj.st.opacity ?? 1));
        element.setAttribute("stroke", "none");
        element.addClass("palimpsest-ink");
        if ((obj.st.brush ?? "pen") === "marker") element.addClass("palimpsest-highlight");
        if ((obj.st.brush ?? "pen") === "pencil") element.style.filter = `url(#${this.grainId})`;
        return;
      }
      case "text": {
        const style = { size: obj.st.size ?? 14, bold: obj.st.bold, italic: obj.st.italic };
        const box = layoutText(obj.s ?? "", g.w, style);
        element.setAttribute("fill", stroke);
        element.setAttribute("font-size", String(style.size));
        element.setAttribute("font-family", TEXT_FONT);
        element.setAttribute("font-weight", style.bold ? "700" : "400");
        element.setAttribute("font-style", style.italic ? "italic" : "normal");
        element.setAttribute("opacity", String(obj.st.opacity ?? 1));
        element.addClass("palimpsest-text");
        element.toggleClass("is-editing", this.editingId === obj.id);

        while (element.firstChild) element.removeChild(element.firstChild);
        box.lines.forEach((line, index) => {
          const span = document.createElementNS(SVG_NS, "tspan");
          span.setAttribute("x", String(g.x ?? 0));
          // Hanging baseline on the first line, then a full line box each time,
          // so the SVG and the textarea sit on exactly the same rows.
          span.setAttribute("y", String((g.y ?? 0) + box.lineHeight * (index + 0.79)));
          span.textContent = line === "" ? " " : line;
          element.appendChild(span);
        });
        return;
      }
    }
  }

  /** A cover: paper, a dog-ear to lift it by, and — once lifted — a tick and a
   *  cross to say how you did.
   *
   *  Lifted does not mean *gone*. The paper drops to a wash and the working you
   *  wrote on it fades with it (`syncOverlay` marks those), so the printed
   *  answer comes through as the clear thing with your attempt ghosted over it
   *  in place. That is the comparison you actually wanted — the alternative,
   *  hiding the cover outright, takes your working away at exactly the moment
   *  you want to hold it against the answer.
   */
  private applyCover(element: SVGGraphicsElement, obj: Obj): void {
    const box = asBox(this.boxOf(obj));
    const paper = obj.st.stroke ?? "#ffe9a3";
    const edge = shade(paper);
    const peeked = this.peeked.has(obj.id);
    const live = !this.readOnly;

    element.addClass("palimpsest-cover");
    element.toggleClass("is-peeked", peeked);
    element.setAttribute("opacity", String(obj.st.opacity ?? 1));

    // Reused rather than rebuilt, for the reason at the top of this file: the
    // overlay reconciles, it does not re-create. A page of forty covers is two
    // hundred child nodes, and a zoom gesture syncs the overlay on every wheel
    // tick — tearing them all down and building them again each time is the
    // difference between a smooth pinch and a stuttering one.
    const part = (tag: "rect" | "path" | "g", cls: string): SVGElement => {
      const found = element.querySelector(`:scope > .${cls}`) as SVGElement | null;
      if (found) return found;
      const made = document.createElementNS(SVG_NS, tag);
      made.addClass(cls);
      element.appendChild(made);
      return made;
    };
    const drop = (cls: string): void => element.querySelector(`:scope > .${cls}`)?.remove();

    const corner = peelCorner(box, this.scale);

    // The paper is a whole rectangle, and the dog-ear is drawn *on* it rather
    // than bitten out of it. Cutting the corner away is the truer picture of a
    // folded page and it is the wrong thing here: the notch would be a small
    // transparent triangle over the very answer this is covering, which on a
    // one-line result is a character or two of it showing. A cover that leaks
    // is not a cover.
    const sheet = part("rect", "palimpsest-cover-paper");
    set(sheet, { x: box.x, y: box.y, width: box.w, height: box.h });
    sheet.setAttribute("fill", paper);
    sheet.setAttribute("stroke", edge);
    sheet.setAttribute("stroke-width", String(0.75 / this.scale));

    // The corner you lift it by: a shaded triangle, so it reads as somewhere to
    // put your thumb rather than as decoration.
    const fold = part("path", "palimpsest-cover-peel");
    fold.setAttribute(
      "d",
      `M ${round(corner.x)} ${round(corner.y)} H ${round(corner.x + corner.w)} V ${round(corner.y + corner.h)} Z`,
    );
    fold.setAttribute("fill", shade(paper, 0.16));
    fold.setAttribute("stroke", edge);
    fold.setAttribute("stroke-width", String(0.75 / this.scale));

    // A graded cover keeps a coloured spine even when it is back down, so
    // finding the four you got wrong on a twelve-page problem set is a glance
    // rather than a hunt. A tick inside the paper would be invisible the moment
    // you wrote over it.
    if (obj.st.mark) {
      const spine = part("rect", "palimpsest-cover-spine");
      set(spine, { x: box.x, y: box.y, width: Math.min(2.5 / this.scale, box.w), height: box.h });
      spine.toggleClass("is-right", obj.st.mark === "right");
      spine.toggleClass("is-wrong", obj.st.mark === "wrong");
    } else {
      drop("palimpsest-cover-spine");
    }

    // Grading is offered exactly when you have just looked at the answer, which
    // is the only moment you know it.
    if (!peeked || !live) {
      drop("palimpsest-cover-right");
      drop("palimpsest-cover-wrong");
      return;
    }

    const zones = markZones(box, this.scale);
    const glyph = readableOn(paper);
    for (const [kind, zone] of [
      ["right", zones.right],
      ["wrong", zones.wrong],
    ] as const) {
      const button = part("g", `palimpsest-cover-${kind}`);
      button.addClass("palimpsest-cover-mark");
      button.addClass(kind === "right" ? "is-right" : "is-wrong");
      // Only the chosen one is filled in, so the pair reads as a decision you
      // made rather than two buttons that both look pressed.
      button.toggleClass("is-chosen", obj.st.mark === kind);

      let pad = button.firstElementChild as SVGElement | null;
      let tick = button.lastElementChild as SVGElement | null;
      if (!pad || pad === tick) {
        while (button.firstChild) button.removeChild(button.firstChild);
        pad = document.createElementNS(SVG_NS, "rect");
        tick = document.createElementNS(SVG_NS, "path");
        button.appendChild(pad);
        button.appendChild(tick);
      }

      set(pad, { x: zone.x, y: zone.y, width: zone.w, height: zone.h });
      pad.setAttribute("rx", String(round(zone.w * 0.28)));

      const inset = zone.w * 0.28;
      const left = zone.x + inset;
      const right = zone.x + zone.w - inset;
      const top = zone.y + inset;
      const bottom = zone.y + zone.h - inset;
      (tick as SVGElement).setAttribute(
        "d",
        kind === "right"
          ? `M ${round(left)} ${round(zone.y + zone.h * 0.54)} L ${round(zone.x + zone.w * 0.43)} ${round(bottom)} L ${round(right)} ${round(top)}`
          : `M ${round(left)} ${round(top)} L ${round(right)} ${round(bottom)} M ${round(right)} ${round(top)} L ${round(left)} ${round(bottom)}`,
      );
      (tick as SVGElement).setAttribute("stroke-width", String(round(Math.max(0.6, zone.w * 0.14))));
      // Chosen, the glyph goes white against a filled pad; unchosen, it takes
      // whichever of black or white can be read on this cover's own colour.
      (tick as SVGElement).setAttribute("stroke", obj.st.mark === kind ? "#ffffff" : glyph);
    }
  }

  /** `preview` is the geometry of a drag in flight, which the frame has to be
   *  drawn from rather than from what is still on file.
   *
   *  Rebuilding this group inside a pointer handler is safe, unlike rebuilding
   *  the shapes: since the text layer went on top, a press lands there and the
   *  pointer is captured by the overlay, so no handle is ever the target of the
   *  gesture being detached. */
  private paintSelection(surface: PageSurface, objects: Obj[], preview?: Map<string, Obj>): void {
    surface.svg.querySelector(".palimpsest-selection")?.remove();
    if (this.selected.length === 0 || this.historyAt !== null) return;

    const chosen = this.chosen(objects)
      .filter((obj) => obj.page === surface.id)
      .map((obj) => preview?.get(obj.id) ?? obj);
    if (chosen.length === 0) return;

    const group = document.createElementNS(SVG_NS, "g");
    group.addClass("palimpsest-selection");
    const pad = 3 / this.scale;

    const outline = (box: Geom, member: boolean): void => {
      const rect = document.createElementNS(SVG_NS, "rect");
      set(rect, {
        x: (box.x ?? 0) - pad,
        y: (box.y ?? 0) - pad,
        width: (box.w ?? 0) + pad * 2,
        height: (box.h ?? 0) + pad * 2,
      });
      rect.addClass("palimpsest-outline");
      if (member) rect.addClass("is-member");
      rect.setAttribute("stroke-width", String((member ? 1 : 1.4) / this.scale));
      group.appendChild(rect);
    };

    // Every member is outlined so you can see what you have got; the handles
    // belong to the box around all of them, because that box is the thing a
    // drag is going to resize.
    const many = chosen.length > 1;
    for (const obj of chosen) outline(this.boxOf(obj), many);
    if (many) outline(this.selectionBox(chosen), false);

    for (const [name, point] of Object.entries(this.handlesFor(chosen))) {
      const handle = document.createElementNS(SVG_NS, "rect");
      const size = 9 / this.scale;
      set(handle, { x: point.x - size / 2, y: point.y - size / 2, width: size, height: size });
      handle.setAttribute("rx", String(1.5 / this.scale));
      handle.setAttribute("stroke-width", String(1.2 / this.scale));
      handle.addClass("palimpsest-handle");
      handle.dataset.handle = name;
      handle.style.cursor = this.handleCursor(name, chosen);
      group.appendChild(handle);
    }

    surface.svg.appendChild(group);
  }

  /** Every grip on a text box does the same thing, so every one of them has to
   *  say the same thing. A corner promising `nwse-resize` on a box whose height
   *  it cannot touch is the cursor lying about the gesture. */
  private handleCursor(name: string, chosen: Obj[]): string {
    // A text box's sides only ever reflow, so they say so; its corners scale it
    // like anything else and take the ordinary diagonal cursor.
    if (chosen.length === 1 && chosen[0].type === "text" && (name === "w" || name === "e")) return "ew-resize";
    return HANDLE_CURSORS[name] ?? "pointer";
  }

  private isSelected(id: string): boolean {
    return this.selected.includes(id);
  }

  private chosen(objects: Obj[]): Obj[] {
    return objects.filter((obj) => this.isSelected(obj.id));
  }

  /** The box around a whole selection, in page coordinates. */
  private selectionBox(chosen: Obj[]): Box {
    const box = unionBox(chosen.map((obj) => asBox(this.boxOf(obj))));
    return box ?? { x: 0, y: 0, w: 0, h: 0 };
  }

  /** Handles for a selection: the object's own when there is one of it, and the
   *  eight round the group box when there are several. */
  private handlesFor(chosen: Obj[]): Record<string, { x: number; y: number }> {
    if (chosen.length === 1) return this.handles(chosen[0]);
    if (chosen.length === 0) return {};
    return boxHandles(this.selectionBox(chosen));
  }

  private handles(obj: Obj): Record<string, { x: number; y: number }> {
    if (isLineLike(obj.type)) {
      return {
        start: { x: obj.g.x1 ?? 0, y: obj.g.y1 ?? 0 },
        end: { x: obj.g.x2 ?? 0, y: obj.g.y2 ?? 0 },
      };
    }
    const box = asBox(this.boxOf(obj));

    // A text box resizes by wrap width, never by scaling the glyphs — dragging a
    // corner to make the words bigger is a thing only diagram tools do. But it
    // still gets corners, because two grips at the mid-height of a one-line box
    // are two grips nobody finds: a hand goes to the corner, and a corner that
    // is not there reads as "this cannot be resized". They set the width, same
    // as the sides, and the cursor says so. There is no `n` or `s`, because the
    // height is the wrapping's to decide and a grip that did nothing would be
    // worse than none.
    if (obj.type === "text") {
      const right = box.x + box.w;
      const middle = box.y + box.h / 2;
      const bottom = box.y + box.h;
      return {
        nw: { x: box.x, y: box.y },
        w: { x: box.x, y: middle },
        sw: { x: box.x, y: bottom },
        ne: { x: right, y: box.y },
        e: { x: right, y: middle },
        se: { x: right, y: bottom },
      };
    }
    return boxHandles(box);
  }

  /** Bounding box in page coordinates, computed rather than measured.
   *
   *  The old code read `getBBox()` off the live SVG, which meant hit testing
   *  depended on the element existing and on a layout pass having run. Text now
   *  lays out through the same module the editor uses, and ink knows its own
   *  extent, so every box is arithmetic. */
  private boxOf(obj: Obj): Geom {
    if (isLineLike(obj.type)) {
      return rectFromDrag(obj.g.x1 ?? 0, obj.g.y1 ?? 0, obj.g.x2 ?? 0, obj.g.y2 ?? 0);
    }
    if (isInk(obj.type)) {
      return inkBounds(unpackPoints(obj.g.p), obj.st.w ?? 2);
    }
    if (obj.type === "text") {
      const box = layoutText(obj.s ?? "", obj.g.w, {
        size: obj.st.size ?? 14,
        bold: obj.st.bold,
        italic: obj.st.italic,
      });
      return { x: obj.g.x ?? 0, y: obj.g.y ?? 0, w: box.width, h: box.height };
    }
    return { x: obj.g.x ?? 0, y: obj.g.y ?? 0, w: obj.g.w ?? 0, h: obj.g.h ?? 0 };
  }

  // ------------------------------------------------------------------ pointer

  private bindSurface(surface: PageSurface): void {
    const svg = surface.svg as unknown as HTMLElement;
    this.registerDomEvent(svg, "pointerdown", (event: PointerEvent) => this.onPointerDown(event, surface));
    this.registerDomEvent(svg, "pointermove", (event: PointerEvent) => this.onPointerMove(event, surface));
    this.registerDomEvent(svg, "pointerup", (event: PointerEvent) => void this.onPointerUp(event, surface));
    this.registerDomEvent(svg, "pointercancel", () => this.abortDrag());
    this.registerDomEvent(svg, "dblclick", (event: MouseEvent) => this.onDoubleClick(event, surface));
    this.registerDomEvent(svg, "contextmenu", (event: MouseEvent) => this.onContextMenu(event, surface));

    const text = surface.text.el;
    this.registerDomEvent(text, "pointerdown", (event: PointerEvent) => this.onTextPointerDown(event, surface));
    this.registerDomEvent(text, "pointermove", (event: PointerEvent) => this.onTextPointerMove(event, surface));
    this.registerDomEvent(text, "dblclick", (event: MouseEvent) => this.onTextDoubleClick(event, surface));
    this.registerDomEvent(text, "contextmenu", (event: MouseEvent) => this.onTextContextMenu(event, surface));
  }

  private toPage(event: { clientX: number; clientY: number }, surface: PageSurface): { x: number; y: number } {
    const rect = surface.svg.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / this.scale, y: (event.clientY - rect.top) / this.scale };
  }

  private onPointerDown(event: PointerEvent, surface: PageSurface): void {
    if (event.button === 1 || this.spaceHeld || this.tool === "pan") return; // the stage pans
    if (event.button !== 0) return;

    const at = this.toPage(event, surface);

    // A cover's own controls answer to whatever tool is in hand. You lift the
    // dog-ear to check an answer with the pen still held, mark it, and carry on
    // — putting the pen down and picking the select tool up first would be a
    // mode change in the middle of working a problem, four times per page.
    //
    // Before the read-only guard, because looking at an old version and lifting
    // a cover to read what is under it are both reading. Grading is not, and
    // `applyCover` does not draw the tick and cross there for that reason.
    const zone = this.studyZoneAt(at.x, at.y, this.state().objects, surface.id);
    if (zone) {
      this.contentEl.focus();
      void this.applyZone(zone.obj, zone.zone);
      return;
    }

    if (this.readOnly) {
      new Notice("Palimpsest: this is the version history. Go back to editing to draw.");
      return;
    }
    if (this.editor) this.commitEditor();

    this.contentEl.focus(); // otherwise Delete and the tool keys never reach us
    surface.svg.setPointerCapture(event.pointerId);
    const point = at;

    if (this.tool === "lasso") {
      const element = document.createElementNS(SVG_NS, "path") as SVGPathElement;
      element.addClass("palimpsest-lasso");
      surface.svg.appendChild(element);
      this.drag = {
        kind: "lasso",
        surface,
        points: [point],
        el: element,
        x0: point.x,
        y0: point.y,
        box: event.altKey,
      };
      return;
    }

    if (this.tool === "select") {
      const { objects } = this.state();
      const chosen = this.chosen(objects);
      const handle = this.handleAt(point.x, point.y, objects, surface.id);

      if (handle && chosen.length) {
        // One object resizes on its own terms — a line by its ends, a text box
        // by its wrap width. Several scale together inside their shared box.
        this.drag =
          chosen.length === 1
            ? { kind: "resize", surface, obj: chosen[0], handle, g: { ...chosen[0].g } }
            : {
                kind: "scale",
                surface,
                handle,
                from: this.selectionBox(chosen),
                objs: chosen,
                starts: chosen.map((obj) => ({ ...obj.g })),
              };
        return;
      }

      const hit = this.hitTest(point.x, point.y, objects, surface.id);
      const additive = event.shiftKey || event.metaKey || event.ctrlKey;

      if (!hit) {
        if (!additive) this.selected = [];
        this.syncOverlays();
        this.syncToolbar();
        return;
      }

      if (additive) {
        // Shift picks up another object; shift on one already held puts it back
        // down. Objects on another page replace the selection rather than
        // joining it, because a group box has to be on one page to mean
        // anything.
        const here = new Set(objects.filter((obj) => obj.page === hit.page).map((obj) => obj.id));
        this.selected = this.isSelected(hit.id)
          ? this.selected.filter((id) => id !== hit.id)
          : [...this.selected.filter((id) => here.has(id)), hit.id];
      } else if (!this.isSelected(hit.id)) {
        this.selected = [hit.id];
      }
      // Pressing a member of a group keeps the group, so the drag moves all of
      // it. Narrowing down to the one you pressed happens on the way up, and
      // only if the press turned out not to be a drag.

      // A shift-click that *put an object down* is not the start of a drag.
      // A cover being dragged takes the working written on it along, which is
      // the difference between moving a post-it and moving a rectangle.
      const moving = this.isSelected(hit.id)
        ? this.withAttempts(this.chosen(objects).filter((obj) => obj.page === hit.page), objects)
        : [];
      if (moving.length) {
        this.drag = {
          kind: "move",
          surface,
          objs: moving,
          starts: moving.map((obj) => ({ ...obj.g })),
          dx: point.x,
          dy: point.y,
          pressed: hit.id,
          additive,
        };
      }
      this.syncOverlays();
      this.syncToolbar();
      return;
    }

    if (this.tool === "eraser") {
      this.drag = { kind: "erase", surface, hits: new Set() };
      this.erase(point.x, point.y, surface);
      return;
    }

    const brush = INK_TOOLS[this.tool];
    if (brush) {
      const style = this.styleOf;
      const element = document.createElementNS(SVG_NS, "path") as SVGPathElement;
      element.addClass("palimpsest-ink");
      element.addClass("is-live");
      element.setAttribute("fill", style.stroke ?? QUICK_COLOURS[0]);
      element.setAttribute("fill-opacity", String(style.opacity ?? 1));
      if (brush === "marker") element.addClass("palimpsest-highlight");
      if (brush === "pencil") element.style.filter = `url(#${this.grainId})`;
      surface.svg.appendChild(element);

      const stylus = event.pointerType === "pen";
      const speed = new SpeedPressure();
      const pressure = stylus ? Math.max(0.05, event.pressure || 0.5) : speed.next(point.x, point.y, event.timeStamp);
      this.drag = {
        kind: "ink",
        surface,
        points: [{ x: point.x, y: point.y, p: pressure }],
        el: element,
        speed,
        stylus,
      };
      this.updateInk(this.drag);
      return;
    }

    if (this.tool === "text") {
      // Clicking a box you already typed should open it, not start another one
      // on top of it. Every editor behaves this way and the alternative is a
      // pile of stacked empty boxes.
      const { objects } = this.state();
      const hit = this.hitTest(point.x, point.y, objects, surface.id);
      if (hit?.type === "text") {
        this.openEditor(surface, hit.g.x ?? point.x, hit.g.y ?? point.y, hit.g.w, hit);
        return;
      }
    }

    const type: ShapeType = this.tool as ShapeType;
    this.drag = { kind: "draw", surface, type, x0: point.x, y0: point.y, x1: point.x, y1: point.y };
  }

  private onPointerMove(event: PointerEvent, surface: PageSurface): void {
    const drag = this.drag;
    if (!drag || drag.kind === "pan") return;
    const point = this.toPage(event, drag.surface);

    if (drag.kind === "ink") {
      // Coalesced events are the difference between a smooth stroke and a
      // polygon on a 120 Hz trackpad: the browser batches several samples into
      // one move, and the ones it swallowed are the curve.
      const samples =
        typeof event.getCoalescedEvents === "function" && event.getCoalescedEvents().length
          ? event.getCoalescedEvents()
          : [event];
      for (const sample of samples) {
        const at = this.toPage(sample, drag.surface);
        const last = drag.points[drag.points.length - 1];
        // Drop samples too close to matter; they are noise and they cost bytes.
        if (Math.hypot(at.x - last.x, at.y - last.y) < 0.6 / this.scale) continue;
        const pressure = drag.stylus
          ? Math.max(0.05, sample.pressure || 0.5)
          : drag.speed.next(at.x, at.y, sample.timeStamp);
        drag.points.push({ x: at.x, y: at.y, p: pressure });
      }
      this.updateInk(drag);
      return;
    }

    if (drag.kind === "erase") {
      this.erase(point.x, point.y, drag.surface);
      return;
    }

    if (drag.kind === "draw") {
      const end = event.shiftKey ? constrain(drag.type, drag.x0, drag.y0, point.x, point.y) : point;
      drag.x1 = end.x;
      drag.y1 = end.y;
      this.updateGhost(drag);
      return;
    }

    if (drag.kind === "lasso") {
      drag.box = event.altKey;
      // Points close enough together to be one point are noise, and a lasso is
      // hit-tested against every object on the page.
      const last = drag.points[drag.points.length - 1];
      if (Math.hypot(point.x - last.x, point.y - last.y) >= 1.5 / this.scale) drag.points.push(point);
      this.updateLasso(drag);
      return;
    }

    if (drag.kind === "move") {
      const dx = point.x - drag.dx;
      const dy = point.y - drag.dy;
      this.previewObjects(
        drag.surface,
        drag.objs,
        drag.objs.map((obj, index) => ({ g: this.translate(obj, drag.starts[index], dx, dy) })),
      );
      return;
    }

    if (drag.kind === "resize") {
      this.previewObjects(drag.surface, [drag.obj], [this.resized(drag, point.x, point.y, event)]);
      return;
    }

    if (drag.kind === "scale") {
      const to = this.scaledBox(drag, point.x, point.y, event);
      this.previewObjects(
        drag.surface,
        drag.objs,
        drag.objs.map((obj, index) => this.scaleObject(obj, drag.starts[index], drag.from, to)),
      );
    }
  }

  private async onPointerUp(event: PointerEvent, surface: PageSurface): Promise<void> {
    const drag = this.drag;
    this.drag = null;
    if (!drag || drag.kind === "pan") return;
    surface.svg.releasePointerCapture?.(event.pointerId);
    const point = this.toPage(event, drag.surface);

    // Commit on pointer-up, never during the drag: one deliberate act is one
    // event, or the log fills with intermediate states and the timelapse
    // stutters through every one of them.
    if (drag.kind === "ink") {
      drag.el.remove();
      const style = this.styleOf;
      const points = thin(drag.points, 0.4);
      if (points.length === 0) return;
      await this.append({
        id: mintId("o"),
        ts: Date.now(),
        type: "ink",
        page: drag.surface.id,
        g: { p: packPoints(points) },
        st: { stroke: style.stroke, w: style.w, opacity: style.opacity, brush: style.brush ?? "pen" },
        // Where the stroke *started*, not where it ended: a line of working that
        // runs off the edge of the post-it was still written on the post-it.
        on: this.ownerAt(drag.surface.id, points[0].x, points[0].y),
      });
      this.remember(style.stroke ?? QUICK_COLOURS[0]);
      return;
    }

    if (drag.kind === "erase") {
      if (drag.hits.size === 0) return;
      const deletes: LogEvent[] = [...drag.hits].map((ref) => ({
        id: mintId(),
        ts: Date.now(),
        type: "obj.delete",
        ref,
      }));
      await this.append(deletes);
      return;
    }

    if (drag.kind === "draw") {
      this.clearGhost(drag.surface);
      const end = event.shiftKey ? constrain(drag.type, drag.x0, drag.y0, point.x, point.y) : point;

      if (drag.type === "text") {
        const box = rectFromDrag(drag.x0, drag.y0, end.x, end.y);
        const wide = (box.w ?? 0) > 24;
        this.openEditor(drag.surface, wide ? (box.x ?? 0) : drag.x0, wide ? (box.y ?? 0) : drag.y0, wide ? box.w : undefined, null);
        return;
      }

      const g = isLineLike(drag.type)
        ? { x1: drag.x0, y1: drag.y0, x2: end.x, y2: end.y }
        : rectFromDrag(drag.x0, drag.y0, end.x, end.y);

      if (this.tooSmall(drag.type, g)) {
        this.syncOverlays();
        return;
      }

      const style = this.styleOf;
      const create: CreateEvent = {
        id: mintId("o"),
        ts: Date.now(),
        type: drag.type,
        page: drag.surface.id,
        g,
        st: this.styleFor(drag.type, style),
        // A cover never belongs to a cover: two overlapping covers are two
        // answers, and making the upper one a child of the lower would delete
        // it along with its parent.
        on: isCover(drag.type) ? undefined : this.ownerAt(drag.surface.id, drag.x0, drag.y0),
      };
      await this.append(create);
      this.remember(style.stroke ?? QUICK_COLOURS[0]);
      this.selected = [create.id];
      this.syncToolbar();
      this.syncOverlays();
      return;
    }

    if (drag.kind === "lasso") {
      drag.el.remove();
      this.catchWithLasso(drag, event.shiftKey);
      return;
    }

    if (drag.kind === "resize") {
      const patch = this.resized(drag, point.x, point.y, event);
      // Nothing moved. Repainting here is what used to detach the node the
      // gesture landed on and swallow the following click, so: don't.
      if (this.samePatch(drag.obj, patch)) return;
      await this.append({ id: mintId(), ts: Date.now(), type: "obj.edit", ref: drag.obj.id, ...patch });
      return;
    }

    const next: Patch[] =
      drag.kind === "move"
        ? drag.objs.map((obj, index) => ({
            g: this.translate(obj, drag.starts[index], point.x - drag.dx, point.y - drag.dy),
          }))
        : (() => {
            const to = this.scaledBox(drag, point.x, point.y, event);
            return drag.objs.map((obj, index) => this.scaleObject(obj, drag.starts[index], drag.from, to));
          })();

    const ts = Date.now();
    const edits: LogEvent[] = [];
    drag.objs.forEach((obj, index) => {
      if (this.samePatch(obj, next[index])) return;
      edits.push({ id: mintId(), ts, type: "obj.edit", ref: obj.id, ...next[index] });
    });

    if (edits.length === 0) {
      // A press on a member of a group that turned out not to be a drag is a
      // request for that one object — the group was only kept in hand in case
      // you meant to move it.
      if (drag.kind === "move" && !drag.additive && this.selected.length > 1) {
        this.selected = [drag.pressed];
        this.syncOverlays();
        this.syncToolbar();
      }
      // A click on a cover that did not move it is a request to look under it.
      // The dog-ear is the affordance that works in every tool; with the select
      // tool in hand the whole cover is the button, because in select mode
      // clicking a thing is how you interact with it, and a cover's interaction
      // is being lifted. It selects it too — lifting costs nothing and is not
      // written down, so there is no harm in getting both.
      if (drag.kind === "move" && !drag.additive) {
        const pressed = drag.objs.find((obj) => obj.id === drag.pressed);
        if (pressed && isCover(pressed.type)) this.togglePeek(pressed.id);
      }
      return;
    }

    // However many objects moved, it was one gesture and it is one undo.
    await this.append(edits);
  }

  private abortDrag(): void {
    const drag = this.drag;
    this.drag = null;
    if (!drag || drag.kind === "pan") return;
    if (drag.kind === "ink" || drag.kind === "lasso") drag.el.remove();
    if (drag.kind === "draw") this.clearGhost(drag.surface);
    this.syncOverlays();
  }

  private onDoubleClick(event: MouseEvent, surface: PageSurface): void {
    if (this.readOnly) return;
    const point = this.toPage(event, surface);
    const { objects } = this.state();
    const hit = this.hitTest(point.x, point.y, objects, surface.id);

    if (hit?.type === "text") {
      this.openEditor(surface, hit.g.x ?? point.x, hit.g.y ?? point.y, hit.g.w, hit);
      return;
    }
    // A double-click on a cover is two lifts, and it has already had them — the
    // single clicks that make it up each toggled the peek on the way past. What
    // it must not also do is drop a text box on the answer.
    if (hit && isCover(hit.type)) return;
    // Double-clicking empty space with the select tool starts a text box there,
    // which is what every editor on this machine does.
    if (!hit && this.tool === "select") {
      this.openEditor(surface, point.x, point.y, undefined, null);
    }
  }

  /** Right-click is where people look for "delete this". */
  private onContextMenu(event: MouseEvent, surface: PageSurface): void {
    if (this.readOnly) return;
    event.preventDefault();
    this.commitEditor();

    const point = this.toPage(event, surface);
    const { objects } = this.state();
    const hit = this.hitTest(point.x, point.y, objects, surface.id);
    const menu = new Menu();

    if (hit) {
      if (!this.isSelected(hit.id)) this.selected = [hit.id];
      this.syncOverlays();
      this.syncToolbar();

      if (hit.type === "text") {
        menu.addItem((item) =>
          item
            .setTitle("Edit text")
            .setIcon("pencil")
            .onClick(() => this.openEditor(surface, hit.g.x ?? point.x, hit.g.y ?? point.y, hit.g.w, hit)),
        );
      }
      if (isCover(hit.type)) {
        const open = this.peeked.has(hit.id);
        menu.addItem((item) =>
          item
            .setTitle(open ? "Cover it again" : "Show the answer")
            .setIcon(open ? "eye-off" : "eye")
            .onClick(() => this.togglePeek(hit.id)),
        );
        // Grading from here works whether or not the cover is lifted, unlike the
        // tick and cross on the paper: right-clicking to say "I got that one
        // wrong" is a deliberate act, not something you can do by brushing past.
        for (const [mark, title, icon] of [
          ["right", "I got it right", "check"],
          ["wrong", "I got it wrong", "x"],
        ] as const) {
          menu.addItem((item) =>
            item
              .setTitle(hit.st.mark === mark ? `${title} — undo` : title)
              .setIcon(icon)
              .onClick(() => void this.grade(hit, mark)),
          );
        }
        menu.addSeparator();
      }
      const many = this.selected.length > 1 ? ` ${this.selected.length} objects` : "";
      menu.addItem((item) =>
        item
          .setTitle(`Duplicate${many}`)
          .setIcon("copy")
          .onClick(() => void this.duplicate()),
      );
      menu.addSeparator();
      menu.addItem((item) =>
        item
          .setTitle(`Delete${many}`)
          .setIcon("trash-2")
          .setWarning(true)
          .onClick(() => void this.deleteSelection()),
      );
    } else {
      menu.addItem((item) =>
        item.setTitle("Add a text box here").setIcon("type").onClick(() => this.openEditor(surface, point.x, point.y, undefined, null)),
      );
      menu.addSeparator();
      menu.addItem((item) =>
        item.setTitle("Insert blank page after").setIcon("file-plus").onClick(() => void this.insertPage(surface.id)),
      );
      menu.addItem((item) =>
        item
          .setTitle("Delete this page")
          .setIcon("trash-2")
          .setWarning(true)
          .setDisabled(this.order.length <= 1)
          .onClick(() => void this.deletePage(surface.id)),
      );
    }

    menu.showAtMouseEvent(event);
  }

  // ---------------------------------------------------------------------- ink

  private updateInk(drag: Extract<Drag, { kind: "ink" }>): void {
    const style = this.styleOf;
    drag.el.setAttribute("d", outlinePath(drag.points, style.w ?? 2, style.brush ?? "pen"));
  }

  // ------------------------------------------------------------------- eraser

  /** An object eraser, not a pixel eraser.
   *
   *  Rubbing out part of a stroke would mean either rewriting the stroke's
   *  points — which the log forbids — or storing a subtractive mask, which then
   *  has to be replayed and exported and reasoned about forever. Whole strokes
   *  go, and because they go as tombstones you can scrub back and watch them
   *  return. */
  private erase(x: number, y: number, surface: PageSurface): void {
    if (this.drag?.kind !== "erase") return;
    const radius = (this.styles.eraser?.w ?? 14) / 2;
    const { objects } = this.state();

    for (const obj of objects) {
      if (obj.page !== surface.id) continue;
      if (this.drag.hits.has(obj.id)) continue;
      // Covers are not erasable. Rubbing out the working on a post-it is the
      // whole reason to bring an eraser near one, and an eraser that took the
      // post-it away with the first stroke — uncovering the answer you were
      // deliberately not looking at — would be the worst possible failure of
      // this feature. Select it and press Delete if you mean the cover.
      if (isCover(obj.type)) continue;
      if (!this.withinReach(obj, x, y, radius)) continue;

      this.drag.hits.add(obj.id);
      const element = surface.svg.querySelector(`[data-id="${cssEscape(obj.id)}"]`);
      element?.addClass("is-erasing");
    }
  }

  private withinReach(obj: Obj, x: number, y: number, radius: number): boolean {
    if (isInk(obj.type)) return distanceToInk(unpackPoints(obj.g.p), x, y) <= radius + (obj.st.w ?? 2) / 2;
    if (isLineLike(obj.type)) return this.distanceToSegment(x, y, obj.g) <= radius + (obj.st.w ?? 2) / 2;
    const box = this.boxOf(obj);
    return (
      x >= (box.x ?? 0) - radius &&
      x <= (box.x ?? 0) + (box.w ?? 0) + radius &&
      y >= (box.y ?? 0) - radius &&
      y <= (box.y ?? 0) + (box.h ?? 0) + radius
    );
  }

  // --------------------------------------------------------------------- text

  private editingId: string | null = null;
  private editorSurface: PageSurface | null = null;
  private editorAt: { x: number; y: number; w?: number } | null = null;
  private editorStyle: { size: number; bold?: boolean; italic?: boolean } | null = null;

  /** A real multi-line text box.
   *
   *  The old editor was a single-line `<input>`: Enter committed, there was no
   *  wrapping, and the box could not be reopened because the double-click never
   *  arrived. This is a `<textarea>` laid over the page at the same size and
   *  font as the rendered text, so Enter is a newline and what you see while
   *  typing is what stays behind. */
  private openEditor(surface: PageSurface, x: number, y: number, width: number | undefined, existing: Obj | null): void {
    this.commitEditor();

    const style = existing
      ? { size: existing.st.size ?? 14, bold: existing.st.bold, italic: existing.st.italic }
      : { size: this.styles.text?.size ?? 14 };
    const colour = existing?.st.stroke ?? this.styles.text?.stroke ?? QUICK_COLOURS[0];

    const editor = surface.el.createEl("textarea", {
      cls: "palimpsest-editor",
      attr: { spellcheck: "false", rows: "1" },
    });
    editor.value = existing?.s ?? "";
    editor.style.font = cssFont({ ...style, size: style.size * this.scale });
    editor.style.lineHeight = String(LINE_HEIGHT);
    editor.style.color = colour;
    editor.style.caretColor = colour;

    this.editor = editor;
    this.editingId = existing?.id ?? null;
    this.editorSurface = surface;
    this.editorAt = { x, y, w: width };
    this.editorStyle = style;
    this.placeEditor();
    if (existing) this.syncOverlays(); // hide the rendered copy underneath

    const grow = (): void => {
      const box = layoutText(editor.value || " ", this.editorAt?.w, style);
      editor.style.height = `${Math.ceil(box.height * this.scale) + 2}px`;
      if (!this.editorAt?.w) editor.style.width = `${Math.ceil(box.width * this.scale) + 14}px`;
    };
    grow();
    editor.oninput = grow;

    editor.onkeydown = (event) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        this.cancelEditor();
      } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        this.commitEditor();
      }
      // Plain Enter falls through and inserts a newline, which is the entire
      // point of this being a textarea.
    };
    editor.onblur = () => this.commitEditor();

    window.setTimeout(() => {
      editor.focus();
      editor.setSelectionRange(editor.value.length, editor.value.length);
    }, 0);
  }

  private placeEditor(): void {
    if (!this.editor || !this.editorAt || !this.editorStyle) return;
    this.editor.style.left = `${this.editorAt.x * this.scale}px`;
    this.editor.style.top = `${this.editorAt.y * this.scale}px`;
    // The font is sized in screen pixels, so a zoom has to resize it too or the
    // text you are typing stops matching the text you already typed.
    this.editor.style.font = cssFont({ ...this.editorStyle, size: this.editorStyle.size * this.scale });
    this.editor.style.lineHeight = String(LINE_HEIGHT);
    const box = layoutText(this.editor.value || " ", this.editorAt.w, this.editorStyle);
    this.editor.style.height = `${Math.ceil(box.height * this.scale) + 2}px`;
    this.editor.style.width = `${Math.ceil((this.editorAt.w ?? box.width) * this.scale) + (this.editorAt.w ? 0 : 14)}px`;
  }

  private moveEditorWithZoom(): void {
    if (!this.editor) return;
    // Keeping the editor pinned through a zoom is easier than reflowing it;
    // committing first would silently end the edit mid-word.
    this.placeEditor();
  }

  private cancelEditor(): void {
    const editor = this.editor;
    this.editor = null;
    this.editingId = null;
    this.editorSurface = null;
    this.editorAt = null;
    this.editorStyle = null;
    editor?.remove();
    this.syncOverlays();
    this.afterEditing();
  }

  private commitEditor(): void {
    const editor = this.editor;
    const surface = this.editorSurface;
    const at = this.editorAt;
    const editingId = this.editingId;
    if (!editor || !surface || !at) return;

    this.editor = null;
    this.editorSurface = null;
    this.editorAt = null;
    this.editorStyle = null;
    this.editingId = null;

    const value = editor.value.replace(/[ \t]+$/gm, "").replace(/\n+$/, "");
    editor.remove();

    const existing = editingId
      ? this.state().objects.find((candidate) => candidate.id === editingId)
      : undefined;

    this.afterEditing();

    if (existing) {
      if (value === (existing.s ?? "")) {
        this.selected = [existing.id];
        this.syncOverlays();
        return;
      }
      // An emptied text box is a deleted text box, not an invisible one.
      if (value === "") {
        void this.append({ id: mintId(), ts: Date.now(), type: "obj.delete", ref: existing.id });
        return;
      }
      void this.append({ id: mintId(), ts: Date.now(), type: "obj.edit", ref: existing.id, s: value });
      return;
    }

    if (value === "") {
      this.syncOverlays();
      return;
    }

    const style = this.styles.text ?? { stroke: QUICK_COLOURS[0], size: 14 };
    const create: CreateEvent = {
      id: mintId("o"),
      ts: Date.now(),
      type: "text",
      page: surface.id,
      g: at.w ? { x: at.x, y: at.y, w: at.w } : { x: at.x, y: at.y },
      st: { stroke: style.stroke, size: style.size },
      s: value,
      on: this.ownerAt(surface.id, at.x, at.y),
    };
    void this.append(create);
    this.remember(style.stroke ?? QUICK_COLOURS[0]);
    this.selected = [create.id];
    this.syncToolbar();
  }

  /** Leaving the text editor: give the keyboard back to the view, and put the
   *  select tool in hand.
   *
   *  Both halves are about being able to touch what you just typed. Focus lives
   *  on `contentEl`, and it was only ever taken on pointer-down — so straight
   *  after typing a box, Delete reached nothing. And the drawing tools stay in
   *  hand on purpose, which is right for a brush and wrong for text: with the
   *  text tool still active, clicking your new box makes another one. */
  private afterEditing(): void {
    if (this.tool === "text") {
      this.tool = "select";
      this.syncToolbar();
    }
    this.contentEl.focus();
  }

  // --------------------------------------------------------------- transforms

  private styleFor(type: ShapeType, style: Style): Style {
    if (type === "highlight") return { stroke: style.stroke, opacity: style.opacity ?? 0.35 };
    if (type === "text") return { stroke: style.stroke, size: style.size ?? 14 };
    // No `w`: a cover has no stroke width to carry. `mark: null` is written out
    // rather than left off so that the key exists from the start — an `st`
    // patch merges over the old one, so a key that was never there cannot be
    // taken away again, and undoing a grade would quietly do nothing.
    if (type === "cover") return { stroke: style.stroke, opacity: style.opacity ?? 1, mark: null };
    return { stroke: style.stroke, w: style.w ?? 2, fill: null };
  }

  /** A stray click should not litter the log with zero-sized shapes. */
  private tooSmall(type: ShapeType, g: Geom): boolean {
    if (isLineLike(type)) {
      return Math.hypot((g.x2 ?? 0) - (g.x1 ?? 0), (g.y2 ?? 0) - (g.y1 ?? 0)) < 3;
    }
    return (g.w ?? 0) < 3 || (g.h ?? 0) < 3;
  }

  private translate(obj: Obj, g: Geom, dx: number, dy: number): Geom {
    if (isInk(obj.type)) {
      return { p: packPoints(translatePoints(unpackPoints(g.p), dx, dy)) };
    }
    if (g.x1 !== undefined) {
      return { x1: (g.x1 ?? 0) + dx, y1: (g.y1 ?? 0) + dy, x2: (g.x2 ?? 0) + dx, y2: (g.y2 ?? 0) + dy };
    }
    return { ...g, x: (g.x ?? 0) + dx, y: (g.y ?? 0) + dy };
  }

  /** Shift keeps the proportions, Alt grows about the centre — the two
   *  modifiers every drawing program has agreed on. */
  private modifiers(event: { shiftKey: boolean; altKey: boolean }): { aspect: boolean; centre: boolean } {
    return { aspect: event.shiftKey, centre: event.altKey };
  }

  private scaledBox(
    drag: Extract<Drag, { kind: "scale" }>,
    x: number,
    y: number,
    event: { shiftKey: boolean; altKey: boolean },
  ): Box {
    return resizeBox(drag.from, drag.handle, x, y, this.modifiers(event));
  }

  private resized(
    drag: Extract<Drag, { kind: "resize" }>,
    x: number,
    y: number,
    event: { shiftKey: boolean; altKey: boolean },
  ): Patch {
    const g = drag.g;
    if (isLineLike(drag.obj.type)) {
      // Shift on an endpoint snaps the line to 45°, the same as drawing one.
      const anchor = drag.handle === "start" ? { x: g.x2 ?? 0, y: g.y2 ?? 0 } : { x: g.x1 ?? 0, y: g.y1 ?? 0 };
      const end = event.shiftKey ? constrain(drag.obj.type, anchor.x, anchor.y, x, y) : { x, y };
      return { g: drag.handle === "start" ? { ...g, x1: end.x, y1: end.y } : { ...g, x2: end.x, y2: end.y } };
    }

    const from = asBox(this.boxOf({ ...drag.obj, g }));

    if (drag.obj.type === "text") {
      // The sides reflow the words, the corners scale them. That is the split
      // every page-layout program uses, and it is the only way both are
      // reachable at all: a text box has one wrap width and one type size, and
      // you have to be able to change either without touching the other.
      if (drag.handle === "w" || drag.handle === "e") {
        return { g: { ...g, ...resizeTextWidth(from, drag.handle, x) } };
      }
      return this.scaleText(drag.obj, g, from, resizeBox(from, drag.handle, x, y, { aspect: true, centre: event.altKey }));
    }

    const to = resizeBox(from, drag.handle, x, y, this.modifiers(event));

    if (isInk(drag.obj.type)) {
      return { g: { p: packPoints(scalePoints(unpackPoints(g.p), from, to)) } };
    }
    return { g: { ...g, x: to.x, y: to.y, w: to.w, h: to.h } };
  }

  /** Type scaled with its box: the size and the wrap width take the same
   *  factor, so the line breaks come out exactly where they were and the words
   *  simply get bigger. Scaling one without the other reflows the paragraph
   *  mid-drag, which is the thing that makes text in a resized diagram jump
   *  around. */
  private scaleText(obj: Obj, start: Geom, from: Box, to: Box): Patch {
    const factor = typeFactor(from, to);
    const size = clampSize((obj.st.size ?? 14) * factor);
    // The clamp is the truth once it bites, or a box dragged to nothing keeps
    // scaling its wrap width against a type size that has stopped moving.
    const base = obj.st.size ?? 14;
    const applied = base > 0 ? size / base : 1;
    const g: Geom = { ...start, x: to.x, y: to.y };
    if (start.w !== undefined) g.w = Math.max(24, start.w * applied);
    return { g, st: { size } };
  }

  /** Where an object lands when the box around the whole selection is dragged
   *  from `from` to `to`. Every kind scales the same way — proportionally,
   *  relative to the frame — except that text keeps its type size, exactly as
   *  it does when you drag its own side. */
  private scaleObject(obj: Obj, start: Geom, from: Box, to: Box): Patch {
    if (isInk(obj.type)) {
      const points = unpackPoints(start.p);
      const own = asBox(inkBounds(points, obj.st.w ?? 2));
      return { g: { p: packPoints(scalePoints(points, own, remap(own, from, to))) } };
    }

    if (isLineLike(obj.type)) {
      const sx = from.w > 0 ? to.w / from.w : 1;
      const sy = from.h > 0 ? to.h / from.h : 1;
      const at = (x: number, y: number) => ({ x: to.x + (x - from.x) * sx, y: to.y + (y - from.y) * sy });
      const a = at(start.x1 ?? 0, start.y1 ?? 0);
      const b = at(start.x2 ?? 0, start.y2 ?? 0);
      return { g: { x1: a.x, y1: a.y, x2: b.x, y2: b.y } };
    }

    if (obj.type === "text") {
      // A label inside a diagram you are scaling has to scale with it, or the
      // diagram comes out with the wrong-sized words in it.
      const own = asBox(this.boxOf({ ...obj, g: start }));
      return this.scaleText(obj, start, own, remap(own, from, to));
    }

    const next = remap({ x: start.x ?? 0, y: start.y ?? 0, w: start.w ?? 0, h: start.h ?? 0 }, from, to);
    return { g: { ...start, x: next.x, y: next.y, w: next.w, h: next.h } };
  }

  private sameGeom(a: Geom, b: Geom): boolean {
    if (a.p || b.p) return JSON.stringify(a.p) === JSON.stringify(b.p);
    const keys: (keyof Geom)[] = ["x", "y", "w", "h", "x1", "y1", "x2", "y2"];
    return keys.every((key) => Math.abs(((a[key] as number) ?? 0) - ((b[key] as number) ?? 0)) < 0.01);
  }

  /** Show a drag in progress without writing anything to the log. */
  private previewShape(surface: PageSurface, obj: Obj): void {
    const element = surface.svg.querySelector(`[data-id="${cssEscape(obj.id)}"]`) as SVGGraphicsElement | null;
    if (!element) return;
    this.applyShape(element, obj);
  }

  private patched(obj: Obj, patch: Patch): Obj {
    return patch.st ? { ...obj, g: patch.g, st: { ...obj.st, ...patch.st } } : { ...obj, g: patch.g };
  }

  /** Has this drag actually changed anything? `st` only ever carries the type
   *  size, so that is the only style worth comparing. */
  private samePatch(obj: Obj, patch: Patch): boolean {
    if (!this.sameGeom(patch.g, obj.g)) return false;
    if (patch.st?.size === undefined) return true;
    return Math.abs(patch.st.size - (obj.st.size ?? 14)) < 0.01;
  }

  /** Show a drag in progress: the shapes *and* the frame round them.
   *
   *  The frame used to sit still until you let go, which on most shapes is only
   *  scruffy — you can see the rectangle following your hand. On a text box it
   *  is the difference between working and appearing not to: a wrap width set
   *  wider than the words changes nothing else you can see, so with the outline
   *  frozen too, dragging the side of a one-line box looked like a dead
   *  control. */
  private previewObjects(surface: PageSurface, objs: Obj[], patches: Patch[]): void {
    const preview = new Map<string, Obj>();
    objs.forEach((obj, index) => {
      const next = this.patched(obj, patches[index]);
      preview.set(obj.id, next);
      this.previewShape(surface, next);
    });
    this.paintSelection(surface, this.state().objects, preview);
  }

  private updateGhost(drag: Extract<Drag, { kind: "draw" }>): void {
    const svg = drag.surface.svg;
    let ghost = svg.querySelector(".palimpsest-ghost") as SVGGraphicsElement | null;
    const tag = tagFor(drag.type === "text" ? "rect" : drag.type);
    if (ghost && ghost.tagName !== tag) {
      ghost.remove();
      ghost = null;
    }
    if (!ghost) {
      ghost = document.createElementNS(SVG_NS, tag) as SVGGraphicsElement;
      ghost.addClass("palimpsest-ghost");
      svg.appendChild(ghost);
    }

    const style = this.styleOf;
    const preview: Obj = {
      id: "__ghost",
      type: drag.type === "text" ? "rect" : drag.type,
      page: drag.surface.id,
      g: isLineLike(drag.type)
        ? { x1: drag.x0, y1: drag.y0, x2: drag.x1, y2: drag.y1 }
        : rectFromDrag(drag.x0, drag.y0, drag.x1, drag.y1),
      st: drag.type === "text" ? { stroke: style.stroke, w: 1, fill: null } : this.styleFor(drag.type, style),
      z: 0,
    };
    this.applyShape(ghost, preview);
    ghost.addClass("palimpsest-ghost");
  }

  private clearGhost(surface: PageSurface): void {
    surface.svg.querySelector(".palimpsest-ghost")?.remove();
  }

  // -------------------------------------------------------------------- lasso

  /** The loop, drawn as you draw it and closed as it is drawn — you are picking
   *  out an area, and an open curve does not say which side of itself you
   *  meant. */
  private updateLasso(drag: Extract<Drag, { kind: "lasso" }>): void {
    const points = this.lassoPolygon(drag);
    drag.el.setAttribute("d", `M ${points.map((p) => `${round(p.x)} ${round(p.y)}`).join(" L ")} Z`);
    drag.el.setAttribute("stroke-width", String(1 / this.scale));
    drag.el.setAttribute("stroke-dasharray", `${4 / this.scale} ${3 / this.scale}`);
  }

  private lassoPolygon(drag: Extract<Drag, { kind: "lasso" }>): Point[] {
    if (!drag.box) return drag.points;
    // Alt straightens the loop into a box: a row of shapes is a rectangle, and
    // tracing four sides freehand to say so is silly.
    const last = drag.points[drag.points.length - 1];
    return marquee(drag.x0, drag.y0, last.x, last.y);
  }

  private catchWithLasso(drag: Extract<Drag, { kind: "lasso" }>, additive: boolean): void {
    const polygon = this.lassoPolygon(drag);
    const { objects } = this.state();
    const caught = objects
      .filter((obj) => obj.page === drag.surface.id && caughtBy(asBox(this.boxOf(obj)), polygon))
      .map((obj) => obj.id);

    const keep = additive
      ? this.selected.filter((id) => objects.some((obj) => obj.id === id && obj.page === drag.surface.id))
      : [];
    this.selected = [...keep, ...caught.filter((id) => !keep.includes(id))];

    // The lasso hands the select tool back, the way the text tool does: what
    // you do with a handful of objects is move or resize them, and neither is
    // something the lasso can do.
    if (this.selected.length) this.tool = "select";
    this.syncOverlays();
    this.syncToolbar();
  }

  /** Topmost object under the point. Boxes, not outlines — clicking inside an
   *  unfilled rectangle should select it, which is what every editor does. */
  private hitTest(x: number, y: number, objects: Obj[], page: PageId): Obj | null {
    for (let i = objects.length - 1; i >= 0; i--) {
      const obj = objects[i];
      if (obj.page !== page) continue;

      if (isInk(obj.type)) {
        const tolerance = Math.max(4, (obj.st.w ?? 2) / 2 + 2);
        if (distanceToInk(unpackPoints(obj.g.p), x, y) <= tolerance) return obj;
        continue;
      }
      if (isLineLike(obj.type)) {
        const tolerance = Math.max(6, (obj.st.w ?? 2) * 2);
        if (this.distanceToSegment(x, y, obj.g) <= tolerance) return obj;
        continue;
      }

      const box = this.boxOf(obj);
      const pad = 2;
      if (
        x >= (box.x ?? 0) - pad &&
        x <= (box.x ?? 0) + (box.w ?? 0) + pad &&
        y >= (box.y ?? 0) - pad &&
        y <= (box.y ?? 0) + (box.h ?? 0) + pad
      ) {
        return obj;
      }
    }
    return null;
  }

  private distanceToSegment(px: number, py: number, g: Geom): number {
    const x1 = g.x1 ?? 0;
    const y1 = g.y1 ?? 0;
    const x2 = g.x2 ?? 0;
    const y2 = g.y2 ?? 0;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) return Math.hypot(px - x1, py - y1);
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSquared));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  private async nudge(dx: number, dy: number): Promise<void> {
    const { objects } = this.state();
    const chosen = this.withAttempts(this.chosen(objects), objects);
    if (chosen.length === 0) return;
    const ts = Date.now();
    await this.append(
      chosen.map((obj) => ({
        id: mintId(),
        ts,
        type: "obj.edit" as const,
        ref: obj.id,
        g: this.translate(obj, obj.g, dx, dy),
      })),
    );
  }

  /** Copy the selection a little down and to the right, and select the copies. */
  private async duplicate(): Promise<void> {
    if (this.readOnly) return;
    const { objects } = this.state();
    const held = this.chosen(objects);
    if (held.length === 0) return;
    const chosen = this.withAttempts(held, objects);

    // Ids first, so a copied attempt can point at the copied cover rather than
    // the original. Without this, duplicating a post-it makes a second post-it
    // whose working still belongs to the first — and dragging either one drags
    // the same handwriting.
    const ts = Date.now();
    const renamed = new Map(chosen.map((obj) => [obj.id, mintId("o")]));
    const copies: CreateEvent[] = chosen.map((obj) => ({
      id: renamed.get(obj.id) as string,
      ts,
      type: obj.type,
      page: obj.page,
      g: this.translate(obj, obj.g, 8, 8),
      st: { ...obj.st },
      s: obj.s,
      on: obj.on ? renamed.get(obj.on) : undefined,
    }));
    await this.append(copies);
    // Only the copies of what was actually picked up. The working came along
    // because it is part of the post-it, not because you selected it.
    this.selected = held.map((obj) => renamed.get(obj.id) as string);
    this.syncOverlays();
    this.syncToolbar();
  }

  private async deleteSelection(): Promise<void> {
    if (this.selected.length === 0 || this.readOnly) return;
    // Throwing a post-it away takes what is written on it. Leaving the working
    // behind would strand it over the answer it was hiding.
    const { objects } = this.state();
    const refs = this.withAttempts(this.chosen(objects), objects).map((obj) => obj.id);
    this.selected = [];
    // A cover that comes back from an undo comes back *down*. Leaving it in the
    // peeked set would mean deleting a cover and undoing it uncovers the answer,
    // which is a way to lose a problem you meant to keep for later.
    for (const ref of refs) this.peeked.delete(ref);
    const ts = Date.now();
    await this.append(refs.map((ref) => ({ id: mintId(), ts, type: "obj.delete" as const, ref })));
  }

  /** Everything on the page you are looking at, which is what `Cmd A` means in
   *  a document that is a column of pages rather than one canvas. */
  private selectAllOnPage(): void {
    if (this.readOnly) return;
    const page = this.order[this.currentPage];
    if (!page) return;
    this.selected = this.state()
      .objects.filter((obj) => obj.page === page)
      .map((obj) => obj.id);
    if (this.selected.length) this.tool = "select";
    this.syncOverlays();
    this.syncToolbar();
  }

  // -------------------------------------------------------------------- study

  /** Which cover control, if any, is under a point.
   *
   *  Worked out from the geometry rather than from `event.target`, for exactly
   *  the reason `handleAt` is: the PDF's text layer sits above the overlay and
   *  takes the press first, so the element under the pointer is never the one
   *  the gesture was aimed at. Topmost cover first. */
  private studyZoneAt(x: number, y: number, objects: Obj[], page: PageId): { obj: Obj; zone: Zone } | null {
    for (let i = objects.length - 1; i >= 0; i--) {
      const obj = objects[i];
      if (!isCover(obj.type) || obj.page !== page) continue;
      const zone = hitZone(asBox(this.boxOf(obj)), this.scale, x, y, this.peeked.has(obj.id));
      if (zone) return { obj, zone };
    }
    return null;
  }

  private async applyZone(obj: Obj, zone: Zone): Promise<void> {
    if (zone === "peel") {
      this.togglePeek(obj.id);
      return;
    }
    await this.grade(obj, zone);
  }

  private togglePeek(id: string): void {
    if (this.peeked.has(id)) this.peeked.delete(id);
    else this.peeked.add(id);
    this.syncOverlays();
  }

  /** Lift every cover on the document, or put every one back down.
   *
   *  The second is the gesture that makes a marked-up problem set reusable
   *  without closing it: you have been through the page checking answers, and
   *  one button hands you the page back the way you found it. */
  private setAllPeeked(open: boolean): void {
    this.peeked.clear();
    if (open) {
      for (const obj of this.state().objects) {
        if (isCover(obj.type)) this.peeked.add(obj.id);
      }
    }
    this.syncOverlays();
  }

  /** Grading is a toggle: pressing the tick a second time takes the grade off
   *  again. Without that, a mis-tap can only be corrected by pressing the other
   *  one, and the tally then counts a lie. */
  private async grade(obj: Obj, mark: Mark): Promise<void> {
    if (this.readOnly) return;
    await this.append({
      id: mintId(),
      ts: Date.now(),
      type: "obj.edit",
      ref: obj.id,
      st: { mark: obj.st.mark === mark ? null : mark },
    });
  }

  /** The cover a mark made here belongs to, if any.
   *
   *  Only a *closed* cover claims what you write on it. Working done while the
   *  answer is showing is not an attempt at the answer — it is a note about it,
   *  and sweeping it away with the next "let me try these again" would throw
   *  out the wrong half. */
  private ownerAt(page: PageId, x: number, y: number): string | undefined {
    const cover = coverAt(this.state().objects, page, x, y);
    return cover && !this.peeked.has(cover.id) ? cover.id : undefined;
  }

  /** A set of objects, plus everything written on any cover in it.
   *
   *  A post-it carries what is written on it. Dragging a cover to a better spot
   *  and leaving your working behind on the page would be the sort of thing you
   *  only notice after you have done it twice.
   *
   *  Moving, nudging and deleting do this. Resizing deliberately does not: a
   *  cover is sized when you place it and long before anything is written on
   *  it, and scaling somebody's handwriting because they widened the paper
   *  under it is a surprise, not a feature. */
  private withAttempts(held: Obj[], objects: Obj[]): Obj[] {
    const covers = held.filter((obj) => isCover(obj.type)).map((obj) => obj.id);
    if (covers.length === 0) return held;
    const already = new Set(held.map((obj) => obj.id));
    return [...held, ...attemptsOn(objects, covers).filter((obj) => !already.has(obj.id))];
  }

  /** Cover the selected words.
   *
   *  The fast way to set a worked-solutions PDF up for practice: select the
   *  solution, press `C`, move on. Dragging a box by hand over forty answers is
   *  the chore that stops you doing it at all.
   *
   *  One cover per page rather than one per line — unlike the highlighter,
   *  which follows the words. A cover hides a region, and a stack of per-line
   *  patches would leave the page showing through the leading: stripes of
   *  visible answer, and on a two-line formula enough to read. */
  private async coverSelection(captured?: { page: PageId; boxes: Box[] }[]): Promise<void> {
    if (this.readOnly) return;
    const pages = captured ?? this.selectionGeometry();
    if (pages.length === 0) return;

    const style = this.styles.cover;
    const ts = Date.now();
    const events: CreateEvent[] = [];

    for (const { page, boxes } of pages) {
      const box = unionCover(boxes);
      if (!box) continue;
      events.push({
        id: mintId("o"),
        ts,
        type: "cover",
        page,
        g: { x: box.x, y: box.y, w: box.w, h: box.h },
        st: this.styleFor("cover", style),
      });
    }
    if (events.length === 0) return;

    this.remember(style.stroke ?? QUICK_COLOURS[0]);
    await this.append(events);
    this.clearTextSelection();
    this.selected = events.map((event) => event.id);
    this.syncToolbar();
    this.syncOverlays();
  }

  /** Wipe the working off the covers so the problems can be done again.
   *
   *  `"wrong"` is the one that earns its keep. A second pass over the four you
   *  got wrong is worth more than a second pass over all forty, and picking
   *  those four out by hand is exactly the chore that stops you doing it.
   *
   *  The covers stay; the grades go with the working, because a grade for an
   *  attempt that no longer exists is not a grade of anything. */
  async clearAttempts(which: "all" | "wrong"): Promise<void> {
    if (this.readOnly) {
      new Notice("Palimpsest: you are looking at the version history. Go back to editing first.");
      return;
    }
    const { objects } = this.state();
    const covers = resetTargets(objects, which);
    if (covers.length === 0) {
      new Notice(which === "wrong" ? "Palimpsest: nothing marked wrong." : "Palimpsest: nothing covered yet.");
      return;
    }

    const ts = Date.now();
    const events: LogEvent[] = attemptsOn(
      objects,
      covers.map((cover) => cover.id),
    ).map((obj) => ({ id: mintId(), ts, type: "obj.delete" as const, ref: obj.id }));

    for (const cover of covers) {
      if (cover.st.mark) events.push({ id: mintId(), ts, type: "obj.edit", ref: cover.id, st: { mark: null } });
    }

    if (events.length === 0) {
      new Notice("Palimpsest: nothing written on those yet.");
      return;
    }

    // Put them back down as well — a set you are about to redo is not a set you
    // want showing its answers.
    for (const cover of covers) this.peeked.delete(cover.id);
    this.selected = [];

    // Forty problems reset is one thing you did, and one Cmd-Z.
    await this.append(events);
    new Notice(`Palimpsest: cleared ${covers.length} answer${covers.length === 1 ? "" : "s"}.`);
  }

  /** Put every cover back down. Reachable as a command, for when the page is
   *  scrolled somewhere else entirely. */
  coverAgain(): void {
    this.setAllPeeked(false);
  }

  /** The practice readout, which appears only on a document that has covers on
   *  it — a row of zeroes on every ordinary PDF would be chrome earning
   *  nothing. */
  private syncStudy(objects: Obj[]): void {
    if (!this.studyEl) return;
    const counts: Tally = tally(objects);
    const label = tallyLabel(counts);
    this.studyEl.toggleClass("is-visible", label !== null);
    if (!label) return;

    this.studyLabelEl.setText(label);

    // One pass, not one per lifted cover: this runs on every wheel tick of a
    // zoom, and `peeked` can hold a deleted cover's id, so the set alone is not
    // the answer.
    const anyOpen = objects.some((obj) => isCover(obj.type) && this.peeked.has(obj.id));
    const icon = anyOpen ? "eye-off" : "eye";
    const hint = anyOpen ? "Cover the answers again" : "Show every answer";
    if (this.studyButton.dataset.icon !== icon) {
      this.studyButton.dataset.icon = icon;
      setIcon(this.studyButton, icon);
      setTooltip(this.studyButton, hint);
      this.studyButton.setAttribute("aria-label", hint);
    }
    this.studyButton.onclick = () => this.setAllPeeked(!anyOpen);
  }

  // ---------------------------------------------------------- page thumbnails

  private thumbs = new Map<PageId, HTMLElement>();
  private thumbObserver: IntersectionObserver | null = null;
  private railBuilt = false;

  private toggleRail(): void {
    this.rootEl.toggleClass("is-rail", !this.rootEl.hasClass("is-rail"));
    this.syncToolbar();
    if (this.rootEl.hasClass("is-rail")) this.scheduleRail();
  }

  private scheduleRail(): void {
    if (!this.rootEl.hasClass("is-rail") || this.railQueued) return;
    this.railQueued = true;
    window.requestAnimationFrame(() => {
      this.railQueued = false;
      this.buildRail();
    });
  }

  private buildRail(): void {
    if (!this.railBuilt) {
      this.railEl.empty();
      const header = this.railEl.createDiv({ cls: "palimpsest-rail-header" });
      header.createSpan({ text: "Pages" });
      const add = header.createEl("button", { cls: "palimpsest-tool", attr: { "aria-label": "Add a blank page at the end" } });
      setIcon(add, "file-plus");
      add.onclick = () => void this.insertPage(this.order[this.order.length - 1] ?? null);
      this.railEl.createDiv({ cls: "palimpsest-thumbs" });
      this.railBuilt = true;

      this.thumbObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            void this.paintThumb(entry.target as HTMLElement);
            this.thumbObserver?.unobserve(entry.target);
          }
        },
        { root: this.railEl, rootMargin: "200px" },
      );
      this.register(() => this.thumbObserver?.disconnect());
    }

    const list = this.railEl.querySelector(".palimpsest-thumbs") as HTMLElement;
    if (!list) return;

    const live = new Set(this.order);
    for (const [id, element] of this.thumbs) {
      if (live.has(id)) continue;
      element.remove();
      this.thumbs.delete(id);
    }

    this.order.forEach((id, index) => {
      let thumb = this.thumbs.get(id);
      if (!thumb) {
        thumb = this.createThumb(id);
        this.thumbs.set(id, thumb);
        this.thumbObserver?.observe(thumb);
      }
      list.appendChild(thumb);
      const label = thumb.querySelector(".palimpsest-thumb-label");
      label?.setText(String(index + 1));
    });

    this.markRailCurrent();
  }

  private createThumb(id: PageId): HTMLElement {
    const thumb = document.createElement("div");
    thumb.addClass("palimpsest-thumb");
    thumb.dataset.page = id;

    const frame = thumb.createDiv({ cls: "palimpsest-thumb-frame" });
    const size = this.sizeOf(id);
    frame.style.aspectRatio = `${size.width} / ${size.height}`;
    frame.createEl("canvas");

    thumb.createDiv({ cls: "palimpsest-thumb-label", text: "" });

    const menu = thumb.createEl("button", { cls: "palimpsest-thumb-menu", attr: { "aria-label": "Page actions" } });
    setIcon(menu, "more-vertical");
    menu.onclick = (event) => {
      event.stopPropagation();
      this.openPageMenu(event, id);
    };

    thumb.onclick = () => {
      const index = this.order.indexOf(id);
      if (index >= 0) this.goToPage(index);
    };

    this.bindThumbDrag(thumb, id);
    return thumb;
  }

  private async paintThumb(thumb: HTMLElement): Promise<void> {
    const id = thumb.dataset.page;
    if (!id || !this.pdf) return;
    const canvas = thumb.querySelector("canvas") as HTMLCanvasElement | null;
    if (!canvas) return;

    const original = /^o(\d+)$/.exec(id);
    if (!original) {
      const size = this.sizeOf(id);
      canvas.width = THUMB_WIDTH;
      canvas.height = Math.round((THUMB_WIDTH * size.height) / size.width);
      const context = canvas.getContext("2d");
      if (context) {
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      return;
    }
    const page = await this.pdf.getPage(Number(original[1]) + 1);
    await renderThumb(page, canvas, THUMB_WIDTH);
  }

  private markRailCurrent(): void {
    const current = this.order[this.currentPage];
    for (const [id, thumb] of this.thumbs) thumb.toggleClass("is-current", id === current);
  }

  private openPageMenu(event: MouseEvent, id: PageId): void {
    const index = this.order.indexOf(id);
    const menu = new Menu();
    menu.addItem((item) =>
      item.setTitle("Insert blank page after").setIcon("file-plus").onClick(() => void this.insertPage(id)),
    );
    menu.addItem((item) =>
      item
        .setTitle("Insert blank page before")
        .setIcon("file-plus")
        .onClick(() => void this.insertPage(index === 0 ? null : this.order[index - 1])),
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Move up")
        .setIcon("arrow-up")
        .setDisabled(index <= 0)
        .onClick(() => void this.movePage(id, index - 2 < 0 ? null : this.order[index - 2])),
    );
    menu.addItem((item) =>
      item
        .setTitle("Move down")
        .setIcon("arrow-down")
        .setDisabled(index >= this.order.length - 1)
        .onClick(() => void this.movePage(id, this.order[index + 1])),
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Delete page")
        .setIcon("trash-2")
        .setWarning(true)
        .setDisabled(this.order.length <= 1)
        .onClick(() => void this.deletePage(id)),
    );
    menu.showAtMouseEvent(event);
  }

  /** Deleting a page hides it from the document; it does not touch the PDF, and
   *  the page comes back if you undo or scrub past the deletion. */
  private async deletePage(id: PageId): Promise<void> {
    await this.append({ id: mintId(), ts: Date.now(), type: "page.delete", ref: id });
  }

  private async insertPage(after: PageId | null): Promise<void> {
    await this.append({
      id: mintId(),
      ts: Date.now(),
      type: "page.insert",
      after,
      page: mintId("p"),
      src: "blank",
    });
  }

  private async movePage(id: PageId, after: PageId | null): Promise<void> {
    if (after === id) return;
    await this.append({ id: mintId(), ts: Date.now(), type: "page.move", ref: id, after });
  }

  /** Drag a thumbnail to reorder. The insertion line is drawn on the gap it
   *  would land in, because "which side of this page" is the whole question. */
  private bindThumbDrag(thumb: HTMLElement, id: PageId): void {
    let start: { x: number; y: number } | null = null;
    let active = false;

    const marker = (): HTMLElement => {
      let line = this.railEl.querySelector(".palimpsest-drop") as HTMLElement | null;
      if (!line) line = this.railEl.createDiv({ cls: "palimpsest-drop" });
      return line;
    };

    const targetIndex = (clientY: number): number => {
      const items = this.order.map((page) => this.thumbs.get(page)).filter(Boolean) as HTMLElement[];
      for (let i = 0; i < items.length; i++) {
        const box = items[i].getBoundingClientRect();
        if (clientY < box.top + box.height / 2) return i;
      }
      return items.length;
    };

    this.registerDomEvent(thumb, "pointerdown", (event: PointerEvent) => {
      if ((event.target as HTMLElement).closest(".palimpsest-thumb-menu")) return;
      start = { x: event.clientX, y: event.clientY };
      thumb.setPointerCapture(event.pointerId);
    });

    this.registerDomEvent(thumb, "pointermove", (event: PointerEvent) => {
      if (!start) return;
      if (!active && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5) return;
      active = true;
      thumb.addClass("is-dragging");

      const index = targetIndex(event.clientY);
      const items = this.order.map((page) => this.thumbs.get(page)).filter(Boolean) as HTMLElement[];
      const line = marker();
      const railBox = this.railEl.getBoundingClientRect();
      const anchor = items[Math.min(index, items.length - 1)];
      if (!anchor) return;
      const box = anchor.getBoundingClientRect();
      const y = index >= items.length ? box.bottom : box.top;
      line.style.top = `${y - railBox.top + this.railEl.scrollTop}px`;
      line.addClass("is-visible");
    });

    this.registerDomEvent(thumb, "pointerup", (event: PointerEvent) => {
      thumb.releasePointerCapture?.(event.pointerId);
      this.railEl.querySelector(".palimpsest-drop")?.removeClass("is-visible");
      thumb.removeClass("is-dragging");
      const wasActive = active;
      start = null;
      active = false;
      if (!wasActive) return;

      const from = this.order.indexOf(id);
      let index = targetIndex(event.clientY);
      // Dragging downwards, the page being moved still occupies a slot above
      // the insertion line, so the target index counts one too many.
      if (from < index) index -= 1;

      const without = this.order.filter((page) => page !== id);
      const at = Math.max(0, Math.min(index, without.length));
      if (at === from) return; // dropped back where it started
      void this.movePage(id, at === 0 ? null : without[at - 1]);
    });
  }

  // ---------------------------------------------------------- version history

  private toggleHistory(): void {
    if (this.historyOpen) this.closeHistory();
    else this.openHistory();
  }

  private openHistory(): void {
    this.clearTextSelection();
    this.commitEditor();
    this.historyOpen = true;
    this.selected = [];
    this.rootEl.addClass("is-history-open");
    this.buildHistoryPanel();
    this.syncToolbar();
  }

  private closeHistory(): void {
    this.historyOpen = false;
    this.historyAt = null;
    this.chosenVersion = null;
    this.rootEl.removeClass("is-history-open");
    this.invalidate();
    void this.rebuildDocument();
    this.syncToolbar();
  }

  /** Version history as a place you go, not a slider you nudge.
   *
   *  A raw scrubber over nine hundred events is unreadable; what you actually
   *  want is "the way it looked before this morning's lecture". So the log is
   *  grouped into versions by the pauses between edits, listed newest first with
   *  a time and a plain summary, and choosing one shows the document as it stood
   *  then — read-only, with a restore button. */
  private buildHistoryPanel(): void {
    this.panelEl.empty();

    const header = this.panelEl.createDiv({ cls: "palimpsest-panel-header" });
    header.createSpan({ text: "Version history" });
    const close = header.createEl("button", { cls: "palimpsest-tool", attr: { "aria-label": "Close" } });
    setIcon(close, "x");
    close.onclick = () => this.closeHistory();

    const list = this.panelEl.createDiv({ cls: "palimpsest-versions" });

    const current = list.createDiv({ cls: "palimpsest-version is-current-version" });
    current.createDiv({ cls: "palimpsest-version-time", text: "Current version" });
    current.createDiv({
      cls: "palimpsest-version-summary",
      text: this.events.length === 0 ? "nothing drawn yet" : `${this.events.length} edits in all`,
    });
    current.onclick = () => this.previewVersion(null);

    const versions = groupVersions(this.events);
    if (versions.length === 0) {
      list.createDiv({ cls: "palimpsest-empty", text: "Draw something and it will show up here." });
    }

    for (const day of byDay(versions)) {
      list.createDiv({ cls: "palimpsest-version-day", text: day.label });
      for (const version of day.versions) {
        const row = list.createDiv({ cls: "palimpsest-version" });
        row.dataset.upto = String(version.upTo);
        row.createDiv({ cls: "palimpsest-version-time", text: timeLabel(version.at) });
        row.createDiv({ cls: "palimpsest-version-summary", text: version.summary });
        row.onclick = () => this.previewVersion(version);
      }
    }

    this.markChosenVersion();
  }

  private previewVersion(version: Version | null): void {
    this.chosenVersion = version;
    this.historyAt = version ? version.upTo : null;
    this.selected = [];
    this.invalidate();
    void this.rebuildDocument();
    this.markChosenVersion();
    this.syncTimelineChrome();
  }

  private markChosenVersion(): void {
    this.panelEl.findAll(".palimpsest-version").forEach((row) => {
      const element = row as HTMLElement;
      const upTo = element.dataset.upto;
      const chosen = this.chosenVersion
        ? upTo === String(this.chosenVersion.upTo)
        : element.hasClass("is-current-version");
      element.toggleClass("is-chosen", chosen);
    });
  }

  private syncTimelineChrome(): void {
    const title = this.historyBarEl.querySelector(".palimpsest-historybar-title");
    const restore = this.historyBarEl.querySelector(".palimpsest-restore") as HTMLButtonElement | null;
    if (this.chosenVersion) {
      const date = new Date(this.chosenVersion.at);
      title?.setText(
        `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${timeLabel(this.chosenVersion.at)} — ${this.chosenVersion.summary}`,
      );
      if (restore) restore.style.display = "";
    } else {
      title?.setText(this.historyOpen ? "Current version" : "Version history");
      if (restore) restore.style.display = "none";
    }
    if (this.historyOpen) this.buildHistoryPanelSummary();
  }

  private buildHistoryPanelSummary(): void {
    const current = this.panelEl.querySelector(".is-current-version .palimpsest-version-summary");
    current?.setText(this.events.length === 0 ? "nothing drawn yet" : `${this.events.length} edits in all`);
  }

  private async restoreChosen(): Promise<void> {
    const version = this.chosenVersion;
    if (!version) return;

    const events = restoreTo(this.events, version.upTo, this.pdfPageCount);
    if (events.length === 0) {
      new Notice("Palimpsest: that version is already what you have.");
      return;
    }

    // Come back to the present *before* writing, so the append lands on the
    // live document rather than on the version being looked at.
    this.historyAt = null;
    this.chosenVersion = null;
    this.historyOpen = false;
    this.rootEl.removeClass("is-history-open");
    this.invalidate();

    await this.append(events);
    await this.rebuildDocument();
    this.syncToolbar();
    new Notice(`Palimpsest: restored ${timeLabel(version.at)} — the edits since are still in the history.`);
  }

  // --------------------------------------------------------------------- find

  private runsCache = new Map<number, TextRun[]>();
  private matches: { surface: number; x: number; y: number; w: number; h: number }[] = [];
  private matchAt = -1;
  private findInputEl!: HTMLInputElement;
  private findCountEl!: HTMLElement;

  private buildFindBar(): void {
    setIcon(this.findEl.createSpan({ cls: "palimpsest-find-icon" }), "search");
    this.findInputEl = this.findEl.createEl("input", {
      cls: "palimpsest-find-input",
      attr: { type: "text", placeholder: "Find in document", spellcheck: "false" },
    });
    this.findCountEl = this.findEl.createSpan({ cls: "palimpsest-label", text: "" });

    this.iconButton(this.findEl, "chevron-up", "Previous match", "Shift Enter", () => this.stepMatch(-1));
    this.iconButton(this.findEl, "chevron-down", "Next match", "Enter", () => this.stepMatch(1));
    this.iconButton(this.findEl, "x", "Close", "Esc", () => this.toggleFind(false));

    let timer = 0;
    this.findInputEl.oninput = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void this.runSearch(), 180);
    };
    this.findInputEl.onkeydown = (event) => {
      event.stopPropagation();
      if (event.key === "Enter") this.stepMatch(event.shiftKey ? -1 : 1);
      if (event.key === "Escape") this.toggleFind(false);
    };
  }

  private toggleFind(open?: boolean): void {
    const next = open ?? !this.rootEl.hasClass("is-find");
    this.rootEl.toggleClass("is-find", next);
    this.syncToolbar();
    if (next) {
      this.findInputEl.focus();
      this.findInputEl.select();
    } else {
      this.matches = [];
      this.matchAt = -1;
      this.paintMatches();
      this.contentEl.focus();
    }
  }

  private async runSearch(): Promise<void> {
    const needle = this.findInputEl.value.trim().toLowerCase();
    this.matches = [];
    this.matchAt = -1;
    if (!needle || !this.pdf) {
      this.findCountEl.setText("");
      this.paintMatches();
      return;
    }

    this.findCountEl.setText("searching…");
    for (let index = 0; index < this.order.length; index++) {
      const original = /^o(\d+)$/.exec(this.order[index]);
      if (!original) continue;
      const number = Number(original[1]);

      for (const run of await this.runsFor(number)) {
        const haystack = run.str.toLowerCase();
        let from = haystack.indexOf(needle);
        while (from !== -1) {
          // Approximate the sub-run box by character proportion. Exact glyph
          // positions would need the font, and a highlight two points wide of
          // perfect is not worth loading one.
          const per = run.w / Math.max(1, run.str.length);
          this.matches.push({
            surface: index,
            x: run.x + per * from,
            y: run.y,
            w: per * needle.length,
            h: run.h,
          });
          from = haystack.indexOf(needle, from + needle.length);
        }
      }
    }

    this.paintMatches();
    if (this.matches.length === 0) {
      this.findCountEl.setText("no matches");
      return;
    }
    this.stepMatch(1);
  }

  private stepMatch(direction: number): void {
    if (this.matches.length === 0) return;
    this.matchAt = (this.matchAt + direction + this.matches.length) % this.matches.length;
    const match = this.matches[this.matchAt];
    this.findCountEl.setText(`${this.matchAt + 1} of ${this.matches.length}`);

    const box = this.offsets[match.surface];
    if (box) {
      const target = box.top + match.y * this.scale - this.stageEl.clientHeight / 3;
      this.stageEl.scrollTop = Math.max(0, target);
    }
    this.paintMatches();
  }

  private paintMatches(): void {
    const grouped = new Map<number, typeof this.matches>();
    this.matches.forEach((match) => {
      const list = grouped.get(match.surface);
      if (list) list.push(match);
      else grouped.set(match.surface, [match]);
    });

    this.surfaces.forEach((surface, index) => {
      surface.svg.querySelector(".palimpsest-matches")?.remove();
      const list = grouped.get(index);
      if (!list || list.length === 0) return;

      const group = document.createElementNS(SVG_NS, "g");
      group.addClass("palimpsest-matches");
      for (const match of list) {
        const rect = document.createElementNS(SVG_NS, "rect");
        set(rect, { x: match.x, y: match.y, width: match.w, height: match.h });
        rect.addClass("palimpsest-match");
        if (this.matches[this.matchAt] === match) rect.addClass("is-active");
        group.appendChild(rect);
      }
      surface.svg.appendChild(group);
    });
  }

  // ---------------------------------------------------------- selecting text

  /** Text runs for an original page, fetched once.
   *
   *  `Cmd F` and the selectable text layer ask the same question of the same
   *  page, so they share the answer — and the answer is the expensive half of
   *  either feature. */
  private async runsFor(number: number): Promise<TextRun[]> {
    const cached = this.runsCache.get(number);
    if (cached) return cached;
    if (!this.pdf) return [];
    const runs = await textRuns(await this.pdf.getPage(number + 1));
    this.runsCache.set(number, runs);
    return runs;
  }

  /** Lay the PDF's own text over a page as selectable spans.
   *
   *  Only pages near the viewport carry one, on the same schedule as the
   *  bitmap: a text layer is the same kind of cost, and four hundred of them
   *  would be the same kind of mistake. */
  private async fillTextLayer(surface: PageSurface): Promise<void> {
    const original = /^o(\d+)$/.exec(surface.id);
    if (!original || !this.pdf) return; // an inserted blank page has nothing to select
    const token = surface.text.begin();
    surface.text.build(token, await this.runsFor(Number(original[1])));
  }

  /** The text layer sits over the markup, so with the select tool in hand it
   *  sees the press first. A press aimed at a shape is handed straight down to
   *  the overlay's own handler; anything else is left alone, and the browser
   *  starts a text selection exactly as it would on any other page.
   *
   *  That is the whole rule, and it is the one every PDF reader uses: one tool,
   *  and what is under the pointer decides whether you are about to move a
   *  circle or select a sentence. */
  private onTextPointerDown(event: PointerEvent, surface: PageSurface): void {
    if (event.button !== 0 || this.spaceHeld || this.tool !== "select") return;

    const point = this.toPage(event, surface);
    const { objects } = this.state();
    const handle = this.readOnly ? null : this.handleAt(point.x, point.y, objects, surface.id);
    const zone = this.studyZoneAt(point.x, point.y, objects, surface.id);
    const grabbed = handle !== null || zone !== null || this.hitTest(point.x, point.y, objects, surface.id) !== null;

    // A press on a resize grip is never the second half of a double-click.
    // There is nothing a handle opens, and counting it turns "select it, then
    // drag its side" — which is how you resize anything, and how you resize a
    // text box in particular — into "select it, then start editing".
    //
    // Nor is a press on a cover's dog-ear or its tick: those are toggles, and a
    // double-tap of a toggle is two presses of it, not one press and one
    // double-click of the page underneath.
    const second = this.isDoublePress(event) && handle === null && zone === null;

    if (!this.readOnly && grabbed) {
      // The two gestures start identically and only one of them may keep the
      // browser's default, or you drag a circle and select the page behind it.
      event.preventDefault();
      this.clearTextSelection();
      // Cancelling the press is also what makes `dblclick` never arrive, so the
      // second one is counted rather than waited for.
      if (second) this.onDoubleClick(event, surface);
      else this.onPointerDown(event, surface);
      return;
    }

    // Otherwise the tool keys and Escape stop reaching us the moment you touch
    // a word. Focusing a div does not disturb a selection the way an input does.
    this.contentEl.focus();

    this.selectionDragging = true;
    if (this.selected.length) {
      this.selected = [];
      this.syncOverlays();
      this.syncToolbar();
    }
  }

  /** Was this press the second of a double-click?
   *
   *  Chromium suppresses the compatibility mouse events — `dblclick` among them
   *  — for a pointer whose `pointerdown` was cancelled, and cancelling is
   *  exactly what stops the page being selected out from under a shape you are
   *  dragging. So on that path the count is kept here. Double-click-to-edit is
   *  how you fix a typo in a text box, and a text box laid over a paragraph is
   *  where you would put one, so it cannot depend on that event arriving. */
  private lastPress = { at: 0, x: 0, y: 0 };

  private isDoublePress(event: PointerEvent): boolean {
    const near = Math.abs(event.clientX - this.lastPress.x) < 5 && Math.abs(event.clientY - this.lastPress.y) < 5;
    const quick = event.timeStamp - this.lastPress.at < 450;
    this.lastPress = { at: event.timeStamp, x: event.clientX, y: event.clientY };
    if (!near || !quick) return false;
    // Three presses in a row are one double-click and one single, not two.
    this.lastPress.at = 0;
    return true;
  }

  /** The cursor is the honest signal of what a click will do — and with the
   *  text layer on top, a shape's own cursor never gets a chance to show. */
  private onTextPointerMove(event: PointerEvent, surface: PageSurface): void {
    if (this.drag || this.selectionDragging || this.tool !== "select" || this.readOnly) return;
    const point = this.toPage(event, surface);
    const { objects } = this.state();
    const handle = this.handleAt(point.x, point.y, objects, surface.id);
    // A cover's dog-ear and its tick are buttons, and say so — the rest of the
    // cover still says "move", because dragging it is the other thing it does.
    const zone = this.studyZoneAt(point.x, point.y, objects, surface.id);
    surface.text.el.style.cursor = handle
      ? this.handleCursor(handle, this.chosen(objects))
      : zone
        ? "pointer"
        : this.hitTest(point.x, point.y, objects, surface.id)
          ? "move"
          : "";
  }

  /** This only ever fires on the path that kept the browser's default — that
   *  is, with no shape under the pointer. Markup is double-clicked open from
   *  `onTextPointerDown` instead. */
  private onTextDoubleClick(event: MouseEvent, surface: PageSurface): void {
    // On the PDF's words the browser selects the word, the way a reader does.
    // On the bare page the old behaviour stands and you get a new text box.
    if (event.target !== surface.text.el) return;
    this.onDoubleClick(event, surface);
  }

  private onTextContextMenu(event: MouseEvent, surface: PageSurface): void {
    if (!this.hasTextSelection()) {
      this.onContextMenu(event, surface);
      return;
    }
    event.preventDefault();

    // Read the selection now, not in the callbacks: by the time one of them
    // runs the menu has been clicked, and a click outside the words is exactly
    // what collapses a selection.
    const text = window.getSelection()?.toString() ?? "";
    const pages = this.selectionGeometry();

    const menu = new Menu();
    menu.addItem((item) => item.setTitle("Copy").setIcon("copy").onClick(() => void this.copySelectedText(text)));
    if (!this.readOnly) {
      menu.addSeparator();
      for (const mark of MARKS) {
        menu.addItem((item) =>
          item
            .setTitle(mark.label)
            .setIcon(mark.icon)
            .onClick(() => void this.markSelection(mark.kind, pages)),
        );
      }
      menu.addItem((item) =>
        item
          .setTitle("Cover this — I'll work it out")
          .setIcon("sticky-note")
          .onClick(() => void this.coverSelection(pages)),
      );
    }
    menu.showAtMouseEvent(event);
  }

  /** Which resize handle is under a point, if any.
   *
   *  The handles are SVG rects underneath the text layer, so they no longer get
   *  the press themselves and `event.target` cannot answer this any more.
   *  Working it out from the geometry has a second and better effect: a handle
   *  becomes grabbable from a few points away rather than only from the nine
   *  pixels it paints. */
  private handleAt(x: number, y: number, objects: Obj[], page: PageId): string | null {
    const chosen = this.chosen(objects).filter((obj) => obj.page === page);
    if (chosen.length === 0) return null;

    const reach = 7 / this.scale;
    for (const [name, point] of Object.entries(this.handlesFor(chosen))) {
      if (Math.abs(point.x - x) <= reach && Math.abs(point.y - y) <= reach) return name;
    }
    return null;
  }

  private buildSelectionBar(): void {
    // A press anywhere outside the words collapses the selection, and the bar
    // is outside the words. Refusing the press keeps the selection alive long
    // enough for the click that follows to act on it.
    this.selectionBarEl.onmousedown = (event) => event.preventDefault();

    this.iconButton(this.selectionBarEl, "copy", "Copy", "Mod C", () => void this.copySelectedText());
    this.separator(this.selectionBarEl);
    for (const mark of MARKS) {
      const button = this.iconButton(this.selectionBarEl, mark.icon, mark.label, "", () =>
        void this.markSelection(mark.kind),
      );
      button.dataset.mark = mark.kind;
    }
    const cover = this.iconButton(this.selectionBarEl, "sticky-note", "Cover this — I'll work it out", "C", () =>
      void this.coverSelection(),
    );
    cover.dataset.mark = "cover";
  }

  /** A selection of the PDF's text, in this view.
   *
   *  Judged by the anchor rather than the range's common ancestor: a selection
   *  dragged across a page break has the whole document column as its ancestor,
   *  and asking whether *that* is a text layer says no to the case this feature
   *  exists for. */
  private hasTextSelection(): boolean {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
    const anchor = selection.anchorNode;
    const element = anchor?.nodeType === Node.ELEMENT_NODE ? (anchor as HTMLElement) : anchor?.parentElement;
    return !!element && this.rootEl.contains(element) && !!element.closest(".palimpsest-textlayer");
  }

  private clearTextSelection(): void {
    if (this.hasTextSelection()) window.getSelection()?.removeAllRanges();
    this.hideSelectionBar();
  }

  private scheduleSelectionBar(): void {
    if (this.selectionQueued) return;
    this.selectionQueued = true;
    window.requestAnimationFrame(() => {
      this.selectionQueued = false;
      this.syncSelectionBar();
    });
  }

  private syncSelectionBar(): void {
    if (this.selectionDragging || !this.hasTextSelection()) {
      this.hideSelectionBar();
      return;
    }
    const box = window.getSelection()?.getRangeAt(0).getBoundingClientRect();
    if (!box || (box.width === 0 && box.height === 0)) {
      this.hideSelectionBar();
      return;
    }

    // Scrolled off: the bar belongs to the words, and clamping it to the edge
    // of a stage they have left is a button pointing at nothing.
    const stage = this.stageEl.getBoundingClientRect();
    if (box.bottom < stage.top || box.top > stage.bottom) {
      this.hideSelectionBar();
      return;
    }

    // Reading an old version is not editing it, so the bar keeps Copy and drops
    // everything that would write.
    this.selectionBarEl.toggleClass("is-marking", !this.readOnly);
    this.selectionBarEl.addClass("is-visible");

    const frame = this.bodyEl.getBoundingClientRect();
    const bar = this.selectionBarEl.getBoundingClientRect();
    const gap = 8;

    // Above the words, or below them when the selection starts at the top of
    // the stage — and clamped to the stage either way, so it can never end up
    // over the thumbnail rail or off the edge of the tab.
    const room = box.top - stage.top > bar.height + gap;
    const top = room ? box.top - bar.height - gap : Math.min(box.bottom + gap, stage.bottom - bar.height - gap);
    const left = Math.min(
      Math.max(box.left + box.width / 2 - bar.width / 2, stage.left + gap),
      stage.right - bar.width - gap,
    );
    this.selectionBarEl.style.top = `${top - frame.top}px`;
    this.selectionBarEl.style.left = `${left - frame.left}px`;
  }

  /** Say how many, but only when "how many" is a question — one selected object
   *  is drawn plainly enough by its own outline. */
  private syncSelectionCount(): void {
    this.selectionCountEl?.setText(this.selected.length > 1 ? `${this.selected.length} selected` : "");
  }

  private hideSelectionBar(): void {
    this.selectionBarEl?.removeClass("is-visible");
  }

  private async copySelectedText(captured?: string): Promise<void> {
    const text = captured ?? window.getSelection()?.toString() ?? "";
    if (!text.trim()) return;
    await navigator.clipboard.writeText(text);
    new Notice(`Copied ${text.length} character${text.length === 1 ? "" : "s"}`);
  }

  /** Turn the selection into marks on the page.
   *
   *  This is the half of "does an object snap to the PDF's own text" that
   *  actually matters. You do not drag a highlight along a line of a slide and
   *  try to keep it level: you select the words, and the box comes out exactly
   *  the height of the line and exactly as long as the sentence. One mark per
   *  line, all of it one undo. */
  private async markSelection(kind: MarkKind, captured?: { page: PageId; boxes: Box[] }[]): Promise<void> {
    if (this.readOnly) return;
    const pages = captured ?? this.selectionGeometry();
    if (pages.length === 0) return;

    const style = kind === "highlight" ? this.styles.highlight : this.styles.line;
    const ts = Date.now();
    const events: LogEvent[] = [];

    for (const { page, boxes } of pages) {
      for (const box of boxes) {
        events.push({
          id: mintId("o"),
          ts,
          type: kind === "highlight" ? "highlight" : "line",
          page,
          g:
            kind === "highlight"
              ? { x: box.x, y: box.y, w: box.w, h: box.h }
              : kind === "underline"
                ? underlineOf(box)
                : strikeOf(box),
          st: this.styleFor(kind === "highlight" ? "highlight" : "line", style),
        });
      }
    }
    if (events.length === 0) return;
    this.remember(style.stroke ?? QUICK_COLOURS[0]);

    await this.append(events);
    this.clearTextSelection();
    this.syncToolbar();
  }

  /** The selection's client rects, in page coordinates, grouped by page.
   *
   *  A selection that runs over a page break is several pages' worth of marks,
   *  and each page's are stored against that page's own stable id — the same
   *  rule as everything else in the log, and the reason a highlight stays put
   *  when a page above it is deleted. */
  private selectionGeometry(): { page: PageId; boxes: Box[] }[] {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return [];

    // The text layer's box is the page's box: same origin, same scale.
    const frames = this.surfaces.map((surface) => ({
      id: surface.id,
      rect: surface.text.el.getBoundingClientRect(),
    }));
    const found = new Map<PageId, Box[]>();

    for (let index = 0; index < selection.rangeCount; index++) {
      const range = selection.getRangeAt(index);
      if (!this.rootEl.contains(range.commonAncestorContainer)) continue;

      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width < 0.4 || rect.height < 0.4) continue;
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const frame = frames.find(
          (candidate) =>
            x >= candidate.rect.left &&
            x <= candidate.rect.right &&
            y >= candidate.rect.top &&
            y <= candidate.rect.bottom,
        );
        if (!frame) continue;

        const boxes = found.get(frame.id) ?? [];
        boxes.push({
          x: (rect.left - frame.rect.left) / this.scale,
          y: (rect.top - frame.rect.top) / this.scale,
          w: rect.width / this.scale,
          h: rect.height / this.scale,
        });
        found.set(frame.id, boxes);
      }
    }

    return [...found].map(([page, boxes]) => ({ page, boxes: mergeLines(boxes) }));
  }

  // ---------------------------------------------------------------- shortcuts

  private onKeyUp(event: KeyboardEvent): void {
    if (event.code === "Space") {
      this.spaceHeld = false;
      this.rootEl.removeClass("is-panning");
    }
  }

  private onKeyDown(event: KeyboardEvent): void {
    const tag = (event.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

    const mod = event.metaKey || event.ctrlKey;

    if (event.code === "Space" && !mod) {
      if (!this.spaceHeld) {
        this.spaceHeld = true;
        this.rootEl.addClass("is-panning");
      }
      event.preventDefault();
      return;
    }

    if (mod && event.key.toLowerCase() === "z") {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) void this.redo();
      else void this.undo();
      return;
    }

    if (mod && event.key.toLowerCase() === "f") {
      event.preventDefault();
      this.toggleFind(true);
      return;
    }

    if (mod && event.key === "\\") {
      event.preventDefault();
      this.toggleRail();
      return;
    }

    if (mod && (event.key === "=" || event.key === "+")) {
      event.preventDefault();
      this.zoomStep(1);
      return;
    }
    if (mod && event.key === "-") {
      event.preventDefault();
      this.zoomStep(-1);
      return;
    }
    if (mod && event.key === "0") {
      event.preventDefault();
      this.applyFit("width");
      return;
    }

    if (event.key === "Escape") {
      if (this.rootEl.hasClass("is-find")) {
        this.toggleFind(false);
        return;
      }
      if (this.hasTextSelection()) {
        this.clearTextSelection();
        return;
      }
      if (this.drag) {
        this.abortDrag();
        return;
      }
      if (this.historyOpen) {
        this.closeHistory();
        return;
      }
      this.selected = [];
      this.tool = "select";
      this.syncToolbar();
      this.syncOverlays();
      return;
    }

    if (this.selected.length && !this.readOnly && event.key.startsWith("Arrow")) {
      const step = event.shiftKey ? 10 : 1;
      const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
      const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
      if (dx || dy) {
        event.preventDefault();
        void this.nudge(dx, dy);
        return;
      }
    }

    if (mod && event.key.toLowerCase() === "d") {
      event.preventDefault();
      void this.duplicate();
      return;
    }

    if ((event.key === "Delete" || event.key === "Backspace") && this.selected.length && !this.readOnly) {
      event.preventDefault();
      void this.deleteSelection();
      return;
    }

    // With nothing selected the page keys scroll, the way they do in a reader.
    if (this.selected.length === 0) {
      const page = this.stageEl.clientHeight * 0.9;
      const nudge: Record<string, number> = {
        ArrowDown: 60,
        ArrowUp: -60,
        PageDown: page,
        PageUp: -page,
      };
      if (event.key in nudge) {
        event.preventDefault();
        this.stageEl.scrollTop += nudge[event.key];
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        this.goToPage(0);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        this.goToPage(this.surfaces.length - 1);
        return;
      }
    }

    // Everything on the page you are looking at. The alternative is a lasso
    // drawn round the whole thing, which is a silly way to ask for all of it.
    if (mod && event.key.toLowerCase() === "a") {
      event.preventDefault();
      this.selectAllOnPage();
      return;
    }

    const shortcuts: Record<string, Tool> = {
      v: "select",
      q: "lasso",
      p: "pen",
      b: "marker",
      n: "pencil",
      e: "eraser",
      h: "highlight",
      t: "text",
      c: "cover",
      r: "rect",
      o: "ellipse",
      l: "line",
      a: "arrow",
    };
    const tool = shortcuts[event.key.toLowerCase()];
    if (tool && !mod && !event.altKey) {
      this.pickTool(tool);
    }
  }
}

// ------------------------------------------------------------------- helpers

/** Set several SVG attributes at once, rounded — full float precision in the
 *  DOM is noise, and it shows up in every diff of a debug dump. */
function set(element: Element, attrs: Record<string, number>): void {
  for (const [name, value] of Object.entries(attrs)) {
    element.setAttribute(name, String(Math.round(value * 100) / 100));
  }
}

/** `Geom` with its optional rectangle fields settled, which is what all the
 *  box arithmetic actually wants. */
function asBox(g: Geom): Box {
  return { x: g.x ?? 0, y: g.y ?? 0, w: g.w ?? 0, h: g.h ?? 0 };
}

/** The eight grips round a rectangle: four corners to scale by, four sides to
 *  change one dimension by. Corners alone means squashing a box horizontally is
 *  a corner drag you have to keep level by hand. */
function boxHandles(box: Box): Record<string, { x: number; y: number }> {
  const midX = box.x + box.w / 2;
  const midY = box.y + box.h / 2;
  const right = box.x + box.w;
  const bottom = box.y + box.h;
  return {
    nw: { x: box.x, y: box.y },
    n: { x: midX, y: box.y },
    ne: { x: right, y: box.y },
    e: { x: right, y: midY },
    se: { x: right, y: bottom },
    s: { x: midX, y: bottom },
    sw: { x: box.x, y: bottom },
    w: { x: box.x, y: midY },
  };
}

const round = (value: number): number => Math.round(value * 100) / 100;

function tagFor(type: ShapeType): string {
  switch (type) {
    case "ellipse":
      return "ellipse";
    case "line":
    case "arrow":
      return "line";
    case "text":
      return "text";
    case "ink":
      return "path";
    // A cover is the paper, the dog-ear you lift it by, and — once lifted — the
    // tick and cross. One element cannot be four, so it is a group.
    case "cover":
      return "g";
    default:
      return "rect";
  }
}

/** Ids are minted from base-36 timestamps, so they are always selector-safe —
 *  but they arrive from a file on disk, and a hand-edited log should not be able
 *  to turn a query into something else. */
function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
}

/** The starting contents of a new markup file: just the header line. */
export function newLogContents(pdfPath: string): string {
  return `${serialise(newDocEvent(pdfPath))}\n`;
}
