// Loaded only after a formula export is requested. No new rendering library:
// freeze KaTeX's existing layout and embed the fonts it actually uses.
import katexLicense from "katex/LICENSE?raw";

const STYLE_PROPERTIES = [
  "display", "position", "top", "right", "bottom", "left", "box-sizing",
  "table-layout", "border-collapse", "border-spacing",
  "width", "height", "min-width", "max-width", "min-height", "max-height",
  "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "border-top-style", "border-right-style", "border-bottom-style", "border-left-style",
  "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
  "font-family", "font-size", "font-weight", "font-style", "font-variant",
  "font-feature-settings", "line-height", "letter-spacing", "word-spacing",
  "text-align", "text-indent", "text-transform", "text-decoration", "white-space",
  "vertical-align", "direction", "overflow", "clip", "clip-path",
  "transform", "transform-origin", "color", "fill", "stroke", "stroke-width",
];
const fontData = new Map<string, Promise<string>>();

/** Finite 2x exports, capped before SVG decoding as well as canvas allocation. */
export function formulaPngDimensions(width: number, height: number): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("Formula has invalid dimensions");
  }
  const scale = Math.min(2, 8192 / width, 8192 / height, Math.sqrt(16_000_000 / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

function weight(value: string): string {
  return value === "normal" ? "400" : value === "bold" ? "700" : value;
}

function family(value: string): string {
  return value.split(",")[0].trim().replace(/^["']|["']$/g, "");
}

function fontKey(style: CSSStyleDeclaration): string {
  return `${family(style.fontFamily)}|${weight(style.fontWeight)}|${style.fontStyle}`;
}

async function asDataUrl(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Formula font could not be read"));
    reader.readAsDataURL(blob);
  });
}

async function embedFont(url: string): Promise<string> {
  let pending = fontData.get(url);
  if (!pending) {
    pending = fetch(url).then(async (response) => {
      if (!response.ok) throw new Error("Formula font could not be loaded");
      return await asDataUrl(await response.blob());
    });
    fontData.set(url, pending);
  }
  try {
    return await pending;
  } catch (error) {
    fontData.delete(url);
    throw error;
  }
}

async function embeddedFonts(wanted: Set<string>): Promise<string> {
  const faces = new Map<string, { style: CSSStyleDeclaration; base: string }>();
  function visit(rules: CSSRuleList, base: string): void {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSFontFaceRule && wanted.has(fontKey(rule.style))) {
        faces.set(fontKey(rule.style), { style: rule.style, base });
      } else if ("cssRules" in rule) {
        visit((rule as CSSGroupingRule).cssRules, base);
      }
    }
  }
  for (const sheet of Array.from(document.styleSheets)) {
    try { visit(sheet.cssRules, sheet.href ?? document.baseURI); } catch { /* Foreign sheets do not own KaTeX's fonts. */ }
  }
  const declarations = (await Promise.all(Array.from(wanted, async (key) => {
    const face = faces.get(key);
    if (!face) throw new Error("Formula font definition is unavailable");
    const source = /url\(["']?([^"')]+)["']?\)\s*format\(["']?woff2["']?\)/i.exec(face.style.getPropertyValue("src"));
    if (!source) throw new Error("Formula font source is unavailable");
    const data = await embedFont(new URL(source[1], face.base).href);
    return `@font-face{font-family:${JSON.stringify(family(face.style.fontFamily))};font-weight:${face.style.fontWeight};font-style:${face.style.fontStyle};src:url(${JSON.stringify(data)}) format("woff2");}`;
  }))).join("\n");
  // The HTML clipboard carries actual font files, so retain their notice in
  // the exported stylesheet as well as the application's bundled disclosures.
  return `/* KaTeX fonts: Copyright (c) 2018 Khan Academy.\n${katexLicense}\n*/\n${declarations}`;
}

function equationNumbers(formula: HTMLElement): Map<Element, string> {
  const numbers = new Map<Element, string>();
  if (!formula.querySelector(".eqn-num, .mml-eqn-num")) return numbers;
  // KaTeX's shipped CSS resets two independent counters on body, not on
  // each formula. Count rendered labels in document order so copying a later
  // equation preserves its current number. This is one scan per export;
  // unnumbered rows and explicit tags have no counter element.
  let html = 0;
  let mathml = 0;
  for (const label of document.querySelectorAll(".katex .eqn-num, .katex .mml-eqn-num")) {
    if (label.getClientRects().length === 0) continue;
    const number = label.classList.contains("eqn-num") ? ++html : ++mathml;
    if (formula.contains(label)) numbers.set(label, `(${number})`);
  }
  return numbers;
}

async function snapshot(formula: HTMLElement): Promise<{ clone: HTMLElement; fonts: string }> {
  await document.fonts.ready;
  if (!formula.isConnected) throw new Error("Formula changed before export");
  const originals = [formula, ...Array.from(formula.querySelectorAll<HTMLElement | SVGElement>("*"))];
  if (originals.length > 4096) throw new Error("Formula is too large to export");
  const clone = formula.cloneNode(true) as HTMLElement;
  const copies = [clone, ...Array.from(clone.querySelectorAll<HTMLElement | SVGElement>("*"))];
  const ink = getComputedStyle(formula).color;
  const fonts = new Set<string>();
  const explicitlyColored = new Set<Element>();
  const numbers = equationNumbers(formula);
  for (let index = 0; index < originals.length; index++) {
    const original = originals[index];
    const style = getComputedStyle(original);
    const copy = copies[index];
    const preserveColor = Boolean(original.style.color) || explicitlyColored.has(original.parentElement!);
    if (preserveColor) explicitlyColored.add(original);
    for (const property of STYLE_PROPERTIES) {
      const value = style.getPropertyValue(property);
      // Use dark ink for documents without baking the app's theme background
      // into the export. Explicit TeX colors remain intact.
      const themeInk = !preserveColor && value === ink
        && (property.endsWith("color") || property === "fill" || property === "stroke");
      copy.style.setProperty(property, themeInk ? "black" : value);
    }
    if (family(style.fontFamily).startsWith("KaTeX_")) fonts.add(fontKey(style));
    const number = numbers.get(original);
    if (number) {
      // Materialize generated content and remove its counter class to avoid
      // counting or drawing it twice when measured inside the live document.
      copy.classList.remove("eqn-num", "mml-eqn-num");
      if (original.namespaceURI === "http://www.w3.org/1998/Math/MathML") {
        const text = document.createElementNS(original.namespaceURI, "mtext");
        text.textContent = number;
        copy.append(text);
      } else { copy.textContent = number; }
    }
  }
  clone.style.display = "inline-block";
  clone.style.position = "relative";
  clone.style.margin = "0";
  clone.style.width = "max-content";
  clone.style.minWidth = "0";
  clone.style.maxWidth = "none";
  clone.style.textAlign = "left";
  clone.style.whiteSpace = "nowrap";
  clone.style.background = "transparent";
  const visual = clone.querySelector<HTMLElement>(".katex-html");
  if (visual) {
    visual.style.display = "inline-block";
    visual.style.width = "max-content";
    visual.style.maxWidth = "none";
    visual.style.textAlign = "left";
    // Tags are positioned against the full display width in the transcript.
    // Put their existing vertical layout into the tight export's normal flow
    // instead of freezing an offset hundreds of pixels beyond the formula.
    for (const tag of visual.querySelectorAll<HTMLElement>(":scope > .katex-tag")) {
      clone.style.height = "auto";
      visual.style.height = "auto";
      tag.style.display = "inline-block";
      tag.style.position = "static";
      tag.style.inset = "auto";
      tag.style.marginLeft = "1em";
    }
  }
  return { clone, fonts: await embeddedFonts(fonts) };
}

export async function formulaToHtml(formula: HTMLElement): Promise<string> {
  const { clone, fonts } = await snapshot(formula);
  const container = document.createElement("div");
  const style = document.createElement("style");
  style.textContent = fonts;
  container.append(style, clone);
  return container.innerHTML;
}

export async function formulaToPng(formula: HTMLElement): Promise<string> {
  const { clone, fonts } = await snapshot(formula);
  clone.querySelector(".katex-mathml")?.remove();
  const visual = clone.querySelector<HTMLElement>(".katex-html");
  if (!visual) throw new Error("Formula rendering is unavailable");
  // An inline span's own rect can omit tall fractions. An inline-block takes
  // KaTeX's strut into account, including both ascenders and descenders.
  visual.style.display = "inline-block";
  const measurement = document.createElement("div");
  measurement.style.cssText = "position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;width:max-content";
  measurement.append(clone);
  document.body.append(measurement);
  let width: number;
  let height: number;
  try {
    const rect = clone.getBoundingClientRect();
    width = Math.ceil(rect.width) + 8;
    height = Math.ceil(rect.height) + 8;
  } finally { measurement.remove(); }
  const size = formulaPngDimensions(width, height);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", String(size.width));
  svg.setAttribute("height", String(size.height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const foreign = document.createElementNS(svg.namespaceURI, "foreignObject");
  foreign.setAttribute("width", String(width));
  foreign.setAttribute("height", String(height));
  const content = document.createElement("div");
  content.style.cssText = "display:inline-block;padding:4px;margin:0;background:transparent";
  const style = document.createElement("style");
  style.textContent = fonts;
  content.append(style, clone);
  foreign.append(content);
  svg.append(foreign);
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Formula image rendering is unavailable");
    context.drawImage(image, 0, 0, size.width, size.height);
    return canvas.toDataURL("image/png");
  } finally { canvas.width = 0; canvas.height = 0; }
}
