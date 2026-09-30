# Palimpsest

Mark up a PDF inside Obsidian — freehand ink, text, rectangles, circles, lines, arrows, highlights — **without ever modifying the PDF**, and keep the whole history of how it got that way.

It also covers up answers so you can work the problems yourself. See **[Covering the answers](#covering-the-answers-and-doing-the-problems)**.

A palimpsest is a manuscript written over an older one where the earlier writing is still readable underneath. That's the idea.

## How it works

Two files, side by side in the vault:

```
lecture-04.pdf          ← the original. Never modified. Not on open, not on save, not ever.
lecture-04.palimpsest   ← an append-only JSONL log of every edit, created on your first mark
```

The view opens the **PDF**, not the log — the tab keeps the PDF's name and the file
explorer highlights the PDF, because that is the document as far as you are concerned.
The log is found beside it. Clicking a `.palimpsest` file directly still works too.

Rendering the document is *replay the log against the PDF*. Rendering it as it stood ten edits ago is *replay the first N events*. That one choice is what makes the timeline, undo, and (later) the timelapse export possible at all — bake edits into the PDF and you'd be diffing binary blobs.

Because the log is plaintext, your Obsidian git setup versions the edit history itself.

### The log

One JSON object per line:

```jsonc
{"v":1,"type":"doc","ts":1756240000000,"pdf":"BlackRock/ESE 271/lecture-04.pdf"}
{"id":"o1","ts":1756240000123,"type":"ellipse","page":"o6","g":{"x":180,"y":320,"w":116,"h":80},"st":{"stroke":"#9061ff","w":2}}
{"id":"o3","ts":1756240003001,"type":"ink","page":"o6","g":{"p":[180,320,0.4,182.4,318.1,0.62,187,315,0.9]},"st":{"stroke":"#9061ff","w":2.4,"brush":"pen"}}
{"id":"o2","ts":1756240009133,"type":"text","page":"o6","g":{"x":394,"y":288},"st":{"stroke":"#9061ff","size":14},"s":"Nyquist limit"}
{"id":"e1","ts":1756240102554,"type":"obj.edit","ref":"o1","g":{"x":184,"w":140}}
{"id":"e2","ts":1756240140880,"type":"obj.delete","ref":"o2"}
{"id":"o7","ts":1756240300000,"type":"cover","page":"o6","g":{"x":72,"y":410,"w":330,"h":54},"st":{"stroke":"#ffe9a3","opacity":1,"mark":null}}
{"id":"o8","ts":1756240340000,"type":"ink","page":"o6","g":{"p":[80,420,0.5,96,428,0.7]},"st":{"stroke":"#9061ff","w":2.4,"brush":"pen"},"on":"o7"}
```

Nothing is ever mutated. Moving a shape appends an `obj.edit` that references it; deleting appends an `obj.delete` tombstone. That's the difference between a history you can scrub and an undo stack that dies when you close the file.

**Pages are addressed by stable id, never by index.** Original page *n* is `o<n>`, fixed at import. The moment you insert or delete a page, "page 3" means different things at different points in the timeline, and index-addressed annotations silently scatter onto the wrong pages on replay. `test/replay.test.mjs` pins this down.

Coordinates are in points, origin at the page's top-left, y down, independent of zoom.

Ink is the one shape whose size is not negligible, so its points go in as a flat
`[x, y, pressure, ...]` array rounded to a tenth of a point, thinned on commit by
Ramer–Douglas–Peucker. A page of handwriting is a few tens of KB, not a few hundred.
A whole stroke is still **one** event, committed on pointer-up, so scrubbing plays a
stroke as a stroke rather than crawling through eight hundred intermediate states.

## Using it

- Open a PDF and click the **pen icon** in the tab's top-right actions. The page becomes markable in place, in the same tab, still called by the PDF's name.
- **After that, just open the PDF.** A PDF you have drawn on reopens showing your markup — you never click the `.palimpsest` file yourself, and never have to remember which of the two holds your work.
- **Settings → Open PDFs in Palimpsest** decides when that happens automatically: *Never*, *Only ones I have already marked up* (the default), or *Every PDF*.
- Opening a PDF here **writes nothing.** The `.palimpsest` log beside it is created the first time you actually mark something, so leaving the setting on *Every PDF* does not fill a course folder with empty logs for slide decks you only glanced at.
- The **page icon** in the tab actions goes back to Obsidian's own viewer, which still has the outline, the PDF's embedded links and any annotations already baked into the file.
- Also reachable from the ribbon, the command **Palimpsest: mark up the current PDF**, or right-click a PDF → **Mark up with Palimpsest**.

### Moving around

The document is **one scrolling column**, not one page at a time — you scroll it the
way you scroll anything else, and you draw on whichever page is under the pointer.
Pages paint as they come near the viewport and drop their bitmaps when they leave, so
a 400-page textbook costs about as much memory as a four-page handout.

- `Cmd`-scroll (or trackpad pinch) zooms, anchored on the pointer. `Cmd -` / `Cmd +` step through zoom stops, `Cmd 0` fits the width. Clicking the percentage toggles fit-width / fit-page.
- **Hold space** — or pick the hand tool — to drag the page around. Middle-drag does it too.
- The page box at the bottom takes a number. `Home` / `End` go to the ends, `PageUp` / `PageDown` move a screen.
- `Cmd \` opens the **page rail**: thumbnails you can click to jump to, drag to reorder, or use to insert and delete pages. `Cmd F` searches the text of the PDF.
- **Two-page** mode is in the bottom-right dropdown.

### Drawing

Keys: `V` select · `Q` lasso · `P` pen · `B` marker · `N` pencil · `E` eraser · `H` highlight · `T` text · `C` cover · `R` rectangle · `O` circle · `L` line · `A` arrow.

- **Pen, marker and pencil** are real brushes, not thin polylines: the stroke is drawn as a filled outline whose width follows pressure and tapers into each end. A stylus's pressure is used directly; a mouse or trackpad has none, so speed stands in for it — you slow down at the ends of a deliberate line, which is exactly where a nib lays down more ink. The marker is deliberately flat and multiplies into the page; the pencil has tooth.
- The **eraser** takes whole strokes, not pixels. They are tombstoned rather than dropped, so scrubbing back brings them out again. Erasing a scribble of eight strokes is **one** undo.
- The **colour puck** (the round swatch) opens a wheel with saturation/value, opacity, and nib size. Every tool remembers its own colour, size and opacity — a 16pt marker and a 2pt pen are not one setting wearing two hats. Recent colours are seeded from what is already on the document.
- **Hold shift** while drawing for a true circle, a square, or a line snapped to 45°.
- The tool stays in your hand after a stroke, so you can draw several in a row. `V` or `Escape` goes back to select. Text is the exception — it hands the select tool back once you finish a box, because a box you just typed is something you want to move or delete, not the first of ten.
- Selected: arrow keys nudge by a point (`shift` by ten), `Cmd-D` duplicates, `Escape` deselects.
- **To delete anything:** select it and press `Delete`, or use the bin in the toolbar, or **right-click it** — right-click also offers *Edit text*, *Duplicate*, and the page operations.

### Picking things up, and resizing them

- **Click** an object to select it. **Shift-** or **Cmd-click** adds another, and does the same again to put one back down. `Cmd A` takes everything on the page you are looking at. `Q` is the **lasso**: draw a loop round what you want, or hold `Alt` to drag a straight-sided box instead. The lasso catches an object by its **centre** — not by touching it, which would pick up a long arrow that merely passes nearby, and not by enclosing it whole, which would miss the one line poking out of a diagram.
- The lasso hands the select tool straight back, because what you do with a handful of objects is move or resize them and the lasso can do neither.
- A selection lives on **one page**. Picking something up on another page puts down what you were holding — every group operation is defined by the box around the members, and a box spanning two pages of a scrolling column is not a box.
- **Everything works on the whole selection:** drag to move, `Delete`, `Cmd-D`, the arrow keys, and the colour/size/opacity controls. However many objects it touches, it is **one** undo.
- **Resize handles** are on the corners *and* the sides — eight of them — so squashing a box horizontally is not a corner drag you have to keep level by hand. **Shift** keeps the proportions, **Alt** grows about the centre. A line has its two ends instead, and shift snaps one to 45°. A text box gets six: its **sides** reflow the words at a new wrap width, its **corners** scale the words themselves, and there is no top or bottom grip because its height is the wrapping's to decide. A text box caught in a **group** resize scales its type too — a label inside a diagram you are scaling has to scale with the diagram.
- Several selected: the handles belong to the box around all of them, and dragging one scales every member proportionally inside it — six shapes move like one picture, not like six independent things.

### Covering the answers, and doing the problems

A worked solution is worth nothing until you have tried the problem. So the
**cover** (`C`, the sticky-note icon) is an opaque patch you drop over an answer:
the page still reads as the page, minus the part you are supposed to produce
yourself.

- **The fast way to set a paper up:** select the answer's text and press `C` —
  or use *Cover this — I'll work it out* on the selection bar. You get one cover
  over the whole selection, snapped to the words. Unlike the highlighter, which
  goes line by line, this is deliberately **one cover, not one per line**: per-line
  patches leave the page showing through the leading, and on a two-line formula
  that is enough to read. You can also just drag one out by hand.
- **Write your attempt straight on it.** A cover is a writing surface, not just
  a patch of opacity. Anything you draw or type on a closed cover belongs to that
  cover: it moves when the cover moves, it goes when the cover goes, and it can
  be wiped without disturbing a single cover.
- **Lift the dog-ear** in the corner to check. It works with any tool in hand,
  so you do not put the pen down to look — and with the select tool, clicking
  anywhere on the cover lifts it too.
- Lifted, the paper drops to a wash and your working **fades with it**, so the
  printed answer reads clearly with your attempt ghosted over it in place. That
  is the comparison you actually wanted; hiding the cover outright would take
  your working away at exactly the moment you want to hold it against the answer.
- **Say how you did.** A tick and a cross appear under a lifted cover — they only
  exist while it is lifted, because grading an answer you have not looked at is
  not a thing to make possible by accident. Press one again to take it back.
  Right-click has both as well, plus *Show the answer* and *Cover it again*.
- A graded cover keeps a **coloured spine** when it is back down, so the four you
  got wrong on a twelve-page set are a glance rather than a hunt. The status bar
  keeps the count: `12 covered · 5 right · 2 wrong · 1 to check`.
- The **eye** beside that count shows every answer at once, or puts them all back.

**Lifting a cover is not an edit, and is never written down.** Logged, checking
an answer would be two lines in the history and a flicker in the timelapse — and,
worse, a problem set reopened next week would come back showing every answer you
had ever looked at. So **the answers are covered again every time you open the
file**, which is the whole point.

Two commands close the loop, both one undo:

- **Clear my attempts and start these again** wipes the working off every cover
  and clears the grades with it. The covers stay. A grade for an attempt that no
  longer exists is not a grade of anything.
- **Clear the ones I got wrong and try them again** does the same for just those.
  A second pass over the four you got wrong is worth more than a second pass over
  all forty, and picking those four out by hand is the chore that stops you doing it.

The eraser will not touch a cover. Rubbing out your working is the whole reason
to bring an eraser near one, and an eraser that took the post-it away with the
first stroke — uncovering the answer you were deliberately not looking at — is
the worst thing this feature could do. Select it and press `Delete` if you mean
the cover.

None of this needed anything new in the log. A cover is an ordinary object that
happens to paint opaque, and **log order is paint order** — so it hides what was
drawn before it and nothing drawn after, which is exactly a post-it, with no
z-index, no layers and no special case in the replay. Scrub back to before you
placed it and the answer is simply there.

### Selecting the PDF's own text

The pages are painted to a canvas, but the PDF's text is laid over them as an
invisible, exactly-placed layer — so with the **select tool** in hand you can
drag across a paragraph, double-click a word, and `Cmd C` it, the same as
anywhere else. Only pages near the viewport carry the layer, on the same
schedule as their bitmaps.

- **One tool does both.** Press on a shape and you move it; press anywhere else
  and you are selecting words. What is under the pointer decides, and the cursor
  says which it will be before you commit.
- Let go and a small bar appears over the selection: **Copy**, **Highlight**,
  **Underline**, **Strikethrough**. Right-click the selection for the same list.
- A highlight made this way is **snapped to the text** — exactly the height of
  the line and exactly as long as the sentence, one mark per line rather than
  one per word, however many runs the PDF cut that line into. A selection that
  runs over a page break marks each page separately, against that page's own id.
- Reaching for the **highlighter with words already selected** highlights those
  words rather than picking the tool up: the box you chose by hand is better
  than the one you would then have to drag.
- `Escape` drops the selection. In version history you can still select and
  copy — the bar keeps *Copy* and drops everything that would write.

### Text boxes

- Click with the text tool for a box that grows with what you type; **drag** one out to fix its width and wrap inside it. Double-clicking empty space with the select tool starts one too, as does right-click → *Add a text box here*.
- **Click a box you already made to edit it** — with the text tool in hand, or by double-clicking with any tool, or right-click → *Edit text*. It is a real multi-line editor sitting exactly on top of the rendered text, in the same font at the same size — `Enter` is a newline, `Cmd-Enter` or clicking away commits, `Escape` cancels. Emptying a box deletes it.
- **The sides reflow, the corners scale.** Dragging a side handle sets the **wrap width** and leaves the type alone. Dragging a **corner** scales the words: the size and the wrap width take the same factor, so the line breaks come out exactly where they were and the paragraph simply gets bigger. There is no top or bottom handle, because a text box's height is the wrapping's to decide.
- The size control changes whatever is **selected** — pick a text box and it reads and sets that box's type size, not the pen's width.

### History

- **Undo/redo** with the arrows or `Cmd-Z` / `Cmd-Shift-Z`. Undo *appends the inverse* rather than deleting the last line — popping the log would be simpler and would throw away the history the plugin exists for, and would make the timelapse a lie. Undoing is a thing you did, so it stays on the record. One gesture is one undo, however many events it wrote.
- The **clock icon** opens **version history**, which works the way Google Docs' does: the log is grouped into versions by the pauses between edits, listed newest first under day headers with a plain summary of what changed. Click one to see the document as it stood then, read-only. **Restore this version** brings it back — by appending the difference, never by truncating, so the edits you restored past are still in the history and you can restore forward again.

## Tags and links

Obsidian indexes tags and `[[links]]` out of **markdown only** — a PDF and a `.palimpsest` log are both invisible to the graph, the tag pane and backlinks. So Palimpsest generates a companion note beside the PDF instead of pretending otherwise.

Click the **links** icon in the markup toolbar (or run **Palimpsest: sync the note for this PDF**) and you get `<name>.md` containing your annotations, an embed of the PDF, and frontmatter.

Nothing is invented. What you type on the page is what lands in the note:

- `#ese271` typed in a text box → a bare YAML frontmatter tag, per vault convention (`"#tag"` in existing frontmatter gets normalised to bare on the way through).
- `[[Nyquist limit]]` typed in a text box → a real link, so the PDF finally shows up in the graph connected to the notes it belongs with.
- Covers you have graded → a **Practice:** line and a per-page count, so a week later the note says which page to go back to rather than only that the page was marked up.

Re-syncing rewrites only the block between `<!-- palimpsest:begin -->` and `<!-- palimpsest:end -->`. Prose you wrote by hand in that note is left alone, and tags you added by hand are never dropped — tags are a union, not a replacement.

## Not here yet

Deliberately, so each lands as its own commit:

- **Export to PDF** — writing the shapes back out via `pdf-lib`, as real annotations or flattened.
- **Timelapse video export.**
- Layers, arrows anchored to shapes, and rotation.
- Auto-syncing the companion note when markup changes; today it is a button, so it never fights your git auto-commit.

## Building

```sh
npm install
npm test           # replay engine, undo, ink, history, selection geometry
npm run check      # tsc
npm run install-local
```

`install-local` builds and copies into the vaults listed in `install.mjs`. Override with `OBSIDIAN_VAULT` (umbrella folder) or `OBSIDIAN_VAULTS` (colon-separated). Vanguard is deliberately absent and stays that way.

## Cleanup

`.gitignore` covers what this repo generates (`node_modules/`, `.testbuild/` from
`npm test`, secrets, logs, editor droppings) — `main.js` stays tracked. See
[CLEANUP.md](CLEANUP.md) for the preview/clean commands and the vault-side copies
`install-local` makes; `.palimpsest` logs and companion notes are never touched.

## One known bet

The plugin borrows Obsidian's own bundled pdf.js (`window.pdfjsLib`, falling back to importing it from `app://obsidian.md/lib/pdfjs/`) rather than shipping a second copy. That's an internal path and could move in a future Obsidian release. It's contained to `src/pdf.ts`, and the failure mode is a clear error message rather than damaged data.

Hooking Obsidian's built-in PDF *view* would be the genuinely unsafe version of this idea, and Palimpsest doesn't: it registers its own view and drives pdf.js directly.

MIT.
