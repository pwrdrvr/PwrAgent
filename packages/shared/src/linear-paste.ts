/**
 * Images in text copied out of Linear.
 *
 * Linear's "copy as prompt" wraps each image in a `<linear-image>` tag holding
 * the editor's image node as JSON. Its `src` is an `uploads.linear.app` URL
 * with a `signature` that expires five minutes after the copy. Within those
 * five minutes the signed link alone fetches the file. After that, the same
 * file is still readable through the Linear MCP's `extract_images`, which
 * authenticates as the signed-in account and ignores the signature.
 *
 * Plain Markdown images pointing at `uploads.linear.app` are found too: that
 * is how a description copied as Markdown carries them.
 */

export const LINEAR_UPLOADS_HOSTNAME = "uploads.linear.app";
export const LINEAR_MCP_HOSTNAME = "mcp.linear.app";
/** At most this many images are fetched for one paste. */
export const LINEAR_PASTED_IMAGE_LIMIT = 10;

export type LinearPastedImage = {
  /** The upload URL without its query or fragment: the stable file identity. */
  url: string;
  /** `url` with the paste's `signature`, when it carried one. */
  signedUrl?: string;
  /** The image's name in Linear, when the paste carried one. */
  alt?: string;
};

const LINEAR_IMAGE_TAG = /<linear-image\b[^>]*>([\s\S]*?)<\/linear-image>/g;
const LINEAR_UPLOAD_URL = /^https:\/\/uploads\.linear\.app(\/[A-Za-z0-9._~%/-]*)(?:[?#]\S*)?$/i;
const LINEAR_MCP_URL = /^https:\/\/mcp\.linear\.app(?:[/?#]|$)/i;
const SIGNATURE_PARAM = /[?&]signature=([A-Za-z0-9._-]{1,4096})(?:[&#]|$)/;
const MARKDOWN_IMAGE = /!\[([^\]\n]{0,300})\]\((https:\/\/uploads\.linear\.app\/[^\s)]+)\)/g;

/** Whether a pasted string may carry a Linear image. Cheap enough per paste. */
export function mayContainLinearPastedImages(text: string): boolean {
  return text.includes("<linear-image") || text.includes(LINEAR_UPLOADS_HOSTNAME);
}

/**
 * The Linear images in a pasted string, in order, without duplicates, capped
 * at {@link LINEAR_PASTED_IMAGE_LIMIT}. Anything that is not an
 * `https://uploads.linear.app/...` URL is ignored.
 */
export function findLinearPastedImages(text: string): LinearPastedImage[] {
  if (!mayContainLinearPastedImages(text)) return [];
  const found: Array<LinearPastedImage & { index: number }> = [];
  for (const match of text.matchAll(LINEAR_IMAGE_TAG)) {
    const image = parseLinearImageNode(match[1] ?? "");
    if (image) found.push({ ...image, index: match.index ?? 0 });
  }
  for (const match of text.matchAll(MARKDOWN_IMAGE)) {
    const upload = parseLinearUploadUrl(match[2] ?? "");
    if (!upload) continue;
    const alt = normalizeAlt(match[1]);
    found.push({ ...upload, ...(alt ? { alt } : {}), index: match.index ?? 0 });
  }
  found.sort((left, right) => left.index - right.index);
  const byUrl = new Map<string, LinearPastedImage>();
  const images: LinearPastedImage[] = [];
  for (const { index: _index, ...image } of found) {
    const earlier = byUrl.get(image.url);
    if (earlier) {
      // A later copy of the same file may carry the signature the first lacked.
      if (!earlier.signedUrl && image.signedUrl) earlier.signedUrl = image.signedUrl;
      continue;
    }
    if (images.length >= LINEAR_PASTED_IMAGE_LIMIT) continue;
    byUrl.set(image.url, image);
    images.push(image);
  }
  return images;
}

/**
 * An `uploads.linear.app` URL reduced to its file identity, or `undefined`
 * for any other URL. The signature is dropped: it only ever grants five
 * minutes, and the MCP does not need it.
 */
export function normalizeLinearUploadUrl(value: string): string | undefined {
  return parseLinearUploadUrl(value)?.url;
}

function parseLinearUploadUrl(
  value: string,
): Pick<LinearPastedImage, "url" | "signedUrl"> | undefined {
  // Hand-parsed: this package runs without DOM or Node globals, so no `URL`.
  // The authority must be exactly the host, so a port, a user name, or a
  // longer host such as `uploads.linear.app.example` does not match.
  const trimmed = value.trim();
  const match = LINEAR_UPLOAD_URL.exec(trimmed);
  const path = match?.[1];
  if (!path || path === "/") return undefined;
  const url = `https://${LINEAR_UPLOADS_HOSTNAME}${path}`;
  // The pattern is anchored, so the query starts right after the path.
  const rest = trimmed.slice(`https://${LINEAR_UPLOADS_HOSTNAME}`.length + path.length);
  const query = rest.startsWith("?") ? rest.split("#")[0]! : "";
  const signature = SIGNATURE_PARAM.exec(query)?.[1];
  return signature ? { url, signedUrl: `${url}?signature=${signature}` } : { url };
}

/** Whether an MCP connection's server URL is Linear's hosted MCP server. */
export function isLinearMcpServerUrl(value: string): boolean {
  return LINEAR_MCP_URL.test(value.trim());
}

function parseLinearImageNode(json: string): LinearPastedImage | undefined {
  let node: unknown;
  try {
    node = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!node || typeof node !== "object") return undefined;
  const attrs = (node as { attrs?: unknown }).attrs;
  if (!attrs || typeof attrs !== "object") return undefined;
  const { src, alt } = attrs as { src?: unknown; alt?: unknown };
  if (typeof src !== "string") return undefined;
  const upload = parseLinearUploadUrl(src);
  if (!upload) return undefined;
  const name = normalizeAlt(alt);
  return { ...upload, ...(name ? { alt: name } : {}) };
}

function normalizeAlt(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 120) : undefined;
}

/** One run of a pasted Linear description: Markdown, or an image Linear named. */
export type LinearPastePiece =
  | { type: "markdown"; text: string }
  | { type: "image"; name?: string };

/** What Linear's copy-as-prompt `<issue>` wrapper says about the issue. */
export type LinearPastedIssue = {
  identifier?: string;
  title?: string;
  team?: string;
  project?: string;
  labels: string[];
};

/**
 * A message holding text copied from Linear, laid out for display: the
 * issue's header when the text carries Linear's `<issue>` wrapper, and the
 * description with each `<linear-image>` as its own piece. `before` and
 * `after` are whatever the operator typed around the paste.
 */
export type LinearPasteLayout = {
  before: string;
  issue?: LinearPastedIssue;
  body: LinearPastePiece[];
  after: string;
};

const ISSUE_OPEN_TAG = /<issue[\s>]/;
const ISSUE_ELEMENT = /<issue(\s[^>]*)?>([\s\S]*?)<\/issue>/;
const CODE_FENCE_LINE = /^ {0,3}(?:```|~~~)/gm;
const EMPTY_ELEMENT = /<([a-z][\w-]*)\b[^>]*>\s*<\/\1>/gi;
const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: '"',
};

/**
 * The display layout of text pasted from Linear, or `undefined` for text
 * that is not one or whose wrapper is malformed. Those render as they are.
 * Nothing here is HTML: each value is plain text or Markdown for the
 * renderer's own Markdown pipeline.
 */
export function parseLinearPaste(text: string): LinearPasteLayout | undefined {
  const hasIssue = ISSUE_OPEN_TAG.test(text);
  if (!hasIssue && !text.includes("<linear-image")) return undefined;
  if (!hasIssue) {
    // Tags quoted as code are about Linear, not from it.
    for (const tag of text.matchAll(LINEAR_IMAGE_TAG)) {
      if (isQuotedAsCode(text, tag.index ?? 0)) return undefined;
    }
    const body = splitLinearDescription(text);
    return body.some((piece) => piece.type === "image")
      ? { before: "", body, after: "" }
      : undefined;
  }
  const match = ISSUE_ELEMENT.exec(text);
  if (!match || isQuotedAsCode(text, match.index)) return undefined;
  const start = match.index;
  const end = start + match[0].length;
  // A second wrapper is more than one issue; leave it as it is.
  if (ISSUE_OPEN_TAG.test(text.slice(end))) return undefined;

  let inner = match[2] ?? "";
  const take = (name: string): ElementMatch | undefined => {
    const element = findElement(inner, name);
    if (element) inner = inner.slice(0, element.start) + inner.slice(element.end);
    return element;
  };
  const title = take("title");
  const description = take("description");
  const team = take("team");
  const project = take("project");
  const labels: string[] = [];
  for (let label = take("label"); label; label = take("label")) {
    const name = elementText(label);
    if (name) labels.push(name);
  }
  const identifier = readAttribute(match[1] ?? "", "identifier");
  const issue: LinearPastedIssue = {
    ...(identifier ? { identifier } : {}),
    ...(title && elementText(title) ? { title: elementText(title) } : {}),
    ...(team && elementText(team) ? { team: elementText(team) } : {}),
    ...(project && elementText(project) ? { project: elementText(project) } : {}),
    labels,
  };
  if (!issue.identifier && !issue.title) return undefined;

  const body = description ? splitLinearDescription(description.content) : [];
  // Anything else Linear wrote (comments, a status) stays visible as it is.
  const rest = inner.replace(EMPTY_ELEMENT, "").trim();
  if (rest) body.push({ type: "markdown", text: rest });
  return {
    before: text.slice(0, start).trim(),
    issue,
    body,
    after: text.slice(end).trim(),
  };
}

/** Whether `index` falls in a fenced code block, or right after a backtick. */
function isQuotedAsCode(text: string, index: number): boolean {
  if (text[index - 1] === "`") return true;
  const fences = text.slice(0, index).match(CODE_FENCE_LINE)?.length ?? 0;
  return fences % 2 === 1;
}

type ElementMatch = { attributes: string; content: string; start: number; end: number };

/**
 * The first `<name ...>content</name>` or `<name ... />`. Plain string
 * scanning: these are the few fixed tags Linear writes, not general XML.
 */
function findElement(source: string, name: string): ElementMatch | undefined {
  const open = new RegExp(`<${name}\\b([^>]*?)(/?)>`).exec(source);
  if (!open) return undefined;
  const start = open.index;
  const afterOpen = start + open[0].length;
  if (open[2] === "/") {
    return { attributes: open[1] ?? "", content: "", start, end: afterOpen };
  }
  const close = source.indexOf(`</${name}>`, afterOpen);
  if (close < 0) return undefined;
  return {
    attributes: open[1] ?? "",
    content: source.slice(afterOpen, close),
    start,
    end: close + name.length + 3,
  };
}

/** An element's `name` attribute, else its text, on one line. */
function elementText(element: ElementMatch): string {
  const value = readAttribute(element.attributes, "name") ?? decodeXmlEntities(element.content);
  return value.replace(/\s+/g, " ").trim().slice(0, 300);
}

function readAttribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attributes);
  const value = match ? decodeXmlEntities(match[1] ?? "").trim() : "";
  return value || undefined;
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(amp|apos|gt|lt|quot|#\d{1,6}|#x[\da-f]{1,6});/gi, (entity, name: string) => {
    const lower = name.toLowerCase();
    if (lower.startsWith("#")) {
      const code = lower.startsWith("#x")
        ? Number.parseInt(lower.slice(2), 16)
        : Number.parseInt(lower.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return XML_ENTITIES[lower] ?? entity;
  });
}

/** A description split around its `<linear-image>` tags. */
function splitLinearDescription(source: string): LinearPastePiece[] {
  const pieces: LinearPastePiece[] = [];
  const pushMarkdown = (value: string) => {
    const trimmed = value.replace(/^\s*\n/, "").trimEnd();
    if (trimmed.trim()) pieces.push({ type: "markdown", text: trimmed });
  };
  let cursor = 0;
  for (const match of source.matchAll(LINEAR_IMAGE_TAG)) {
    const index = match.index ?? 0;
    pushMarkdown(source.slice(cursor, index));
    const name = readLinearImageName(match[1] ?? "");
    pieces.push(name ? { type: "image", name } : { type: "image" });
    cursor = index + match[0].length;
  }
  pushMarkdown(source.slice(cursor));
  return pieces;
}

function readLinearImageName(json: string): string | undefined {
  try {
    const node = JSON.parse(json) as { attrs?: { alt?: unknown } } | null;
    return normalizeAlt(node?.attrs?.alt);
  } catch {
    return undefined;
  }
}
