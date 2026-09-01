/** Version history: grouping the log into something readable, and restoring a
 *  version by appending rather than by truncating. The second is the one that
 *  would quietly destroy a document if it were wrong. */
import test from "node:test";
import assert from "node:assert/strict";
import { groupVersions, byDay, restoreTo } from "../.testbuild/history.mjs";
import { replay } from "../.testbuild/log.mjs";

const T0 = Date.UTC(2026, 7, 30, 14, 0, 0);
const MIN = 60 * 1000;

let n = 0;
const draw = (id, ts, extra = {}) => ({
  id,
  ts,
  type: "rect",
  page: "o0",
  g: { x: 0, y: 0, w: 10, h: 10 },
  st: { stroke: "#9061ff", w: 2 },
  ...extra,
});
const edit = (ts, ref, g) => ({ id: `e${n++}`, ts, type: "obj.edit", ref, g });
const kill = (ts, ref) => ({ id: `e${n++}`, ts, type: "obj.delete", ref });

test("a pause splits one session into two versions", () => {
  const events = [
    draw("a", T0),
    draw("b", T0 + 10 * 1000),
    // ten minutes later, a different sitting
    draw("c", T0 + 10 * MIN),
    draw("d", T0 + 10 * MIN + 5000),
  ];

  const versions = groupVersions(events);
  assert.equal(versions.length, 2, "two sittings");
  assert.equal(versions[0].upTo, 4, "newest first, and it replays the whole log");
  assert.equal(versions[1].upTo, 2, "the older one stops before the gap");
});

test("a long unbroken session is still cut into restore points", () => {
  // An edit every thirty seconds for an hour: never a two-minute pause, so
  // only the twenty-minute ceiling breaks it up.
  const events = Array.from({ length: 120 }, (_, i) => draw(`o${i}`, T0 + i * 30 * 1000));
  const versions = groupVersions(events);

  assert.ok(versions.length >= 3, `an hour is more than one restore point (got ${versions.length})`);
  assert.equal(versions[0].upTo, 120, "and the newest still reaches the end of the log");
});

test("versions are summarised in words, not event counts", () => {
  const events = [
    draw("a", T0),
    draw("b", T0 + 1000),
    { ...draw("c", T0 + 2000), type: "arrow", g: { x1: 0, y1: 0, x2: 5, y2: 5 } },
    edit(T0 + 3000, "a", { x: 4 }),
  ];

  const [version] = groupVersions(events);
  assert.match(version.summary, /2 rectangles/);
  assert.match(version.summary, /1 arrow/);
  assert.match(version.summary, /1 change/);
});

test("an empty log has no versions", () => {
  assert.deepEqual(groupVersions([]), []);
});

test("days are labelled relative to now", () => {
  const now = new Date(T0 + 2 * 24 * 60 * 60 * 1000);
  const versions = groupVersions([draw("a", T0)]);
  const days = byDay(versions, now);

  assert.equal(days.length, 1);
  assert.ok(!["Today", "Yesterday"].includes(days[0].label), "two days back gets a date");

  const today = byDay(groupVersions([draw("b", now.getTime())]), now);
  assert.equal(today[0].label, "Today");
});

// ----------------------------------------------------------------- restoring

test("restoring an earlier version deletes what came after it", () => {
  const events = [draw("a", T0), draw("b", T0 + 1000)];
  const patch = restoreTo(events, 1, 1); // back to just after "a"

  const after = replay([...events, ...patch], 1);
  assert.deepEqual(
    after.objects.map((o) => o.id),
    ["a"],
    "b is gone",
  );
});

test("restoring brings back something that was deleted since", () => {
  const events = [draw("a", T0), kill(T0 + 1000, "a")];
  const patch = restoreTo(events, 1, 1); // back to when "a" was alive

  const after = replay([...events, ...patch], 1);
  assert.deepEqual(after.objects.map((o) => o.id), ["a"], "a is back");
});

test("restoring rewinds a shape's geometry, not just its existence", () => {
  const events = [draw("a", T0), edit(T0 + 1000, "a", { x: 500, y: 500 })];
  const patch = restoreTo(events, 1, 1);

  const after = replay([...events, ...patch], 1);
  assert.equal(after.objects[0].g.x, 0, "back where it was drawn");
  assert.equal(after.objects[0].g.y, 0);
});

test("restoring never shortens the log", () => {
  const events = [draw("a", T0), draw("b", T0 + 1000), kill(T0 + 2000, "a")];
  const before = events.length;
  const patch = restoreTo(events, 1, 1);

  assert.ok(patch.length > 0, "there is something to do");
  assert.equal(events.length, before, "and it did not touch the log it was given");
  assert.ok(
    patch.every((event) => typeof event.id === "string" && typeof event.ts === "number"),
    "every restore step is a real, stamped event",
  );
});

test("restoring the current version is a no-op", () => {
  const events = [draw("a", T0), draw("b", T0 + 1000)];
  assert.deepEqual(restoreTo(events, events.length, 1), []);
});

test("you can restore past a restore, because the restore is itself history", () => {
  const events = [draw("a", T0), draw("b", T0 + 1000)];

  const undone = [...events, ...restoreTo(events, 1, 1)];
  assert.deepEqual(replay(undone, 1).objects.map((o) => o.id), ["a"], "b removed");

  // Now go back to the version that still had b in it.
  const redone = [...undone, ...restoreTo(undone, 2, 1)];
  assert.deepEqual(replay(redone, 1).objects.map((o) => o.id), ["a", "b"], "b is back");
});

test("restoring puts deleted pages back and undoes reordering", () => {
  const events = [
    { id: "p1", ts: T0, type: "page.delete", ref: "o1" },
    { id: "p2", ts: T0 + 1000, type: "page.move", ref: "o2", after: null },
  ];
  assert.deepEqual(replay(events, 3).order, ["o2", "o0"]);

  const patch = restoreTo(events, 0, 3); // all the way back to the untouched PDF
  assert.deepEqual(replay([...events, ...patch], 3).order, ["o0", "o1", "o2"]);
});

test("a restored page is the PDF's page, not a fresh blank one", () => {
  const events = [{ id: "p1", ts: T0, type: "page.delete", ref: "o1" }];
  const patch = restoreTo(events, 0, 3);
  const insert = patch.find((event) => event.type === "page.insert");

  assert.equal(insert.page, "o1");
  assert.equal(insert.src, "original", "or it would replay as an empty sheet");
});
