/** Text boxes: measuring, wrapping, and the metrics both the renderer and the
 *  editor have to agree on.
 *
 *  The editor is a real `<textarea>` sitting exactly on top of the rendered
 *  `<text>`, so what you type lands where it will end up. That only holds if
 *  both sides wrap identically — hence one module, used by both, rather than
 *  SVG's own line breaking (there isn't any) or the browser's (which the SVG
 *  renderer cannot see).
 *
 *  The font is a fixed stack rather than `var(--font-text)`: a canvas
 *  `measureText` cannot resolve a CSS custom property, so a theme variable here
 *  would mean measuring one font and drawing another. It also keeps a text box
 *  looking the same in a light theme, a dark theme, and an eventual PDF export.
 */

export const TEXT_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

/** Multiple of the font size. Matches the editor's line-height exactly. */
export const LINE_HEIGHT = 1.28;

let measurer: CanvasRenderingContext2D | null = null;

function context(): CanvasRenderingContext2D {
  if (!measurer) {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Palimpsest: no 2d context for text measurement");
    measurer = ctx;
  }
  return measurer;
}

export interface TextStyle {
  size: number;
  bold?: boolean;
  italic?: boolean;
}

export function cssFont(style: TextStyle): string {
  const weight = style.bold ? "700" : "400";
  const slant = style.italic ? "italic " : "";
  return `${slant}${weight} ${style.size}px ${TEXT_FONT}`;
}

export function measure(text: string, style: TextStyle): number {
  const ctx = context();
  ctx.font = cssFont(style);
  return ctx.measureText(text).width;
}

/** Break a string into the lines that will actually be drawn.
 *
 *  `width` of 0 or undefined means the box auto-sizes: only explicit newlines
 *  break it. That is the default for a box you made with a click; dragging one
 *  out gives it a width and turns wrapping on. */
export function wrap(text: string, width: number | undefined, style: TextStyle): string[] {
  const paragraphs = text.split("\n");
  if (!width || width <= 0) return paragraphs;

  const out: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph === "") {
      out.push("");
      continue;
    }
    out.push(...wrapParagraph(paragraph, width, style));
  }
  return out;
}

function wrapParagraph(paragraph: string, width: number, style: TextStyle): string[] {
  const lines: string[] = [];
  // Keep the trailing space on each token, so a run of spaces survives a wrap
  // instead of being quietly collapsed the way a naive split would.
  const words = paragraph.match(/\S+\s*|\s+/g) ?? [paragraph];

  let line = "";
  for (const word of words) {
    const candidate = line + word;
    if (line && measure(candidate.trimEnd(), style) > width) {
      lines.push(line.trimEnd());
      line = word.trimStart();
      // A single word longer than the box has to be cut, or it runs off the page.
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

export interface TextBox {
  lines: string[];
  width: number;
  height: number;
  lineHeight: number;
}

/** The box a piece of text occupies, in page points, with the origin at its
 *  top-left corner. */
export function layout(text: string, width: number | undefined, style: TextStyle): TextBox {
  const lines = wrap(text, width, style);
  const lineHeight = style.size * LINE_HEIGHT;
  const natural = lines.reduce((widest, line) => Math.max(widest, measure(line, style)), 0);
  return {
    lines,
    width: width && width > 0 ? width : natural,
    height: Math.max(lineHeight, lines.length * lineHeight),
    lineHeight,
  };
}
