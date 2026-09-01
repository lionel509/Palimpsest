/** The companion note is the only place a marked-up PDF becomes visible to the
 *  graph. The risk here is clobbering prose the user wrote by hand. */
import test from "node:test";
import assert from "node:assert/strict";
import { generate, merge, extractTags, extractLinks, BEGIN, END } from "../.testbuild/note.mjs";

const text = (id, page, s) => ({ id, type: "text", page, g: { x: 10, y: 10 }, st: {}, s, z: 0 });
const circle = (id, page) => ({ id, type: "ellipse", page, g: { x: 0, y: 0, w: 10, h: 10 }, st: {}, z: 1 });

const state = (objects, order = ["o0", "o1"]) => ({ order, objects });

test("tags and links are read out of what was typed on the page", () => {
  assert.deepEqual(extractTags("the #nyquist limit, see #ese271/lectures"), ["nyquist", "ese271/lectures"]);
  assert.deepEqual(extractLinks("compare [[Nyquist limit]] and [[Sampling|this]]"), ["Nyquist limit", "Sampling"]);
});

test("a generated note carries the page's tags and links", () => {
  const g = generate({
    pdfPath: "BlackRock/ESE 271/lecture-04.pdf",
    title: "lecture-04",
    state: state([text("a", "o1", "watch the [[Nyquist limit]] #ese271")]),
  });
  assert.deepEqual(g.tags, ["ese271"]);
  assert.deepEqual(g.links, ["Nyquist limit"]);
  assert.match(g.block, /### Page 2/);
  assert.match(g.block, /!\[\[BlackRock\/ESE 271\/lecture-04\.pdf\]\]/);
});

test("non-text marks are summarised rather than listed as blanks", () => {
  const g = generate({
    pdfPath: "a.pdf",
    title: "a",
    state: state([circle("c1", "o0"), circle("c2", "o0"), text("t", "o0", "note")]),
  });
  assert.match(g.block, /- note/);
  // Shapes are named the way a person would name them, and identically to the
  // way the version history names them — not by their type in the log.
  assert.match(g.block, /2 circles/);
});

test("an empty document says so instead of writing an empty section", () => {
  const g = generate({ pdfPath: "a.pdf", title: "a", state: state([]) });
  assert.match(g.block, /No annotations yet/);
});

test("merge into a fresh note seeds the frontmatter", () => {
  const g = generate({ pdfPath: "a.pdf", title: "a", state: state([text("t", "o0", "hi #maths")]) });
  const out = merge(null, g, ["blackrock", "pdf"]);
  assert.match(out, /^---\ntags:\n {2}- blackrock\n {2}- pdf\n {2}- maths\n---/);
  assert.ok(out.includes(BEGIN) && out.includes(END));
});

test("merging again replaces only the managed block and keeps the user's prose", () => {
  const first = merge(null, generate({ pdfPath: "a.pdf", title: "a", state: state([text("t", "o0", "one")]) }), ["pdf"]);
  const edited = first.replace(END, `${END}\n\n## My own thoughts\n\nThis matters because of X.`);

  const second = merge(
    edited,
    generate({ pdfPath: "a.pdf", title: "a", state: state([text("t", "o0", "two")]) }),
  );

  assert.match(second, /## My own thoughts/, "hand-written prose survives");
  assert.match(second, /This matters because of X\./);
  assert.match(second, /- two/, "the block is refreshed");
  assert.doesNotMatch(second, /- one/, "the stale block is gone");
  assert.equal(second.split(BEGIN).length - 1, 1, "exactly one managed block");
});

test("tags added by hand in the note are never dropped", () => {
  const g1 = generate({ pdfPath: "a.pdf", title: "a", state: state([text("t", "o0", "#alpha")]) });
  const first = merge(null, g1, ["pdf"]);
  const edited = first.replace("  - alpha", "  - alpha\n  - handwritten");

  const g2 = generate({ pdfPath: "a.pdf", title: "a", state: state([text("t", "o0", "#beta")]) });
  const second = merge(edited, g2);

  for (const tag of ["pdf", "alpha", "handwritten", "beta"]) {
    assert.ok(second.includes(`  - ${tag}`), `kept ${tag}`);
  }
});

test("an inline tag list in existing frontmatter is understood", () => {
  const existing = '---\ntags: [school, "#pdf"]\n---\n\nsome prose\n';
  const g = generate({ pdfPath: "a.pdf", title: "a", state: state([text("t", "o0", "#new")]) });
  const out = merge(existing, g);
  assert.match(out, /- school/);
  assert.match(out, /- pdf/, "a quoted #tag is normalised to a bare one");
  assert.match(out, /- new/);
  assert.match(out, /some prose/);
});

test("a note with no frontmatter at all is handled", () => {
  const g = generate({ pdfPath: "a.pdf", title: "a", state: state([]) });
  const out = merge("just prose, no frontmatter\n", g);
  assert.match(out, /^---\n/);
  assert.match(out, /just prose, no frontmatter/);
});
