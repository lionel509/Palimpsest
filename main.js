"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/pdf.ts
var pdf_exports = {};
__export(pdf_exports, {
  baseSize: () => baseSize,
  loadPdfjs: () => loadPdfjs,
  openPdf: () => openPdf,
  pageSizes: () => pageSizes,
  renderPage: () => renderPage,
  renderThumb: () => renderThumb,
  textRuns: () => textRuns
});
async function loadPdfjs() {
  if (cached) return cached;
  const existing = window.pdfjsLib;
  if (existing) {
    cached = existing;
    return cached;
  }
  const mod = await dynamicImport(PDFJS_MODULE);
  const lib = mod?.getDocument ? mod : mod?.default;
  if (!lib?.getDocument) {
    throw new Error("Palimpsest: could not load Obsidian's pdf.js. Open any PDF once, then reopen this file.");
  }
  if (lib.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc) {
    lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  }
  cached = lib;
  return cached;
}
async function openPdf(bytes) {
  const pdfjs = await loadPdfjs();
  return await pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise;
}
function baseSize(page) {
  const viewport = page.getViewport({ scale: 1 });
  return { width: viewport.width, height: viewport.height };
}
async function renderPage(page, canvas, scale, onTask) {
  const dpr = window.devicePixelRatio || 1;
  const viewport = page.getViewport({ scale: scale * dpr });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
  canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
  const context2 = canvas.getContext("2d");
  if (!context2) throw new Error("Palimpsest: no 2d canvas context");
  const task = page.render({ canvasContext: context2, viewport });
  onTask?.(task);
  try {
    await task.promise;
  } catch (error) {
    const name = error?.name;
    if (name !== "RenderingCancelledException") throw error;
  }
}
async function renderThumb(page, canvas, width) {
  const base = page.getViewport({ scale: 1 });
  await renderPage(page, canvas, width / base.width);
}
async function pageSizes(pdf, cap = 250) {
  const first = baseSize(await pdf.getPage(1));
  const count = pdf.numPages;
  if (count > cap) return new Array(count).fill(first);
  const sizes = new Array(count).fill(first);
  const batch = 32;
  for (let start = 1; start < count; start += batch) {
    const end = Math.min(count, start + batch);
    const pages = await Promise.all(
      Array.from({ length: end - start }, (_, i) => pdf.getPage(start + i + 1))
    );
    pages.forEach((page, i) => {
      sizes[start + i] = baseSize(page);
    });
  }
  return sizes;
}
async function textRuns(page) {
  const pdfjs = await loadPdfjs();
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const styles = content.styles ?? {};
  const out = [];
  for (const item of content.items) {
    if (!item.str || !item.transform) continue;
    const m = pdfjs.Util.transform(viewport.transform, item.transform);
    const style = styles[item.fontName ?? ""] ?? {};
    const h = Math.hypot(m[2], m[3]) || item.height || 10;
    const angle = Math.atan2(m[1], m[0]) + (style.vertical ? Math.PI / 2 : 0);
    const rise = h * (style.ascent && style.ascent > 0 ? style.ascent : DEFAULT_ASCENT);
    out.push({
      str: item.str,
      x: angle === 0 ? m[4] : m[4] + rise * Math.sin(angle),
      y: angle === 0 ? m[5] - rise : m[5] - rise * Math.cos(angle),
      w: item.width ?? 0,
      h,
      // The real font is only installed if pdf.js has already painted this page
      // with it, so every stack ends in something that certainly exists.
      font: style.fontFamily ? `${style.fontFamily}, sans-serif` : "sans-serif",
      angle,
      eol: item.hasEOL === true
    });
  }
  return out;
}
var PDFJS_MODULE, PDFJS_WORKER, dynamicImport, cached, DEFAULT_ASCENT;
var init_pdf = __esm({
  "src/pdf.ts"() {
    "use strict";
    PDFJS_MODULE = "app://obsidian.md/lib/pdfjs/pdf.min.mjs";
    PDFJS_WORKER = "app://obsidian.md/lib/pdfjs/pdf.worker.min.mjs";
    dynamicImport = new Function("url", "return import(url);");
    cached = null;
    DEFAULT_ASCENT = 0.8;
  }
});

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => PalimpsestPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian3 = require("obsidian");

// src/log.ts
var LOG_VERSION = 1;
var originalPageId = (index) => `o${index}`;
var SHAPE_TYPES = [
  "rect",
  "ellipse",
  "line",
  "arrow",
  "text",
  "highlight",
  "ink",
  "cover"
];
var isShapeType = (t) => SHAPE_TYPES.includes(t);
var counter = 0;
function mintId(prefix = "e") {
  counter += 1;
  const stamp = Date.now().toString(36);
  const salt = Math.floor(Math.random() * 1e6).toString(36);
  return `${prefix}${stamp}${counter.toString(36)}${salt}`;
}
function serialise(event) {
  return JSON.stringify(event);
}
function newDocEvent(pdfPath) {
  return { v: LOG_VERSION, type: "doc", ts: Date.now(), pdf: pdfPath };
}
function parseLog(text) {
  const out = { header: null, events: [], bad: [] };
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      out.bad.push(i + 1);
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) {
      out.bad.push(i + 1);
      continue;
    }
    const event = parsed;
    if (event.type === "doc") {
      out.header = parsed;
      continue;
    }
    if (typeof event.type !== "string") {
      out.bad.push(i + 1);
      continue;
    }
    out.events.push(parsed);
  }
  return out;
}
function replay(events, originalPageCount, upTo) {
  const { order, objects } = walk(events, originalPageCount, upTo);
  return {
    order,
    objects: [...objects.values()].filter((obj) => !obj.dead).sort((a, b) => a.z - b.z)
  };
}
function walk(events, originalPageCount, upTo) {
  const limit = upTo === void 0 ? events.length : Math.max(0, Math.min(upTo, events.length));
  const order = [];
  for (let i = 0; i < originalPageCount; i++) order.push(originalPageId(i));
  const objects = /* @__PURE__ */ new Map();
  let z = 0;
  for (let i = 0; i < limit; i++) {
    const event = events[i];
    if (isShapeType(event.type)) {
      const create = event;
      objects.set(create.id, {
        id: create.id,
        type: create.type,
        page: create.page,
        g: { ...create.g },
        st: { ...create.st },
        s: create.s,
        on: create.on,
        z: z++
      });
      continue;
    }
    switch (event.type) {
      case "obj.edit": {
        const existing = objects.get(event.ref);
        if (!existing) break;
        if (event.g) existing.g = { ...existing.g, ...event.g };
        if (event.st) existing.st = { ...existing.st, ...event.st };
        if (event.s !== void 0) existing.s = event.s;
        break;
      }
      case "obj.delete": {
        const existing = objects.get(event.ref);
        if (existing) existing.dead = true;
        break;
      }
      case "obj.restore": {
        const existing = objects.get(event.ref);
        if (existing) existing.dead = false;
        break;
      }
      case "page.insert": {
        const at = event.after === null ? 0 : order.indexOf(event.after) + 1;
        if (event.after !== null && at === 0) break;
        order.splice(at, 0, event.page);
        break;
      }
      case "page.delete": {
        const at = order.indexOf(event.ref);
        if (at >= 0) order.splice(at, 1);
        break;
      }
      case "page.move": {
        const from = order.indexOf(event.ref);
        if (from < 0) break;
        order.splice(from, 1);
        const to = event.after === null ? 0 : order.indexOf(event.after) + 1;
        if (event.after !== null && to === 0) {
          order.splice(from, 0, event.ref);
          break;
        }
        order.splice(to, 0, event.ref);
        break;
      }
    }
  }
  return { order, objects };
}
function inverseOf(events, index, originalPageCount) {
  const target = events[index];
  if (!target) return null;
  const stamp = { id: mintId(), ts: Date.now() };
  if (isShapeType(target.type)) {
    return { ...stamp, type: "obj.delete", ref: target.id };
  }
  switch (target.type) {
    case "obj.delete":
      return { ...stamp, type: "obj.restore", ref: target.ref };
    case "obj.restore":
      return { ...stamp, type: "obj.delete", ref: target.ref };
    case "obj.edit": {
      const before = walk(events, originalPageCount, index).objects.get(target.ref);
      if (!before) return null;
      const undo = { ...stamp, type: "obj.edit", ref: target.ref };
      if (target.g) undo.g = { ...before.g };
      if (target.st) undo.st = { ...before.st };
      if (target.s !== void 0) undo.s = before.s ?? "";
      return undo;
    }
    case "page.insert":
      return { ...stamp, type: "page.delete", ref: target.page };
    case "page.delete": {
      const before = walk(events, originalPageCount, index).order;
      const at = before.indexOf(target.ref);
      if (at < 0) return null;
      return {
        ...stamp,
        type: "page.insert",
        after: at === 0 ? null : before[at - 1],
        page: target.ref,
        src: /^o\d+$/.test(target.ref) ? "original" : "blank"
      };
    }
    case "page.move": {
      const before = walk(events, originalPageCount, index).order;
      const at = before.indexOf(target.ref);
      if (at < 0) return null;
      return { ...stamp, type: "page.move", ref: target.ref, after: at === 0 ? null : before[at - 1] };
    }
    default:
      return null;
  }
}
function rectFromDrag(x1, y1, x2, y2) {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1)
  };
}
var SHAPE_NAMES = {
  rect: ["rectangle", "rectangles"],
  ellipse: ["circle", "circles"],
  line: ["line", "lines"],
  arrow: ["arrow", "arrows"],
  text: ["text box", "text boxes"],
  highlight: ["highlight", "highlights"],
  ink: ["stroke", "strokes"],
  cover: ["cover", "covers"]
};
function nameShape(type, count) {
  const pair = SHAPE_NAMES[type];
  if (!pair) return `${count} ${type}`;
  return `${count} ${pair[count === 1 ? 0 : 1]}`;
}
var isLineLike = (type) => type === "line" || type === "arrow";
var isInk = (type) => type === "ink";
var isCover = (type) => type === "cover";

// src/study.ts
var PEEL = 15;
var MARK_BUTTON = 17;
var SELECTION_PAD = 2;
function peelCorner(box, scale) {
  const wanted = PEEL / Math.max(scale, 1e-4);
  const size = Math.max(6, Math.min(wanted, box.w / 2, box.h / 2));
  return { x: box.x + box.w - size, y: box.y, w: size, h: size };
}
function markZones(box, scale) {
  const size = MARK_BUTTON / Math.max(scale, 1e-4);
  const gap = size * 0.25;
  const y = box.y + box.h - size / 2;
  const wrongX = box.x + box.w - size - gap * 0.5;
  return {
    right: { x: wrongX - size - gap, y, w: size, h: size },
    wrong: { x: wrongX, y, w: size, h: size }
  };
}
var inside = (box, x, y) => x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;
function hitZone(box, scale, x, y, peeked) {
  if (peeked) {
    const zones = markZones(box, scale);
    if (inside(zones.right, x, y)) return "right";
    if (inside(zones.wrong, x, y)) return "wrong";
  }
  return inside(peelCorner(box, scale), x, y) ? "peel" : null;
}
function coverAt(objects, page, x, y) {
  for (let i = objects.length - 1; i >= 0; i--) {
    const obj = objects[i];
    if (obj.type !== "cover" || obj.page !== page) continue;
    if (inside({ x: obj.g.x ?? 0, y: obj.g.y ?? 0, w: obj.g.w ?? 0, h: obj.g.h ?? 0 }, x, y)) return obj;
  }
  return null;
}
function attemptsOn(objects, covers) {
  const owners = new Set(covers);
  return objects.filter((obj) => obj.on !== void 0 && owners.has(obj.on));
}
function unionCover(boxes, pad = SELECTION_PAD) {
  if (boxes.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const box of boxes) {
    left = Math.min(left, box.x);
    top = Math.min(top, box.y);
    right = Math.max(right, box.x + box.w);
    bottom = Math.max(bottom, box.y + box.h);
  }
  return { x: left - pad, y: top - pad, w: right - left + pad * 2, h: bottom - top + pad * 2 };
}
function tally(objects) {
  const written = /* @__PURE__ */ new Set();
  for (const obj of objects) {
    if (obj.on !== void 0) written.add(obj.on);
  }
  const out = { covers: 0, tried: 0, right: 0, wrong: 0 };
  for (const obj of objects) {
    if (obj.type !== "cover") continue;
    out.covers++;
    if (written.has(obj.id)) out.tried++;
    if (obj.st.mark === "right") out.right++;
    else if (obj.st.mark === "wrong") out.wrong++;
  }
  return out;
}
function tallyLabel(counts) {
  if (counts.covers === 0) return null;
  const parts = [`${counts.covers} covered`];
  if (counts.right) parts.push(`${counts.right} right`);
  if (counts.wrong) parts.push(`${counts.wrong} wrong`);
  const graded = counts.right + counts.wrong;
  if (counts.tried > graded) parts.push(`${counts.tried - graded} to check`);
  return parts.join(" \xB7 ");
}
function resetTargets(objects, which) {
  return objects.filter((obj) => obj.type === "cover" && (which === "all" || obj.st.mark === "wrong"));
}

// src/note.ts
var BEGIN = "<!-- palimpsest:begin -->";
var END = "<!-- palimpsest:end -->";
var TAG_PATTERN = /#([A-Za-z][\w/-]*)/g;
var LINK_PATTERN = /\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]/g;
function extractTags(text) {
  const found = /* @__PURE__ */ new Set();
  for (const match of text.matchAll(TAG_PATTERN)) found.add(match[1]);
  return [...found];
}
function extractLinks(text) {
  const found = /* @__PURE__ */ new Set();
  for (const match of text.matchAll(LINK_PATTERN)) found.add(match[1].trim());
  return [...found];
}
var label = (page, order) => {
  const at = order.indexOf(page);
  return at >= 0 ? `Page ${at + 1}` : "Detached page";
};
function generate(input) {
  const { order, objects } = input.state;
  const tags = /* @__PURE__ */ new Set();
  const links = /* @__PURE__ */ new Set();
  const byPage = /* @__PURE__ */ new Map();
  for (const obj of objects) {
    const list = byPage.get(obj.page) ?? [];
    list.push(obj);
    byPage.set(obj.page, list);
  }
  const lines = [BEGIN, "", `## Markup on [[${input.pdfPath}|${input.title}]]`, ""];
  const practice = tallyLabel(tally(objects));
  if (practice) lines.push(`**Practice:** ${practice}`, "");
  const pages = [...order, ...[...byPage.keys()].filter((page) => !order.includes(page))];
  let wrote = false;
  for (const page of pages) {
    const marks = byPage.get(page);
    if (!marks || marks.length === 0) continue;
    wrote = true;
    const texts = marks.filter((mark) => mark.type === "text" && (mark.s ?? "").trim().length > 0);
    const others = marks.length - texts.length;
    lines.push(`### ${label(page, order)}`);
    for (const mark of texts) {
      const body = (mark.s ?? "").trim();
      for (const tag of extractTags(body)) tags.add(tag);
      for (const link of extractLinks(body)) links.add(link);
      lines.push(`- ${body}`);
    }
    if (others > 0) {
      const kinds = /* @__PURE__ */ new Map();
      for (const mark of marks) {
        if (mark.type === "text") continue;
        kinds.set(mark.type, (kinds.get(mark.type) ?? 0) + 1);
      }
      const summary = [...kinds.entries()].map(
        ([kind, count]) => kind === "cover" ? coverSummary(marks.filter((mark) => mark.type === "cover")) : nameShape(kind, count)
      ).join(", ");
      lines.push(`- *${summary}*`);
    }
    lines.push("");
  }
  if (!wrote) lines.push("*No annotations yet.*", "");
  lines.push(`![[${input.pdfPath}]]`, "", END);
  return { tags: [...tags], links: [...links], block: lines.join("\n") };
}
function coverSummary(covers) {
  const base = nameShape("cover", covers.length);
  const graded = [
    covers.filter((cover) => cover.st.mark === "right").length,
    covers.filter((cover) => cover.st.mark === "wrong").length
  ];
  const parts = [graded[0] ? `${graded[0]} right` : "", graded[1] ? `${graded[1]} wrong` : ""].filter(Boolean);
  return parts.length ? `${base} (${parts.join(", ")})` : base;
}
function renderFrontmatter(tags) {
  if (tags.length === 0) return "---\ntags: []\n---";
  return ["---", "tags:", ...tags.map((tag) => `  - ${tag}`), "---"].join("\n");
}
function normaliseTag(raw) {
  return raw.trim().replace(/^["']|["']$/g, "").replace(/^#/, "").trim();
}
function splitFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) return { tags: [], rest: text, had: false };
  const tags = [];
  const block = match[1];
  const list = /(?:^|\n)tags:\s*(\[[^\]]*\]|(?:\n\s*-\s*[^\n]+)+)/.exec(block);
  if (list) {
    if (list[1].startsWith("[")) {
      for (const raw of list[1].slice(1, -1).split(",")) {
        const tag = normaliseTag(raw);
        if (tag) tags.push(tag);
      }
    } else {
      for (const line of list[1].split("\n")) {
        const tag = normaliseTag(line.replace(/^\s*-\s*/, ""));
        if (tag) tags.push(tag);
      }
    }
  }
  return { tags, rest: text.slice(match[0].length), had: true };
}
function merge(existing, generated, seedTags = []) {
  const source = existing ?? "";
  const { tags: currentTags, rest } = splitFrontmatter(source);
  const tags = [];
  for (const tag of [...existing ? [] : seedTags, ...currentTags, ...generated.tags]) {
    if (!tags.includes(tag)) tags.push(tag);
  }
  let body = rest;
  const start = body.indexOf(BEGIN);
  const finish = body.indexOf(END);
  if (start >= 0 && finish > start) {
    body = body.slice(0, start) + generated.block + body.slice(finish + END.length);
  } else {
    body = `${body.trimEnd()}

${generated.block}
`.trimStart();
  }
  return `${renderFrontmatter(tags)}

${body.trim()}
`;
}

// src/settings.ts
var DEFAULT_SETTINGS = {
  openMode: "marked"
};
function migrateSettings(raw) {
  const data = raw ?? {};
  if (data.openMode) return { openMode: data.openMode };
  if (data.takeOverAllPdfs) return { openMode: "always" };
  if (data.reopenMarkedUp === false) return { openMode: "never" };
  return { ...DEFAULT_SETTINGS };
}

// src/settings-tab.ts
var import_obsidian = require("obsidian");
var PalimpsestSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new import_obsidian.Setting(containerEl).setName("Open PDFs in Palimpsest").setDesc(
      "Which PDFs open ready to draw on, instead of in Obsidian's own viewer. Opening one here writes nothing \u2014 the markup file beside it is created the first time you actually mark something, so this never litters a folder with empty logs."
    ).addDropdown(
      (dropdown) => dropdown.addOption("never", "Never \u2014 always use Obsidian's viewer").addOption("marked", "Only ones I have already marked up").addOption("always", "Every PDF").setValue(this.plugin.settings.openMode).onChange(async (value) => {
        this.plugin.settings.openMode = value;
        await this.plugin.saveSettings();
      })
    );
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "The trade with \u201CEvery PDF\u201D is text: Palimpsest paints pages to canvases, so Obsidian's text selection and outline are not available (Palimpsest has its own search, with Cmd-F). The button in the tab's actions opens the plain PDF whenever you want those back."
    });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Markup is stored in a .palimpsest file beside each PDF. It is a plaintext log of your edits, so your vault's git history versions the markup too. The PDF itself is never modified."
    });
  }
};

// src/view.ts
var import_obsidian2 = require("obsidian");
init_pdf();

// src/page.ts
init_pdf();

// src/textlayer.ts
var TextLayer = class {
  el;
  /** Bumped on every claim and every clear, so a page that scrolled away while
   *  its text was being fetched cannot be filled in behind us. */
  token = 0;
  status = "empty";
  constructor() {
    this.el = document.createElement("div");
    this.el.addClass("palimpsest-textlayer");
  }
  get isEmpty() {
    return this.status === "empty";
  }
  /** Take the layer before an await; hand the token back to `build`. */
  begin() {
    this.status = "pending";
    return ++this.token;
  }
  layout(size, scale) {
    this.el.style.width = `${size.width}px`;
    this.el.style.height = `${size.height}px`;
    this.el.style.transform = `scale(${scale})`;
  }
  build(token, runs) {
    if (token !== this.token) return;
    this.el.empty();
    const spans = [];
    const kept = [];
    for (const run of runs) {
      if (!run.str) continue;
      const span = this.el.createSpan({ text: run.str });
      span.style.left = `${run.x}px`;
      span.style.top = `${run.y}px`;
      span.style.fontSize = `${run.h}px`;
      span.style.fontFamily = run.font;
      spans.push(span);
      kept.push(run);
      if (run.eol) this.el.createEl("br");
    }
    const declared = parseFloat(this.el.style.width);
    const painted = this.el.getBoundingClientRect().width;
    const scale = declared > 0 && painted > 0 ? painted / declared : 1;
    const widths = spans.map((span) => span.getBoundingClientRect().width / scale);
    spans.forEach((span, index) => {
      const run = kept[index];
      const parts = [];
      if (run.angle !== 0) parts.push(`rotate(${run.angle * 180 / Math.PI}deg)`);
      if (run.w > 0 && widths[index] > 0) parts.push(`scaleX(${run.w / widths[index]})`);
      if (parts.length) span.style.transform = parts.join(" ");
    });
    this.status = "built";
  }
  clear() {
    if (this.status === "empty") return;
    this.token++;
    this.status = "empty";
    this.el.empty();
  }
};

// src/page.ts
var SVG_NS = "http://www.w3.org/2000/svg";
var PageSurface = class {
  constructor(id, size) {
    this.id = id;
    this.size = size;
    this.el = document.createElement("div");
    this.el.addClass("palimpsest-page");
    this.el.dataset.page = id;
    this.canvas = document.createElement("canvas");
    this.canvas.addClass("palimpsest-canvas");
    this.el.appendChild(this.canvas);
    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.addClass("palimpsest-overlay");
    this.el.appendChild(this.svg);
    this.el.appendChild(this.text.el);
    this.badge = document.createElement("div");
    this.badge.addClass("palimpsest-page-badge");
    this.el.appendChild(this.badge);
  }
  el;
  canvas;
  svg;
  /** The PDF's text, above the markup so that in select mode it sees the press
   *  first — it is the thing you are usually pointing at. */
  text = new TextLayer();
  badge;
  /** The scale this surface's bitmap was painted at, or -1 for "not painted". */
  paintedAt = -1;
  /** Bumped on every paint request so a stale render cannot land after a newer one. */
  token = 0;
  task = null;
  /** Position in the current page order, 0-based. */
  setNumber(index, total) {
    this.badge.setText(`${index + 1} / ${total}`);
  }
  /** Lay the box out at `scale`, without painting anything into it. */
  layout(scale) {
    const width = Math.round(this.size.width * scale);
    const height = Math.round(this.size.height * scale);
    this.el.style.width = `${width}px`;
    this.el.style.height = `${height}px`;
    this.svg.setAttribute("viewBox", `0 0 ${this.size.width} ${this.size.height}`);
    this.svg.style.width = `${width}px`;
    this.svg.style.height = `${height}px`;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.text.layout(this.size, scale);
  }
  get isPainted() {
    return this.paintedAt > 0;
  }
  get needsRepaint() {
    return this.paintedAt < 0;
  }
  /** True when the bitmap is at a resolution too far from the current scale to
   *  keep using. Repainting on every zoom tick would thrash; letting it drift
   *  makes the page visibly soft. */
  staleAt(scale) {
    return this.paintedAt > 0 && Math.abs(this.paintedAt - scale) / scale > 0.02;
  }
  async paint(pdf, scale) {
    const mine = ++this.token;
    this.task?.cancel();
    this.task = null;
    const original = /^o(\d+)$/.exec(this.id);
    if (!original) {
      this.paintBlank(scale);
      this.paintedAt = scale;
      return;
    }
    const page = await pdf.getPage(Number(original[1]) + 1);
    if (mine !== this.token) return;
    const actual = baseSize(page);
    if (Math.abs(actual.width - this.size.width) > 0.5 || Math.abs(actual.height - this.size.height) > 0.5) {
      this.size = actual;
      this.layout(scale);
    }
    await renderPage(page, this.canvas, scale, (cancellable) => {
      this.task = cancellable;
    });
    if (mine !== this.token) return;
    this.task = null;
    this.paintedAt = scale;
    this.el.addClass("is-painted");
  }
  paintBlank(scale) {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(this.size.width * scale * dpr));
    this.canvas.height = Math.max(1, Math.floor(this.size.height * scale * dpr));
    const context2 = this.canvas.getContext("2d");
    if (!context2) return;
    context2.fillStyle = "#ffffff";
    context2.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.el.addClass("is-painted");
  }
  /** Drop the bitmap and the text, keep the box. A 1x1 canvas is what actually
   *  frees the memory — clearRect leaves the backing store allocated. */
  release() {
    this.text.clear();
    if (this.paintedAt < 0) return;
    this.token++;
    this.task?.cancel();
    this.task = null;
    this.canvas.width = 1;
    this.canvas.height = 1;
    this.paintedAt = -1;
    this.el.removeClass("is-painted");
  }
  destroy() {
    this.release();
    this.el.remove();
  }
};

// src/selection.ts
function sharesLine(a, b) {
  const overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return overlap * 3 > Math.min(a.h, b.h);
}
var GAP = 0.6;
function absorb(into, box) {
  const right = Math.max(into.x + into.w, box.x + box.w);
  const bottom = Math.max(into.y + into.h, box.y + box.h);
  into.x = Math.min(into.x, box.x);
  into.y = Math.min(into.y, box.y);
  into.w = right - into.x;
  into.h = bottom - into.y;
}
function mergeLines(boxes) {
  const lines = [];
  for (const box of boxes) {
    const line = lines.find((candidate) => sharesLine(candidate[0], box));
    if (line) line.push(box);
    else lines.push([box]);
  }
  const out = [];
  for (const line of lines) {
    line.sort((a, b) => a.x - b.x);
    let run = null;
    for (const box of line) {
      if (run && box.x - (run.x + run.w) <= Math.min(run.h, box.h) * GAP) {
        absorb(run, box);
        continue;
      }
      run = { ...box };
      out.push(run);
    }
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}
function underlineOf(box) {
  const y = box.y + box.h * 0.92;
  return { x1: box.x, y1: y, x2: box.x + box.w, y2: y };
}
function strikeOf(box) {
  const y = box.y + box.h * 0.55;
  return { x1: box.x, y1: y, x2: box.x + box.w, y2: y };
}

// src/group.ts
var MIN = 1;
function unionBox(boxes) {
  if (boxes.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const box of boxes) {
    left = Math.min(left, box.x);
    top = Math.min(top, box.y);
    right = Math.max(right, box.x + box.w);
    bottom = Math.max(bottom, box.y + box.h);
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}
function remap(box, from, to) {
  const sx = from.w > 0 ? to.w / from.w : 1;
  const sy = from.h > 0 ? to.h / from.h : 1;
  return {
    x: to.x + (box.x - from.x) * sx,
    y: to.y + (box.y - from.y) * sy,
    w: box.w * sx,
    h: box.h * sy
  };
}
function resizeBox(from, handle, x, y, opts = {}) {
  const west = handle.includes("w");
  const east = handle.includes("e");
  const north = handle.includes("n");
  const south = handle.includes("s");
  let left = west ? x : from.x;
  let right = east ? x : from.x + from.w;
  let top = north ? y : from.y;
  let bottom = south ? y : from.y + from.h;
  if (opts.aspect && from.w > 0 && from.h > 0 && (west || east) && (north || south)) {
    const ratio = from.w / from.h;
    const width = Math.abs(right - left);
    const height = Math.abs(bottom - top);
    if (width / ratio >= height) {
      const wanted = width / ratio;
      if (north) top = bottom - wanted;
      else bottom = top + wanted;
    } else {
      const wanted = height * ratio;
      if (west) left = right - wanted;
      else right = left + wanted;
    }
  }
  if (opts.centre) {
    const cx = from.x + from.w / 2;
    const cy = from.y + from.h / 2;
    if (west || east) {
      const reach = Math.abs((west ? left : right) - cx);
      left = cx - reach;
      right = cx + reach;
    }
    if (north || south) {
      const reach = Math.abs((north ? top : bottom) - cy);
      top = cy - reach;
      bottom = cy + reach;
    }
  }
  return {
    x: Math.min(left, right),
    y: Math.min(top, bottom),
    w: Math.max(MIN, Math.abs(right - left)),
    h: Math.max(MIN, Math.abs(bottom - top))
  };
}
function resizeTextWidth(box, handle, x, min = 24) {
  if (handle.includes("e")) return { x: box.x, w: Math.max(min, x - box.x) };
  const right = box.x + box.w;
  return { x: Math.min(x, right - min), w: Math.max(min, right - x) };
}
function typeFactor(from, to) {
  const fx = from.w > 0 ? to.w / from.w : 1;
  const fy = from.h > 0 ? to.h / from.h : 1;
  return Math.sqrt(Math.max(1e-6, fx * fy));
}
function clampSize(size) {
  return Math.round(Math.min(400, Math.max(4, size)) * 10) / 10;
}
function pointInPolygon(x, y, poly) {
  if (poly.length < 3) return false;
  let inside2 = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    const straddles = a.y > y !== b.y > y;
    if (straddles && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside2 = !inside2;
  }
  return inside2;
}
function caughtBy(box, poly) {
  return pointInPolygon(box.x + box.w / 2, box.y + box.h / 2, poly);
}
function marquee(x0, y0, x1, y1) {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 }
  ];
}

// src/ink.ts
var NIBS = {
  pen: { min: 0.32, max: 1, taper: 0.18, caps: "round" },
  marker: { min: 1, max: 1, taper: 0, caps: "flat" },
  pencil: { min: 0.55, max: 1, taper: 0.1, caps: "round" }
};
function packPoints(points) {
  const out = [];
  for (const point of points) {
    out.push(round(point.x, 1), round(point.y, 1), round(point.p, 2));
  }
  return out;
}
function unpackPoints(flat) {
  if (!flat) return [];
  const out = [];
  for (let i = 0; i + 3 <= flat.length; i += 3) {
    out.push({ x: flat[i], y: flat[i + 1], p: flat[i + 2] });
  }
  return out;
}
var round = (value, places) => {
  const factor = Math.pow(10, places);
  return Math.round(value * factor) / factor;
};
function thin(points, epsilon) {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    if (last <= first + 1) continue;
    let worst = -1;
    let worstDistance = epsilon;
    for (let i = first + 1; i < last; i++) {
      const distance = pointToSegment(points[i], points[first], points[last]);
      if (distance > worstDistance) {
        worst = i;
        worstDistance = distance;
      }
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    stack.push([first, worst], [worst, last]);
  }
  return points.filter((_, i) => keep[i] === 1);
}
function pointToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
var SpeedPressure = class {
  last = null;
  value = 0.5;
  next(x, y, now) {
    if (!this.last) {
      this.last = { x, y, t: now };
      return this.value;
    }
    const dt = Math.max(1, now - this.last.t);
    const speed = Math.hypot(x - this.last.x, y - this.last.y) / dt;
    this.last = { x, y, t: now };
    const target = Math.max(0.15, Math.min(1, 1 - speed / 1.2));
    this.value += (target - this.value) * 0.3;
    return this.value;
  }
};
function outlinePath(points, width, brush) {
  const nib = NIBS[brush] ?? NIBS.pen;
  const radius = Math.max(0.2, width / 2);
  const centre = smooth(points);
  if (centre.length === 0) return "";
  if (centre.length === 1) return dot(centre[0], radius * nib.max);
  const radii = radiiFor(centre, radius, nib);
  const left = [];
  const right = [];
  for (let i = 0; i < centre.length; i++) {
    const [nx, ny] = normalAt(centre, i);
    const r = radii[i];
    left.push({ x: centre[i].x + nx * r, y: centre[i].y + ny * r, p: 0 });
    right.push({ x: centre[i].x - nx * r, y: centre[i].y - ny * r, p: 0 });
  }
  const head = centre[0];
  const tail = centre[centre.length - 1];
  const headRadius = radii[0];
  const tailRadius = radii[radii.length - 1];
  let d = `M ${fmt(left[0].x)} ${fmt(left[0].y)}`;
  d += curveThrough(left);
  d += nib.caps === "round" ? ` A ${fmt(tailRadius)} ${fmt(tailRadius)} 0 0 1 ${fmt(right[right.length - 1].x)} ${fmt(right[right.length - 1].y)}` : ` L ${fmt(right[right.length - 1].x)} ${fmt(right[right.length - 1].y)}`;
  d += curveThrough([...right].reverse());
  d += nib.caps === "round" ? ` A ${fmt(headRadius)} ${fmt(headRadius)} 0 0 1 ${fmt(left[0].x)} ${fmt(left[0].y)}` : ` L ${fmt(left[0].x)} ${fmt(left[0].y)}`;
  return `${d} Z`;
}
function curveThrough(points) {
  let d = "";
  for (let i = 1; i < points.length - 1; i++) {
    const midX = (points[i].x + points[i + 1].x) / 2;
    const midY = (points[i].y + points[i + 1].y) / 2;
    d += ` Q ${fmt(points[i].x)} ${fmt(points[i].y)} ${fmt(midX)} ${fmt(midY)}`;
  }
  const last = points[points.length - 1];
  return `${d} L ${fmt(last.x)} ${fmt(last.y)}`;
}
function dot(point, radius) {
  const r = Math.max(0.4, radius);
  return `M ${fmt(point.x - r)} ${fmt(point.y)} A ${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(point.x + r)} ${fmt(point.y)} A ${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(point.x - r)} ${fmt(point.y)} Z`;
}
function radiiFor(points, radius, nib) {
  const lengths = cumulativeLength(points);
  const total = lengths[lengths.length - 1] || 1;
  const taperLength = Math.min(total * 0.4, radius * 12) * (nib.taper * 5);
  return points.map((point, i) => {
    const pressure = nib.min + (nib.max - nib.min) * clamp01(point.p);
    if (taperLength <= 0) return radius * pressure;
    const fromStart = lengths[i];
    const fromEnd = total - lengths[i];
    const ease = Math.min(1, Math.min(fromStart, fromEnd) / taperLength);
    return radius * pressure * Math.sqrt(ease === 1 ? 1 : 0.15 + 0.85 * ease);
  });
}
function cumulativeLength(points) {
  const out = [0];
  for (let i = 1; i < points.length; i++) {
    out.push(out[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  return out;
}
function normalAt(points, i) {
  const previous = points[Math.max(0, i - 1)];
  const next = points[Math.min(points.length - 1, i + 1)];
  const dx = next.x - previous.x;
  const dy = next.y - previous.y;
  const length = Math.hypot(dx, dy) || 1;
  return [-dy / length, dx / length];
}
function smooth(points) {
  if (points.length <= 2) return points.slice();
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    out.push({
      x: (points[i - 1].x + points[i].x * 2 + points[i + 1].x) / 4,
      y: (points[i - 1].y + points[i].y * 2 + points[i + 1].y) / 4,
      p: (points[i - 1].p + points[i].p * 2 + points[i + 1].p) / 4
    });
  }
  out.push(points[points.length - 1]);
  return out;
}
function inkBounds(points, width) {
  if (points.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const pad = Math.max(1, width / 2);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
}
function distanceToInk(points, x, y) {
  if (points.length === 0) return Infinity;
  if (points.length === 1) return Math.hypot(x - points[0].x, y - points[0].y);
  const probe = { x, y, p: 0 };
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const distance = pointToSegment(probe, points[i - 1], points[i]);
    if (distance < best) best = distance;
  }
  return best;
}
function scalePoints(points, from, to) {
  const sx = from.w === 0 ? 1 : to.w / from.w;
  const sy = from.h === 0 ? 1 : to.h / from.h;
  return points.map((point) => ({
    x: to.x + (point.x - from.x) * sx,
    y: to.y + (point.y - from.y) * sy,
    p: point.p
  }));
}
function translatePoints(points, dx, dy) {
  return points.map((point) => ({ x: point.x + dx, y: point.y + dy, p: point.p }));
}
var clamp01 = (value) => Math.max(0, Math.min(1, value));
var fmt = (value) => (Math.round(value * 100) / 100).toString();

// src/text.ts
var TEXT_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
var LINE_HEIGHT = 1.28;
var measurer = null;
function context() {
  if (!measurer) {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Palimpsest: no 2d context for text measurement");
    measurer = ctx;
  }
  return measurer;
}
function cssFont(style) {
  const weight = style.bold ? "700" : "400";
  const slant = style.italic ? "italic " : "";
  return `${slant}${weight} ${style.size}px ${TEXT_FONT}`;
}
function measure(text, style) {
  const ctx = context();
  ctx.font = cssFont(style);
  return ctx.measureText(text).width;
}
function wrap(text, width, style) {
  const paragraphs = text.split("\n");
  if (!width || width <= 0) return paragraphs;
  const out = [];
  for (const paragraph of paragraphs) {
    if (paragraph === "") {
      out.push("");
      continue;
    }
    out.push(...wrapParagraph(paragraph, width, style));
  }
  return out;
}
function wrapParagraph(paragraph, width, style) {
  const lines = [];
  const words = paragraph.match(/\S+\s*|\s+/g) ?? [paragraph];
  let line = "";
  for (const word of words) {
    const candidate = line + word;
    if (line && measure(candidate.trimEnd(), style) > width) {
      lines.push(line.trimEnd());
      line = word.trimStart();
      while (measure(line, style) > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && measure(line.slice(0, cut), style) > width) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    } else {
      line = candidate;
    }
  }
  lines.push(line.trimEnd());
  return lines;
}
function layout(text, width, style) {
  const lines = wrap(text, width, style);
  const lineHeight = style.size * LINE_HEIGHT;
  const natural = lines.reduce((widest, line) => Math.max(widest, measure(line, style)), 0);
  return {
    lines,
    width: width && width > 0 ? width : natural,
    height: Math.max(lineHeight, lines.length * lineHeight),
    lineHeight
  };
}

// src/history.ts
var GAP_MS = 2 * 60 * 1e3;
var MAX_SPAN_MS = 20 * 60 * 1e3;
function groupVersions(events) {
  if (events.length === 0) return [];
  const versions = [];
  let start = 0;
  for (let i = 1; i <= events.length; i++) {
    const ended = i === events.length || events[i].ts - events[i - 1].ts > GAP_MS || events[i].ts - events[start].ts > MAX_SPAN_MS;
    if (!ended) continue;
    versions.push({
      upTo: i,
      from: start,
      at: events[i - 1].ts,
      count: i - start,
      summary: summarise(events.slice(start, i))
    });
    start = i;
  }
  return versions.reverse();
}
function byDay(versions, now = /* @__PURE__ */ new Date()) {
  const days = [];
  for (const version of versions) {
    const label2 = dayLabel(new Date(version.at), now);
    const last = days[days.length - 1];
    if (last && last.label === label2) last.versions.push(version);
    else days.push({ label: label2, versions: [version] });
  }
  return days;
}
function dayLabel(date, now) {
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(date, now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return "Yesterday";
  const thisYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(void 0, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: thisYear ? void 0 : "numeric"
  });
}
function timeLabel(ts) {
  return new Date(ts).toLocaleTimeString(void 0, { hour: "numeric", minute: "2-digit" });
}
function summarise(events) {
  const drawn = /* @__PURE__ */ new Map();
  let changed = 0;
  let removed = 0;
  let restored = 0;
  let pages = 0;
  for (const event of events) {
    if (SHAPE_TYPES.includes(event.type)) {
      const type = event.type;
      drawn.set(type, (drawn.get(type) ?? 0) + 1);
    } else if (event.type === "obj.edit") changed++;
    else if (event.type === "obj.delete") removed++;
    else if (event.type === "obj.restore") restored++;
    else if (event.type.startsWith("page.")) pages++;
  }
  const parts = [];
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
function restoreTo(events, upTo, originalPageCount) {
  const then = replay(events, originalPageCount, upTo);
  const now = replay(events, originalPageCount);
  const out = [];
  const stamp = () => ({ id: mintId(), ts: Date.now() });
  const thenObjects = new Map(then.objects.map((obj) => [obj.id, obj]));
  const nowObjects = new Map(now.objects.map((obj) => [obj.id, obj]));
  for (const [id] of nowObjects) {
    if (!thenObjects.has(id)) out.push({ ...stamp(), type: "obj.delete", ref: id });
  }
  for (const [id, was] of thenObjects) {
    const is = nowObjects.get(id);
    if (!is) {
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
function restorePages(now, target, stamp) {
  const out = [];
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
      src: /^o\d+$/.test(target[i]) ? "original" : "blank"
    });
  }
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
function sameShape(a, b) {
  return (a.s ?? "") === (b.s ?? "") && JSON.stringify(a.g) === JSON.stringify(b.g) && JSON.stringify(a.st) === JSON.stringify(b.st);
}

// src/colour.ts
var RING_OUTER = 84;
var RING_INNER = 64;
var SIZE = RING_OUTER * 2;
function hsvToHex({ h, s, v }) {
  const c = v * s;
  const x = c * (1 - Math.abs(h / 60 % 2 - 1));
  const m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const byte = (value) => Math.round((value + m) * 255).toString(16).padStart(2, "0");
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}
function hexToHsv(hex) {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  if (![r, g, b].every((v) => Number.isFinite(v))) return { h: 265, s: 0.62, v: 1 };
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = (g - b) / d % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}
var isHex = (value) => /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim());
function shade(hex, amount = 0.24) {
  const { h, s, v } = hexToHsv(hex);
  return hsvToHex({ h, s: Math.min(1, s + amount * 0.6), v: Math.max(0, v - amount) });
}
var readableOn = (hex) => {
  const { s, v } = hexToHsv(hex);
  return v * (1 - s * 0.4) > 0.6 ? "#1f2328" : "#ffffff";
};
function openPuck(anchor, options) {
  const popover = document.body.createDiv({ cls: "palimpsest-puck" });
  const box = anchor.getBoundingClientRect();
  popover.style.left = `${Math.max(8, Math.min(window.innerWidth - SIZE - 40, box.left - 20))}px`;
  popover.style.top = `${box.bottom + 8}px`;
  let hsv = hexToHsv(options.colour);
  const wheel = popover.createEl("canvas", { cls: "palimpsest-wheel" });
  const dpr = window.devicePixelRatio || 1;
  wheel.width = SIZE * dpr;
  wheel.height = SIZE * dpr;
  wheel.style.width = `${SIZE}px`;
  wheel.style.height = `${SIZE}px`;
  const hexField = popover.createEl("input", {
    cls: "palimpsest-hex",
    attr: { type: "text", spellcheck: "false", "aria-label": "Hex colour" }
  });
  const sliders = popover.createDiv({ cls: "palimpsest-sliders" });
  const sizeRow = slider(sliders, "Size", 1, 40, options.size, 1, (value) => options.onSize(value), (v) => `${v} pt`);
  const opacityRow = options.showOpacity ? slider(sliders, "Opacity", 5, 100, Math.round(options.opacity * 100), 1, (value) => options.onOpacity(value / 100), (v) => `${v}%`) : null;
  const recentsRow = popover.createDiv({ cls: "palimpsest-recents" });
  for (const recent of options.recents.slice(0, 10)) {
    const swatch = recentsRow.createEl("button", { cls: "palimpsest-swatch", attr: { "aria-label": recent } });
    swatch.style.background = recent;
    swatch.onclick = () => {
      hsv = hexToHsv(recent);
      paint();
      emit();
    };
  }
  const paint = () => {
    drawWheel(wheel, dpr, hsv);
    hexField.value = hsvToHex(hsv);
    hexField.style.borderColor = hsvToHex(hsv);
  };
  const emit = () => options.onColour(hsvToHex(hsv));
  let dragging = null;
  const at = (event) => {
    const rect = wheel.getBoundingClientRect();
    return { x: event.clientX - rect.left - RING_OUTER, y: event.clientY - rect.top - RING_OUTER };
  };
  const applyRing = (x, y) => {
    let angle = Math.atan2(y, x) * 180 / Math.PI + 90;
    if (angle < 0) angle += 360;
    hsv = { ...hsv, h: angle % 360 };
  };
  const applySquare = (x, y) => {
    const half = squareHalf();
    hsv = {
      ...hsv,
      s: Math.max(0, Math.min(1, (x + half) / (half * 2))),
      v: Math.max(0, Math.min(1, 1 - (y + half) / (half * 2)))
    };
  };
  wheel.addEventListener("pointerdown", (event) => {
    wheel.setPointerCapture(event.pointerId);
    const { x, y } = at(event);
    const radius = Math.hypot(x, y);
    dragging = radius > RING_INNER ? "ring" : "square";
    if (dragging === "ring") applyRing(x, y);
    else applySquare(x, y);
    paint();
    emit();
  });
  wheel.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const { x, y } = at(event);
    if (dragging === "ring") applyRing(x, y);
    else applySquare(x, y);
    paint();
    emit();
  });
  const stop = () => {
    dragging = null;
  };
  wheel.addEventListener("pointerup", stop);
  wheel.addEventListener("pointercancel", stop);
  hexField.onchange = () => {
    if (!isHex(hexField.value)) {
      paint();
      return;
    }
    const value = hexField.value.trim();
    hsv = hexToHsv(value.startsWith("#") ? value : `#${value}`);
    paint();
    emit();
  };
  hexField.onkeydown = (event) => {
    event.stopPropagation();
    if (event.key === "Enter") hexField.blur();
  };
  paint();
  const close = () => {
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onEscape, true);
    popover.remove();
  };
  const onOutside = (event) => {
    const target = event.target;
    if (popover.contains(target) || anchor.contains(target)) return;
    close();
  };
  const onEscape = (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    close();
  };
  window.setTimeout(() => {
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onEscape, true);
  }, 0);
  return close;
}
var squareHalf = () => (RING_INNER - 6) / Math.SQRT2;
function drawWheel(canvas, dpr, hsv) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.translate(RING_OUTER, RING_OUTER);
  for (let degree = 0; degree < 360; degree++) {
    const from = (degree - 90.6) * Math.PI / 180;
    const to = (degree - 89.4) * Math.PI / 180;
    ctx.beginPath();
    ctx.arc(0, 0, RING_OUTER - 1, from, to);
    ctx.arc(0, 0, RING_INNER, to, from, true);
    ctx.closePath();
    ctx.fillStyle = hsvToHex({ h: degree, s: 1, v: 1 });
    ctx.fill();
  }
  const half = squareHalf();
  const pure = hsvToHex({ h: hsv.h, s: 1, v: 1 });
  ctx.fillStyle = pure;
  ctx.fillRect(-half, -half, half * 2, half * 2);
  const white = ctx.createLinearGradient(-half, 0, half, 0);
  white.addColorStop(0, "rgba(255,255,255,1)");
  white.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = white;
  ctx.fillRect(-half, -half, half * 2, half * 2);
  const black = ctx.createLinearGradient(0, -half, 0, half);
  black.addColorStop(0, "rgba(0,0,0,0)");
  black.addColorStop(1, "rgba(0,0,0,1)");
  ctx.fillStyle = black;
  ctx.fillRect(-half, -half, half * 2, half * 2);
  const hueAngle = (hsv.h - 90) * Math.PI / 180;
  const hueRadius = (RING_OUTER + RING_INNER) / 2;
  ring(ctx, Math.cos(hueAngle) * hueRadius, Math.sin(hueAngle) * hueRadius, 7);
  ring(ctx, -half + hsv.s * half * 2, -half + (1 - hsv.v) * half * 2, 6);
  ctx.restore();
}
function ring(ctx, x, y, radius) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.6;
  ctx.stroke();
}
function slider(parent, label2, min, max, value, step, onInput, format) {
  const row = parent.createDiv({ cls: "palimpsest-slider-row" });
  row.createSpan({ cls: "palimpsest-slider-label", text: label2 });
  const input = row.createEl("input", {
    attr: { type: "range", min: String(min), max: String(max), step: String(step), value: String(value) }
  });
  const readout = row.createSpan({ cls: "palimpsest-slider-value", text: format(value) });
  input.oninput = () => {
    const next = Number(input.value);
    readout.setText(format(next));
    onInput(next);
  };
  return input;
}

// src/view.ts
var VIEW_TYPE_PALIMPSEST = "palimpsest-view";
var PALIMPSEST_EXT = "palimpsest";
var SVG_NS2 = "http://www.w3.org/2000/svg";
var INK_TOOLS = { pen: "pen", marker: "marker", pencil: "pencil" };
var TOOLS = [
  { tool: "select", icon: "mouse-pointer-2", label: "Select text and objects", key: "V", group: 0 },
  { tool: "lasso", icon: "lasso-select", label: "Lasso several objects (Alt drags a box)", key: "Q", group: 0 },
  { tool: "pan", icon: "hand", label: "Pan (or hold space)", key: "space", group: 0 },
  { tool: "pen", icon: "pen-tool", label: "Pen", key: "P", group: 1 },
  { tool: "marker", icon: "paintbrush", label: "Marker", key: "B", group: 1 },
  { tool: "pencil", icon: "pencil", label: "Pencil", key: "N", group: 1 },
  { tool: "eraser", icon: "eraser", label: "Eraser", key: "E", group: 1 },
  { tool: "highlight", icon: "highlighter", label: "Highlight", key: "H", group: 2 },
  { tool: "text", icon: "type", label: "Text", key: "T", group: 2 },
  { tool: "cover", icon: "sticky-note", label: "Cover an answer, and work it out yourself", key: "C", group: 2 },
  { tool: "rect", icon: "square", label: "Rectangle", key: "R", group: 3 },
  { tool: "ellipse", icon: "circle", label: "Circle", key: "O", group: 3 },
  { tool: "line", icon: "minus", label: "Line", key: "L", group: 3 },
  { tool: "arrow", icon: "arrow-right", label: "Arrow", key: "A", group: 3 }
];
var DEFAULT_STYLES = {
  pen: { stroke: "#9061ff", w: 2.4, brush: "pen", opacity: 1 },
  eraser: { stroke: "#8b8b8b", w: 16 },
  marker: { stroke: "#d29922", w: 14, brush: "marker", opacity: 0.4 },
  pencil: { stroke: "#1f2328", w: 1.6, brush: "pencil", opacity: 0.85 },
  highlight: { stroke: "#f2e14c", opacity: 0.35 },
  // The paper colour rides in `stroke` rather than `fill` so that the puck, the
  // quick swatches and the recent-colours list all reach it without knowing
  // covers exist — every one of them writes `stroke`. What it *paints* is the
  // fill; `applyShape` is the one place that has to know the difference.
  cover: { stroke: "#ffe9a3", opacity: 1 },
  text: { stroke: "#9061ff", size: 14 },
  rect: { stroke: "#e5534b", w: 2, fill: null },
  ellipse: { stroke: "#9061ff", w: 2, fill: null },
  line: { stroke: "#1f2328", w: 2 },
  arrow: { stroke: "#9061ff", w: 2 }
};
var QUICK_COLOURS = ["#9061ff", "#e5534b", "#3fb950", "#d29922", "#2f81f7", "#1f2328"];
var MARKS = [
  { kind: "highlight", icon: "highlighter", label: "Highlight" },
  { kind: "underline", icon: "underline", label: "Underline" },
  { kind: "strike", icon: "strikethrough", label: "Strikethrough" }
];
var HANDLE_CURSORS = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  start: "grab",
  end: "grab"
};
var isMac = () => navigator.platform.toLowerCase().includes("mac");
var ZOOM_MIN = 0.1;
var ZOOM_MAX = 8;
var ZOOM_STOPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];
var PAINT_MARGIN = 1;
var THUMB_WIDTH = 108;
function constrain(type, x0, y0, x, y) {
  if (isLineLike(type)) {
    const dx = x - x0;
    const dy = y - y0;
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4;
    const length = Math.hypot(dx, dy);
    return { x: x0 + Math.cos(angle) * length, y: y0 + Math.sin(angle) * length };
  }
  const side = Math.max(Math.abs(x - x0), Math.abs(y - y0));
  return { x: x0 + Math.sign(x - x0 || 1) * side, y: y0 + Math.sign(y - y0 || 1) * side };
}
var PalimpsestView = class extends import_obsidian2.FileView {
  allowNoFile = false;
  events = [];
  header = null;
  /** The two files this view is about. `logFile` is null until there is
   *  something to write, which is the whole point of opening a PDF here being
   *  free. Everything that writes goes through `ensureLog`. */
  pdfFile = null;
  logFile = null;
  pdf = null;
  pdfPageCount = 0;
  sizes = [];
  surfaces = [];
  order = [];
  scale = 1;
  fit = "width";
  viewMode = "single";
  currentPage = 0;
  tool = "select";
  styles = structuredClone(DEFAULT_STYLES);
  recents = [...QUICK_COLOURS];
  /** The selection, as a list. Always on one page: every group operation is
   *  defined by the box around the members, and a box spanning two pages of a
   *  scrolling column is not a box. */
  selected = [];
  /** Covers currently lifted, by id.
   *
   *  Deliberately *not* in the log. A peek is a thing you do while reading, not
   *  an edit to the document: logged, every check of an answer would be two
   *  lines in the history and a flicker in the timelapse — and a problem set
   *  reopened next week would come back with every answer you had ever looked
   *  at already showing. Held here, the answers are covered again every time the
   *  file opens, which is the entire point. */
  peeked = /* @__PURE__ */ new Set();
  /** How far along the timeline we are looking. null means "now". */
  historyAt = null;
  historyOpen = false;
  chosenVersion = null;
  /** Batches of event indices, so one gesture is one undo. */
  undoStack = [];
  redoStack = [];
  undoButton = null;
  redoButton = null;
  deleteButton = null;
  spaceHeld = false;
  drag = null;
  /** True while a press that began a text selection is still down. The bar over
   *  a selection waits for the button to come up; one that follows the pointer
   *  mid-drag is a panel in the way of the thing you are selecting. */
  selectionDragging = false;
  selectionQueued = false;
  editor = null;
  closePuck = null;
  /** Unique per view, so two open documents cannot fight over SVG def ids. */
  uid = Math.random().toString(36).slice(2, 8);
  rootEl;
  toolbarEl;
  historyBarEl;
  bodyEl;
  railEl;
  stageEl;
  docEl;
  panelEl;
  statusEl;
  findEl;
  selectionBarEl;
  pageInputEl;
  pageTotalEl;
  zoomLabelEl;
  selectionCountEl;
  studyEl;
  studyLabelEl;
  studyButton;
  puckEl;
  sizeLabelEl;
  styleGroupEl;
  watchingDisk = false;
  watchingSelection = false;
  lastFitWidth = 0;
  scrollQueued = false;
  railQueued = false;
  lastWrite = 0;
  plugin;
  plainAction = null;
  noteAction = null;
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }
  getViewType() {
    return VIEW_TYPE_PALIMPSEST;
  }
  getDisplayText() {
    return this.file ? this.file.basename : "Palimpsest";
  }
  getIcon() {
    return "pen-line";
  }
  /** Either half of the pair opens here.
   *
   *  Opening the **PDF** is the normal way in: the tab keeps the PDF's name,
   *  the file explorer highlights the PDF, and the log stays an implementation
   *  detail — created on your first mark, not on arrival. Opening the `.palimpsest`
   *  log directly still works, for when you click one in the file explorer. */
  canAcceptExtension(extension) {
    return extension === PALIMPSEST_EXT || extension === "pdf";
  }
  // ---------------------------------------------------------------- lifecycle
  async onLoadFile(file) {
    this.contentEl.empty();
    this.contentEl.addClass("palimpsest-root");
    this.rootEl = this.contentEl;
    this.buildChrome();
    this.undoStack = [];
    this.redoStack = [];
    this.selected = [];
    this.peeked.clear();
    this.historyAt = null;
    this.pool.clear();
    this.thumbs.clear();
    this.railBuilt = false;
    this.runsCache.clear();
    this.matches = [];
    this.matchAt = -1;
    this.surfaces = [];
    this.offsets = [];
    this.currentPage = 0;
    this.selectionDragging = false;
    this.invalidate();
    let pdfFile;
    if (file.extension === "pdf") {
      pdfFile = file;
      const beside = this.app.vault.getAbstractFileByPath(this.plugin.logPathFor(file));
      this.logFile = beside instanceof import_obsidian2.TFile ? beside : null;
      this.header = { v: 1, type: "doc", ts: Date.now(), pdf: file.path };
      this.events = this.logFile ? this.readLog(await this.app.vault.read(this.logFile)) : [];
    } else {
      this.logFile = file;
      const parsed = parseLog(await this.app.vault.read(file));
      this.header = parsed.header;
      this.events = parsed.events;
      if (parsed.bad.length) {
        new import_obsidian2.Notice(`Palimpsest: skipped ${parsed.bad.length} unreadable line(s) \u2014 see line ${parsed.bad[0]}`);
      }
      if (!this.header) {
        this.showError("This file has no `doc` header line, so there is no PDF to mark up.");
        return;
      }
      pdfFile = this.resolvePdf(this.header.pdf, file);
      if (!pdfFile) {
        this.showError(`Cannot find the PDF this markup belongs to: ${this.header.pdf}`);
        return;
      }
    }
    this.pdfFile = pdfFile;
    try {
      const bytes = await this.app.vault.readBinary(pdfFile);
      this.pdf = await openPdf(bytes);
      this.pdfPageCount = this.pdf.numPages;
      this.sizes = await pageSizes(this.pdf);
    } catch (error) {
      this.showError(`Could not open the PDF: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.addPlainPdfAction(pdfFile);
    this.addNoteAction(pdfFile);
    this.collectRecents();
    await this.rebuildDocument();
    this.applyFit("width");
    this.syncTimelineChrome();
    if (this.watchingDisk) return;
    this.watchingDisk = true;
    this.registerEvent(
      this.app.vault.on("modify", (changed) => {
        if (changed.path !== this.logFile?.path) return;
        if (Date.now() - this.lastWrite < 1500) return;
        void this.reloadFromDisk();
      })
    );
  }
  readLog(text) {
    const parsed = parseLog(text);
    if (parsed.bad.length) {
      new import_obsidian2.Notice(`Palimpsest: skipped ${parsed.bad.length} unreadable line(s) \u2014 see line ${parsed.bad[0]}`);
    }
    return parsed.events;
  }
  async reloadFromDisk() {
    if (!this.logFile) return;
    const parsed = parseLog(await this.app.vault.read(this.logFile));
    if (parsed.events.length === this.events.length) return;
    this.events = parsed.events;
    this.undoStack = [];
    this.redoStack = [];
    new import_obsidian2.Notice("Palimpsest: the markup changed on disk \u2014 reloaded.");
    await this.rebuildDocument();
    this.syncTimelineChrome();
  }
  /** The PDF cannot carry tags or links itself; a companion note can. */
  addNoteAction(pdf) {
    if (this.noteAction) return;
    this.noteAction = this.addAction("links-coming-in", "Sync the note for this PDF (tags and links)", () => {
      void this.plugin.syncNote(pdf);
    });
  }
  /** Obsidian's viewer still has the outline, the embedded links and the PDF's
   *  own annotations. One button, so neither viewer is a trap. */
  addPlainPdfAction(pdf) {
    if (this.plainAction) return;
    this.plainAction = this.addAction("file-text", "Open the plain PDF (outline, embedded links)", () => {
      this.plugin.showPlainOnce(pdf.path);
      void this.leaf.setViewState({ type: "pdf", state: { file: pdf.path }, active: true });
    });
  }
  async onUnloadFile() {
    this.closePuck?.();
    this.closePuck = null;
    this.editor?.remove();
    this.editor = null;
    for (const surface of this.surfaces) surface.destroy();
    this.surfaces = [];
    if (this.pdf) {
      this.pdf.destroy?.();
      this.pdf = null;
    }
    this.events = [];
    this.pdfFile = null;
    this.logFile = null;
    this.plainAction?.remove();
    this.plainAction = null;
    this.noteAction?.remove();
    this.noteAction = null;
    this.contentEl.empty();
  }
  /** The PDF is normally the same basename next to the log; the header path wins. */
  resolvePdf(path, log) {
    const byPath = this.app.vault.getAbstractFileByPath(path);
    if (byPath instanceof import_obsidian2.TFile) return byPath;
    const sibling = log.parent ? `${log.parent.path === "/" ? "" : `${log.parent.path}/`}${log.basename}.pdf` : null;
    if (sibling) {
      const found = this.app.vault.getAbstractFileByPath(sibling);
      if (found instanceof import_obsidian2.TFile) return found;
    }
    return null;
  }
  showError(message) {
    this.stageEl.empty();
    this.stageEl.createDiv({ cls: "palimpsest-error", text: message });
  }
  // ------------------------------------------------------------------- chrome
  buildChrome() {
    this.toolbarEl = this.contentEl.createDiv({ cls: "palimpsest-toolbar" });
    this.historyBarEl = this.contentEl.createDiv({ cls: "palimpsest-historybar" });
    this.findEl = this.contentEl.createDiv({ cls: "palimpsest-find" });
    this.bodyEl = this.contentEl.createDiv({ cls: "palimpsest-body" });
    this.railEl = this.bodyEl.createDiv({ cls: "palimpsest-rail" });
    this.stageEl = this.bodyEl.createDiv({ cls: "palimpsest-stage" });
    this.docEl = this.stageEl.createDiv({ cls: "palimpsest-doc" });
    this.panelEl = this.bodyEl.createDiv({ cls: "palimpsest-panel" });
    this.selectionBarEl = this.bodyEl.createDiv({ cls: "palimpsest-selectionbar" });
    this.statusEl = this.contentEl.createDiv({ cls: "palimpsest-status" });
    this.contentEl.appendChild(this.buildDefs());
    this.buildToolbar();
    this.buildHistoryBar();
    this.buildFindBar();
    this.buildSelectionBar();
    this.buildStatusBar();
    if (!this.watchingSelection) {
      this.watchingSelection = true;
      this.registerDomEvent(document, "selectionchange", () => this.scheduleSelectionBar());
      this.registerDomEvent(document, "pointerup", () => {
        if (!this.selectionDragging) return;
        this.selectionDragging = false;
        this.scheduleSelectionBar();
      });
    }
    this.registerDomEvent(this.stageEl, "wheel", (event) => this.onWheel(event), { passive: false });
    this.registerDomEvent(this.stageEl, "scroll", () => this.onScroll());
    this.registerDomEvent(this.contentEl, "keydown", (event) => this.onKeyDown(event));
    this.registerDomEvent(this.contentEl, "keyup", (event) => this.onKeyUp(event));
    this.contentEl.tabIndex = -1;
    this.registerDomEvent(this.stageEl, "pointerdown", (event) => {
      if (event.button !== 1 && !(this.spaceHeld || this.tool === "pan")) return;
      event.preventDefault();
      this.drag = {
        kind: "pan",
        x: event.clientX,
        y: event.clientY,
        left: this.stageEl.scrollLeft,
        top: this.stageEl.scrollTop
      };
      this.stageEl.setPointerCapture(event.pointerId);
    });
    this.registerDomEvent(this.stageEl, "pointermove", (event) => {
      if (this.drag?.kind !== "pan") return;
      this.stageEl.scrollLeft = this.drag.left - (event.clientX - this.drag.x);
      this.stageEl.scrollTop = this.drag.top - (event.clientY - this.drag.y);
    });
    this.registerDomEvent(this.stageEl, "pointerup", (event) => {
      if (this.drag?.kind !== "pan") return;
      this.drag = null;
      this.stageEl.releasePointerCapture?.(event.pointerId);
    });
    const observer = new ResizeObserver(() => {
      const width = this.stageEl.clientWidth;
      if (width === 0 || width === this.lastFitWidth) return;
      this.lastFitWidth = width;
      if (this.fit !== "free") this.applyFit(this.fit);
      else this.paintVisible();
    });
    observer.observe(this.stageEl);
    this.register(() => observer.disconnect());
  }
  /** One set of SVG defs for the whole view, referenced by every page's overlay.
   *  Ids carry the view's uid so two open documents cannot collide. */
  buildDefs() {
    const holder = document.createElementNS(SVG_NS2, "svg");
    holder.addClass("palimpsest-defs");
    holder.setAttribute("width", "0");
    holder.setAttribute("height", "0");
    const defs = document.createElementNS(SVG_NS2, "defs");
    const marker = document.createElementNS(SVG_NS2, "marker");
    marker.setAttribute("id", this.arrowId);
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "9");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "6");
    marker.setAttribute("markerHeight", "6");
    marker.setAttribute("orient", "auto-start-reverse");
    marker.setAttribute("markerUnits", "strokeWidth");
    const head = document.createElementNS(SVG_NS2, "path");
    head.setAttribute("d", "M 0 1 L 10 5 L 0 9 z");
    head.setAttribute("fill", "context-stroke");
    marker.appendChild(head);
    defs.appendChild(marker);
    const grain = document.createElementNS(SVG_NS2, "filter");
    grain.setAttribute("id", this.grainId);
    grain.setAttribute("x", "-20%");
    grain.setAttribute("y", "-20%");
    grain.setAttribute("width", "140%");
    grain.setAttribute("height", "140%");
    const turbulence = document.createElementNS(SVG_NS2, "feTurbulence");
    turbulence.setAttribute("type", "fractalNoise");
    turbulence.setAttribute("baseFrequency", "0.9");
    turbulence.setAttribute("numOctaves", "3");
    turbulence.setAttribute("result", "noise");
    const displace = document.createElementNS(SVG_NS2, "feDisplacementMap");
    displace.setAttribute("in", "SourceGraphic");
    displace.setAttribute("in2", "noise");
    displace.setAttribute("scale", "1.6");
    displace.setAttribute("xChannelSelector", "R");
    displace.setAttribute("yChannelSelector", "G");
    grain.appendChild(turbulence);
    grain.appendChild(displace);
    defs.appendChild(grain);
    holder.appendChild(defs);
    return holder;
  }
  get arrowId() {
    return `palimpsest-arrow-${this.uid}`;
  }
  get grainId() {
    return `palimpsest-grain-${this.uid}`;
  }
  buildToolbar() {
    const history = this.toolbarEl.createDiv({ cls: "palimpsest-group" });
    this.undoButton = this.iconButton(history, "undo-2", "Undo", "Mod Z", () => void this.undo());
    this.redoButton = this.iconButton(history, "redo-2", "Redo", "Mod Shift Z", () => void this.redo());
    this.deleteButton = this.iconButton(
      history,
      "trash-2",
      "Delete the selection",
      "Del",
      () => void this.deleteSelection()
    );
    let group = -1;
    let container = this.toolbarEl;
    for (const entry of TOOLS) {
      if (entry.group !== group) {
        group = entry.group;
        this.separator();
        container = this.toolbarEl.createDiv({ cls: "palimpsest-group" });
      }
      const button = this.iconButton(container, entry.icon, entry.label, entry.key, () => this.pickTool(entry.tool));
      button.dataset.tool = entry.tool;
    }
    this.separator();
    this.styleGroupEl = this.toolbarEl.createDiv({ cls: "palimpsest-group palimpsest-style" });
    this.puckEl = this.styleGroupEl.createEl("button", {
      cls: "palimpsest-puck-button",
      attr: { "aria-label": "Colour, size and opacity" }
    });
    this.puckEl.createDiv({ cls: "palimpsest-puck-dot" });
    this.puckEl.onclick = () => this.togglePuck();
    for (const colour of QUICK_COLOURS) {
      const swatch = this.styleGroupEl.createEl("button", {
        cls: "palimpsest-swatch",
        attr: { "aria-label": colour }
      });
      swatch.style.background = colour;
      swatch.dataset.colour = colour;
      swatch.onclick = () => this.setColour(colour);
    }
    this.sizeLabelEl = this.styleGroupEl.createSpan({ cls: "palimpsest-label palimpsest-size", text: "" });
    const right = this.toolbarEl.createDiv({ cls: "palimpsest-group palimpsest-right" });
    const pages = this.iconButton(right, "panel-left", "Page thumbnails", "Mod \\", () => this.toggleRail());
    pages.dataset.toggle = "rail";
    const find = this.iconButton(right, "search", "Find in document", "Mod F", () => this.toggleFind());
    find.dataset.toggle = "find";
    const clock = this.iconButton(right, "history", "Version history", "", () => this.toggleHistory());
    clock.dataset.toggle = "history";
  }
  buildHistoryBar() {
    const back = this.historyBarEl.createEl("button", { cls: "palimpsest-back" });
    (0, import_obsidian2.setIcon)(back.createSpan(), "arrow-left");
    back.createSpan({ text: "Back to editing" });
    back.onclick = () => this.closeHistory();
    this.historyBarEl.createDiv({ cls: "palimpsest-historybar-title", text: "Version history" });
    const restore = this.historyBarEl.createEl("button", {
      cls: "mod-cta palimpsest-restore",
      text: "Restore this version"
    });
    restore.onclick = () => void this.restoreChosen();
  }
  buildStatusBar() {
    const left = this.statusEl.createDiv({ cls: "palimpsest-group" });
    this.iconButton(left, "chevron-up", "Previous page", "", () => this.goToPage(this.currentPage - 1));
    this.pageInputEl = left.createEl("input", {
      cls: "palimpsest-page-input",
      attr: { type: "text", inputmode: "numeric", "aria-label": "Page number" }
    });
    this.pageTotalEl = left.createSpan({ cls: "palimpsest-label", text: "of 0" });
    this.selectionCountEl = left.createSpan({ cls: "palimpsest-label palimpsest-count", text: "" });
    this.iconButton(left, "chevron-down", "Next page", "", () => this.goToPage(this.currentPage + 1));
    this.pageInputEl.onchange = () => {
      const wanted = parseInt(this.pageInputEl.value, 10);
      if (Number.isFinite(wanted)) this.goToPage(wanted - 1);
      else this.syncStatus();
    };
    this.pageInputEl.onkeydown = (event) => {
      event.stopPropagation();
      if (event.key === "Enter") this.pageInputEl.blur();
    };
    this.studyEl = this.statusEl.createDiv({ cls: "palimpsest-group palimpsest-study" });
    (0, import_obsidian2.setIcon)(this.studyEl.createSpan({ cls: "palimpsest-study-icon" }), "sticky-note");
    this.studyLabelEl = this.studyEl.createSpan({ cls: "palimpsest-label" });
    this.studyButton = this.iconButton(this.studyEl, "eye", "Show every answer", "", () => this.setAllPeeked(true));
    const right = this.statusEl.createDiv({ cls: "palimpsest-group palimpsest-right" });
    const mode = right.createEl("select", { cls: "palimpsest-select dropdown" });
    for (const [value, label2] of [
      ["single", "Single column"],
      ["spread", "Two pages"]
    ]) {
      mode.createEl("option", { value, text: label2 });
    }
    mode.onchange = () => {
      this.viewMode = mode.value;
      this.docEl.toggleClass("is-spread", this.viewMode === "spread");
      this.applyFit(this.fit === "free" ? "width" : this.fit);
    };
    this.iconButton(right, "zoom-out", "Zoom out", "Mod -", () => this.zoomStep(-1));
    this.zoomLabelEl = right.createSpan({ cls: "palimpsest-label palimpsest-zoom", text: "100%" });
    this.zoomLabelEl.onclick = () => this.applyFit(this.fit === "width" ? "page" : "width");
    (0, import_obsidian2.setTooltip)(this.zoomLabelEl, "Fit width / fit page");
    this.iconButton(right, "zoom-in", "Zoom in", "Mod +", () => this.zoomStep(1));
  }
  iconButton(parent, icon, label2, shortcut, onClick) {
    const hint = shortcut ? `${label2}  ${shortcut.replace("Mod", isMac() ? "\u2318" : "Ctrl")}` : label2;
    const button = parent.createEl("button", { cls: "palimpsest-tool", attr: { "aria-label": hint } });
    (0, import_obsidian2.setIcon)(button, icon);
    (0, import_obsidian2.setTooltip)(button, hint);
    button.onclick = onClick;
    return button;
  }
  separator(parent = this.toolbarEl) {
    parent.createDiv({ cls: "palimpsest-sep" });
  }
  // -------------------------------------------------------------------- tools
  get styleOf() {
    const key = this.styleKey(this.tool);
    if (!this.styles[key]) this.styles[key] = { stroke: QUICK_COLOURS[0], w: 2 };
    return this.styles[key];
  }
  styleKey(tool) {
    return tool === "select" || tool === "pan" || tool === "lasso" ? "pen" : tool;
  }
  pickTool(tool) {
    if (tool === "highlight" && !this.readOnly && this.hasTextSelection()) {
      void this.markSelection("highlight");
      return;
    }
    if (tool === "cover" && !this.readOnly && this.hasTextSelection()) {
      void this.coverSelection();
      return;
    }
    this.commitEditor();
    this.tool = tool;
    if (tool !== "select" && tool !== "lasso") {
      this.selected = [];
      this.clearTextSelection();
    }
    this.syncToolbar();
    this.syncOverlays();
  }
  setColour(colour) {
    this.styleOf.stroke = colour;
    this.remember(colour);
    this.syncToolbar();
    if (this.selected.length) void this.applyStyleToSelection({ stroke: colour });
  }
  remember(colour) {
    this.recents = [colour, ...this.recents.filter((c) => c !== colour)].slice(0, 12);
  }
  /** Seed the recents from what is already on the page, so reopening a document
   *  picks up where you left off rather than showing six defaults. */
  collectRecents() {
    const used = /* @__PURE__ */ new Map();
    for (const obj of replay(this.events, this.pdfPageCount).objects) {
      const stroke = obj.st.stroke;
      if (stroke) used.set(stroke, (used.get(stroke) ?? 0) + 1);
    }
    const ranked = [...used.entries()].sort((a, b) => b[1] - a[1]).map(([colour]) => colour);
    this.recents = [...ranked, ...QUICK_COLOURS.filter((c) => !ranked.includes(c))].slice(0, 12);
  }
  /** What the style controls are talking about.
   *
   *  With something selected, they mean *that*: choosing a text box and moving
   *  the size control has to change that box's type, not the pen's width, and
   *  the puck has to open showing the number it is about to change. With
   *  nothing selected they mean the tool in hand, as they always did. */
  get styleTarget() {
    const chosen = this.chosen(this.state().objects);
    if (chosen.length) return { style: chosen[0].st, isText: chosen.every((obj) => obj.type === "text") };
    return { style: this.styleOf, isText: this.tool === "text" };
  }
  togglePuck() {
    if (this.closePuck) {
      this.closePuck();
      this.closePuck = null;
      return;
    }
    const target = this.styleTarget;
    const style = this.styleOf;
    const isText = target.isText;
    this.closePuck = openPuck(this.puckEl, {
      colour: target.style.stroke ?? QUICK_COLOURS[0],
      opacity: target.style.opacity ?? 1,
      size: isText ? target.style.size ?? 14 : target.style.w ?? 2,
      recents: this.recents,
      showOpacity: !isText,
      onColour: (hex) => this.setColour(hex),
      onOpacity: (value) => {
        style.opacity = value;
        this.syncToolbar();
        if (this.selected.length) void this.applyStyleToSelection({ opacity: value });
      },
      onSize: (value) => {
        if (isText) style.size = value;
        else style.w = value;
        this.syncToolbar();
        if (this.selected.length) void this.applyStyleToSelection(isText ? { size: value } : { w: value });
      }
    });
  }
  syncToolbar() {
    this.toolbarEl.findAll(".palimpsest-tool").forEach((button) => {
      const element = button;
      if (element.dataset.tool) element.toggleClass("is-active", element.dataset.tool === this.tool);
      if (element.dataset.toggle === "rail") element.toggleClass("is-active", this.rootEl.hasClass("is-rail"));
      if (element.dataset.toggle === "find") element.toggleClass("is-active", this.rootEl.hasClass("is-find"));
      if (element.dataset.toggle === "history") element.toggleClass("is-active", this.historyOpen);
    });
    const { style, isText } = this.styleTarget;
    const dot2 = this.puckEl.querySelector(".palimpsest-puck-dot");
    if (dot2) {
      dot2.style.background = style.stroke ?? QUICK_COLOURS[0];
      dot2.style.opacity = String(style.opacity ?? 1);
    }
    this.styleGroupEl.findAll(".palimpsest-swatch").forEach((button) => {
      const element = button;
      element.toggleClass("is-active", element.dataset.colour === style.stroke);
    });
    this.sizeLabelEl.setText(isText ? `${style.size ?? 14} pt` : `${style.w ?? 2} pt`);
    const idle = this.tool === "select" || this.tool === "pan" || this.tool === "lasso";
    this.styleGroupEl.toggleClass("is-dim", idle && this.selected.length === 0);
    this.deleteButton?.toggleClass("is-disabled", this.selected.length === 0 || this.readOnly);
    this.syncSelectionCount();
    this.rootEl.dataset.tool = this.tool;
    this.syncHistoryButtons();
  }
  // ----------------------------------------------------------------- document
  /** Replay is not free on a long log and the pointer handlers ask for it
   *  constantly, so it is memoised against the only two things that change it. */
  stateCache = null;
  /** Editing is off while the history panel is open, whichever version is
   *  selected. Gating on `historyAt` alone let you draw on the live document
   *  from inside the history view, with the toolbar hidden. */
  get readOnly() {
    return this.historyOpen || this.historyAt !== null;
  }
  state() {
    const length = this.events.length;
    const at = this.historyAt;
    if (this.stateCache && this.stateCache.length === length && this.stateCache.at === at) {
      return this.stateCache.value;
    }
    const value = replay(this.events, this.pdfPageCount, at ?? void 0);
    this.stateCache = { length, at, value };
    return value;
  }
  invalidate() {
    this.stateCache = null;
  }
  sizeOf(id) {
    const original = /^o(\d+)$/.exec(id);
    if (original) return this.sizes[Number(original[1])] ?? this.sizes[0] ?? { width: 612, height: 792 };
    return this.sizes[0] ?? { width: 612, height: 792 };
  }
  pool = /* @__PURE__ */ new Map();
  offsets = [];
  /** Bring the column of pages in line with the replayed page order. */
  async rebuildDocument() {
    if (!this.pdf) return;
    const { order } = this.state();
    this.order = order;
    const live = new Set(order);
    for (const [id, surface] of this.pool) {
      if (live.has(id)) continue;
      surface.destroy();
      this.pool.delete(id);
    }
    this.surfaces = order.map((id) => {
      let surface = this.pool.get(id);
      if (!surface) {
        surface = new PageSurface(id, this.sizeOf(id));
        this.bindSurface(surface);
        this.pool.set(id, surface);
      }
      return surface;
    });
    this.surfaces.forEach((surface, index) => {
      this.docEl.appendChild(surface.el);
      surface.setNumber(index, order.length);
    });
    this.layoutAll();
    this.syncOverlays();
    this.paintVisible();
    this.scheduleRail();
    this.syncStatus();
  }
  layoutAll() {
    for (const surface of this.surfaces) surface.layout(this.scale);
    this.offsets = this.surfaces.map((surface) => ({
      top: surface.el.offsetTop,
      bottom: surface.el.offsetTop + surface.el.offsetHeight
    }));
    this.scheduleSelectionBar();
  }
  onScroll() {
    if (this.scrollQueued) return;
    this.scrollQueued = true;
    window.requestAnimationFrame(() => {
      this.scrollQueued = false;
      this.paintVisible();
      this.trackCurrentPage();
      this.scheduleSelectionBar();
    });
  }
  paintVisible() {
    if (!this.pdf) return;
    const height = this.stageEl.clientHeight;
    const top = this.stageEl.scrollTop - height * PAINT_MARGIN;
    const bottom = this.stageEl.scrollTop + height * (1 + PAINT_MARGIN);
    for (let i = 0; i < this.surfaces.length; i++) {
      const surface = this.surfaces[i];
      const box = this.offsets[i];
      if (!box) continue;
      const visible = box.bottom >= top && box.top <= bottom;
      if (visible) {
        if (surface.needsRepaint || surface.staleAt(this.scale)) void surface.paint(this.pdf, this.scale);
        if (surface.text.isEmpty) void this.fillTextLayer(surface);
      } else {
        surface.release();
      }
    }
  }
  trackCurrentPage() {
    const line = this.stageEl.scrollTop + 8;
    let current = 0;
    for (let i = 0; i < this.offsets.length; i++) {
      if (this.offsets[i].bottom > line) {
        current = i;
        break;
      }
      current = i;
    }
    if (current === this.currentPage) return;
    this.currentPage = current;
    this.syncStatus();
    this.markRailCurrent();
  }
  goToPage(index) {
    const clamped = Math.max(0, Math.min(index, this.surfaces.length - 1));
    const box = this.offsets[clamped];
    if (!box) return;
    this.stageEl.scrollTop = box.top - 14;
    this.currentPage = clamped;
    this.syncStatus();
    this.markRailCurrent();
  }
  syncStatus() {
    this.pageInputEl.value = String(this.currentPage + 1);
    this.pageTotalEl.setText(`of ${this.surfaces.length}`);
    this.zoomLabelEl.setText(`${Math.round(this.scale * 100)}%`);
  }
  // --------------------------------------------------------------------- zoom
  onWheel(event) {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const factor = Math.exp(-event.deltaY / 340);
    this.setScale(this.scale * factor, event);
  }
  zoomStep(direction) {
    const stops = ZOOM_STOPS;
    const next = direction > 0 ? stops.find((stop) => stop > this.scale + 1e-3) ?? ZOOM_MAX : [...stops].reverse().find((stop) => stop < this.scale - 1e-3) ?? ZOOM_MIN;
    this.setScale(next);
  }
  setScale(value, anchor) {
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
    if (Math.abs(clamped - this.scale) < 5e-4) return;
    const rect = this.stageEl.getBoundingClientRect();
    const ax = anchor ? anchor.clientX - rect.left : this.stageEl.clientWidth / 2;
    const ay = anchor ? anchor.clientY - rect.top : this.stageEl.clientHeight / 2;
    const beforeX = this.stageEl.scrollLeft + ax;
    const beforeY = this.stageEl.scrollTop + ay;
    const ratio = clamped / this.scale;
    this.scale = clamped;
    this.fit = "free";
    this.moveEditorWithZoom();
    this.layoutAll();
    this.stageEl.scrollLeft = beforeX * ratio - ax;
    this.stageEl.scrollTop = beforeY * ratio - ay;
    this.syncOverlays();
    this.paintVisible();
    this.syncStatus();
  }
  applyFit(mode) {
    if (mode === "free" || this.surfaces.length === 0) return;
    const columns = this.viewMode === "spread" ? 2 : 1;
    const gutter = 28 * columns + 24;
    const availableWidth = this.stageEl.clientWidth - gutter;
    const availableHeight = this.stageEl.clientHeight - 34;
    if (availableWidth <= 0) return;
    const widest = this.surfaces.reduce((max, surface) => Math.max(max, surface.size.width), 1);
    const tallest = this.surfaces.reduce((max, surface) => Math.max(max, surface.size.height), 1);
    const byWidth = availableWidth / columns / widest;
    const scale = mode === "width" ? byWidth : Math.min(byWidth, availableHeight / tallest);
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
    this.lastFitWidth = this.stageEl.clientWidth;
    const keep = this.currentPage;
    this.scale = clamped;
    this.layoutAll();
    this.fit = mode;
    this.goToPage(keep);
    this.syncOverlays();
    this.paintVisible();
    this.syncStatus();
  }
  // ------------------------------------------------------------------ writing
  /** The only way anything reaches the file.
   *
   *  Takes a list, and writes it as one batch: erasing eight strokes or
   *  restoring a version is a single act and has to be a single undo. */
  async append(events, track = "user") {
    const list = Array.isArray(events) ? events : [events];
    if (list.length === 0) return;
    const log = await this.ensureLog();
    if (!log || log.extension !== PALIMPSEST_EXT) return;
    const indices = list.map((_, offset) => this.events.length + offset);
    this.events.push(...list);
    this.invalidate();
    this.lastWrite = Date.now();
    await this.app.vault.append(log, `${list.map(serialise).join("\n")}
`);
    this.lastWrite = Date.now();
    if (track === "user") {
      this.undoStack.push(indices);
      this.redoStack.length = 0;
    } else if (track === "undo") {
      this.redoStack.push(indices);
    } else {
      this.undoStack.push(indices);
    }
    const touchesPages = list.some((event) => event.type.startsWith("page."));
    if (touchesPages) await this.rebuildDocument();
    else this.syncOverlays();
    this.syncTimelineChrome();
    this.syncHistoryButtons();
  }
  /** The sidecar, created the first time there is something to put in it.
   *
   *  Opening a PDF in Palimpsest writes nothing. That is what makes "open every
   *  PDF here" a reasonable default rather than a way to litter a course folder
   *  with empty logs for every slide deck you glanced at. */
  async ensureLog() {
    if (this.logFile) return this.logFile;
    const pdf = this.pdfFile;
    if (!pdf) return null;
    const path = this.plugin.logPathFor(pdf);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof import_obsidian2.TFile) {
      this.logFile = existing;
      return existing;
    }
    try {
      this.logFile = await this.app.vault.create(path, newLogContents(pdf.path));
    } catch (error) {
      new import_obsidian2.Notice(`Palimpsest: could not create ${path} \u2014 ${error instanceof Error ? error.message : error}`);
      return null;
    }
    return this.logFile;
  }
  syncHistoryButtons() {
    this.undoButton?.toggleClass("is-disabled", this.undoStack.length === 0);
    this.redoButton?.toggleClass("is-disabled", this.redoStack.length === 0);
    this.deleteButton?.toggleClass("is-disabled", this.selected.length === 0 || this.readOnly);
  }
  /** Undo by appending the inverse. Popping the last line would be simpler and
   *  would throw away the history the whole plugin is for. */
  async undo() {
    if (this.readOnly) {
      new import_obsidian2.Notice("Palimpsest: you are looking at the version history. Go back to editing first.");
      return;
    }
    const batch = this.undoStack.pop();
    if (!batch) {
      new import_obsidian2.Notice("Palimpsest: nothing to undo.");
      return;
    }
    const inverses = [];
    for (const index of [...batch].reverse()) {
      const inverse = inverseOf(this.events, index, this.pdfPageCount);
      if (inverse) inverses.push(inverse);
    }
    if (inverses.length === 0) {
      new import_obsidian2.Notice("Palimpsest: that edit cannot be undone.");
      return;
    }
    this.selected = [];
    await this.append(inverses, "undo");
  }
  async redo() {
    if (this.readOnly) return;
    const batch = this.redoStack.pop();
    if (!batch) {
      new import_obsidian2.Notice("Palimpsest: nothing to redo.");
      return;
    }
    const inverses = [];
    for (const index of [...batch].reverse()) {
      const inverse = inverseOf(this.events, index, this.pdfPageCount);
      if (inverse) inverses.push(inverse);
    }
    if (inverses.length === 0) return;
    this.selected = [];
    await this.append(inverses, "redo");
  }
  async applyStyleToSelection(patch) {
    if (this.selected.length === 0 || this.readOnly) return;
    const ts = Date.now();
    await this.append(this.selected.map((ref) => ({ id: mintId(), ts, type: "obj.edit", ref, st: patch })));
  }
  // ---------------------------------------------------------------- rendering
  syncOverlays() {
    const { objects } = this.state();
    const byPage = /* @__PURE__ */ new Map();
    for (const obj of objects) {
      const list = byPage.get(obj.page);
      if (list) list.push(obj);
      else byPage.set(obj.page, [obj]);
    }
    for (const surface of this.surfaces) this.syncOverlay(surface, byPage.get(surface.id) ?? []);
    this.rootEl.toggleClass("is-history", this.historyAt !== null);
    this.rootEl.toggleClass("is-readonly", this.readOnly);
    this.syncStudy(objects);
  }
  /** Reconcile one page's overlay against the objects that belong on it.
   *
   *  Elements persist across updates and are matched by id. This is not just
   *  faster than emptying the SVG — it is what makes double-click work at all,
   *  because a node detached during a gesture kills the click that follows. */
  syncOverlay(surface, objects) {
    const svg = surface.svg;
    const wanted = new Set(objects.map((obj) => obj.id));
    for (const child of Array.from(svg.children)) {
      const id = child.dataset?.id;
      if (id && !wanted.has(id)) child.remove();
    }
    let previous = null;
    for (const obj of objects) {
      const selector = `[data-id="${cssEscape(obj.id)}"]`;
      let element = svg.querySelector(selector);
      if (element && element.tagName !== tagFor(obj.type)) {
        element.remove();
        element = null;
      }
      if (!element) {
        element = document.createElementNS(SVG_NS2, tagFor(obj.type));
        element.dataset.id = obj.id;
        element.addClass("palimpsest-shape");
      }
      this.applyShape(element, obj);
      element.toggleClass("is-under-peek", obj.on !== void 0 && this.peeked.has(obj.on));
      const shouldFollow = previous ? previous.nextSibling : svg.firstChild;
      if (element !== shouldFollow) svg.insertBefore(element, shouldFollow);
      previous = element;
    }
    this.paintSelection(surface, objects);
  }
  applyShape(element, obj) {
    const g = obj.g;
    const stroke = obj.st.stroke ?? QUICK_COLOURS[0];
    const width = obj.st.w ?? 2;
    element.removeClass("palimpsest-highlight");
    element.removeClass("palimpsest-text");
    element.removeClass("palimpsest-ink");
    element.removeClass("palimpsest-cover");
    element.style.removeProperty("filter");
    switch (obj.type) {
      case "cover":
        this.applyCover(element, obj);
        return;
      case "rect":
      case "highlight": {
        set(element, {
          x: g.x ?? 0,
          y: g.y ?? 0,
          width: Math.max(0, g.w ?? 0),
          height: Math.max(0, g.h ?? 0)
        });
        if (obj.type === "highlight") {
          element.setAttribute("fill", stroke);
          element.setAttribute("stroke", "none");
          element.setAttribute("opacity", String(obj.st.opacity ?? 0.35));
          element.addClass("palimpsest-highlight");
        } else {
          element.setAttribute("fill", obj.st.fill ?? "none");
          element.setAttribute("stroke", stroke);
          element.setAttribute("stroke-width", String(width));
          element.setAttribute("opacity", String(obj.st.opacity ?? 1));
        }
        return;
      }
      case "ellipse": {
        set(element, {
          cx: (g.x ?? 0) + (g.w ?? 0) / 2,
          cy: (g.y ?? 0) + (g.h ?? 0) / 2,
          rx: Math.max(0, (g.w ?? 0) / 2),
          ry: Math.max(0, (g.h ?? 0) / 2)
        });
        element.setAttribute("fill", obj.st.fill ?? "none");
        element.setAttribute("stroke", stroke);
        element.setAttribute("stroke-width", String(width));
        element.setAttribute("opacity", String(obj.st.opacity ?? 1));
        return;
      }
      case "line":
      case "arrow": {
        set(element, { x1: g.x1 ?? 0, y1: g.y1 ?? 0, x2: g.x2 ?? 0, y2: g.y2 ?? 0 });
        element.setAttribute("stroke", stroke);
        element.setAttribute("stroke-width", String(width));
        element.setAttribute("stroke-linecap", "round");
        element.setAttribute("opacity", String(obj.st.opacity ?? 1));
        if (obj.type === "arrow") element.setAttribute("marker-end", `url(#${this.arrowId})`);
        else element.removeAttribute("marker-end");
        return;
      }
      case "ink": {
        const points = unpackPoints(g.p);
        element.setAttribute("d", outlinePath(points, width, obj.st.brush ?? "pen"));
        element.setAttribute("fill", stroke);
        element.setAttribute("fill-opacity", String(obj.st.opacity ?? 1));
        element.setAttribute("stroke", "none");
        element.addClass("palimpsest-ink");
        if ((obj.st.brush ?? "pen") === "marker") element.addClass("palimpsest-highlight");
        if ((obj.st.brush ?? "pen") === "pencil") element.style.filter = `url(#${this.grainId})`;
        return;
      }
      case "text": {
        const style = { size: obj.st.size ?? 14, bold: obj.st.bold, italic: obj.st.italic };
        const box = layout(obj.s ?? "", g.w, style);
        element.setAttribute("fill", stroke);
        element.setAttribute("font-size", String(style.size));
        element.setAttribute("font-family", TEXT_FONT);
        element.setAttribute("font-weight", style.bold ? "700" : "400");
        element.setAttribute("font-style", style.italic ? "italic" : "normal");
        element.setAttribute("opacity", String(obj.st.opacity ?? 1));
        element.addClass("palimpsest-text");
        element.toggleClass("is-editing", this.editingId === obj.id);
        while (element.firstChild) element.removeChild(element.firstChild);
        box.lines.forEach((line, index) => {
          const span = document.createElementNS(SVG_NS2, "tspan");
          span.setAttribute("x", String(g.x ?? 0));
          span.setAttribute("y", String((g.y ?? 0) + box.lineHeight * (index + 0.79)));
          span.textContent = line === "" ? " " : line;
          element.appendChild(span);
        });
        return;
      }
    }
  }
  /** A cover: paper, a dog-ear to lift it by, and — once lifted — a tick and a
   *  cross to say how you did.
   *
   *  Lifted does not mean *gone*. The paper drops to a wash and the working you
   *  wrote on it fades with it (`syncOverlay` marks those), so the printed
   *  answer comes through as the clear thing with your attempt ghosted over it
   *  in place. That is the comparison you actually wanted — the alternative,
   *  hiding the cover outright, takes your working away at exactly the moment
   *  you want to hold it against the answer.
   */
  applyCover(element, obj) {
    const box = asBox(this.boxOf(obj));
    const paper = obj.st.stroke ?? "#ffe9a3";
    const edge = shade(paper);
    const peeked = this.peeked.has(obj.id);
    const live = !this.readOnly;
    element.addClass("palimpsest-cover");
    element.toggleClass("is-peeked", peeked);
    element.setAttribute("opacity", String(obj.st.opacity ?? 1));
    const part = (tag, cls) => {
      const found = element.querySelector(`:scope > .${cls}`);
      if (found) return found;
      const made = document.createElementNS(SVG_NS2, tag);
      made.addClass(cls);
      element.appendChild(made);
      return made;
    };
    const drop = (cls) => element.querySelector(`:scope > .${cls}`)?.remove();
    const corner = peelCorner(box, this.scale);
    const sheet = part("rect", "palimpsest-cover-paper");
    set(sheet, { x: box.x, y: box.y, width: box.w, height: box.h });
    sheet.setAttribute("fill", paper);
    sheet.setAttribute("stroke", edge);
    sheet.setAttribute("stroke-width", String(0.75 / this.scale));
    const fold = part("path", "palimpsest-cover-peel");
    fold.setAttribute(
      "d",
      `M ${round2(corner.x)} ${round2(corner.y)} H ${round2(corner.x + corner.w)} V ${round2(corner.y + corner.h)} Z`
    );
    fold.setAttribute("fill", shade(paper, 0.16));
    fold.setAttribute("stroke", edge);
    fold.setAttribute("stroke-width", String(0.75 / this.scale));
    if (obj.st.mark) {
      const spine = part("rect", "palimpsest-cover-spine");
      set(spine, { x: box.x, y: box.y, width: Math.min(2.5 / this.scale, box.w), height: box.h });
      spine.toggleClass("is-right", obj.st.mark === "right");
      spine.toggleClass("is-wrong", obj.st.mark === "wrong");
    } else {
      drop("palimpsest-cover-spine");
    }
    if (!peeked || !live) {
      drop("palimpsest-cover-right");
      drop("palimpsest-cover-wrong");
      return;
    }
    const zones = markZones(box, this.scale);
    const glyph = readableOn(paper);
    for (const [kind, zone] of [
      ["right", zones.right],
      ["wrong", zones.wrong]
    ]) {
      const button = part("g", `palimpsest-cover-${kind}`);
      button.addClass("palimpsest-cover-mark");
      button.addClass(kind === "right" ? "is-right" : "is-wrong");
      button.toggleClass("is-chosen", obj.st.mark === kind);
      let pad = button.firstElementChild;
      let tick = button.lastElementChild;
      if (!pad || pad === tick) {
        while (button.firstChild) button.removeChild(button.firstChild);
        pad = document.createElementNS(SVG_NS2, "rect");
        tick = document.createElementNS(SVG_NS2, "path");
        button.appendChild(pad);
        button.appendChild(tick);
      }
      set(pad, { x: zone.x, y: zone.y, width: zone.w, height: zone.h });
      pad.setAttribute("rx", String(round2(zone.w * 0.28)));
      const inset = zone.w * 0.28;
      const left = zone.x + inset;
      const right = zone.x + zone.w - inset;
      const top = zone.y + inset;
      const bottom = zone.y + zone.h - inset;
      tick.setAttribute(
        "d",
        kind === "right" ? `M ${round2(left)} ${round2(zone.y + zone.h * 0.54)} L ${round2(zone.x + zone.w * 0.43)} ${round2(bottom)} L ${round2(right)} ${round2(top)}` : `M ${round2(left)} ${round2(top)} L ${round2(right)} ${round2(bottom)} M ${round2(right)} ${round2(top)} L ${round2(left)} ${round2(bottom)}`
      );
      tick.setAttribute("stroke-width", String(round2(Math.max(0.6, zone.w * 0.14))));
      tick.setAttribute("stroke", obj.st.mark === kind ? "#ffffff" : glyph);
    }
  }
  /** `preview` is the geometry of a drag in flight, which the frame has to be
   *  drawn from rather than from what is still on file.
   *
   *  Rebuilding this group inside a pointer handler is safe, unlike rebuilding
   *  the shapes: since the text layer went on top, a press lands there and the
   *  pointer is captured by the overlay, so no handle is ever the target of the
   *  gesture being detached. */
  paintSelection(surface, objects, preview) {
    surface.svg.querySelector(".palimpsest-selection")?.remove();
    if (this.selected.length === 0 || this.historyAt !== null) return;
    const chosen = this.chosen(objects).filter((obj) => obj.page === surface.id).map((obj) => preview?.get(obj.id) ?? obj);
    if (chosen.length === 0) return;
    const group = document.createElementNS(SVG_NS2, "g");
    group.addClass("palimpsest-selection");
    const pad = 3 / this.scale;
    const outline = (box, member) => {
      const rect = document.createElementNS(SVG_NS2, "rect");
      set(rect, {
        x: (box.x ?? 0) - pad,
        y: (box.y ?? 0) - pad,
        width: (box.w ?? 0) + pad * 2,
        height: (box.h ?? 0) + pad * 2
      });
      rect.addClass("palimpsest-outline");
      if (member) rect.addClass("is-member");
      rect.setAttribute("stroke-width", String((member ? 1 : 1.4) / this.scale));
      group.appendChild(rect);
    };
    const many = chosen.length > 1;
    for (const obj of chosen) outline(this.boxOf(obj), many);
    if (many) outline(this.selectionBox(chosen), false);
    for (const [name, point] of Object.entries(this.handlesFor(chosen))) {
      const handle = document.createElementNS(SVG_NS2, "rect");
      const size = 9 / this.scale;
      set(handle, { x: point.x - size / 2, y: point.y - size / 2, width: size, height: size });
      handle.setAttribute("rx", String(1.5 / this.scale));
      handle.setAttribute("stroke-width", String(1.2 / this.scale));
      handle.addClass("palimpsest-handle");
      handle.dataset.handle = name;
      handle.style.cursor = this.handleCursor(name, chosen);
      group.appendChild(handle);
    }
    surface.svg.appendChild(group);
  }
  /** Every grip on a text box does the same thing, so every one of them has to
   *  say the same thing. A corner promising `nwse-resize` on a box whose height
   *  it cannot touch is the cursor lying about the gesture. */
  handleCursor(name, chosen) {
    if (chosen.length === 1 && chosen[0].type === "text" && (name === "w" || name === "e")) return "ew-resize";
    return HANDLE_CURSORS[name] ?? "pointer";
  }
  isSelected(id) {
    return this.selected.includes(id);
  }
  chosen(objects) {
    return objects.filter((obj) => this.isSelected(obj.id));
  }
  /** The box around a whole selection, in page coordinates. */
  selectionBox(chosen) {
    const box = unionBox(chosen.map((obj) => asBox(this.boxOf(obj))));
    return box ?? { x: 0, y: 0, w: 0, h: 0 };
  }
  /** Handles for a selection: the object's own when there is one of it, and the
   *  eight round the group box when there are several. */
  handlesFor(chosen) {
    if (chosen.length === 1) return this.handles(chosen[0]);
    if (chosen.length === 0) return {};
    return boxHandles(this.selectionBox(chosen));
  }
  handles(obj) {
    if (isLineLike(obj.type)) {
      return {
        start: { x: obj.g.x1 ?? 0, y: obj.g.y1 ?? 0 },
        end: { x: obj.g.x2 ?? 0, y: obj.g.y2 ?? 0 }
      };
    }
    const box = asBox(this.boxOf(obj));
    if (obj.type === "text") {
      const right = box.x + box.w;
      const middle = box.y + box.h / 2;
      const bottom = box.y + box.h;
      return {
        nw: { x: box.x, y: box.y },
        w: { x: box.x, y: middle },
        sw: { x: box.x, y: bottom },
        ne: { x: right, y: box.y },
        e: { x: right, y: middle },
        se: { x: right, y: bottom }
      };
    }
    return boxHandles(box);
  }
  /** Bounding box in page coordinates, computed rather than measured.
   *
   *  The old code read `getBBox()` off the live SVG, which meant hit testing
   *  depended on the element existing and on a layout pass having run. Text now
   *  lays out through the same module the editor uses, and ink knows its own
   *  extent, so every box is arithmetic. */
  boxOf(obj) {
    if (isLineLike(obj.type)) {
      return rectFromDrag(obj.g.x1 ?? 0, obj.g.y1 ?? 0, obj.g.x2 ?? 0, obj.g.y2 ?? 0);
    }
    if (isInk(obj.type)) {
      return inkBounds(unpackPoints(obj.g.p), obj.st.w ?? 2);
    }
    if (obj.type === "text") {
      const box = layout(obj.s ?? "", obj.g.w, {
        size: obj.st.size ?? 14,
        bold: obj.st.bold,
        italic: obj.st.italic
      });
      return { x: obj.g.x ?? 0, y: obj.g.y ?? 0, w: box.width, h: box.height };
    }
    return { x: obj.g.x ?? 0, y: obj.g.y ?? 0, w: obj.g.w ?? 0, h: obj.g.h ?? 0 };
  }
  // ------------------------------------------------------------------ pointer
  bindSurface(surface) {
    const svg = surface.svg;
    this.registerDomEvent(svg, "pointerdown", (event) => this.onPointerDown(event, surface));
    this.registerDomEvent(svg, "pointermove", (event) => this.onPointerMove(event, surface));
    this.registerDomEvent(svg, "pointerup", (event) => void this.onPointerUp(event, surface));
    this.registerDomEvent(svg, "pointercancel", () => this.abortDrag());
    this.registerDomEvent(svg, "dblclick", (event) => this.onDoubleClick(event, surface));
    this.registerDomEvent(svg, "contextmenu", (event) => this.onContextMenu(event, surface));
    const text = surface.text.el;
    this.registerDomEvent(text, "pointerdown", (event) => this.onTextPointerDown(event, surface));
    this.registerDomEvent(text, "pointermove", (event) => this.onTextPointerMove(event, surface));
    this.registerDomEvent(text, "dblclick", (event) => this.onTextDoubleClick(event, surface));
    this.registerDomEvent(text, "contextmenu", (event) => this.onTextContextMenu(event, surface));
  }
  toPage(event, surface) {
    const rect = surface.svg.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / this.scale, y: (event.clientY - rect.top) / this.scale };
  }
  onPointerDown(event, surface) {
    if (event.button === 1 || this.spaceHeld || this.tool === "pan") return;
    if (event.button !== 0) return;
    const at = this.toPage(event, surface);
    const zone = this.studyZoneAt(at.x, at.y, this.state().objects, surface.id);
    if (zone) {
      this.contentEl.focus();
      void this.applyZone(zone.obj, zone.zone);
      return;
    }
    if (this.readOnly) {
      new import_obsidian2.Notice("Palimpsest: this is the version history. Go back to editing to draw.");
      return;
    }
    if (this.editor) this.commitEditor();
    this.contentEl.focus();
    surface.svg.setPointerCapture(event.pointerId);
    const point = at;
    if (this.tool === "lasso") {
      const element = document.createElementNS(SVG_NS2, "path");
      element.addClass("palimpsest-lasso");
      surface.svg.appendChild(element);
      this.drag = {
        kind: "lasso",
        surface,
        points: [point],
        el: element,
        x0: point.x,
        y0: point.y,
        box: event.altKey
      };
      return;
    }
    if (this.tool === "select") {
      const { objects } = this.state();
      const chosen = this.chosen(objects);
      const handle = this.handleAt(point.x, point.y, objects, surface.id);
      if (handle && chosen.length) {
        this.drag = chosen.length === 1 ? { kind: "resize", surface, obj: chosen[0], handle, g: { ...chosen[0].g } } : {
          kind: "scale",
          surface,
          handle,
          from: this.selectionBox(chosen),
          objs: chosen,
          starts: chosen.map((obj) => ({ ...obj.g }))
        };
        return;
      }
      const hit = this.hitTest(point.x, point.y, objects, surface.id);
      const additive = event.shiftKey || event.metaKey || event.ctrlKey;
      if (!hit) {
        if (!additive) this.selected = [];
        this.syncOverlays();
        this.syncToolbar();
        return;
      }
      if (additive) {
        const here = new Set(objects.filter((obj) => obj.page === hit.page).map((obj) => obj.id));
        this.selected = this.isSelected(hit.id) ? this.selected.filter((id) => id !== hit.id) : [...this.selected.filter((id) => here.has(id)), hit.id];
      } else if (!this.isSelected(hit.id)) {
        this.selected = [hit.id];
      }
      const moving = this.isSelected(hit.id) ? this.withAttempts(this.chosen(objects).filter((obj) => obj.page === hit.page), objects) : [];
      if (moving.length) {
        this.drag = {
          kind: "move",
          surface,
          objs: moving,
          starts: moving.map((obj) => ({ ...obj.g })),
          dx: point.x,
          dy: point.y,
          pressed: hit.id,
          additive
        };
      }
      this.syncOverlays();
      this.syncToolbar();
      return;
    }
    if (this.tool === "eraser") {
      this.drag = { kind: "erase", surface, hits: /* @__PURE__ */ new Set() };
      this.erase(point.x, point.y, surface);
      return;
    }
    const brush = INK_TOOLS[this.tool];
    if (brush) {
      const style = this.styleOf;
      const element = document.createElementNS(SVG_NS2, "path");
      element.addClass("palimpsest-ink");
      element.addClass("is-live");
      element.setAttribute("fill", style.stroke ?? QUICK_COLOURS[0]);
      element.setAttribute("fill-opacity", String(style.opacity ?? 1));
      if (brush === "marker") element.addClass("palimpsest-highlight");
      if (brush === "pencil") element.style.filter = `url(#${this.grainId})`;
      surface.svg.appendChild(element);
      const stylus = event.pointerType === "pen";
      const speed = new SpeedPressure();
      const pressure = stylus ? Math.max(0.05, event.pressure || 0.5) : speed.next(point.x, point.y, event.timeStamp);
      this.drag = {
        kind: "ink",
        surface,
        points: [{ x: point.x, y: point.y, p: pressure }],
        el: element,
        speed,
        stylus
      };
      this.updateInk(this.drag);
      return;
    }
    if (this.tool === "text") {
      const { objects } = this.state();
      const hit = this.hitTest(point.x, point.y, objects, surface.id);
      if (hit?.type === "text") {
        this.openEditor(surface, hit.g.x ?? point.x, hit.g.y ?? point.y, hit.g.w, hit);
        return;
      }
    }
    const type = this.tool;
    this.drag = { kind: "draw", surface, type, x0: point.x, y0: point.y, x1: point.x, y1: point.y };
  }
  onPointerMove(event, surface) {
    const drag = this.drag;
    if (!drag || drag.kind === "pan") return;
    const point = this.toPage(event, drag.surface);
    if (drag.kind === "ink") {
      const samples = typeof event.getCoalescedEvents === "function" && event.getCoalescedEvents().length ? event.getCoalescedEvents() : [event];
      for (const sample of samples) {
        const at = this.toPage(sample, drag.surface);
        const last = drag.points[drag.points.length - 1];
        if (Math.hypot(at.x - last.x, at.y - last.y) < 0.6 / this.scale) continue;
        const pressure = drag.stylus ? Math.max(0.05, sample.pressure || 0.5) : drag.speed.next(at.x, at.y, sample.timeStamp);
        drag.points.push({ x: at.x, y: at.y, p: pressure });
      }
      this.updateInk(drag);
      return;
    }
    if (drag.kind === "erase") {
      this.erase(point.x, point.y, drag.surface);
      return;
    }
    if (drag.kind === "draw") {
      const end = event.shiftKey ? constrain(drag.type, drag.x0, drag.y0, point.x, point.y) : point;
      drag.x1 = end.x;
      drag.y1 = end.y;
      this.updateGhost(drag);
      return;
    }
    if (drag.kind === "lasso") {
      drag.box = event.altKey;
      const last = drag.points[drag.points.length - 1];
      if (Math.hypot(point.x - last.x, point.y - last.y) >= 1.5 / this.scale) drag.points.push(point);
      this.updateLasso(drag);
      return;
    }
    if (drag.kind === "move") {
      const dx = point.x - drag.dx;
      const dy = point.y - drag.dy;
      this.previewObjects(
        drag.surface,
        drag.objs,
        drag.objs.map((obj, index) => ({ g: this.translate(obj, drag.starts[index], dx, dy) }))
      );
      return;
    }
    if (drag.kind === "resize") {
      this.previewObjects(drag.surface, [drag.obj], [this.resized(drag, point.x, point.y, event)]);
      return;
    }
    if (drag.kind === "scale") {
      const to = this.scaledBox(drag, point.x, point.y, event);
      this.previewObjects(
        drag.surface,
        drag.objs,
        drag.objs.map((obj, index) => this.scaleObject(obj, drag.starts[index], drag.from, to))
      );
    }
  }
  async onPointerUp(event, surface) {
    const drag = this.drag;
    this.drag = null;
    if (!drag || drag.kind === "pan") return;
    surface.svg.releasePointerCapture?.(event.pointerId);
    const point = this.toPage(event, drag.surface);
    if (drag.kind === "ink") {
      drag.el.remove();
      const style = this.styleOf;
      const points = thin(drag.points, 0.4);
      if (points.length === 0) return;
      await this.append({
        id: mintId("o"),
        ts: Date.now(),
        type: "ink",
        page: drag.surface.id,
        g: { p: packPoints(points) },
        st: { stroke: style.stroke, w: style.w, opacity: style.opacity, brush: style.brush ?? "pen" },
        // Where the stroke *started*, not where it ended: a line of working that
        // runs off the edge of the post-it was still written on the post-it.
        on: this.ownerAt(drag.surface.id, points[0].x, points[0].y)
      });
      this.remember(style.stroke ?? QUICK_COLOURS[0]);
      return;
    }
    if (drag.kind === "erase") {
      if (drag.hits.size === 0) return;
      const deletes = [...drag.hits].map((ref) => ({
        id: mintId(),
        ts: Date.now(),
        type: "obj.delete",
        ref
      }));
      await this.append(deletes);
      return;
    }
    if (drag.kind === "draw") {
      this.clearGhost(drag.surface);
      const end = event.shiftKey ? constrain(drag.type, drag.x0, drag.y0, point.x, point.y) : point;
      if (drag.type === "text") {
        const box = rectFromDrag(drag.x0, drag.y0, end.x, end.y);
        const wide = (box.w ?? 0) > 24;
        this.openEditor(drag.surface, wide ? box.x ?? 0 : drag.x0, wide ? box.y ?? 0 : drag.y0, wide ? box.w : void 0, null);
        return;
      }
      const g = isLineLike(drag.type) ? { x1: drag.x0, y1: drag.y0, x2: end.x, y2: end.y } : rectFromDrag(drag.x0, drag.y0, end.x, end.y);
      if (this.tooSmall(drag.type, g)) {
        this.syncOverlays();
        return;
      }
      const style = this.styleOf;
      const create = {
        id: mintId("o"),
        ts: Date.now(),
        type: drag.type,
        page: drag.surface.id,
        g,
        st: this.styleFor(drag.type, style),
        // A cover never belongs to a cover: two overlapping covers are two
        // answers, and making the upper one a child of the lower would delete
        // it along with its parent.
        on: isCover(drag.type) ? void 0 : this.ownerAt(drag.surface.id, drag.x0, drag.y0)
      };
      await this.append(create);
      this.remember(style.stroke ?? QUICK_COLOURS[0]);
      this.selected = [create.id];
      this.syncToolbar();
      this.syncOverlays();
      return;
    }
    if (drag.kind === "lasso") {
      drag.el.remove();
      this.catchWithLasso(drag, event.shiftKey);
      return;
    }
    if (drag.kind === "resize") {
      const patch = this.resized(drag, point.x, point.y, event);
      if (this.samePatch(drag.obj, patch)) return;
      await this.append({ id: mintId(), ts: Date.now(), type: "obj.edit", ref: drag.obj.id, ...patch });
      return;
    }
    const next = drag.kind === "move" ? drag.objs.map((obj, index) => ({
      g: this.translate(obj, drag.starts[index], point.x - drag.dx, point.y - drag.dy)
    })) : (() => {
      const to = this.scaledBox(drag, point.x, point.y, event);
      return drag.objs.map((obj, index) => this.scaleObject(obj, drag.starts[index], drag.from, to));
    })();
    const ts = Date.now();
    const edits = [];
    drag.objs.forEach((obj, index) => {
      if (this.samePatch(obj, next[index])) return;
      edits.push({ id: mintId(), ts, type: "obj.edit", ref: obj.id, ...next[index] });
    });
    if (edits.length === 0) {
      if (drag.kind === "move" && !drag.additive && this.selected.length > 1) {
        this.selected = [drag.pressed];
        this.syncOverlays();
        this.syncToolbar();
      }
      if (drag.kind === "move" && !drag.additive) {
        const pressed = drag.objs.find((obj) => obj.id === drag.pressed);
        if (pressed && isCover(pressed.type)) this.togglePeek(pressed.id);
      }
      return;
    }
    await this.append(edits);
  }
  abortDrag() {
    const drag = this.drag;
    this.drag = null;
    if (!drag || drag.kind === "pan") return;
    if (drag.kind === "ink" || drag.kind === "lasso") drag.el.remove();
    if (drag.kind === "draw") this.clearGhost(drag.surface);
    this.syncOverlays();
  }
  onDoubleClick(event, surface) {
    if (this.readOnly) return;
    const point = this.toPage(event, surface);
    const { objects } = this.state();
    const hit = this.hitTest(point.x, point.y, objects, surface.id);
    if (hit?.type === "text") {
      this.openEditor(surface, hit.g.x ?? point.x, hit.g.y ?? point.y, hit.g.w, hit);
      return;
    }
    if (hit && isCover(hit.type)) return;
    if (!hit && this.tool === "select") {
      this.openEditor(surface, point.x, point.y, void 0, null);
    }
  }
  /** Right-click is where people look for "delete this". */
  onContextMenu(event, surface) {
    if (this.readOnly) return;
    event.preventDefault();
    this.commitEditor();
    const point = this.toPage(event, surface);
    const { objects } = this.state();
    const hit = this.hitTest(point.x, point.y, objects, surface.id);
    const menu = new import_obsidian2.Menu();
    if (hit) {
      if (!this.isSelected(hit.id)) this.selected = [hit.id];
      this.syncOverlays();
      this.syncToolbar();
      if (hit.type === "text") {
        menu.addItem(
          (item) => item.setTitle("Edit text").setIcon("pencil").onClick(() => this.openEditor(surface, hit.g.x ?? point.x, hit.g.y ?? point.y, hit.g.w, hit))
        );
      }
      if (isCover(hit.type)) {
        const open = this.peeked.has(hit.id);
        menu.addItem(
          (item) => item.setTitle(open ? "Cover it again" : "Show the answer").setIcon(open ? "eye-off" : "eye").onClick(() => this.togglePeek(hit.id))
        );
        for (const [mark, title, icon] of [
          ["right", "I got it right", "check"],
          ["wrong", "I got it wrong", "x"]
        ]) {
          menu.addItem(
            (item) => item.setTitle(hit.st.mark === mark ? `${title} \u2014 undo` : title).setIcon(icon).onClick(() => void this.grade(hit, mark))
          );
        }
        menu.addSeparator();
      }
      const many = this.selected.length > 1 ? ` ${this.selected.length} objects` : "";
      menu.addItem(
        (item) => item.setTitle(`Duplicate${many}`).setIcon("copy").onClick(() => void this.duplicate())
      );
      menu.addSeparator();
      menu.addItem(
        (item) => item.setTitle(`Delete${many}`).setIcon("trash-2").setWarning(true).onClick(() => void this.deleteSelection())
      );
    } else {
      menu.addItem(
        (item) => item.setTitle("Add a text box here").setIcon("type").onClick(() => this.openEditor(surface, point.x, point.y, void 0, null))
      );
      menu.addSeparator();
      menu.addItem(
        (item) => item.setTitle("Insert blank page after").setIcon("file-plus").onClick(() => void this.insertPage(surface.id))
      );
      menu.addItem(
        (item) => item.setTitle("Delete this page").setIcon("trash-2").setWarning(true).setDisabled(this.order.length <= 1).onClick(() => void this.deletePage(surface.id))
      );
    }
    menu.showAtMouseEvent(event);
  }
  // ---------------------------------------------------------------------- ink
  updateInk(drag) {
    const style = this.styleOf;
    drag.el.setAttribute("d", outlinePath(drag.points, style.w ?? 2, style.brush ?? "pen"));
  }
  // ------------------------------------------------------------------- eraser
  /** An object eraser, not a pixel eraser.
   *
   *  Rubbing out part of a stroke would mean either rewriting the stroke's
   *  points — which the log forbids — or storing a subtractive mask, which then
   *  has to be replayed and exported and reasoned about forever. Whole strokes
   *  go, and because they go as tombstones you can scrub back and watch them
   *  return. */
  erase(x, y, surface) {
    if (this.drag?.kind !== "erase") return;
    const radius = (this.styles.eraser?.w ?? 14) / 2;
    const { objects } = this.state();
    for (const obj of objects) {
      if (obj.page !== surface.id) continue;
      if (this.drag.hits.has(obj.id)) continue;
      if (isCover(obj.type)) continue;
      if (!this.withinReach(obj, x, y, radius)) continue;
      this.drag.hits.add(obj.id);
      const element = surface.svg.querySelector(`[data-id="${cssEscape(obj.id)}"]`);
      element?.addClass("is-erasing");
    }
  }
  withinReach(obj, x, y, radius) {
    if (isInk(obj.type)) return distanceToInk(unpackPoints(obj.g.p), x, y) <= radius + (obj.st.w ?? 2) / 2;
    if (isLineLike(obj.type)) return this.distanceToSegment(x, y, obj.g) <= radius + (obj.st.w ?? 2) / 2;
    const box = this.boxOf(obj);
    return x >= (box.x ?? 0) - radius && x <= (box.x ?? 0) + (box.w ?? 0) + radius && y >= (box.y ?? 0) - radius && y <= (box.y ?? 0) + (box.h ?? 0) + radius;
  }
  // --------------------------------------------------------------------- text
  editingId = null;
  editorSurface = null;
  editorAt = null;
  editorStyle = null;
  /** A real multi-line text box.
   *
   *  The old editor was a single-line `<input>`: Enter committed, there was no
   *  wrapping, and the box could not be reopened because the double-click never
   *  arrived. This is a `<textarea>` laid over the page at the same size and
   *  font as the rendered text, so Enter is a newline and what you see while
   *  typing is what stays behind. */
  openEditor(surface, x, y, width, existing) {
    this.commitEditor();
    const style = existing ? { size: existing.st.size ?? 14, bold: existing.st.bold, italic: existing.st.italic } : { size: this.styles.text?.size ?? 14 };
    const colour = existing?.st.stroke ?? this.styles.text?.stroke ?? QUICK_COLOURS[0];
    const editor = surface.el.createEl("textarea", {
      cls: "palimpsest-editor",
      attr: { spellcheck: "false", rows: "1" }
    });
    editor.value = existing?.s ?? "";
    editor.style.font = cssFont({ ...style, size: style.size * this.scale });
    editor.style.lineHeight = String(LINE_HEIGHT);
    editor.style.color = colour;
    editor.style.caretColor = colour;
    this.editor = editor;
    this.editingId = existing?.id ?? null;
    this.editorSurface = surface;
    this.editorAt = { x, y, w: width };
    this.editorStyle = style;
    this.placeEditor();
    if (existing) this.syncOverlays();
    const grow = () => {
      const box = layout(editor.value || " ", this.editorAt?.w, style);
      editor.style.height = `${Math.ceil(box.height * this.scale) + 2}px`;
      if (!this.editorAt?.w) editor.style.width = `${Math.ceil(box.width * this.scale) + 14}px`;
    };
    grow();
    editor.oninput = grow;
    editor.onkeydown = (event) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        this.cancelEditor();
      } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        this.commitEditor();
      }
    };
    editor.onblur = () => this.commitEditor();
    window.setTimeout(() => {
      editor.focus();
      editor.setSelectionRange(editor.value.length, editor.value.length);
    }, 0);
  }
  placeEditor() {
    if (!this.editor || !this.editorAt || !this.editorStyle) return;
    this.editor.style.left = `${this.editorAt.x * this.scale}px`;
    this.editor.style.top = `${this.editorAt.y * this.scale}px`;
    this.editor.style.font = cssFont({ ...this.editorStyle, size: this.editorStyle.size * this.scale });
    this.editor.style.lineHeight = String(LINE_HEIGHT);
    const box = layout(this.editor.value || " ", this.editorAt.w, this.editorStyle);
    this.editor.style.height = `${Math.ceil(box.height * this.scale) + 2}px`;
    this.editor.style.width = `${Math.ceil((this.editorAt.w ?? box.width) * this.scale) + (this.editorAt.w ? 0 : 14)}px`;
  }
  moveEditorWithZoom() {
    if (!this.editor) return;
    this.placeEditor();
  }
  cancelEditor() {
    const editor = this.editor;
    this.editor = null;
    this.editingId = null;
    this.editorSurface = null;
    this.editorAt = null;
    this.editorStyle = null;
    editor?.remove();
    this.syncOverlays();
    this.afterEditing();
  }
  commitEditor() {
    const editor = this.editor;
    const surface = this.editorSurface;
    const at = this.editorAt;
    const editingId = this.editingId;
    if (!editor || !surface || !at) return;
    this.editor = null;
    this.editorSurface = null;
    this.editorAt = null;
    this.editorStyle = null;
    this.editingId = null;
    const value = editor.value.replace(/[ \t]+$/gm, "").replace(/\n+$/, "");
    editor.remove();
    const existing = editingId ? this.state().objects.find((candidate) => candidate.id === editingId) : void 0;
    this.afterEditing();
    if (existing) {
      if (value === (existing.s ?? "")) {
        this.selected = [existing.id];
        this.syncOverlays();
        return;
      }
      if (value === "") {
        void this.append({ id: mintId(), ts: Date.now(), type: "obj.delete", ref: existing.id });
        return;
      }
      void this.append({ id: mintId(), ts: Date.now(), type: "obj.edit", ref: existing.id, s: value });
      return;
    }
    if (value === "") {
      this.syncOverlays();
      return;
    }
    const style = this.styles.text ?? { stroke: QUICK_COLOURS[0], size: 14 };
    const create = {
      id: mintId("o"),
      ts: Date.now(),
      type: "text",
      page: surface.id,
      g: at.w ? { x: at.x, y: at.y, w: at.w } : { x: at.x, y: at.y },
      st: { stroke: style.stroke, size: style.size },
      s: value,
      on: this.ownerAt(surface.id, at.x, at.y)
    };
    void this.append(create);
    this.remember(style.stroke ?? QUICK_COLOURS[0]);
    this.selected = [create.id];
    this.syncToolbar();
  }
  /** Leaving the text editor: give the keyboard back to the view, and put the
   *  select tool in hand.
   *
   *  Both halves are about being able to touch what you just typed. Focus lives
   *  on `contentEl`, and it was only ever taken on pointer-down — so straight
   *  after typing a box, Delete reached nothing. And the drawing tools stay in
   *  hand on purpose, which is right for a brush and wrong for text: with the
   *  text tool still active, clicking your new box makes another one. */
  afterEditing() {
    if (this.tool === "text") {
      this.tool = "select";
      this.syncToolbar();
    }
    this.contentEl.focus();
  }
  // --------------------------------------------------------------- transforms
  styleFor(type, style) {
    if (type === "highlight") return { stroke: style.stroke, opacity: style.opacity ?? 0.35 };
    if (type === "text") return { stroke: style.stroke, size: style.size ?? 14 };
    if (type === "cover") return { stroke: style.stroke, opacity: style.opacity ?? 1, mark: null };
    return { stroke: style.stroke, w: style.w ?? 2, fill: null };
  }
  /** A stray click should not litter the log with zero-sized shapes. */
  tooSmall(type, g) {
    if (isLineLike(type)) {
      return Math.hypot((g.x2 ?? 0) - (g.x1 ?? 0), (g.y2 ?? 0) - (g.y1 ?? 0)) < 3;
    }
    return (g.w ?? 0) < 3 || (g.h ?? 0) < 3;
  }
  translate(obj, g, dx, dy) {
    if (isInk(obj.type)) {
      return { p: packPoints(translatePoints(unpackPoints(g.p), dx, dy)) };
    }
    if (g.x1 !== void 0) {
      return { x1: (g.x1 ?? 0) + dx, y1: (g.y1 ?? 0) + dy, x2: (g.x2 ?? 0) + dx, y2: (g.y2 ?? 0) + dy };
    }
    return { ...g, x: (g.x ?? 0) + dx, y: (g.y ?? 0) + dy };
  }
  /** Shift keeps the proportions, Alt grows about the centre — the two
   *  modifiers every drawing program has agreed on. */
  modifiers(event) {
    return { aspect: event.shiftKey, centre: event.altKey };
  }
  scaledBox(drag, x, y, event) {
    return resizeBox(drag.from, drag.handle, x, y, this.modifiers(event));
  }
  resized(drag, x, y, event) {
    const g = drag.g;
    if (isLineLike(drag.obj.type)) {
      const anchor = drag.handle === "start" ? { x: g.x2 ?? 0, y: g.y2 ?? 0 } : { x: g.x1 ?? 0, y: g.y1 ?? 0 };
      const end = event.shiftKey ? constrain(drag.obj.type, anchor.x, anchor.y, x, y) : { x, y };
      return { g: drag.handle === "start" ? { ...g, x1: end.x, y1: end.y } : { ...g, x2: end.x, y2: end.y } };
    }
    const from = asBox(this.boxOf({ ...drag.obj, g }));
    if (drag.obj.type === "text") {
      if (drag.handle === "w" || drag.handle === "e") {
        return { g: { ...g, ...resizeTextWidth(from, drag.handle, x) } };
      }
      return this.scaleText(drag.obj, g, from, resizeBox(from, drag.handle, x, y, { aspect: true, centre: event.altKey }));
    }
    const to = resizeBox(from, drag.handle, x, y, this.modifiers(event));
    if (isInk(drag.obj.type)) {
      return { g: { p: packPoints(scalePoints(unpackPoints(g.p), from, to)) } };
    }
    return { g: { ...g, x: to.x, y: to.y, w: to.w, h: to.h } };
  }
  /** Type scaled with its box: the size and the wrap width take the same
   *  factor, so the line breaks come out exactly where they were and the words
   *  simply get bigger. Scaling one without the other reflows the paragraph
   *  mid-drag, which is the thing that makes text in a resized diagram jump
   *  around. */
  scaleText(obj, start, from, to) {
    const factor = typeFactor(from, to);
    const size = clampSize((obj.st.size ?? 14) * factor);
    const base = obj.st.size ?? 14;
    const applied = base > 0 ? size / base : 1;
    const g = { ...start, x: to.x, y: to.y };
    if (start.w !== void 0) g.w = Math.max(24, start.w * applied);
    return { g, st: { size } };
  }
  /** Where an object lands when the box around the whole selection is dragged
   *  from `from` to `to`. Every kind scales the same way — proportionally,
   *  relative to the frame — except that text keeps its type size, exactly as
   *  it does when you drag its own side. */
  scaleObject(obj, start, from, to) {
    if (isInk(obj.type)) {
      const points = unpackPoints(start.p);
      const own = asBox(inkBounds(points, obj.st.w ?? 2));
      return { g: { p: packPoints(scalePoints(points, own, remap(own, from, to))) } };
    }
    if (isLineLike(obj.type)) {
      const sx = from.w > 0 ? to.w / from.w : 1;
      const sy = from.h > 0 ? to.h / from.h : 1;
      const at = (x, y) => ({ x: to.x + (x - from.x) * sx, y: to.y + (y - from.y) * sy });
      const a = at(start.x1 ?? 0, start.y1 ?? 0);
      const b = at(start.x2 ?? 0, start.y2 ?? 0);
      return { g: { x1: a.x, y1: a.y, x2: b.x, y2: b.y } };
    }
    if (obj.type === "text") {
      const own = asBox(this.boxOf({ ...obj, g: start }));
      return this.scaleText(obj, start, own, remap(own, from, to));
    }
    const next = remap({ x: start.x ?? 0, y: start.y ?? 0, w: start.w ?? 0, h: start.h ?? 0 }, from, to);
    return { g: { ...start, x: next.x, y: next.y, w: next.w, h: next.h } };
  }
  sameGeom(a, b) {
    if (a.p || b.p) return JSON.stringify(a.p) === JSON.stringify(b.p);
    const keys = ["x", "y", "w", "h", "x1", "y1", "x2", "y2"];
    return keys.every((key) => Math.abs((a[key] ?? 0) - (b[key] ?? 0)) < 0.01);
  }
  /** Show a drag in progress without writing anything to the log. */
  previewShape(surface, obj) {
    const element = surface.svg.querySelector(`[data-id="${cssEscape(obj.id)}"]`);
    if (!element) return;
    this.applyShape(element, obj);
  }
  patched(obj, patch) {
    return patch.st ? { ...obj, g: patch.g, st: { ...obj.st, ...patch.st } } : { ...obj, g: patch.g };
  }
  /** Has this drag actually changed anything? `st` only ever carries the type
   *  size, so that is the only style worth comparing. */
  samePatch(obj, patch) {
    if (!this.sameGeom(patch.g, obj.g)) return false;
    if (patch.st?.size === void 0) return true;
    return Math.abs(patch.st.size - (obj.st.size ?? 14)) < 0.01;
  }
  /** Show a drag in progress: the shapes *and* the frame round them.
   *
   *  The frame used to sit still until you let go, which on most shapes is only
   *  scruffy — you can see the rectangle following your hand. On a text box it
   *  is the difference between working and appearing not to: a wrap width set
   *  wider than the words changes nothing else you can see, so with the outline
   *  frozen too, dragging the side of a one-line box looked like a dead
   *  control. */
  previewObjects(surface, objs, patches) {
    const preview = /* @__PURE__ */ new Map();
    objs.forEach((obj, index) => {
      const next = this.patched(obj, patches[index]);
      preview.set(obj.id, next);
      this.previewShape(surface, next);
    });
    this.paintSelection(surface, this.state().objects, preview);
  }
  updateGhost(drag) {
    const svg = drag.surface.svg;
    let ghost = svg.querySelector(".palimpsest-ghost");
    const tag = tagFor(drag.type === "text" ? "rect" : drag.type);
    if (ghost && ghost.tagName !== tag) {
      ghost.remove();
      ghost = null;
    }
    if (!ghost) {
      ghost = document.createElementNS(SVG_NS2, tag);
      ghost.addClass("palimpsest-ghost");
      svg.appendChild(ghost);
    }
    const style = this.styleOf;
    const preview = {
      id: "__ghost",
      type: drag.type === "text" ? "rect" : drag.type,
      page: drag.surface.id,
      g: isLineLike(drag.type) ? { x1: drag.x0, y1: drag.y0, x2: drag.x1, y2: drag.y1 } : rectFromDrag(drag.x0, drag.y0, drag.x1, drag.y1),
      st: drag.type === "text" ? { stroke: style.stroke, w: 1, fill: null } : this.styleFor(drag.type, style),
      z: 0
    };
    this.applyShape(ghost, preview);
    ghost.addClass("palimpsest-ghost");
  }
  clearGhost(surface) {
    surface.svg.querySelector(".palimpsest-ghost")?.remove();
  }
  // -------------------------------------------------------------------- lasso
  /** The loop, drawn as you draw it and closed as it is drawn — you are picking
   *  out an area, and an open curve does not say which side of itself you
   *  meant. */
  updateLasso(drag) {
    const points = this.lassoPolygon(drag);
    drag.el.setAttribute("d", `M ${points.map((p) => `${round2(p.x)} ${round2(p.y)}`).join(" L ")} Z`);
    drag.el.setAttribute("stroke-width", String(1 / this.scale));
    drag.el.setAttribute("stroke-dasharray", `${4 / this.scale} ${3 / this.scale}`);
  }
  lassoPolygon(drag) {
    if (!drag.box) return drag.points;
    const last = drag.points[drag.points.length - 1];
    return marquee(drag.x0, drag.y0, last.x, last.y);
  }
  catchWithLasso(drag, additive) {
    const polygon = this.lassoPolygon(drag);
    const { objects } = this.state();
    const caught = objects.filter((obj) => obj.page === drag.surface.id && caughtBy(asBox(this.boxOf(obj)), polygon)).map((obj) => obj.id);
    const keep = additive ? this.selected.filter((id) => objects.some((obj) => obj.id === id && obj.page === drag.surface.id)) : [];
    this.selected = [...keep, ...caught.filter((id) => !keep.includes(id))];
    if (this.selected.length) this.tool = "select";
    this.syncOverlays();
    this.syncToolbar();
  }
  /** Topmost object under the point. Boxes, not outlines — clicking inside an
   *  unfilled rectangle should select it, which is what every editor does. */
  hitTest(x, y, objects, page) {
    for (let i = objects.length - 1; i >= 0; i--) {
      const obj = objects[i];
      if (obj.page !== page) continue;
      if (isInk(obj.type)) {
        const tolerance = Math.max(4, (obj.st.w ?? 2) / 2 + 2);
        if (distanceToInk(unpackPoints(obj.g.p), x, y) <= tolerance) return obj;
        continue;
      }
      if (isLineLike(obj.type)) {
        const tolerance = Math.max(6, (obj.st.w ?? 2) * 2);
        if (this.distanceToSegment(x, y, obj.g) <= tolerance) return obj;
        continue;
      }
      const box = this.boxOf(obj);
      const pad = 2;
      if (x >= (box.x ?? 0) - pad && x <= (box.x ?? 0) + (box.w ?? 0) + pad && y >= (box.y ?? 0) - pad && y <= (box.y ?? 0) + (box.h ?? 0) + pad) {
        return obj;
      }
    }
    return null;
  }
  distanceToSegment(px, py, g) {
    const x1 = g.x1 ?? 0;
    const y1 = g.y1 ?? 0;
    const x2 = g.x2 ?? 0;
    const y2 = g.y2 ?? 0;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) return Math.hypot(px - x1, py - y1);
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSquared));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }
  async nudge(dx, dy) {
    const { objects } = this.state();
    const chosen = this.withAttempts(this.chosen(objects), objects);
    if (chosen.length === 0) return;
    const ts = Date.now();
    await this.append(
      chosen.map((obj) => ({
        id: mintId(),
        ts,
        type: "obj.edit",
        ref: obj.id,
        g: this.translate(obj, obj.g, dx, dy)
      }))
    );
  }
  /** Copy the selection a little down and to the right, and select the copies. */
  async duplicate() {
    if (this.readOnly) return;
    const { objects } = this.state();
    const held = this.chosen(objects);
    if (held.length === 0) return;
    const chosen = this.withAttempts(held, objects);
    const ts = Date.now();
    const renamed = new Map(chosen.map((obj) => [obj.id, mintId("o")]));
    const copies = chosen.map((obj) => ({
      id: renamed.get(obj.id),
      ts,
      type: obj.type,
      page: obj.page,
      g: this.translate(obj, obj.g, 8, 8),
      st: { ...obj.st },
      s: obj.s,
      on: obj.on ? renamed.get(obj.on) : void 0
    }));
    await this.append(copies);
    this.selected = held.map((obj) => renamed.get(obj.id));
    this.syncOverlays();
    this.syncToolbar();
  }
  async deleteSelection() {
    if (this.selected.length === 0 || this.readOnly) return;
    const { objects } = this.state();
    const refs = this.withAttempts(this.chosen(objects), objects).map((obj) => obj.id);
    this.selected = [];
    for (const ref of refs) this.peeked.delete(ref);
    const ts = Date.now();
    await this.append(refs.map((ref) => ({ id: mintId(), ts, type: "obj.delete", ref })));
  }
  /** Everything on the page you are looking at, which is what `Cmd A` means in
   *  a document that is a column of pages rather than one canvas. */
  selectAllOnPage() {
    if (this.readOnly) return;
    const page = this.order[this.currentPage];
    if (!page) return;
    this.selected = this.state().objects.filter((obj) => obj.page === page).map((obj) => obj.id);
    if (this.selected.length) this.tool = "select";
    this.syncOverlays();
    this.syncToolbar();
  }
  // -------------------------------------------------------------------- study
  /** Which cover control, if any, is under a point.
   *
   *  Worked out from the geometry rather than from `event.target`, for exactly
   *  the reason `handleAt` is: the PDF's text layer sits above the overlay and
   *  takes the press first, so the element under the pointer is never the one
   *  the gesture was aimed at. Topmost cover first. */
  studyZoneAt(x, y, objects, page) {
    for (let i = objects.length - 1; i >= 0; i--) {
      const obj = objects[i];
      if (!isCover(obj.type) || obj.page !== page) continue;
      const zone = hitZone(asBox(this.boxOf(obj)), this.scale, x, y, this.peeked.has(obj.id));
      if (zone) return { obj, zone };
    }
    return null;
  }
  async applyZone(obj, zone) {
    if (zone === "peel") {
      this.togglePeek(obj.id);
      return;
    }
    await this.grade(obj, zone);
  }
  togglePeek(id) {
    if (this.peeked.has(id)) this.peeked.delete(id);
    else this.peeked.add(id);
    this.syncOverlays();
  }
  /** Lift every cover on the document, or put every one back down.
   *
   *  The second is the gesture that makes a marked-up problem set reusable
   *  without closing it: you have been through the page checking answers, and
   *  one button hands you the page back the way you found it. */
  setAllPeeked(open) {
    this.peeked.clear();
    if (open) {
      for (const obj of this.state().objects) {
        if (isCover(obj.type)) this.peeked.add(obj.id);
      }
    }
    this.syncOverlays();
  }
  /** Grading is a toggle: pressing the tick a second time takes the grade off
   *  again. Without that, a mis-tap can only be corrected by pressing the other
   *  one, and the tally then counts a lie. */
  async grade(obj, mark) {
    if (this.readOnly) return;
    await this.append({
      id: mintId(),
      ts: Date.now(),
      type: "obj.edit",
      ref: obj.id,
      st: { mark: obj.st.mark === mark ? null : mark }
    });
  }
  /** The cover a mark made here belongs to, if any.
   *
   *  Only a *closed* cover claims what you write on it. Working done while the
   *  answer is showing is not an attempt at the answer — it is a note about it,
   *  and sweeping it away with the next "let me try these again" would throw
   *  out the wrong half. */
  ownerAt(page, x, y) {
    const cover = coverAt(this.state().objects, page, x, y);
    return cover && !this.peeked.has(cover.id) ? cover.id : void 0;
  }
  /** A set of objects, plus everything written on any cover in it.
   *
   *  A post-it carries what is written on it. Dragging a cover to a better spot
   *  and leaving your working behind on the page would be the sort of thing you
   *  only notice after you have done it twice.
   *
   *  Moving, nudging and deleting do this. Resizing deliberately does not: a
   *  cover is sized when you place it and long before anything is written on
   *  it, and scaling somebody's handwriting because they widened the paper
   *  under it is a surprise, not a feature. */
  withAttempts(held, objects) {
    const covers = held.filter((obj) => isCover(obj.type)).map((obj) => obj.id);
    if (covers.length === 0) return held;
    const already = new Set(held.map((obj) => obj.id));
    return [...held, ...attemptsOn(objects, covers).filter((obj) => !already.has(obj.id))];
  }
  /** Cover the selected words.
   *
   *  The fast way to set a worked-solutions PDF up for practice: select the
   *  solution, press `C`, move on. Dragging a box by hand over forty answers is
   *  the chore that stops you doing it at all.
   *
   *  One cover per page rather than one per line — unlike the highlighter,
   *  which follows the words. A cover hides a region, and a stack of per-line
   *  patches would leave the page showing through the leading: stripes of
   *  visible answer, and on a two-line formula enough to read. */
  async coverSelection(captured) {
    if (this.readOnly) return;
    const pages = captured ?? this.selectionGeometry();
    if (pages.length === 0) return;
    const style = this.styles.cover;
    const ts = Date.now();
    const events = [];
    for (const { page, boxes } of pages) {
      const box = unionCover(boxes);
      if (!box) continue;
      events.push({
        id: mintId("o"),
        ts,
        type: "cover",
        page,
        g: { x: box.x, y: box.y, w: box.w, h: box.h },
        st: this.styleFor("cover", style)
      });
    }
    if (events.length === 0) return;
    this.remember(style.stroke ?? QUICK_COLOURS[0]);
    await this.append(events);
    this.clearTextSelection();
    this.selected = events.map((event) => event.id);
    this.syncToolbar();
    this.syncOverlays();
  }
  /** Wipe the working off the covers so the problems can be done again.
   *
   *  `"wrong"` is the one that earns its keep. A second pass over the four you
   *  got wrong is worth more than a second pass over all forty, and picking
   *  those four out by hand is exactly the chore that stops you doing it.
   *
   *  The covers stay; the grades go with the working, because a grade for an
   *  attempt that no longer exists is not a grade of anything. */
  async clearAttempts(which) {
    if (this.readOnly) {
      new import_obsidian2.Notice("Palimpsest: you are looking at the version history. Go back to editing first.");
      return;
    }
    const { objects } = this.state();
    const covers = resetTargets(objects, which);
    if (covers.length === 0) {
      new import_obsidian2.Notice(which === "wrong" ? "Palimpsest: nothing marked wrong." : "Palimpsest: nothing covered yet.");
      return;
    }
    const ts = Date.now();
    const events = attemptsOn(
      objects,
      covers.map((cover) => cover.id)
    ).map((obj) => ({ id: mintId(), ts, type: "obj.delete", ref: obj.id }));
    for (const cover of covers) {
      if (cover.st.mark) events.push({ id: mintId(), ts, type: "obj.edit", ref: cover.id, st: { mark: null } });
    }
    if (events.length === 0) {
      new import_obsidian2.Notice("Palimpsest: nothing written on those yet.");
      return;
    }
    for (const cover of covers) this.peeked.delete(cover.id);
    this.selected = [];
    await this.append(events);
    new import_obsidian2.Notice(`Palimpsest: cleared ${covers.length} answer${covers.length === 1 ? "" : "s"}.`);
  }
  /** Put every cover back down. Reachable as a command, for when the page is
   *  scrolled somewhere else entirely. */
  coverAgain() {
    this.setAllPeeked(false);
  }
  /** The practice readout, which appears only on a document that has covers on
   *  it — a row of zeroes on every ordinary PDF would be chrome earning
   *  nothing. */
  syncStudy(objects) {
    if (!this.studyEl) return;
    const counts = tally(objects);
    const label2 = tallyLabel(counts);
    this.studyEl.toggleClass("is-visible", label2 !== null);
    if (!label2) return;
    this.studyLabelEl.setText(label2);
    const anyOpen = objects.some((obj) => isCover(obj.type) && this.peeked.has(obj.id));
    const icon = anyOpen ? "eye-off" : "eye";
    const hint = anyOpen ? "Cover the answers again" : "Show every answer";
    if (this.studyButton.dataset.icon !== icon) {
      this.studyButton.dataset.icon = icon;
      (0, import_obsidian2.setIcon)(this.studyButton, icon);
      (0, import_obsidian2.setTooltip)(this.studyButton, hint);
      this.studyButton.setAttribute("aria-label", hint);
    }
    this.studyButton.onclick = () => this.setAllPeeked(!anyOpen);
  }
  // ---------------------------------------------------------- page thumbnails
  thumbs = /* @__PURE__ */ new Map();
  thumbObserver = null;
  railBuilt = false;
  toggleRail() {
    this.rootEl.toggleClass("is-rail", !this.rootEl.hasClass("is-rail"));
    this.syncToolbar();
    if (this.rootEl.hasClass("is-rail")) this.scheduleRail();
  }
  scheduleRail() {
    if (!this.rootEl.hasClass("is-rail") || this.railQueued) return;
    this.railQueued = true;
    window.requestAnimationFrame(() => {
      this.railQueued = false;
      this.buildRail();
    });
  }
  buildRail() {
    if (!this.railBuilt) {
      this.railEl.empty();
      const header = this.railEl.createDiv({ cls: "palimpsest-rail-header" });
      header.createSpan({ text: "Pages" });
      const add = header.createEl("button", { cls: "palimpsest-tool", attr: { "aria-label": "Add a blank page at the end" } });
      (0, import_obsidian2.setIcon)(add, "file-plus");
      add.onclick = () => void this.insertPage(this.order[this.order.length - 1] ?? null);
      this.railEl.createDiv({ cls: "palimpsest-thumbs" });
      this.railBuilt = true;
      this.thumbObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            void this.paintThumb(entry.target);
            this.thumbObserver?.unobserve(entry.target);
          }
        },
        { root: this.railEl, rootMargin: "200px" }
      );
      this.register(() => this.thumbObserver?.disconnect());
    }
    const list = this.railEl.querySelector(".palimpsest-thumbs");
    if (!list) return;
    const live = new Set(this.order);
    for (const [id, element] of this.thumbs) {
      if (live.has(id)) continue;
      element.remove();
      this.thumbs.delete(id);
    }
    this.order.forEach((id, index) => {
      let thumb = this.thumbs.get(id);
      if (!thumb) {
        thumb = this.createThumb(id);
        this.thumbs.set(id, thumb);
        this.thumbObserver?.observe(thumb);
      }
      list.appendChild(thumb);
      const label2 = thumb.querySelector(".palimpsest-thumb-label");
      label2?.setText(String(index + 1));
    });
    this.markRailCurrent();
  }
  createThumb(id) {
    const thumb = document.createElement("div");
    thumb.addClass("palimpsest-thumb");
    thumb.dataset.page = id;
    const frame = thumb.createDiv({ cls: "palimpsest-thumb-frame" });
    const size = this.sizeOf(id);
    frame.style.aspectRatio = `${size.width} / ${size.height}`;
    frame.createEl("canvas");
    thumb.createDiv({ cls: "palimpsest-thumb-label", text: "" });
    const menu = thumb.createEl("button", { cls: "palimpsest-thumb-menu", attr: { "aria-label": "Page actions" } });
    (0, import_obsidian2.setIcon)(menu, "more-vertical");
    menu.onclick = (event) => {
      event.stopPropagation();
      this.openPageMenu(event, id);
    };
    thumb.onclick = () => {
      const index = this.order.indexOf(id);
      if (index >= 0) this.goToPage(index);
    };
    this.bindThumbDrag(thumb, id);
    return thumb;
  }
  async paintThumb(thumb) {
    const id = thumb.dataset.page;
    if (!id || !this.pdf) return;
    const canvas = thumb.querySelector("canvas");
    if (!canvas) return;
    const original = /^o(\d+)$/.exec(id);
    if (!original) {
      const size = this.sizeOf(id);
      canvas.width = THUMB_WIDTH;
      canvas.height = Math.round(THUMB_WIDTH * size.height / size.width);
      const context2 = canvas.getContext("2d");
      if (context2) {
        context2.fillStyle = "#ffffff";
        context2.fillRect(0, 0, canvas.width, canvas.height);
      }
      return;
    }
    const page = await this.pdf.getPage(Number(original[1]) + 1);
    await renderThumb(page, canvas, THUMB_WIDTH);
  }
  markRailCurrent() {
    const current = this.order[this.currentPage];
    for (const [id, thumb] of this.thumbs) thumb.toggleClass("is-current", id === current);
  }
  openPageMenu(event, id) {
    const index = this.order.indexOf(id);
    const menu = new import_obsidian2.Menu();
    menu.addItem(
      (item) => item.setTitle("Insert blank page after").setIcon("file-plus").onClick(() => void this.insertPage(id))
    );
    menu.addItem(
      (item) => item.setTitle("Insert blank page before").setIcon("file-plus").onClick(() => void this.insertPage(index === 0 ? null : this.order[index - 1]))
    );
    menu.addSeparator();
    menu.addItem(
      (item) => item.setTitle("Move up").setIcon("arrow-up").setDisabled(index <= 0).onClick(() => void this.movePage(id, index - 2 < 0 ? null : this.order[index - 2]))
    );
    menu.addItem(
      (item) => item.setTitle("Move down").setIcon("arrow-down").setDisabled(index >= this.order.length - 1).onClick(() => void this.movePage(id, this.order[index + 1]))
    );
    menu.addSeparator();
    menu.addItem(
      (item) => item.setTitle("Delete page").setIcon("trash-2").setWarning(true).setDisabled(this.order.length <= 1).onClick(() => void this.deletePage(id))
    );
    menu.showAtMouseEvent(event);
  }
  /** Deleting a page hides it from the document; it does not touch the PDF, and
   *  the page comes back if you undo or scrub past the deletion. */
  async deletePage(id) {
    await this.append({ id: mintId(), ts: Date.now(), type: "page.delete", ref: id });
  }
  async insertPage(after) {
    await this.append({
      id: mintId(),
      ts: Date.now(),
      type: "page.insert",
      after,
      page: mintId("p"),
      src: "blank"
    });
  }
  async movePage(id, after) {
    if (after === id) return;
    await this.append({ id: mintId(), ts: Date.now(), type: "page.move", ref: id, after });
  }
  /** Drag a thumbnail to reorder. The insertion line is drawn on the gap it
   *  would land in, because "which side of this page" is the whole question. */
  bindThumbDrag(thumb, id) {
    let start = null;
    let active = false;
    const marker = () => {
      let line = this.railEl.querySelector(".palimpsest-drop");
      if (!line) line = this.railEl.createDiv({ cls: "palimpsest-drop" });
      return line;
    };
    const targetIndex = (clientY) => {
      const items = this.order.map((page) => this.thumbs.get(page)).filter(Boolean);
      for (let i = 0; i < items.length; i++) {
        const box = items[i].getBoundingClientRect();
        if (clientY < box.top + box.height / 2) return i;
      }
      return items.length;
    };
    this.registerDomEvent(thumb, "pointerdown", (event) => {
      if (event.target.closest(".palimpsest-thumb-menu")) return;
      start = { x: event.clientX, y: event.clientY };
      thumb.setPointerCapture(event.pointerId);
    });
    this.registerDomEvent(thumb, "pointermove", (event) => {
      if (!start) return;
      if (!active && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5) return;
      active = true;
      thumb.addClass("is-dragging");
      const index = targetIndex(event.clientY);
      const items = this.order.map((page) => this.thumbs.get(page)).filter(Boolean);
      const line = marker();
      const railBox = this.railEl.getBoundingClientRect();
      const anchor = items[Math.min(index, items.length - 1)];
      if (!anchor) return;
      const box = anchor.getBoundingClientRect();
      const y = index >= items.length ? box.bottom : box.top;
      line.style.top = `${y - railBox.top + this.railEl.scrollTop}px`;
      line.addClass("is-visible");
    });
    this.registerDomEvent(thumb, "pointerup", (event) => {
      thumb.releasePointerCapture?.(event.pointerId);
      this.railEl.querySelector(".palimpsest-drop")?.removeClass("is-visible");
      thumb.removeClass("is-dragging");
      const wasActive = active;
      start = null;
      active = false;
      if (!wasActive) return;
      const from = this.order.indexOf(id);
      let index = targetIndex(event.clientY);
      if (from < index) index -= 1;
      const without = this.order.filter((page) => page !== id);
      const at = Math.max(0, Math.min(index, without.length));
      if (at === from) return;
      void this.movePage(id, at === 0 ? null : without[at - 1]);
    });
  }
  // ---------------------------------------------------------- version history
  toggleHistory() {
    if (this.historyOpen) this.closeHistory();
    else this.openHistory();
  }
  openHistory() {
    this.clearTextSelection();
    this.commitEditor();
    this.historyOpen = true;
    this.selected = [];
    this.rootEl.addClass("is-history-open");
    this.buildHistoryPanel();
    this.syncToolbar();
  }
  closeHistory() {
    this.historyOpen = false;
    this.historyAt = null;
    this.chosenVersion = null;
    this.rootEl.removeClass("is-history-open");
    this.invalidate();
    void this.rebuildDocument();
    this.syncToolbar();
  }
  /** Version history as a place you go, not a slider you nudge.
   *
   *  A raw scrubber over nine hundred events is unreadable; what you actually
   *  want is "the way it looked before this morning's lecture". So the log is
   *  grouped into versions by the pauses between edits, listed newest first with
   *  a time and a plain summary, and choosing one shows the document as it stood
   *  then — read-only, with a restore button. */
  buildHistoryPanel() {
    this.panelEl.empty();
    const header = this.panelEl.createDiv({ cls: "palimpsest-panel-header" });
    header.createSpan({ text: "Version history" });
    const close = header.createEl("button", { cls: "palimpsest-tool", attr: { "aria-label": "Close" } });
    (0, import_obsidian2.setIcon)(close, "x");
    close.onclick = () => this.closeHistory();
    const list = this.panelEl.createDiv({ cls: "palimpsest-versions" });
    const current = list.createDiv({ cls: "palimpsest-version is-current-version" });
    current.createDiv({ cls: "palimpsest-version-time", text: "Current version" });
    current.createDiv({
      cls: "palimpsest-version-summary",
      text: this.events.length === 0 ? "nothing drawn yet" : `${this.events.length} edits in all`
    });
    current.onclick = () => this.previewVersion(null);
    const versions = groupVersions(this.events);
    if (versions.length === 0) {
      list.createDiv({ cls: "palimpsest-empty", text: "Draw something and it will show up here." });
    }
    for (const day of byDay(versions)) {
      list.createDiv({ cls: "palimpsest-version-day", text: day.label });
      for (const version of day.versions) {
        const row = list.createDiv({ cls: "palimpsest-version" });
        row.dataset.upto = String(version.upTo);
        row.createDiv({ cls: "palimpsest-version-time", text: timeLabel(version.at) });
        row.createDiv({ cls: "palimpsest-version-summary", text: version.summary });
        row.onclick = () => this.previewVersion(version);
      }
    }
    this.markChosenVersion();
  }
  previewVersion(version) {
    this.chosenVersion = version;
    this.historyAt = version ? version.upTo : null;
    this.selected = [];
    this.invalidate();
    void this.rebuildDocument();
    this.markChosenVersion();
    this.syncTimelineChrome();
  }
  markChosenVersion() {
    this.panelEl.findAll(".palimpsest-version").forEach((row) => {
      const element = row;
      const upTo = element.dataset.upto;
      const chosen = this.chosenVersion ? upTo === String(this.chosenVersion.upTo) : element.hasClass("is-current-version");
      element.toggleClass("is-chosen", chosen);
    });
  }
  syncTimelineChrome() {
    const title = this.historyBarEl.querySelector(".palimpsest-historybar-title");
    const restore = this.historyBarEl.querySelector(".palimpsest-restore");
    if (this.chosenVersion) {
      const date = new Date(this.chosenVersion.at);
      title?.setText(
        `${date.toLocaleDateString(void 0, { month: "short", day: "numeric" })}, ${timeLabel(this.chosenVersion.at)} \u2014 ${this.chosenVersion.summary}`
      );
      if (restore) restore.style.display = "";
    } else {
      title?.setText(this.historyOpen ? "Current version" : "Version history");
      if (restore) restore.style.display = "none";
    }
    if (this.historyOpen) this.buildHistoryPanelSummary();
  }
  buildHistoryPanelSummary() {
    const current = this.panelEl.querySelector(".is-current-version .palimpsest-version-summary");
    current?.setText(this.events.length === 0 ? "nothing drawn yet" : `${this.events.length} edits in all`);
  }
  async restoreChosen() {
    const version = this.chosenVersion;
    if (!version) return;
    const events = restoreTo(this.events, version.upTo, this.pdfPageCount);
    if (events.length === 0) {
      new import_obsidian2.Notice("Palimpsest: that version is already what you have.");
      return;
    }
    this.historyAt = null;
    this.chosenVersion = null;
    this.historyOpen = false;
    this.rootEl.removeClass("is-history-open");
    this.invalidate();
    await this.append(events);
    await this.rebuildDocument();
    this.syncToolbar();
    new import_obsidian2.Notice(`Palimpsest: restored ${timeLabel(version.at)} \u2014 the edits since are still in the history.`);
  }
  // --------------------------------------------------------------------- find
  runsCache = /* @__PURE__ */ new Map();
  matches = [];
  matchAt = -1;
  findInputEl;
  findCountEl;
  buildFindBar() {
    (0, import_obsidian2.setIcon)(this.findEl.createSpan({ cls: "palimpsest-find-icon" }), "search");
    this.findInputEl = this.findEl.createEl("input", {
      cls: "palimpsest-find-input",
      attr: { type: "text", placeholder: "Find in document", spellcheck: "false" }
    });
    this.findCountEl = this.findEl.createSpan({ cls: "palimpsest-label", text: "" });
    this.iconButton(this.findEl, "chevron-up", "Previous match", "Shift Enter", () => this.stepMatch(-1));
    this.iconButton(this.findEl, "chevron-down", "Next match", "Enter", () => this.stepMatch(1));
    this.iconButton(this.findEl, "x", "Close", "Esc", () => this.toggleFind(false));
    let timer = 0;
    this.findInputEl.oninput = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void this.runSearch(), 180);
    };
    this.findInputEl.onkeydown = (event) => {
      event.stopPropagation();
      if (event.key === "Enter") this.stepMatch(event.shiftKey ? -1 : 1);
      if (event.key === "Escape") this.toggleFind(false);
    };
  }
  toggleFind(open) {
    const next = open ?? !this.rootEl.hasClass("is-find");
    this.rootEl.toggleClass("is-find", next);
    this.syncToolbar();
    if (next) {
      this.findInputEl.focus();
      this.findInputEl.select();
    } else {
      this.matches = [];
      this.matchAt = -1;
      this.paintMatches();
      this.contentEl.focus();
    }
  }
  async runSearch() {
    const needle = this.findInputEl.value.trim().toLowerCase();
    this.matches = [];
    this.matchAt = -1;
    if (!needle || !this.pdf) {
      this.findCountEl.setText("");
      this.paintMatches();
      return;
    }
    this.findCountEl.setText("searching\u2026");
    for (let index = 0; index < this.order.length; index++) {
      const original = /^o(\d+)$/.exec(this.order[index]);
      if (!original) continue;
      const number = Number(original[1]);
      for (const run of await this.runsFor(number)) {
        const haystack = run.str.toLowerCase();
        let from = haystack.indexOf(needle);
        while (from !== -1) {
          const per = run.w / Math.max(1, run.str.length);
          this.matches.push({
            surface: index,
            x: run.x + per * from,
            y: run.y,
            w: per * needle.length,
            h: run.h
          });
          from = haystack.indexOf(needle, from + needle.length);
        }
      }
    }
    this.paintMatches();
    if (this.matches.length === 0) {
      this.findCountEl.setText("no matches");
      return;
    }
    this.stepMatch(1);
  }
  stepMatch(direction) {
    if (this.matches.length === 0) return;
    this.matchAt = (this.matchAt + direction + this.matches.length) % this.matches.length;
    const match = this.matches[this.matchAt];
    this.findCountEl.setText(`${this.matchAt + 1} of ${this.matches.length}`);
    const box = this.offsets[match.surface];
    if (box) {
      const target = box.top + match.y * this.scale - this.stageEl.clientHeight / 3;
      this.stageEl.scrollTop = Math.max(0, target);
    }
    this.paintMatches();
  }
  paintMatches() {
    const grouped = /* @__PURE__ */ new Map();
    this.matches.forEach((match) => {
      const list = grouped.get(match.surface);
      if (list) list.push(match);
      else grouped.set(match.surface, [match]);
    });
    this.surfaces.forEach((surface, index) => {
      surface.svg.querySelector(".palimpsest-matches")?.remove();
      const list = grouped.get(index);
      if (!list || list.length === 0) return;
      const group = document.createElementNS(SVG_NS2, "g");
      group.addClass("palimpsest-matches");
      for (const match of list) {
        const rect = document.createElementNS(SVG_NS2, "rect");
        set(rect, { x: match.x, y: match.y, width: match.w, height: match.h });
        rect.addClass("palimpsest-match");
        if (this.matches[this.matchAt] === match) rect.addClass("is-active");
        group.appendChild(rect);
      }
      surface.svg.appendChild(group);
    });
  }
  // ---------------------------------------------------------- selecting text
  /** Text runs for an original page, fetched once.
   *
   *  `Cmd F` and the selectable text layer ask the same question of the same
   *  page, so they share the answer — and the answer is the expensive half of
   *  either feature. */
  async runsFor(number) {
    const cached2 = this.runsCache.get(number);
    if (cached2) return cached2;
    if (!this.pdf) return [];
    const runs = await textRuns(await this.pdf.getPage(number + 1));
    this.runsCache.set(number, runs);
    return runs;
  }
  /** Lay the PDF's own text over a page as selectable spans.
   *
   *  Only pages near the viewport carry one, on the same schedule as the
   *  bitmap: a text layer is the same kind of cost, and four hundred of them
   *  would be the same kind of mistake. */
  async fillTextLayer(surface) {
    const original = /^o(\d+)$/.exec(surface.id);
    if (!original || !this.pdf) return;
    const token = surface.text.begin();
    surface.text.build(token, await this.runsFor(Number(original[1])));
  }
  /** The text layer sits over the markup, so with the select tool in hand it
   *  sees the press first. A press aimed at a shape is handed straight down to
   *  the overlay's own handler; anything else is left alone, and the browser
   *  starts a text selection exactly as it would on any other page.
   *
   *  That is the whole rule, and it is the one every PDF reader uses: one tool,
   *  and what is under the pointer decides whether you are about to move a
   *  circle or select a sentence. */
  onTextPointerDown(event, surface) {
    if (event.button !== 0 || this.spaceHeld || this.tool !== "select") return;
    const point = this.toPage(event, surface);
    const { objects } = this.state();
    const handle = this.readOnly ? null : this.handleAt(point.x, point.y, objects, surface.id);
    const zone = this.studyZoneAt(point.x, point.y, objects, surface.id);
    const grabbed = handle !== null || zone !== null || this.hitTest(point.x, point.y, objects, surface.id) !== null;
    const second = this.isDoublePress(event) && handle === null && zone === null;
    if (!this.readOnly && grabbed) {
      event.preventDefault();
      this.clearTextSelection();
      if (second) this.onDoubleClick(event, surface);
      else this.onPointerDown(event, surface);
      return;
    }
    this.contentEl.focus();
    this.selectionDragging = true;
    if (this.selected.length) {
      this.selected = [];
      this.syncOverlays();
      this.syncToolbar();
    }
  }
  /** Was this press the second of a double-click?
   *
   *  Chromium suppresses the compatibility mouse events — `dblclick` among them
   *  — for a pointer whose `pointerdown` was cancelled, and cancelling is
   *  exactly what stops the page being selected out from under a shape you are
   *  dragging. So on that path the count is kept here. Double-click-to-edit is
   *  how you fix a typo in a text box, and a text box laid over a paragraph is
   *  where you would put one, so it cannot depend on that event arriving. */
  lastPress = { at: 0, x: 0, y: 0 };
  isDoublePress(event) {
    const near = Math.abs(event.clientX - this.lastPress.x) < 5 && Math.abs(event.clientY - this.lastPress.y) < 5;
    const quick = event.timeStamp - this.lastPress.at < 450;
    this.lastPress = { at: event.timeStamp, x: event.clientX, y: event.clientY };
    if (!near || !quick) return false;
    this.lastPress.at = 0;
    return true;
  }
  /** The cursor is the honest signal of what a click will do — and with the
   *  text layer on top, a shape's own cursor never gets a chance to show. */
  onTextPointerMove(event, surface) {
    if (this.drag || this.selectionDragging || this.tool !== "select" || this.readOnly) return;
    const point = this.toPage(event, surface);
    const { objects } = this.state();
    const handle = this.handleAt(point.x, point.y, objects, surface.id);
    const zone = this.studyZoneAt(point.x, point.y, objects, surface.id);
    surface.text.el.style.cursor = handle ? this.handleCursor(handle, this.chosen(objects)) : zone ? "pointer" : this.hitTest(point.x, point.y, objects, surface.id) ? "move" : "";
  }
  /** This only ever fires on the path that kept the browser's default — that
   *  is, with no shape under the pointer. Markup is double-clicked open from
   *  `onTextPointerDown` instead. */
  onTextDoubleClick(event, surface) {
    if (event.target !== surface.text.el) return;
    this.onDoubleClick(event, surface);
  }
  onTextContextMenu(event, surface) {
    if (!this.hasTextSelection()) {
      this.onContextMenu(event, surface);
      return;
    }
    event.preventDefault();
    const text = window.getSelection()?.toString() ?? "";
    const pages = this.selectionGeometry();
    const menu = new import_obsidian2.Menu();
    menu.addItem((item) => item.setTitle("Copy").setIcon("copy").onClick(() => void this.copySelectedText(text)));
    if (!this.readOnly) {
      menu.addSeparator();
      for (const mark of MARKS) {
        menu.addItem(
          (item) => item.setTitle(mark.label).setIcon(mark.icon).onClick(() => void this.markSelection(mark.kind, pages))
        );
      }
      menu.addItem(
        (item) => item.setTitle("Cover this \u2014 I'll work it out").setIcon("sticky-note").onClick(() => void this.coverSelection(pages))
      );
    }
    menu.showAtMouseEvent(event);
  }
  /** Which resize handle is under a point, if any.
   *
   *  The handles are SVG rects underneath the text layer, so they no longer get
   *  the press themselves and `event.target` cannot answer this any more.
   *  Working it out from the geometry has a second and better effect: a handle
   *  becomes grabbable from a few points away rather than only from the nine
   *  pixels it paints. */
  handleAt(x, y, objects, page) {
    const chosen = this.chosen(objects).filter((obj) => obj.page === page);
    if (chosen.length === 0) return null;
    const reach = 7 / this.scale;
    for (const [name, point] of Object.entries(this.handlesFor(chosen))) {
      if (Math.abs(point.x - x) <= reach && Math.abs(point.y - y) <= reach) return name;
    }
    return null;
  }
  buildSelectionBar() {
    this.selectionBarEl.onmousedown = (event) => event.preventDefault();
    this.iconButton(this.selectionBarEl, "copy", "Copy", "Mod C", () => void this.copySelectedText());
    this.separator(this.selectionBarEl);
    for (const mark of MARKS) {
      const button = this.iconButton(
        this.selectionBarEl,
        mark.icon,
        mark.label,
        "",
        () => void this.markSelection(mark.kind)
      );
      button.dataset.mark = mark.kind;
    }
    const cover = this.iconButton(
      this.selectionBarEl,
      "sticky-note",
      "Cover this \u2014 I'll work it out",
      "C",
      () => void this.coverSelection()
    );
    cover.dataset.mark = "cover";
  }
  /** A selection of the PDF's text, in this view.
   *
   *  Judged by the anchor rather than the range's common ancestor: a selection
   *  dragged across a page break has the whole document column as its ancestor,
   *  and asking whether *that* is a text layer says no to the case this feature
   *  exists for. */
  hasTextSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
    const anchor = selection.anchorNode;
    const element = anchor?.nodeType === Node.ELEMENT_NODE ? anchor : anchor?.parentElement;
    return !!element && this.rootEl.contains(element) && !!element.closest(".palimpsest-textlayer");
  }
  clearTextSelection() {
    if (this.hasTextSelection()) window.getSelection()?.removeAllRanges();
    this.hideSelectionBar();
  }
  scheduleSelectionBar() {
    if (this.selectionQueued) return;
    this.selectionQueued = true;
    window.requestAnimationFrame(() => {
      this.selectionQueued = false;
      this.syncSelectionBar();
    });
  }
  syncSelectionBar() {
    if (this.selectionDragging || !this.hasTextSelection()) {
      this.hideSelectionBar();
      return;
    }
    const box = window.getSelection()?.getRangeAt(0).getBoundingClientRect();
    if (!box || box.width === 0 && box.height === 0) {
      this.hideSelectionBar();
      return;
    }
    const stage = this.stageEl.getBoundingClientRect();
    if (box.bottom < stage.top || box.top > stage.bottom) {
      this.hideSelectionBar();
      return;
    }
    this.selectionBarEl.toggleClass("is-marking", !this.readOnly);
    this.selectionBarEl.addClass("is-visible");
    const frame = this.bodyEl.getBoundingClientRect();
    const bar = this.selectionBarEl.getBoundingClientRect();
    const gap = 8;
    const room = box.top - stage.top > bar.height + gap;
    const top = room ? box.top - bar.height - gap : Math.min(box.bottom + gap, stage.bottom - bar.height - gap);
    const left = Math.min(
      Math.max(box.left + box.width / 2 - bar.width / 2, stage.left + gap),
      stage.right - bar.width - gap
    );
    this.selectionBarEl.style.top = `${top - frame.top}px`;
    this.selectionBarEl.style.left = `${left - frame.left}px`;
  }
  /** Say how many, but only when "how many" is a question — one selected object
   *  is drawn plainly enough by its own outline. */
  syncSelectionCount() {
    this.selectionCountEl?.setText(this.selected.length > 1 ? `${this.selected.length} selected` : "");
  }
  hideSelectionBar() {
    this.selectionBarEl?.removeClass("is-visible");
  }
  async copySelectedText(captured) {
    const text = captured ?? window.getSelection()?.toString() ?? "";
    if (!text.trim()) return;
    await navigator.clipboard.writeText(text);
    new import_obsidian2.Notice(`Copied ${text.length} character${text.length === 1 ? "" : "s"}`);
  }
  /** Turn the selection into marks on the page.
   *
   *  This is the half of "does an object snap to the PDF's own text" that
   *  actually matters. You do not drag a highlight along a line of a slide and
   *  try to keep it level: you select the words, and the box comes out exactly
   *  the height of the line and exactly as long as the sentence. One mark per
   *  line, all of it one undo. */
  async markSelection(kind, captured) {
    if (this.readOnly) return;
    const pages = captured ?? this.selectionGeometry();
    if (pages.length === 0) return;
    const style = kind === "highlight" ? this.styles.highlight : this.styles.line;
    const ts = Date.now();
    const events = [];
    for (const { page, boxes } of pages) {
      for (const box of boxes) {
        events.push({
          id: mintId("o"),
          ts,
          type: kind === "highlight" ? "highlight" : "line",
          page,
          g: kind === "highlight" ? { x: box.x, y: box.y, w: box.w, h: box.h } : kind === "underline" ? underlineOf(box) : strikeOf(box),
          st: this.styleFor(kind === "highlight" ? "highlight" : "line", style)
        });
      }
    }
    if (events.length === 0) return;
    this.remember(style.stroke ?? QUICK_COLOURS[0]);
    await this.append(events);
    this.clearTextSelection();
    this.syncToolbar();
  }
  /** The selection's client rects, in page coordinates, grouped by page.
   *
   *  A selection that runs over a page break is several pages' worth of marks,
   *  and each page's are stored against that page's own stable id — the same
   *  rule as everything else in the log, and the reason a highlight stays put
   *  when a page above it is deleted. */
  selectionGeometry() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return [];
    const frames = this.surfaces.map((surface) => ({
      id: surface.id,
      rect: surface.text.el.getBoundingClientRect()
    }));
    const found = /* @__PURE__ */ new Map();
    for (let index = 0; index < selection.rangeCount; index++) {
      const range = selection.getRangeAt(index);
      if (!this.rootEl.contains(range.commonAncestorContainer)) continue;
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width < 0.4 || rect.height < 0.4) continue;
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const frame = frames.find(
          (candidate) => x >= candidate.rect.left && x <= candidate.rect.right && y >= candidate.rect.top && y <= candidate.rect.bottom
        );
        if (!frame) continue;
        const boxes = found.get(frame.id) ?? [];
        boxes.push({
          x: (rect.left - frame.rect.left) / this.scale,
          y: (rect.top - frame.rect.top) / this.scale,
          w: rect.width / this.scale,
          h: rect.height / this.scale
        });
        found.set(frame.id, boxes);
      }
    }
    return [...found].map(([page, boxes]) => ({ page, boxes: mergeLines(boxes) }));
  }
  // ---------------------------------------------------------------- shortcuts
  onKeyUp(event) {
    if (event.code === "Space") {
      this.spaceHeld = false;
      this.rootEl.removeClass("is-panning");
    }
  }
  onKeyDown(event) {
    const tag = event.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    const mod = event.metaKey || event.ctrlKey;
    if (event.code === "Space" && !mod) {
      if (!this.spaceHeld) {
        this.spaceHeld = true;
        this.rootEl.addClass("is-panning");
      }
      event.preventDefault();
      return;
    }
    if (mod && event.key.toLowerCase() === "z") {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) void this.redo();
      else void this.undo();
      return;
    }
    if (mod && event.key.toLowerCase() === "f") {
      event.preventDefault();
      this.toggleFind(true);
      return;
    }
    if (mod && event.key === "\\") {
      event.preventDefault();
      this.toggleRail();
      return;
    }
    if (mod && (event.key === "=" || event.key === "+")) {
      event.preventDefault();
      this.zoomStep(1);
      return;
    }
    if (mod && event.key === "-") {
      event.preventDefault();
      this.zoomStep(-1);
      return;
    }
    if (mod && event.key === "0") {
      event.preventDefault();
      this.applyFit("width");
      return;
    }
    if (event.key === "Escape") {
      if (this.rootEl.hasClass("is-find")) {
        this.toggleFind(false);
        return;
      }
      if (this.hasTextSelection()) {
        this.clearTextSelection();
        return;
      }
      if (this.drag) {
        this.abortDrag();
        return;
      }
      if (this.historyOpen) {
        this.closeHistory();
        return;
      }
      this.selected = [];
      this.tool = "select";
      this.syncToolbar();
      this.syncOverlays();
      return;
    }
    if (this.selected.length && !this.readOnly && event.key.startsWith("Arrow")) {
      const step = event.shiftKey ? 10 : 1;
      const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
      const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
      if (dx || dy) {
        event.preventDefault();
        void this.nudge(dx, dy);
        return;
      }
    }
    if (mod && event.key.toLowerCase() === "d") {
      event.preventDefault();
      void this.duplicate();
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && this.selected.length && !this.readOnly) {
      event.preventDefault();
      void this.deleteSelection();
      return;
    }
    if (this.selected.length === 0) {
      const page = this.stageEl.clientHeight * 0.9;
      const nudge = {
        ArrowDown: 60,
        ArrowUp: -60,
        PageDown: page,
        PageUp: -page
      };
      if (event.key in nudge) {
        event.preventDefault();
        this.stageEl.scrollTop += nudge[event.key];
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        this.goToPage(0);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        this.goToPage(this.surfaces.length - 1);
        return;
      }
    }
    if (mod && event.key.toLowerCase() === "a") {
      event.preventDefault();
      this.selectAllOnPage();
      return;
    }
    const shortcuts = {
      v: "select",
      q: "lasso",
      p: "pen",
      b: "marker",
      n: "pencil",
      e: "eraser",
      h: "highlight",
      t: "text",
      c: "cover",
      r: "rect",
      o: "ellipse",
      l: "line",
      a: "arrow"
    };
    const tool = shortcuts[event.key.toLowerCase()];
    if (tool && !mod && !event.altKey) {
      this.pickTool(tool);
    }
  }
};
function set(element, attrs) {
  for (const [name, value] of Object.entries(attrs)) {
    element.setAttribute(name, String(Math.round(value * 100) / 100));
  }
}
function asBox(g) {
  return { x: g.x ?? 0, y: g.y ?? 0, w: g.w ?? 0, h: g.h ?? 0 };
}
function boxHandles(box) {
  const midX = box.x + box.w / 2;
  const midY = box.y + box.h / 2;
  const right = box.x + box.w;
  const bottom = box.y + box.h;
  return {
    nw: { x: box.x, y: box.y },
    n: { x: midX, y: box.y },
    ne: { x: right, y: box.y },
    e: { x: right, y: midY },
    se: { x: right, y: bottom },
    s: { x: midX, y: bottom },
    sw: { x: box.x, y: bottom },
    w: { x: box.x, y: midY }
  };
}
var round2 = (value) => Math.round(value * 100) / 100;
function tagFor(type) {
  switch (type) {
    case "ellipse":
      return "ellipse";
    case "line":
    case "arrow":
      return "line";
    case "text":
      return "text";
    case "ink":
      return "path";
    // A cover is the paper, the dog-ear you lift it by, and — once lifted — the
    // tick and cross. One element cannot be four, so it is a group.
    case "cover":
      return "g";
    default:
      return "rect";
  }
}
function cssEscape(value) {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
}
function newLogContents(pdfPath) {
  return `${serialise(newDocEvent(pdfPath))}
`;
}

// src/main.ts
var PDF_VIEW = "pdf";
var PalimpsestPlugin = class extends import_obsidian3.Plugin {
  settings = { ...DEFAULT_SETTINGS };
  /** PDF views we have already put a button on, so leaf changes don't stack them up. */
  decorated = /* @__PURE__ */ new WeakSet();
  /** PDFs to leave alone for one open, because the user asked for the plain page. */
  plainOnce = /* @__PURE__ */ new Set();
  async onload() {
    await this.loadSettings();
    this.registerView(VIEW_TYPE_PALIMPSEST, (leaf) => new PalimpsestView(leaf, this));
    this.registerExtensions([PALIMPSEST_EXT], VIEW_TYPE_PALIMPSEST);
    this.addSettingTab(new PalimpsestSettingTab(this.app, this));
    this.addRibbonIcon("pen-line", "Palimpsest: mark up a PDF", () => void this.markUpActive());
    this.addCommand({
      id: "markup-active-pdf",
      name: "Mark up the current PDF",
      callback: () => void this.markUpActive()
    });
    this.addCommand({
      id: "sync-note",
      name: "Sync the note for this PDF",
      callback: () => void this.syncNoteForActive()
    });
    this.addCommand({
      id: "cover-answers-again",
      name: "Cover the answers again",
      checkCallback: (checking) => {
        const view = this.activeMarkup();
        if (checking) return view !== null;
        view?.coverAgain();
        return true;
      }
    });
    this.addCommand({
      id: "clear-attempts",
      name: "Clear my attempts and start these again",
      checkCallback: (checking) => {
        const view = this.activeMarkup();
        if (checking) return view !== null;
        void view?.clearAttempts("all");
        return true;
      }
    });
    this.addCommand({
      id: "clear-wrong-attempts",
      name: "Clear the ones I got wrong and try them again",
      checkCallback: (checking) => {
        const view = this.activeMarkup();
        if (checking) return view !== null;
        void view?.clearAttempts("wrong");
        return true;
      }
    });
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof import_obsidian3.TFile) || file.extension !== "pdf") return;
        menu.addItem(
          (item) => item.setTitle("Mark up with Palimpsest").setIcon("pen-line").onClick(() => void this.openMarkup(file))
        );
      })
    );
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.decoratePdfViews()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.decoratePdfViews()));
    this.app.workspace.onLayoutReady(() => this.decoratePdfViews());
    this.registerEvent(this.app.workspace.on("file-open", (file) => void this.maybeRedirect(file)));
  }
  onunload() {
  }
  async loadSettings() {
    this.settings = migrateSettings(await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  /** The markup view in front of you, if that is what is in front of you. */
  activeMarkup() {
    const view = this.app.workspace.getActiveViewOfType(PalimpsestView);
    return view ?? null;
  }
  /** Where a PDF's markup lives: the same name, beside it. */
  logPathFor(pdf) {
    const folder = pdf.parent instanceof import_obsidian3.TFolder && pdf.parent.path !== "/" ? `${pdf.parent.path}/` : "";
    return `${folder}${pdf.basename}.${PALIMPSEST_EXT}`;
  }
  existingLogFor(pdf) {
    const found = this.app.vault.getAbstractFileByPath(this.logPathFor(pdf));
    return found instanceof import_obsidian3.TFile ? found : null;
  }
  /** Let the plain PDF through once, when the user asked for it explicitly. */
  showPlainOnce(path) {
    this.plainOnce.add(path);
  }
  async maybeRedirect(file) {
    if (!file || file.extension !== "pdf") return;
    if (this.plainOnce.has(file.path)) {
      this.plainOnce.delete(file.path);
      return;
    }
    const mode = this.settings.openMode;
    if (mode === "never") return;
    if (mode === "marked" && this.existingLogFor(file) === null) return;
    const leaf = this.app.workspace.getLeavesOfType(PDF_VIEW).find((candidate) => {
      const view = candidate.view;
      return view.file?.path === file.path;
    });
    if (!leaf) return;
    await this.openMarkup(file, leaf);
  }
  async syncNoteForActive() {
    const file = this.app.workspace.getActiveFile();
    if (!file) return;
    let pdf = null;
    if (file.extension === "pdf") pdf = file;
    else if (file.extension === PALIMPSEST_EXT) pdf = await this.pdfForLog(file);
    if (!pdf) {
      new import_obsidian3.Notice("Palimpsest: open a PDF or its markup first.");
      return;
    }
    const note = await this.syncNote(pdf);
    if (note) await this.app.workspace.getLeaf(true).openFile(note);
  }
  /** The log's own header says which PDF it belongs to; the sibling of the same
   *  name is the fallback for a log whose PDF has been moved alongside it. */
  async pdfForLog(log) {
    const header = parseLog(await this.app.vault.read(log)).header;
    if (header) {
      const stated = this.app.vault.getAbstractFileByPath(header.pdf);
      if (stated instanceof import_obsidian3.TFile) return stated;
    }
    const folder = log.parent && log.parent.path !== "/" ? `${log.parent.path}/` : "";
    const sibling = this.app.vault.getAbstractFileByPath(`${folder}${log.basename}.pdf`);
    return sibling instanceof import_obsidian3.TFile ? sibling : null;
  }
  /** Write the companion markdown note that puts this PDF in the graph.
   *
   *  Obsidian indexes tags and links out of markdown only, so a PDF cannot
   *  carry either by itself. Whatever was typed on the page is what lands here:
   *  `#tags` become frontmatter, `[[links]]` become real links. Nothing is
   *  invented, and prose written by hand in the note is left alone.
   */
  async syncNote(pdf) {
    const log = this.existingLogFor(pdf);
    if (!log) {
      new import_obsidian3.Notice("Palimpsest: nothing marked up on this PDF yet.");
      return null;
    }
    const parsed = parseLog(await this.app.vault.read(log));
    const pageCount = await this.pageCount(pdf);
    const state = replay(parsed.events, pageCount);
    const generated = generate({ pdfPath: pdf.path, title: pdf.basename, state });
    const path = `${pdf.parent && pdf.parent.path !== "/" ? `${pdf.parent.path}/` : ""}${pdf.basename}.md`;
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof import_obsidian3.TFile) {
      const merged = merge(await this.app.vault.read(existing), generated);
      await this.app.vault.modify(existing, merged);
      new import_obsidian3.Notice(`Palimpsest: updated ${existing.basename}`);
      return existing;
    }
    const created = await this.app.vault.create(path, merge(null, generated, ["pdf"]));
    new import_obsidian3.Notice(`Palimpsest: created ${created.basename}`);
    return created;
  }
  /** Page count without keeping the document open. */
  async pageCount(pdf) {
    const { openPdf: openPdf2 } = await Promise.resolve().then(() => (init_pdf(), pdf_exports));
    try {
      const doc = await openPdf2(await this.app.vault.readBinary(pdf));
      const count = doc.numPages;
      doc.destroy?.();
      return count;
    } catch {
      return 0;
    }
  }
  /** Add "Mark up with Palimpsest" to every open PDF view that lacks it.
   *
   *  `addAction` is ItemView's public API — this adds a button to the tab's own
   *  action bar. It is not the same thing as reaching into Obsidian's PDF
   *  viewer internals, which this plugin deliberately does not do.
   */
  decoratePdfViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(PDF_VIEW)) {
      const view = leaf.view;
      if (this.decorated.has(view)) continue;
      const asItem = view;
      if (typeof asItem.addAction !== "function") continue;
      try {
        asItem.addAction("pen-line", "Mark up with Palimpsest", () => {
          const file = view.file;
          if (file instanceof import_obsidian3.TFile) void this.openMarkup(file, leaf);
        });
        this.decorated.add(view);
      } catch {
      }
    }
  }
  async markUpActive() {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "pdf") {
      new import_obsidian3.Notice("Palimpsest: open a PDF first, then mark it up.");
      return;
    }
    await this.openMarkup(file, this.app.workspace.getMostRecentLeaf() ?? void 0);
  }
  /** Show a PDF ready to draw on.
   *
   *  The view opens **the PDF itself**, so the tab keeps the PDF's name and the
   *  file explorer highlights the PDF rather than a sidecar nobody thinks of as
   *  the document. Nothing is written here: the `<name>.palimpsest` log is
   *  created the first time an edit is actually made, which is what lets
   *  "open every PDF in Palimpsest" be a setting you can leave on without
   *  filling a course folder with empty logs.
   *
   *  The PDF itself is never touched — not on open, not on save, not ever.
   */
  async openMarkup(pdf, inPlaceOf) {
    const leaf = inPlaceOf && inPlaceOf.view.getViewType() === PDF_VIEW ? inPlaceOf : this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE_PALIMPSEST, state: { file: pdf.path }, active: true });
  }
};
