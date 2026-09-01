/** Version history.
 *
 *  The log is a list of individual edits, and a list of individual edits is not
 *  a history anyone wants to read: an hour of marking up a lecture is nine
 *  hundred lines, and "edit 447 of 912" tells you nothing. Google Docs solves
 *  this by grouping edits into versions separated by pauses, labelling each with
 *  a time, and letting you open one. Same idea here.
 *
 *  Grouping is derived, never stored. The log stays a flat append-only file;
 *  how it is presented is this module's problem alone, so changing the grouping
 *  rule later cannot corrupt anybody's history.
 */

import { LogEvent, Obj, PageId, SHAPE_TYPES, ShapeType, mintId, nameShape, replay } from "./log";

/** A pause this long starts a new version. Short enough that stepping away for
 *  coffee splits the session, long enough that thinking for a moment does not. */
const GAP_MS = 2 * 60 * 1000;

/** And a version never runs longer than this, so a solid hour of drawing is
 *  still several restore points rather than one enormous one. */
const MAX_SPAN_MS = 20 * 60 * 1000;

export interface Version {
  /** Replay the log up to here to see this version. */
  upTo: number;
  /** Index of the first event in the version. */
  from: number;
  at: number;
  count: number;
  summary: string;
}

export interface VersionDay {
  label: string;
  versions: Version[];
}

export function groupVersions(events: LogEvent[]): Version[] {
  if (events.length === 0) return [];

  const versions: Version[] = [];
  let start = 0;

  for (let i = 1; i <= events.length; i++) {
    const ended =
      i === events.length ||
      events[i].ts - events[i - 1].ts > GAP_MS ||
      events[i].ts - events[start].ts > MAX_SPAN_MS;
    if (!ended) continue;

    versions.push({
      upTo: i,
      from: start,
      at: events[i - 1].ts,
      count: i - start,
      summary: summarise(events.slice(start, i)),
    });
    start = i;
  }

  // Newest first, the way every version history is read.
  return versions.reverse();
}

/** Day headers, so a month of markup is skimmable. */
export function byDay(versions: Version[], now = new Date()): VersionDay[] {
  const days: VersionDay[] = [];
  for (const version of versions) {
    const label = dayLabel(new Date(version.at), now);
    const last = days[days.length - 1];
    if (last && last.label === label) last.versions.push(version);
    else days.push({ label, versions: [version] });
  }
  return days;
}

function dayLabel(date: Date, now: Date): string {
  const sameDay = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString();
  if (sameDay(date, now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return "Yesterday";
  const thisYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: thisYear ? undefined : "numeric",
  });
}

export function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// ------------------------------------------------------------------ summary

/** What happened in a version, in the fewest words that are still true. */
function summarise(events: LogEvent[]): string {
  const drawn = new Map<ShapeType, number>();
  let changed = 0;
  let removed = 0;
  let restored = 0;
  let pages = 0;

  for (const event of events) {
    if ((SHAPE_TYPES as readonly string[]).includes(event.type)) {
      const type = event.type as ShapeType;
      drawn.set(type, (drawn.get(type) ?? 0) + 1);
    } else if (event.type === "obj.edit") changed++;
    else if (event.type === "obj.delete") removed++;
    else if (event.type === "obj.restore") restored++;
    else if (event.type.startsWith("page.")) pages++;
  }

  const parts: string[] = [];
  for (const [type, count] of [...drawn.entries()].sort((a, b) => b[1] - a[1])) {
    parts.push(nameShape(type, count));
  }
  if (changed) parts.push(`${changed} change${changed === 1 ? "" : "s"}`);
  if (removed) parts.push(`${removed} deleted`);
  if (restored) parts.push(`${restored} restored`);
  if (pages) parts.push(`${pages} page change${pages === 1 ? "" : "s"}`);

  if (parts.length === 0) return `${events.length} edits`;
  if (parts.length <= 3) return parts.join(", ");
  return `${parts.slice(0, 2).join(", ")} and ${parts.length - 2} more`;
}

// ------------------------------------------------------------------ restore

/** The events that turn the document as it is now back into the document as it
 *  stood at `upTo`.
 *
 *  Restoring *appends*, exactly like undo does. Truncating the log to the chosen
 *  point would be the obvious implementation and it would destroy everything
 *  after it — which is the one thing this plugin promises never to happen. So a
 *  restore is itself an edit, it shows up in the history as one, and you can
 *  restore back past it.
 */
export function restoreTo(events: LogEvent[], upTo: number, originalPageCount: number): LogEvent[] {
  const then = replay(events, originalPageCount, upTo);
  const now = replay(events, originalPageCount);
  const out: LogEvent[] = [];
  const stamp = (): { id: string; ts: number } => ({ id: mintId(), ts: Date.now() });

  const thenObjects = new Map(then.objects.map((obj) => [obj.id, obj]));
  const nowObjects = new Map(now.objects.map((obj) => [obj.id, obj]));

  // Anything that exists now and did not exist then goes away.
  for (const [id] of nowObjects) {
    if (!thenObjects.has(id)) out.push({ ...stamp(), type: "obj.delete", ref: id });
  }

  for (const [id, was] of thenObjects) {
    const is = nowObjects.get(id);
    if (!is) {
      // It was deleted since. Bring it back, then put it how it was — restore
      // only clears the tombstone, it does not rewind the shape's geometry.
      out.push({ ...stamp(), type: "obj.restore", ref: id });
      out.push({ ...stamp(), type: "obj.edit", ref: id, g: { ...was.g }, st: { ...was.st }, s: was.s ?? "" });
      continue;
    }
    if (!sameShape(was, is)) {
      out.push({ ...stamp(), type: "obj.edit", ref: id, g: { ...was.g }, st: { ...was.st }, s: was.s ?? "" });
    }
  }

  out.push(...restorePages(now.order, then.order, stamp));
  return out;
}

function restorePages(
  now: PageId[],
  target: PageId[],
  stamp: () => { id: string; ts: number },
): LogEvent[] {
  const out: LogEvent[] = [];
  const wanted = new Set(target);
  const present = new Set(now);

  for (const page of now) {
    if (!wanted.has(page)) out.push({ ...stamp(), type: "page.delete", ref: page });
  }
  for (let i = 0; i < target.length; i++) {
    if (present.has(target[i])) continue;
    out.push({
      ...stamp(),
      type: "page.insert",
      after: i === 0 ? null : target[i - 1],
      page: target[i],
      src: /^o\d+$/.test(target[i]) ? "original" : "blank",
    });
  }

  // Now both sides hold the same pages; walk the target order and move anything
  // that is not already sitting behind the page it should follow.
  const working = now.filter((page) => wanted.has(page));
  for (const page of target) {
    if (!working.includes(page)) working.push(page);
  }
  for (let i = 0; i < target.length; i++) {
    if (working[i] === target[i]) continue;
    const page = target[i];
    working.splice(working.indexOf(page), 1);
    working.splice(i, 0, page);
    out.push({ ...stamp(), type: "page.move", ref: page, after: i === 0 ? null : target[i - 1] });
  }

  return out;
}

function sameShape(a: Obj, b: Obj): boolean {
  return (
    (a.s ?? "") === (b.s ?? "") &&
    JSON.stringify(a.g) === JSON.stringify(b.g) &&
    JSON.stringify(a.st) === JSON.stringify(b.st)
  );
}
