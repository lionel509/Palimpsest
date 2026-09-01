/** Covers: the geometry of lifting one, and the arithmetic of a practice run.
 *
 *  The load-bearing claim these pin down is that a cover needed no new
 *  machinery in the log to work — it is an ordinary object, and *log order is
 *  paint order* is what makes it hide the answer. The replay tests below check
 *  that directly, because if paint order ever stopped following the log, a
 *  covered answer would quietly become a visible one.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  attemptsOn,
  coverAt,
  hitZone,
  markZones,
  peelCorner,
  resetTargets,
  tally,
  tallyLabel,
  unionCover,
} from "../.testbuild/study.mjs";
import { replay, inverseOf, isCover } from "../.testbuild/log.mjs";

const box = (x, y, w, h) => ({ x, y, w, h });

let n = 0;
const cover = (id, g, mark = null) => ({
  id,
  ts: 1000 + n++,
  type: "cover",
  page: "o0",
  g,
  st: { stroke: "#ffe9a3", opacity: 1, mark },
});
const stroke = (id, on) => ({
  id,
  ts: 1000 + n++,
  type: "ink",
  page: "o0",
  g: { p: [10, 10, 0.5, 20, 20, 0.5] },
  st: { stroke: "#9061ff", w: 2 },
  ...(on ? { on } : {}),
});

// ---------------------------------------------------------------- geometry

test("the dog-ear is a constant size on screen, not on the page", () => {
  const big = box(100, 100, 300, 200);
  const near = peelCorner(big, 1);
  const far = peelCorner(big, 0.5);

  // Half the zoom, twice the page-points — so it paints the same size either
  // way. A control that shrank with the document would be unhittable on a
  // page fitted to the window.
  assert.equal(far.w, near.w * 2);
  assert.equal(near.x + near.w, 400, "and it sits in the top-right corner");
  assert.equal(near.y, 100);
});

test("a one-line answer's cover does not come out as one big corner", () => {
  const thin = box(100, 100, 40, 12);
  const corner = peelCorner(thin, 1);
  assert.ok(corner.w <= thin.h / 2, "clamped to half the cover");
  assert.ok(corner.w >= 6, "but never to nothing");
});

test("the tick and cross straddle the bottom edge, so a short cover still has room", () => {
  const short = box(100, 100, 200, 14);
  const { right, wrong } = markZones(short, 1);

  assert.equal(right.h, wrong.h);
  assert.equal(right.y + right.h / 2, 114, "centred on the bottom edge");
  assert.ok(right.x + right.w <= wrong.x, "and they do not overlap each other");
  assert.ok(wrong.x + wrong.w <= short.x + short.w, "nor hang off the right of the cover");
});

test("grading is only offered on a cover you have actually lifted", () => {
  const shape = box(100, 100, 200, 60);
  const { right } = markZones(shape, 1);
  const at = { x: right.x + right.w / 2, y: right.y + right.h / 2 };

  assert.equal(hitZone(shape, 1, at.x, at.y, true), "right");
  assert.equal(hitZone(shape, 1, at.x, at.y, false), null, "closed: no tick to press");
});

test("the dog-ear answers whether the cover is up or down", () => {
  const shape = box(100, 100, 200, 60);
  const corner = peelCorner(shape, 1);
  const at = { x: corner.x + corner.w / 2, y: corner.y + corner.h / 2 };

  assert.equal(hitZone(shape, 1, at.x, at.y, false), "peel");
  assert.equal(hitZone(shape, 1, at.x, at.y, true), "peel");
  assert.equal(hitZone(shape, 1, 110, 130, false), null, "the middle of the paper is not a control");
});

// ------------------------------------------------------------- from a selection

test("a selected answer becomes one cover, not one per line", () => {
  // What a three-line selection hands back: one box per line.
  const lines = [box(72, 100, 300, 12), box(72, 116, 300, 12), box(72, 132, 180, 12)];
  const merged = unionCover(lines, 2);

  assert.deepEqual(merged, { x: 70, y: 98, w: 304, h: 48 });
  // The gaps between the lines are inside it. Per-line covers would leave the
  // leading showing, and on a two-line formula that is enough to read.
  assert.ok(merged.h > 12 * 3, "the leading is covered too");
});

test("covering nothing covers nothing", () => {
  assert.equal(unionCover([]), null);
});

// ------------------------------------------------------------------ ownership

test("a cover claims what is written on it, and only that", () => {
  const objects = replay(
    [cover("c1", box(100, 100, 200, 80)), stroke("s1", "c1"), stroke("s2", "c1"), stroke("s3")],
    1,
  ).objects;

  const mine = attemptsOn(objects, ["c1"]).map((obj) => obj.id);
  assert.deepEqual(mine, ["s1", "s2"]);
  assert.deepEqual(attemptsOn(objects, ["c2"]), [], "a cover that never existed owns nothing");
});

test("the topmost cover under the point is the one you drew on", () => {
  const objects = replay([cover("under", box(0, 0, 200, 200)), cover("over", box(50, 50, 60, 60))], 1).objects;

  assert.equal(coverAt(objects, "o0", 70, 70).id, "over");
  assert.equal(coverAt(objects, "o0", 10, 10).id, "under");
  assert.equal(coverAt(objects, "o0", 400, 400), null);
  assert.equal(coverAt(objects, "o9", 70, 70), null, "and pages are not interchangeable");
});

// --------------------------------------------------------------------- tally

test("the tally counts covers, attempts and grades separately", () => {
  const objects = replay(
    [
      cover("c1", box(0, 0, 10, 10), "right"),
      cover("c2", box(0, 20, 10, 10), "wrong"),
      cover("c3", box(0, 40, 10, 10)),
      cover("c4", box(0, 60, 10, 10)),
      stroke("s1", "c1"),
      stroke("s2", "c3"),
      stroke("loose"),
    ],
    1,
  ).objects;

  assert.deepEqual(tally(objects), { covers: 4, tried: 2, right: 1, wrong: 1 });
});

test("the readout names only what there is to say", () => {
  assert.equal(tallyLabel({ covers: 0, tried: 0, right: 0, wrong: 0 }), null, "an ordinary PDF says nothing");
  assert.equal(tallyLabel({ covers: 6, tried: 0, right: 0, wrong: 0 }), "6 covered");
  assert.equal(tallyLabel({ covers: 6, tried: 4, right: 2, wrong: 1 }), "6 covered · 2 right · 1 wrong · 1 to check");
});

test("reset picks out the ones you got wrong", () => {
  const objects = replay(
    [cover("c1", box(0, 0, 10, 10), "right"), cover("c2", box(0, 20, 10, 10), "wrong"), stroke("s1", "c1")],
    1,
  ).objects;

  assert.deepEqual(
    resetTargets(objects, "wrong").map((obj) => obj.id),
    ["c2"],
  );
  assert.deepEqual(
    resetTargets(objects, "all").map((obj) => obj.id),
    ["c1", "c2"],
    "and a stroke is not a cover",
  );
});

// --------------------------------------------------------- through the log

test("a cover hides what came before it and nothing after — that is the whole trick", () => {
  const events = [stroke("answer"), cover("c1", box(0, 0, 200, 80)), stroke("attempt", "c1")];
  const objects = replay(events, 1);

  // Paint order is log order, so the ordering *is* the layering. If this ever
  // stops holding, a covered answer becomes a visible one.
  assert.deepEqual(
    objects.objects.map((obj) => obj.id),
    ["answer", "c1", "attempt"],
  );
  assert.ok(isCover(objects.objects[1].type));
});

test("a grade is an ordinary edit, so it undoes like one", () => {
  const events = [cover("c1", box(0, 0, 200, 80))];
  events.push({ id: "m1", ts: 2000, type: "obj.edit", ref: "c1", st: { mark: "wrong" } });
  assert.equal(replay(events, 1).objects[0].st.mark, "wrong");

  const back = inverseOf(events, 1, 1);
  assert.ok(back, "a grade has an inverse");
  const after = replay([...events, back], 1).objects[0];

  // `null` rather than a missing key: an st patch is merged over the old one,
  // and `undefined` would serialise to `{}` and change nothing at all.
  assert.equal(after.st.mark, null, "undoing a grade actually removes it");
});

test("scrubbing back to before a cover shows the answer it hides", () => {
  const events = [stroke("answer"), cover("c1", box(0, 0, 200, 80))];
  const before = replay(events, 1, 1).objects;

  assert.deepEqual(
    before.map((obj) => obj.id),
    ["answer"],
    "the cover had not been placed yet",
  );
});

test("ownership survives the round trip through the log", () => {
  const events = [cover("c1", box(0, 0, 200, 80)), stroke("s1", "c1")];
  const parsed = JSON.parse(JSON.stringify(events));
  const objects = replay(parsed, 1).objects;

  assert.equal(objects.find((obj) => obj.id === "s1").on, "c1");
  assert.equal(objects.find((obj) => obj.id === "c1").on, undefined, "a cover belongs to nothing");
});
