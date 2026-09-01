/** Ink is the one shape whose storage cost is not negligible, and the one whose
 *  rendering is not a direct transcription of what is stored. Both halves are
 *  worth pinning down. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  packPoints,
  unpackPoints,
  thin,
  outlinePath,
  inkBounds,
  distanceToInk,
  translatePoints,
  scalePoints,
} from "../.testbuild/ink.mjs";

const pt = (x, y, p = 0.5) => ({ x, y, p });

test("points survive a round trip through the log, rounded", () => {
  const points = [pt(1.24, 3.68, 0.512), pt(10, 20, 1)];
  const back = unpackPoints(packPoints(points));

  assert.equal(back.length, 2);
  assert.deepEqual(back[0], { x: 1.2, y: 3.7, p: 0.51 });
  assert.deepEqual(back[1], { x: 10, y: 20, p: 1 });
});

test("a flat array of the wrong length does not invent a point", () => {
  assert.equal(unpackPoints([1, 2]).length, 0, "two numbers are not a point");
  assert.equal(unpackPoints([1, 2, 3, 4]).length, 1, "the trailing scrap is dropped");
  assert.equal(unpackPoints(undefined).length, 0);
});

test("thinning drops points that carry no shape and keeps the ends", () => {
  // A straight run of eleven samples: nine of them say nothing.
  const straight = Array.from({ length: 11 }, (_, i) => pt(i, 0));
  const thinned = thin(straight, 0.4);

  assert.equal(thinned.length, 2, "a straight line is two points");
  assert.deepEqual([thinned[0].x, thinned[1].x], [0, 10], "and they are the ends");
});

test("thinning keeps a corner", () => {
  const bent = [pt(0, 0), pt(5, 0), pt(10, 0), pt(10, 5), pt(10, 10)];
  const thinned = thin(bent, 0.4);

  assert.equal(thinned.length, 3, "start, corner, end");
  assert.deepEqual(
    thinned.map((point) => [point.x, point.y]),
    [
      [0, 0],
      [10, 0],
      [10, 10],
    ],
  );
});

test("a stroke renders as a closed filled outline, not a stroked line", () => {
  const d = outlinePath([pt(0, 0), pt(10, 0), pt(20, 4)], 4, "pen");

  assert.match(d, /^M /, "starts with a move");
  assert.match(d, /Z$/, "and closes, because it is a filled shape");
  assert.ok(d.includes("A "), "a round nib caps with arcs");
});

test("a single tap is a dot, not an empty path", () => {
  const d = outlinePath([pt(5, 5, 1)], 4, "pen");
  assert.match(d, /^M .*Z$/s);
  assert.ok(d.length > 20, "there is real geometry in it");
});

test("a marker has flat caps; a pen does not", () => {
  const points = [pt(0, 0), pt(30, 0)];
  assert.ok(!outlinePath(points, 6, "marker").includes("A "), "flat");
  assert.ok(outlinePath(points, 6, "pen").includes("A "), "round");
});

test("bounds cover the nib, not just the centreline", () => {
  const box = inkBounds([pt(10, 10), pt(20, 30)], 6);

  assert.ok(box.x <= 7, "half the width to the left of the first point");
  assert.ok(box.y <= 7);
  assert.ok(box.x + box.w >= 23, "and to the right of the last");
  assert.ok(box.y + box.h >= 33);
});

test("distance finds the nearest point on the stroke, including between samples", () => {
  const stroke = [pt(0, 0), pt(10, 0)];

  assert.equal(distanceToInk(stroke, 5, 3), 3, "square onto the middle of a segment");
  assert.equal(distanceToInk(stroke, 0, 0), 0, "on it");
  assert.equal(distanceToInk(stroke, 14, 0), 4, "off the end");
});

test("moving and scaling a stroke keep its pressure", () => {
  const stroke = [pt(0, 0, 0.2), pt(10, 10, 0.9)];

  const moved = translatePoints(stroke, 5, -5);
  assert.deepEqual(moved[0], { x: 5, y: -5, p: 0.2 });
  assert.equal(moved[1].p, 0.9, "pressure is not a coordinate");

  const scaled = scalePoints(stroke, { x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 20, h: 5 });
  assert.deepEqual(scaled[1], { x: 20, y: 5, p: 0.9 });
});
