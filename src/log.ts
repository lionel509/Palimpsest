/** The append-only edit log, and the replay that turns it into a document.
 *
 *  Two rules hold the whole design up:
 *
 *  1. The PDF is never modified. Every edit is a line appended here.
 *  2. Nothing in this log is ever mutated either. Moving a shape appends an
 *     `obj.edit` referencing it; deleting appends an `obj.delete` tombstone.
 *     That is what makes the history scrubbable rather than just undoable.
 *
 *  Coordinates are stored in *unscaled viewport space*: points, origin at the
 *  page's top-left, y increasing downwards, independent of zoom. That maps 1:1
 *  onto the SVG overlay's viewBox. PDF user space is bottom-up, so an export
 *  has to flip y — `viewport.convertToPdfPoint` does it in one call.
 *
 *  A third rule falls out of the first two and is load-bearing for `cover`:
 *  **log order is paint order.** An opaque patch hides what was drawn before it
 *  and nothing drawn after, which is exactly what a post-it does — cover the
 *  answer, then write your attempt on top of the cover — with no z-index, no
 *  layers and no special case anywhere in the replay.
 */

export const LOG_VERSION = 1;

/** A page's identity, stable for the life of the document.
 *
 *  Original pages are `o<index>`, fixed at import and never renumbered.
 *  Inserted pages get a minted id. Events reference these, NEVER an index —
 *  once a page is inserted or deleted, "page 3" means different things at
 *  different points in the timeline, and index-addressed annotations scatter
 *  onto the wrong pages on replay.
 */
export type PageId = string;

export const originalPageId = (index: number): PageId => `o${index}`;

export type ShapeType = "rect" | "ellipse" | "line" | "arrow" | "text" | "highlight" | "ink" | "cover";

export const SHAPE_TYPES: readonly ShapeType[] = [
  "rect",
  "ellipse",
  "line",
  "arrow",
  "text",
  "highlight",
  "ink",
  "cover",
];

/** Freehand nibs. Stored on the object so a stroke redraws the same way
 *  forever, even if the toolbar's defaults change under it. */
export type Brush = "pen" | "marker" | "pencil";

const isShapeType = (t: string): t is ShapeType => (SHAPE_TYPES as readonly string[]).includes(t);

/** Rect-like shapes carry x/y/w/h; line-like carry x1/y1/x2/y2; ink carries a
 *  flat point array. */
export interface Geom {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  /** Ink only: [x, y, pressure, x, y, pressure, ...].
   *
   *  Flat and rounded rather than an array of objects, because this is the one
   *  shape whose size is not negligible: a page of handwriting is thousands of
   *  points, and `[{"x":1.2,"y":3.4,"p":0.5}]` costs three times what
   *  `[1.2,3.4,0.5]` does for exactly the same information. */
  p?: number[];
}

/** How an attempt at a covered answer turned out, once you have looked.
 *
 *  Only ever set on a `cover`. Absent means "not tried yet", which is a third
 *  state and deliberately not a value: a document full of `"mark":null` would
 *  say the same thing at four times the size.
 */
export type Mark = "right" | "wrong";

export interface Style {
  stroke?: string;
  /** Stroke width in points. */
  w?: number;
  fill?: string | null;
  /** Font size in points, for `text`. */
  size?: number;
  opacity?: number;
  /** Ink only: which nib drew this. */
  brush?: Brush;
  /** Text only. */
  align?: "left" | "center" | "right";
  bold?: boolean;
  italic?: boolean;
  /** Cover only: whether you got it right.
   *
   *  A grade is not a style, and this is the one field here that admits it. It
   *  lives in `st` anyway because `obj.edit` patches exactly three things — `g`,
   *  `st`, `s` — and every other part of the system is built on that: `inverseOf`
   *  restores the whole prior `st`, `restoreTo` diffs it, the history summary
   *  counts an edit of it. A fourth patchable field would mean touching all of
   *  them, and marking an answer wrong would be the one edit you could not undo
   *  or scrub past.
   *
   *  `null` is spelled out rather than left off, and a cover is created carrying
   *  it. An `st` patch is applied by spreading it over the old one and
   *  `JSON.stringify` drops `undefined`, so "no longer graded" written as
   *  `undefined` would serialise to `{}` and change nothing — un-marking would
   *  silently fail, and so would undoing a mark. */
  mark?: Mark | null;
}

/** First line of every log: which PDF this is markup *for*. */
export interface DocEvent {
  v: number;
  type: "doc";
  ts: number;
  /** Vault-relative path to the original PDF. */
  pdf: string;
}

export interface CreateEvent {
  id: string;
  ts: number;
  type: ShapeType;
  page: PageId;
  g: Geom;
  st: Style;
  /** Text content, for `text`. */
  s?: string;
  /** The cover this was written *on*, if it was written on one.
   *
   *  A post-it is a writing surface, not just a patch of opacity: the working
   *  you do on top of a covered answer belongs to that cover, so lifting the
   *  cover can fade it, moving the cover carries it, and "let me try these
   *  again next week" can wipe the attempts without touching the covers.
   *
   *  Fixed at creation and never edited, which is what lets `obj.edit` stay a
   *  three-field patch. */
  on?: string;
}

export interface EditEvent {
  id: string;
  ts: number;
  type: "obj.edit";
  ref: string;
  g?: Geom;
  st?: Style;
  s?: string;
}

export interface DeleteEvent {
  id: string;
  ts: number;
  type: "obj.delete";
  ref: string;
}

/** Undo of a delete. Deleted shapes are tombstoned rather than dropped, so
 *  bringing one back is a new event and never a rewrite of an old one. */
export interface RestoreEvent {
  id: string;
  ts: number;
  type: "obj.restore";
  ref: string;
}

/** Page operations. No UI yet — the format and replay support them so that
 *  adding the UI later does not require rewriting anyone's existing log. */
export interface PageInsertEvent {
  id: string;
  ts: number;
  type: "page.insert";
  /** New page lands after this one; null means the very front. */
  after: PageId | null;
  page: PageId;
  /** `original` means "put PDF page `page` back where it was" — an undone
   *  deletion. Only `blank` actually invents a page. */
  src: "blank" | "original";
}

export interface PageDeleteEvent {
  id: string;
  ts: number;
  type: "page.delete";
  ref: PageId;
}

export interface PageMoveEvent {
  id: string;
  ts: number;
  type: "page.move";
  ref: PageId;
  after: PageId | null;
}

export type LogEvent =
  | CreateEvent
  | EditEvent
  | DeleteEvent
  | RestoreEvent
  | PageInsertEvent
  | PageDeleteEvent
  | PageMoveEvent;

/** A shape as it exists at some point in the timeline. */
export interface Obj {
  id: string;
  type: ShapeType;
  page: PageId;
  g: Geom;
  st: Style;
  s?: string;
  /** The cover this was written on. See `CreateEvent.on`. */
  on?: string;
  /** Creation order, which is also paint order. */
  z: number;
  /** Tombstoned by an obj.delete. Kept so obj.restore can bring it back. */
  dead?: boolean;
}

export interface DocState {
  /** Visible pages, in order. */
  order: PageId[];
  /** Live shapes, in paint order. */
  objects: Obj[];
}

export interface ParsedLog {
  header: DocEvent | null;
  events: LogEvent[];
  /** Lines that could not be parsed, kept so a corrupt line is visible rather
   *  than silently dropped. */
  bad: number[];
}

let counter = 0;

/** Event ids only need to be unique within a document. */
export function mintId(prefix = "e"): string {
  counter += 1;
  const stamp = Date.now().toString(36);
  const salt = Math.floor(Math.random() * 1e6).toString(36);
  return `${prefix}${stamp}${counter.toString(36)}${salt}`;
}

export function serialise(event: DocEvent | LogEvent): string {
  return JSON.stringify(event);
}

export function newDocEvent(pdfPath: string): DocEvent {
  return { v: LOG_VERSION, type: "doc", ts: Date.now(), pdf: pdfPath };
}

export function parseLog(text: string): ParsedLog {
  const out: ParsedLog = { header: null, events: [], bad: [] };
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      out.bad.push(i + 1);
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) {
      out.bad.push(i + 1);
      continue;
    }

    const event = parsed as { type?: unknown };
    if (event.type === "doc") {
      out.header = parsed as DocEvent;
      continue;
    }
    if (typeof event.type !== "string") {
      out.bad.push(i + 1);
      continue;
    }
    out.events.push(parsed as LogEvent);
  }

  return out;
}

/** Rebuild the document as it stood after the first `upTo` events.
 *
 *  `upTo` is an event count, not a timestamp — the scrubber addresses events by
 *  position so that two edits in the same millisecond stay distinguishable.
 *  Pass `events.length` for "now".
 */
export function replay(events: LogEvent[], originalPageCount: number, upTo?: number): DocState {
  const { order, objects } = walk(events, originalPageCount, upTo);
  return {
    order,
    objects: [...objects.values()].filter((obj) => !obj.dead).sort((a, b) => a.z - b.z),
  };
}

/** Replay including tombstoned shapes. `inverseOf` needs to see a deleted shape
 *  to bring it back, and the walk itself must exist in exactly one place — two
 *  copies of this loop that drifted apart would be a miserable bug to find. */
function walk(
  events: LogEvent[],
  originalPageCount: number,
  upTo?: number,
): { order: PageId[]; objects: Map<string, Obj> } {
  const limit = upTo === undefined ? events.length : Math.max(0, Math.min(upTo, events.length));

  const order: PageId[] = [];
  for (let i = 0; i < originalPageCount; i++) order.push(originalPageId(i));

  const objects = new Map<string, Obj>();
  let z = 0;

  for (let i = 0; i < limit; i++) {
    const event = events[i];

    if (isShapeType(event.type)) {
      const create = event as CreateEvent;
      objects.set(create.id, {
        id: create.id,
        type: create.type,
        page: create.page,
        g: { ...create.g },
        st: { ...create.st },
        s: create.s,
        on: create.on,
        z: z++,
      });
      continue;
    }

    switch (event.type) {
      case "obj.edit": {
        const existing = objects.get(event.ref);
        if (!existing) break; // an edit of something that never existed
        if (event.g) existing.g = { ...existing.g, ...event.g };
        if (event.st) existing.st = { ...existing.st, ...event.st };
        if (event.s !== undefined) existing.s = event.s;
        break;
      }
      case "obj.delete": {
        const existing = objects.get(event.ref);
        if (existing) existing.dead = true;
        break;
      }
      case "obj.restore": {
        const existing = objects.get(event.ref);
        if (existing) existing.dead = false;
        break;
      }
      case "page.insert": {
        const at = event.after === null ? 0 : order.indexOf(event.after) + 1;
        if (event.after !== null && at === 0) break; // anchor is gone
        order.splice(at, 0, event.page);
        break;
      }
      case "page.delete": {
        const at = order.indexOf(event.ref);
        if (at >= 0) order.splice(at, 1);
        break;
      }
      case "page.move": {
        const from = order.indexOf(event.ref);
        if (from < 0) break;
        order.splice(from, 1);
        const to = event.after === null ? 0 : order.indexOf(event.after) + 1;
        if (event.after !== null && to === 0) {
          order.splice(from, 0, event.ref); // anchor is gone; put it back
          break;
        }
        order.splice(to, 0, event.ref);
        break;
      }
    }
  }

  return { order, objects };
}

/** The event that undoes event `index`.
 *
 *  Undo appends the inverse rather than truncating the log. Popping the last
 *  line would be simpler and would destroy the history this plugin exists to
 *  keep — and it would make the timelapse a lie. Undoing is a thing you did,
 *  so it belongs in the record.
 *
 *  Returns null when the event has no meaningful inverse.
 */
export function inverseOf(events: LogEvent[], index: number, originalPageCount: number): LogEvent | null {
  const target = events[index];
  if (!target) return null;

  const stamp = { id: mintId(), ts: Date.now() };

  if (isShapeType(target.type)) {
    return { ...stamp, type: "obj.delete", ref: (target as CreateEvent).id };
  }

  switch (target.type) {
    case "obj.delete":
      return { ...stamp, type: "obj.restore", ref: target.ref };

    case "obj.restore":
      return { ...stamp, type: "obj.delete", ref: target.ref };

    case "obj.edit": {
      // Whatever the shape looked like immediately before this edit.
      const before = walk(events, originalPageCount, index).objects.get(target.ref);
      if (!before) return null;

      // Restore the whole prior geometry rather than only the keys this edit
      // touched: JSON drops undefined, so a key that did not exist before would
      // vanish from the inverse and the undo would be silently partial.
      const undo: EditEvent = { ...stamp, type: "obj.edit", ref: target.ref };
      if (target.g) undo.g = { ...before.g };
      if (target.st) undo.st = { ...before.st };
      if (target.s !== undefined) undo.s = before.s ?? "";
      return undo;
    }

    case "page.insert":
      return { ...stamp, type: "page.delete", ref: target.page };

    case "page.delete": {
      // Put it back where it was, which means knowing what was in front of it.
      const before = walk(events, originalPageCount, index).order;
      const at = before.indexOf(target.ref);
      if (at < 0) return null;
      return {
        ...stamp,
        type: "page.insert",
        after: at === 0 ? null : before[at - 1],
        page: target.ref,
        src: /^o\d+$/.test(target.ref) ? "original" : "blank",
      };
    }

    case "page.move": {
      const before = walk(events, originalPageCount, index).order;
      const at = before.indexOf(target.ref);
      if (at < 0) return null;
      return { ...stamp, type: "page.move", ref: target.ref, after: at === 0 ? null : before[at - 1] };
    }

    default:
      return null;
  }
}

/** Normalise a drag into a positive-sized rect. */
export function rectFromDrag(x1: number, y1: number, x2: number, y2: number): Geom {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1),
  };
}

/** What to call a shape in prose. Both the version history and the companion
 *  note describe what is on a page, and they have to agree — "3 inks" in one
 *  place and "3 strokes" in the other is the sort of thing nobody reports and
 *  everybody notices. */
const SHAPE_NAMES: Record<ShapeType, [string, string]> = {
  rect: ["rectangle", "rectangles"],
  ellipse: ["circle", "circles"],
  line: ["line", "lines"],
  arrow: ["arrow", "arrows"],
  text: ["text box", "text boxes"],
  highlight: ["highlight", "highlights"],
  ink: ["stroke", "strokes"],
  cover: ["cover", "covers"],
};

export function nameShape(type: ShapeType, count: number): string {
  const pair = SHAPE_NAMES[type];
  if (!pair) return `${count} ${type}`;
  return `${count} ${pair[count === 1 ? 0 : 1]}`;
}

export const isLineLike = (type: ShapeType): boolean => type === "line" || type === "arrow";

export const isInk = (type: ShapeType): boolean => type === "ink";

export const isCover = (type: ShapeType): boolean => type === "cover";
