/** The colour puck.
 *
 *  Sketchbook puts colour behind a single round swatch that opens a wheel, and
 *  that is the right shape for this: a row of six fixed swatches is fine until
 *  the first time you want the exact green the slide uses. Hue on the ring,
 *  saturation and value in the square, opacity underneath, and a row of recents
 *  so the colour you have been using all lecture is one click away.
 */

const RING_OUTER = 84;
const RING_INNER = 64;
const SIZE = RING_OUTER * 2;

export interface HSV {
  h: number; // 0..360
  s: number; // 0..1
  v: number; // 0..1
}

// -------------------------------------------------------------- conversions

export function hsvToHex({ h, s, v }: HSV): string {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  const byte = (value: number): string =>
    Math.round((value + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

export function hexToHsv(hex: string): HSV {
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
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export const isHex = (value: string): boolean => /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim());

/** A darker relative of a colour.
 *
 *  A cover is a piece of coloured paper laid on the page, and paper has an
 *  edge. Drawing that edge in a fixed grey makes it read as a border round a
 *  rectangle; drawing it in a shade of the paper's own colour makes it read as
 *  the paper's thickness, which is the thing that says "this is on top of the
 *  page" rather than "this is part of the page". Saturation comes up as value
 *  goes down, because a shadow on coloured stock is not a greyer version of it.
 */
export function shade(hex: string, amount = 0.24): string {
  const { h, s, v } = hexToHsv(hex);
  return hsvToHex({ h, s: Math.min(1, s + amount * 0.6), v: Math.max(0, v - amount) });
}

/** Black or white, whichever can be read on top of this colour.
 *
 *  Rec. 601 luma: a cover can be any colour the puck can produce, and a dark
 *  blue one with a dark tick on it is a control you cannot see. */
export const readableOn = (hex: string): string => {
  const { s, v } = hexToHsv(hex);
  return v * (1 - s * 0.4) > 0.6 ? "#1f2328" : "#ffffff";
};

// -------------------------------------------------------------------- picker

export interface PuckOptions {
  colour: string;
  opacity: number;
  size: number;
  /** Colours used recently in this document, most recent first. */
  recents: string[];
  showOpacity: boolean;
  onColour: (hex: string) => void;
  onOpacity: (value: number) => void;
  onSize: (value: number) => void;
}

/** Open the picker anchored under `anchor`. Returns a closer. */
export function openPuck(anchor: HTMLElement, options: PuckOptions): () => void {
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
    attr: { type: "text", spellcheck: "false", "aria-label": "Hex colour" },
  });

  const sliders = popover.createDiv({ cls: "palimpsest-sliders" });
  const sizeRow = slider(sliders, "Size", 1, 40, options.size, 1, (value) => options.onSize(value), (v) => `${v} pt`);
  const opacityRow = options.showOpacity
    ? slider(sliders, "Opacity", 5, 100, Math.round(options.opacity * 100), 1, (value) => options.onOpacity(value / 100), (v) => `${v}%`)
    : null;
  void sizeRow;
  void opacityRow;

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

  const paint = (): void => {
    drawWheel(wheel, dpr, hsv);
    hexField.value = hsvToHex(hsv);
    hexField.style.borderColor = hsvToHex(hsv);
  };

  const emit = (): void => options.onColour(hsvToHex(hsv));

  // -- interaction ---------------------------------------------------------

  let dragging: "ring" | "square" | null = null;

  const at = (event: PointerEvent): { x: number; y: number } => {
    const rect = wheel.getBoundingClientRect();
    return { x: event.clientX - rect.left - RING_OUTER, y: event.clientY - rect.top - RING_OUTER };
  };

  const applyRing = (x: number, y: number): void => {
    let angle = (Math.atan2(y, x) * 180) / Math.PI + 90;
    if (angle < 0) angle += 360;
    hsv = { ...hsv, h: angle % 360 };
  };

  const applySquare = (x: number, y: number): void => {
    const half = squareHalf();
    hsv = {
      ...hsv,
      s: Math.max(0, Math.min(1, (x + half) / (half * 2))),
      v: Math.max(0, Math.min(1, 1 - (y + half) / (half * 2))),
    };
  };

  wheel.addEventListener("pointerdown", (event: PointerEvent) => {
    wheel.setPointerCapture(event.pointerId);
    const { x, y } = at(event);
    const radius = Math.hypot(x, y);
    dragging = radius > RING_INNER ? "ring" : "square";
    if (dragging === "ring") applyRing(x, y);
    else applySquare(x, y);
    paint();
    emit();
  });

  wheel.addEventListener("pointermove", (event: PointerEvent) => {
    if (!dragging) return;
    const { x, y } = at(event);
    if (dragging === "ring") applyRing(x, y);
    else applySquare(x, y);
    paint();
    emit();
  });

  const stop = (): void => {
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

  // -- dismissal -----------------------------------------------------------

  const close = (): void => {
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onEscape, true);
    popover.remove();
  };

  const onOutside = (event: PointerEvent): void => {
    const target = event.target as Node;
    if (popover.contains(target) || anchor.contains(target)) return;
    close();
  };

  const onEscape = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    close();
  };

  // Deferred, or the click that opened the puck immediately closes it.
  window.setTimeout(() => {
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onEscape, true);
  }, 0);

  return close;
}

const squareHalf = (): number => (RING_INNER - 6) / Math.SQRT2;

function drawWheel(canvas: HTMLCanvasElement, dpr: number, hsv: HSV): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.translate(RING_OUTER, RING_OUTER);

  // Hue ring, one wedge per degree — cheap, and no seam.
  for (let degree = 0; degree < 360; degree++) {
    const from = ((degree - 90.6) * Math.PI) / 180;
    const to = ((degree - 89.4) * Math.PI) / 180;
    ctx.beginPath();
    ctx.arc(0, 0, RING_OUTER - 1, from, to);
    ctx.arc(0, 0, RING_INNER, to, from, true);
    ctx.closePath();
    ctx.fillStyle = hsvToHex({ h: degree, s: 1, v: 1 });
    ctx.fill();
  }

  // Saturation/value square, inscribed in the ring.
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

  // Markers.
  const hueAngle = ((hsv.h - 90) * Math.PI) / 180;
  const hueRadius = (RING_OUTER + RING_INNER) / 2;
  ring(ctx, Math.cos(hueAngle) * hueRadius, Math.sin(hueAngle) * hueRadius, 7);
  ring(ctx, -half + hsv.s * half * 2, -half + (1 - hsv.v) * half * 2, 6);

  ctx.restore();
}

function ring(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number): void {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.6;
  ctx.stroke();
}

function slider(
  parent: HTMLElement,
  label: string,
  min: number,
  max: number,
  value: number,
  step: number,
  onInput: (value: number) => void,
  format: (value: number) => string,
): HTMLInputElement {
  const row = parent.createDiv({ cls: "palimpsest-slider-row" });
  row.createSpan({ cls: "palimpsest-slider-label", text: label });
  const input = row.createEl("input", {
    attr: { type: "range", min: String(min), max: String(max), step: String(step), value: String(value) },
  });
  const readout = row.createSpan({ cls: "palimpsest-slider-value", text: format(value) });
  input.oninput = () => {
    const next = Number(input.value);
    readout.setText(format(next));
    onInput(next);
  };
  return input;
}
