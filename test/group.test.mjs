import test from "node:test";
import assert from "node:assert/strict";

import {
  caughtBy,
  marquee,
  pointInPolygon,
  remap,
  clampSize,
  resizeBox,
  resizeTextWidth,
  typeFactor,
  unionBox,
} from "../.testbuild/group.mjs";

const box = (x, y, w, h) => ({ x, y, w, h });

test("the union is the box round everything", () => {
  assert.deepEqual(unionBox([box(10, 10, 20, 20), box(50, 5, 10, 40)]), { x: 10, y: 5, w: 50, h: 40 });
  assert.equal(unionBox([]), null);
});

test("a corner drag anchors the opposite corner", () => {
  const from = box(100, 100, 60, 40);
  assert.deepEqual(resizeBox(from, "se", 200, 200), { x: 100, y: 100, w: 100, h: 100 });
  assert.deepEqual(resizeBox(from, "nw", 80, 90), { x: 80, y: 90, w: 80, h: 50 });
});

test("an edge drag moves one side and leaves the other three", () => {
  const from = box(100, 100, 60, 40);
  assert.deepEqual(resizeBox(from, "e", 200, 999), { x: 100, y: 100, w: 100, h: 40 });
  assert.deepEqual(resizeBox(from, "n", 999, 60), { x: 100, y: 60, w: 60, h: 80 });
});

test("dragging a corner past the opposite one flips rather than inverts", () => {
  // A negative width is not a box; the drag reads as having crossed over.
  const flipped = resizeBox(box(100, 100, 60, 40), "se", 40, 30);
  assert.deepEqual(flipped, { x: 40, y: 30, w: 60, h: 70 });
});

test("shift keeps the proportions, and only on a corner", () => {
  const from = box(0, 0, 100, 50); // 2:1

  const square = resizeBox(from, "se", 200, 60, { aspect: true });
  assert.equal(square.w / square.h, 2);

  // An edge handle has only one axis to give, so shift must not touch it.
  assert.deepEqual(resizeBox(from, "e", 200, 999, { aspect: true }), { x: 0, y: 0, w: 200, h: 50 });
});

test("alt grows about the centre", () => {
  const from = box(100, 100, 60, 40); // centre 130, 120
  const grown = resizeBox(from, "e", 160, 0, { centre: true });

  assert.equal(grown.x + grown.w / 2, 130);
  assert.equal(grown.w, 60);
  assert.equal(grown.y, 100, "the untouched axis stays put");
});

test("a box never resizes to nothing", () => {
  const flat = resizeBox(box(0, 0, 100, 100), "se", 0, 0);
  assert.ok(flat.w >= 1 && flat.h >= 1);
});

test("remap keeps a member's place inside the frame", () => {
  const frame = box(0, 0, 100, 100);
  const doubled = box(0, 0, 200, 200);

  // A member in the middle of the frame stays in the middle of it.
  assert.deepEqual(remap(box(40, 40, 20, 20), frame, doubled), { x: 80, y: 80, w: 40, h: 40 });
  // A member flush with a corner stays flush with it.
  assert.deepEqual(remap(box(0, 0, 10, 10), frame, doubled), { x: 0, y: 0, w: 20, h: 20 });
});

test("remap survives a frame with no width", () => {
  const flat = remap(box(5, 5, 1, 1), box(0, 0, 0, 10), box(0, 0, 40, 20));
  assert.ok(Number.isFinite(flat.x) && Number.isFinite(flat.w));
});

test("point in polygon handles a concave loop", () => {
  // A C-shape: the notch on the right is outside despite being between the arms.
  const c = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 2 },
    { x: 2, y: 2 },
    { x: 2, y: 8 },
    { x: 10, y: 8 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  assert.equal(pointInPolygon(1, 5, c), true, "inside the spine");
  assert.equal(pointInPolygon(6, 5, c), false, "in the notch");
  assert.equal(pointInPolygon(20, 5, c), false, "outside altogether");
});

test("a polygon needs three points to hold anything", () => {
  assert.equal(pointInPolygon(1, 1, [{ x: 0, y: 0 }, { x: 2, y: 2 }]), false);
});

test("the lasso catches by the centre, not by touching", () => {
  const loop = marquee(0, 0, 100, 100);

  assert.equal(caughtBy(box(40, 40, 20, 20), loop), true, "wholly inside");
  assert.equal(caughtBy(box(90, 90, 40, 40), loop), false, "overlapping, centre outside");
  assert.equal(caughtBy(box(-50, 40, 200, 20), loop), true, "poking out both sides, centre inside");
});

test("every grip on a text box sets the wrap width", () => {
  const box = { x: 100, y: 50, w: 200, h: 18 };

  // The right-hand grips move the right edge and leave the left alone.
  for (const handle of ["e", "ne", "se"]) {
    assert.deepEqual(resizeTextWidth(box, handle, 400), { x: 100, w: 300 }, handle);
  }
  // The left-hand ones move the left edge and keep the right where it was.
  for (const handle of ["w", "nw", "sw"]) {
    assert.deepEqual(resizeTextWidth(box, handle, 40), { x: 40, w: 260 }, handle);
  }
});

test("a text box cannot be dragged narrower than it can hold a word", () => {
  const box = { x: 100, y: 50, w: 200, h: 18 };

  const squashed = resizeTextWidth(box, "e", 90);
  assert.equal(squashed.w, 24);
  assert.equal(squashed.x, 100, "the edge you are not dragging stays put");

  // Dragging the left edge past the right pins it rather than turning it over.
  const crossed = resizeTextWidth(box, "w", 999);
  assert.equal(crossed.w, 24);
  assert.equal(crossed.x, 276);
});

test("type takes the scale factor when the scale is uniform", () => {
  const from = { x: 0, y: 0, w: 100, h: 40 };

  assert.equal(typeFactor(from, { x: 0, y: 0, w: 200, h: 80 }), 2);
  assert.equal(typeFactor(from, { x: 0, y: 0, w: 50, h: 20 }), 0.5);
  assert.equal(typeFactor(from, { ...from }), 1);
});

test("a squashed box still gives type one number to take", () => {
  const from = { x: 0, y: 0, w: 100, h: 100 };
  // Four times as wide, unchanged in height: the area doubled, so does the type.
  assert.equal(typeFactor(from, { x: 0, y: 0, w: 400, h: 100 }), 2);
});

test("type factor survives a box with no extent", () => {
  assert.ok(Number.isFinite(typeFactor({ x: 0, y: 0, w: 0, h: 0 }, { x: 0, y: 0, w: 9, h: 9 })));
});

test("type sizes are clamped to something readable, in tenths", () => {
  assert.equal(clampSize(0.01), 4);
  assert.equal(clampSize(9999), 400);
  assert.equal(clampSize(13.700000000000001), 13.7);
  assert.equal(clampSize(14), 14);
});

test("a corner drag on a text box keeps its line breaks", () => {
  // The size and the wrap width take the same factor, so a paragraph that fit
  // in four lines still fits in four: same relative widths, same breaks.
  const from = { x: 10, y: 10, w: 120, h: 60 };
  const to = resizeBox(from, "se", 250, 130, { aspect: true });
  const factor = typeFactor(from, to);

  assert.ok(Math.abs(factor - to.w / from.w) < 1e-9);
  assert.ok(Math.abs(factor - to.h / from.h) < 1e-9);
});
