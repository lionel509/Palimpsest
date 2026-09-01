import test from "node:test";
import assert from "node:assert/strict";

import { mergeLines, strikeOf, underlineOf } from "../.testbuild/selection.mjs";

const box = (x, y, w, h) => ({ x, y, w, h });

test("adjacent runs on one line become one mark", () => {
  // A line of a slide comes back from the browser as one rect per text run.
  const merged = mergeLines([box(100, 200, 40, 12), box(143, 200, 30, 12), box(176, 200, 55, 12)]);

  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], { x: 100, y: 200, w: 131, h: 12 });
});

test("a column gutter is not a word space", () => {
  // Same line, but the second column starts 180pt away: fifteen line-heights,
  // where a word space is well under one.
  const merged = mergeLines([box(72, 300, 180, 12), box(320, 300, 180, 12)]);

  assert.equal(merged.length, 2);
  assert.deepEqual(
    merged.map((b) => b.x),
    [72, 320],
  );
});

test("lines stay separate and come back in reading order", () => {
  const merged = mergeLines([box(100, 214, 40, 12), box(100, 200, 40, 12), box(145, 200, 40, 12)]);

  assert.equal(merged.length, 2);
  assert.deepEqual(
    merged.map((b) => [b.y, b.w]),
    [
      [200, 85],
      [214, 40],
    ],
  );
});

test("a superscript joins the line it hangs off, and stretches the box up", () => {
  const merged = mergeLines([box(100, 200, 40, 12), box(141, 196, 5, 7)]);

  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], { x: 100, y: 196, w: 46, h: 16 });
});

test("an empty selection yields nothing", () => {
  assert.deepEqual(mergeLines([]), []);
});

test("merging never mutates the caller's rects", () => {
  const first = box(100, 200, 40, 12);
  const second = box(143, 200, 30, 12);
  mergeLines([first, second]);

  assert.deepEqual(first, { x: 100, y: 200, w: 40, h: 12 });
  assert.deepEqual(second, { x: 143, y: 200, w: 30, h: 12 });
});

test("a rule spans the box, and the underline sits below the strike", () => {
  const line = box(100, 200, 60, 12);
  const under = underlineOf(line);
  const strike = strikeOf(line);

  for (const rule of [under, strike]) {
    assert.equal(rule.x1, 100);
    assert.equal(rule.x2, 160);
    assert.equal(rule.y1, rule.y2);
  }
  assert.ok(strike.y1 > line.y, "a strike crosses the words, not their tops");
  assert.ok(strike.y1 < under.y1, "a strike sits above an underline");
  assert.ok(under.y1 <= line.y + line.h, "an underline stays inside the line box");
});
