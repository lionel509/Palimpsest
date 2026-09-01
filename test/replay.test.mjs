/** The replay engine is the whole bet: if these fail, nothing above it matters.
 *
 *  Run with `npm test` (which builds src/log.ts to test/.build first).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { replay, rectFromDrag, parseLog, originalPageId } from "../.testbuild/log.mjs";

let n = 0;
const ev = (e) => ({ id: `e${n++}`, ts: 1000 + n, ...e });

const circle = (id, page, g = { x: 10, y: 10, w: 40, h: 40 }) => ({
  id,
  ts: 1000 + n++,
  type: "ellipse",
  page,
  g,
  st: { stroke: "#9061ff", w: 2 },
});

test("original pages are addressed by stable id, not index", () => {
  const { order } = replay([], 3);
  assert.deepEqual(order, ["o0", "o1", "o2"]);
  assert.equal(originalPageId(2), "o2");
});

test("an annotation stays on its page after a page is inserted before it", () => {
  const events = [
    circle("mark", "o2"),
    ev({ type: "page.insert", after: "o0", page: "iNEW", src: "blank" }),
  ];
  const { order, objects } = replay(events, 3);

  // o2 is now the fourth page on screen...
  assert.deepEqual(order, ["o0", "iNEW", "o1", "o2"]);
  assert.equal(order.indexOf("o2"), 3);
  // ...but the annotation is still attached to o2, not to "page 3".
  assert.equal(objects.length, 1);
  assert.equal(objects[0].page, "o2");
});

test("insert then delete leaves the surviving pages and their marks intact", () => {
  const events = [
    circle("a", "o0"),
    circle("b", "o1"),
    ev({ type: "page.insert", after: "o0", page: "iNEW", src: "blank" }),
    ev({ type: "page.delete", ref: "iNEW" }),
  ];
  const { order, objects } = replay(events, 2);
  assert.deepEqual(order, ["o0", "o1"]);
  assert.deepEqual(objects.map((o) => `${o.id}@${o.page}`), ["a@o0", "b@o1"]);
});

test("page.move reorders without disturbing what is drawn on the pages", () => {
  const events = [
    circle("a", "o0"),
    ev({ type: "page.move", ref: "o0", after: "o2" }),
  ];
  const { order, objects } = replay(events, 3);
  assert.deepEqual(order, ["o1", "o2", "o0"]);
  assert.equal(objects[0].page, "o0");
});

test("obj.edit chains resolve in order and never mutate the log", () => {
  const events = [
    circle("a", "o0", { x: 0, y: 0, w: 10, h: 10 }),
    ev({ type: "obj.edit", ref: "a", g: { x: 5 } }),
    ev({ type: "obj.edit", ref: "a", g: { x: 9, w: 20 } }),
    ev({ type: "obj.edit", ref: "a", st: { stroke: "#e5534b" } }),
  ];
  const { objects } = replay(events, 1);
  assert.deepEqual(objects[0].g, { x: 9, y: 0, w: 20, h: 10 });
  assert.equal(objects[0].st.stroke, "#e5534b");
  assert.equal(objects[0].st.w, 2, "an edit patches, it does not replace, the style");

  // The events themselves are untouched — that is what makes history replayable.
  assert.equal(events[0].g.x, 0);
});

test("scrubbing back shows the document before a deletion", () => {
  const events = [
    circle("a", "o0"),
    circle("b", "o0"),
    ev({ type: "obj.delete", ref: "a" }),
  ];
  assert.equal(replay(events, 1).objects.length, 1, "after everything: one shape left");
  assert.equal(replay(events, 1, 2).objects.length, 2, "scrubbed back: the deleted shape is there again");
  assert.equal(replay(events, 1, 0).objects.length, 0, "at the start: a clean page");
});

test("upTo is clamped rather than throwing", () => {
  const events = [circle("a", "o0")];
  assert.equal(replay(events, 1, -5).objects.length, 0);
  assert.equal(replay(events, 1, 99).objects.length, 1);
});

test("editing a deleted object is ignored instead of resurrecting it", () => {
  const events = [
    circle("a", "o0"),
    ev({ type: "obj.delete", ref: "a" }),
    ev({ type: "obj.edit", ref: "a", g: { x: 500 } }),
  ];
  assert.equal(replay(events, 1).objects.length, 0);
});

test("paint order follows creation order", () => {
  const events = [circle("first", "o0"), circle("second", "o0"), circle("third", "o0")];
  assert.deepEqual(replay(events, 1).objects.map((o) => o.id), ["first", "second", "third"]);
});

test("a corrupt line is reported, not silently swallowed", () => {
  const text = [
    '{"v":1,"type":"doc","ts":1,"pdf":"a.pdf"}',
    '{"id":"o1","ts":2,"type":"rect","page":"o0","g":{},"st":{}}',
    "{ this is not json",
    "",
    '{"id":"o2","ts":3,"type":"rect","page":"o0","g":{},"st":{}}',
  ].join("\n");

  const parsed = parseLog(text);
  assert.equal(parsed.header.pdf, "a.pdf");
  assert.equal(parsed.events.length, 2);
  assert.deepEqual(parsed.bad, [3]);
});

test("a drag in any direction becomes a positive-sized rect", () => {
  assert.deepEqual(rectFromDrag(50, 60, 10, 20), { x: 10, y: 20, w: 40, h: 40 });
  assert.deepEqual(rectFromDrag(10, 20, 50, 60), { x: 10, y: 20, w: 40, h: 40 });
});
