/** The companion note: how a marked-up PDF gets into the graph.
 *
 *  Obsidian only indexes tags and wikilinks out of markdown. A PDF and a
 *  `.palimpsest` log are both invisible to the graph, the tag pane and
 *  backlinks, so the only honest way to give a PDF tags and links is to
 *  generate a note next to it that carries them.
 *
 *  Nothing here invents a tag. Whatever you type on the page is what shows up:
 *  write `[[Nyquist limit]]` in a text box and the note links it; write
 *  `#ese271` and it becomes a frontmatter tag. That keeps the note honest and
 *  keeps the page the place you actually work.
 */

import { DocState, Obj, PageId, ShapeType, nameShape } from "./log";
import { tally, tallyLabel } from "./study";

export const BEGIN = "<!-- palimpsest:begin -->";
export const END = "<!-- palimpsest:end -->";

const TAG_PATTERN = /#([A-Za-z][\w/-]*)/g;
const LINK_PATTERN = /\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]/g;

/** `#ese271` typed on the page becomes a bare YAML tag, per vault convention. */
export function extractTags(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(TAG_PATTERN)) found.add(match[1]);
  return [...found];
}

/** `[[Nyquist limit]]` typed on the page becomes a real link in the graph. */
export function extractLinks(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(LINK_PATTERN)) found.add(match[1].trim());
  return [...found];
}

export interface NoteInput {
  /** Vault-relative path of the PDF, for the embed. */
  pdfPath: string;
  /** Display name for the heading. */
  title: string;
  state: DocState;
}

export interface GeneratedNote {
  tags: string[];
  links: string[];
  /** The managed block, markers included. */
  block: string;
}

const label = (page: PageId, order: PageId[]): string => {
  const at = order.indexOf(page);
  return at >= 0 ? `Page ${at + 1}` : "Detached page";
};

export function generate(input: NoteInput): GeneratedNote {
  const { order, objects } = input.state;

  const tags = new Set<string>();
  const links = new Set<string>();

  const byPage = new Map<PageId, Obj[]>();
  for (const obj of objects) {
    const list = byPage.get(obj.page) ?? [];
    list.push(obj);
    byPage.set(obj.page, list);
  }

  const lines: string[] = [BEGIN, "", `## Markup on [[${input.pdfPath}|${input.title}]]`, ""];

  // How the practice went, when this is a document you have been practising on.
  // A PDF with no covers on it gets no line at all rather than a row of zeroes.
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
      const kinds = new Map<string, number>();
      for (const mark of marks) {
        if (mark.type === "text") continue;
        kinds.set(mark.type, (kinds.get(mark.type) ?? 0) + 1);
      }
      const summary = [...kinds.entries()]
        .map(([kind, count]) =>
          kind === "cover"
            ? coverSummary(marks.filter((mark) => mark.type === "cover"))
            : nameShape(kind as ShapeType, count),
        )
        .join(", ");
      lines.push(`- *${summary}*`);
    }
    lines.push("");
  }

  if (!wrote) lines.push("*No annotations yet.*", "");

  lines.push(`![[${input.pdfPath}]]`, "", END);

  return { tags: [...tags], links: [...links], block: lines.join("\n") };
}

/** Covers on one page, with how they went.
 *
 *  "3 covers" only says the page was set up for practice. "3 covers, 2 wrong"
 *  says which page to go back to, which is the thing you open this note for a
 *  week later. */
function coverSummary(covers: Obj[]): string {
  const base = nameShape("cover", covers.length);
  const graded = [
    covers.filter((cover) => cover.st.mark === "right").length,
    covers.filter((cover) => cover.st.mark === "wrong").length,
  ];
  const parts = [graded[0] ? `${graded[0]} right` : "", graded[1] ? `${graded[1]} wrong` : ""].filter(Boolean);
  return parts.length ? `${base} (${parts.join(", ")})` : base;
}

/** YAML tag list, bare entries — never `"#tag"`. */
function renderFrontmatter(tags: string[]): string {
  if (tags.length === 0) return "---\ntags: []\n---";
  return ["---", "tags:", ...tags.map((tag) => `  - ${tag}`), "---"].join("\n");
}

/** Vault convention is a bare tag. Strip quotes, then the hash — in that order,
 *  or `"#pdf"` comes out still wearing its hash. */
function normaliseTag(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, "").replace(/^#/, "").trim();
}

function splitFrontmatter(text: string): { tags: string[]; rest: string; had: boolean } {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) return { tags: [], rest: text, had: false };

  const tags: string[] = [];
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

/** Write the generated block into a note without touching anything else in it.
 *
 *  Tags are a union: tags typed on the page are added, tags added by hand in
 *  the note survive. Prose outside the managed block is never rewritten.
 */
export function merge(existing: string | null, generated: GeneratedNote, seedTags: string[] = []): string {
  const source = existing ?? "";
  const { tags: currentTags, rest } = splitFrontmatter(source);

  const tags: string[] = [];
  for (const tag of [...(existing ? [] : seedTags), ...currentTags, ...generated.tags]) {
    if (!tags.includes(tag)) tags.push(tag);
  }

  let body = rest;
  const start = body.indexOf(BEGIN);
  const finish = body.indexOf(END);

  if (start >= 0 && finish > start) {
    body = body.slice(0, start) + generated.block + body.slice(finish + END.length);
  } else {
    body = `${body.trimEnd()}\n\n${generated.block}\n`.trimStart();
  }

  return `${renderFrontmatter(tags)}\n\n${body.trim()}\n`;
}
