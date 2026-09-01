/** Undo appends the inverse instead of truncating the log — the history is the
 *  product, so an undo has to be a thing that happened, not a thing erased. */
import test from "node:test";
import assert from "node:assert/strict";
import { replay, inverseOf } from "../.testbuild/log.mjs";

let n = 0;
const ev = (e) => ({ id: `e${n++}`, ts: 1000 + n, ...e });
const rect = (id, g) => ({ id, ts: 1000 + n++, type: "rect", page: "o0", g, st: { stroke: "#9061ff", w: 2 } });

/** Apply the inverse of event `i` and hand back the new log. */
const undo = (events, i, pages = 1) => {
  const inverse = inverseOf(events, i, pages);
  assert.ok(inverse, "expected an inverse");
  return [...events, inverse];
};

const shapes = (events) => replay(events, 1).objects;

test("undoing a draw removes the shape but lengthens the log", () => {
  const events = [rect("a", { x: 0, y: 0, w: 10, h: 10 })];
  const after = undo(events, 0);

  assert.equal(shapes(after).length, 0, "the shape is gone");
  assert.equal(after.length, 2, "the log grew — nothing was erased");
  assert.equal(shapes(after.slice(0, 1)).length, 1, "and the drawing is still in the history");
});

test("undoing a delete brings the shape back, edits and all", () => {
  const events = [
    rect("a", { x: 0, y: 0, w: 10, h: 10 }),
    ev({ type: "obj.edit", ref: "a", g: { x: 40, w: 25 } }),
    ev({ type: "obj.delete", ref: "a" }),
  ];
  assert.equal(shapes(events).length, 0);

  const after = undo(events, 2);
  const back = shapes(after);
  assert.equal(back.length, 1);
  assert.deepEqual(back[0].g, { x: 40, y: 0, w: 25, h: 10 }, "restored as it was, not as first drawn");
});

test("undoing a move restores the previous geometry exactly", () => {
  const events = [
    rect("a", { x: 10, y: 20, w: 30, h: 40 }),
    ev({ type: "obj.edit", ref: "a", g: { x: 99, y: 99, w: 30, h: 40 } }),
  ];
  const after = undo(events, 1);
  assert.deepEqual(shapes(after)[0].g, { x: 10, y: 20, w: 30, h: 40 });
});

test("undoing a restyle leaves the geometry alone", () => {
  const events = [
    rect("a", { x: 1, y: 2, w: 3, h: 4 }),
    ev({ type: "obj.edit", ref: "a", st: { stroke: "#e5534b" } }),
  ];
  const after = undo(events, 1);
  const shape = shapes(after)[0];
  assert.equal(shape.st.stroke, "#9061ff");
  assert.equal(shape.st.w, 2);
  assert.deepEqual(shape.g, { x: 1, y: 2, w: 3, h: 4 });
});

test("undoing a retype restores the previous words", () => {
  const events = [
    { id: "t", ts: 1, type: "text", page: "o0", g: { x: 0, y: 0 }, st: {}, s: "Nyquist" },
    ev({ type: "obj.edit", ref: "t", s: "Shannon" }),
  ];
  const after = undo(events, 1);
  assert.equal(shapes(after)[0].s, "Nyquist");
});

test("redo is just undoing the undo", () => {
  const drawn = [rect("a", { x: 0, y: 0, w: 10, h: 10 })];

  const undone = undo(drawn, 0);
  assert.equal(shapes(undone).length, 0);

  const redone = undo(undone, 1); // invert the inverse
  assert.equal(shapes(redone).length, 1, "the shape is back");
  assert.equal(redone.length, 3, "and every step of that is on the record");
});

test("undo of an undo of a delete settles, rather than oscillating away", () => {
  // Starts deleted, so an even number of flips lands back on deleted.
  let events = [rect("a", { x: 0, y: 0, w: 10, h: 10 }), ev({ type: "obj.delete", ref: "a" })];
  assert.equal(shapes(events).length, 0);

  for (let i = 0; i < 4; i++) events = undo(events, events.length - 1);
  assert.equal(shapes(events).length, 0, "four flips: back to deleted");

  events = undo(events, events.length - 1);
  assert.equal(shapes(events).length, 1, "five: present again");
  assert.equal(events.length, 7, "and all seven steps are on the record");
});

test("scrubbing still walks through the undos as real steps", () => {
  const events = undo([rect("a", { x: 0, y: 0, w: 10, h: 10 })], 0);
  assert.equal(replay(events, 1, 1).objects.length, 1, "mid-history the shape exists");
  assert.equal(replay(events, 1, 2).objects.length, 0, "after the undo it does not");
});

test("an event with no meaningful inverse says so", () => {
  assert.equal(inverseOf([], 0, 1), null, "there is no event 0 to invert");
  assert.equal(
    inverseOf([ev({ type: "page.move", ref: "gone", after: null })], 0, 2),
    null,
    "moving a page that is not in the document has nothing to put back",
  );
});

test("undoing a page move puts the page back where it was", () => {
  // Three original pages; move the last one to the front, then undo it.
  const move = ev({ type: "page.move", ref: "o2", after: null });
  const events = [move];
  assert.deepEqual(replay(events, 3).order, ["o2", "o0", "o1"], "moved to the front");

  const back = undo(events, 0, 3);
  assert.deepEqual(replay(back, 3).order, ["o0", "o1", "o2"], "and back behind o1");
  assert.equal(back.length, 2, "by appending, not by dropping the move");
});

test("undoing a page deletion restores the page in its old position", () => {
  const events = [ev({ type: "page.delete", ref: "o1" })];
  assert.deepEqual(replay(events, 3).order, ["o0", "o2"]);

  const back = undo(events, 0, 3);
  assert.deepEqual(replay(back, 3).order, ["o0", "o1", "o2"], "page 1 is back between its neighbours");
  assert.equal(back[1].src, "original", "and it is the PDF page, not a new blank one");
});
