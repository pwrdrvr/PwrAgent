/**
 * Images in text copied out of Linear.
 *
 * Linear's "copy as prompt" wraps each image in a `<linear-image>` tag holding
 * the editor's image node as JSON. Its `src` is an `uploads.linear.app` URL
 * with a `signature` that expires five minutes after the copy, so the link in
 * a pasted prompt is almost always dead by the time anything reads it. The
 * same file is still readable through the Linear MCP's `extract_images`,
 * which authenticates as the signed-in account and ignores the signature.
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
  /** The image's name in Linear, when the paste carried one. */
  alt?: string;
};

const LINEAR_IMAGE_TAG = /<linear-image\b[^>]*>([\s\S]*?)<\/linear-image>/g;
const LINEAR_UPLOAD_URL = /^https:\/\/uploads\.linear\.app(\/[A-Za-z0-9._~%/-]*)(?:[?#]\S*)?$/i;
const LINEAR_MCP_URL = /^https:\/\/mcp\.linear\.app(?:[/?#]|$)/i;
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
    const url = normalizeLinearUploadUrl(match[2] ?? "");
    if (!url) continue;
    const alt = normalizeAlt(match[1]);
    found.push({ url, ...(alt ? { alt } : {}), index: match.index ?? 0 });
  }
  found.sort((left, right) => left.index - right.index);
  const seen = new Set<string>();
  const images: LinearPastedImage[] = [];
  for (const { index: _index, ...image } of found) {
    if (seen.has(image.url)) continue;
    seen.add(image.url);
    images.push(image);
    if (images.length >= LINEAR_PASTED_IMAGE_LIMIT) break;
  }
  return images;
}

/**
 * An `uploads.linear.app` URL reduced to its file identity, or `undefined`
 * for any other URL. The signature is dropped: it only ever grants five
 * minutes, and the MCP does not need it.
 */
export function normalizeLinearUploadUrl(value: string): string | undefined {
  // Hand-parsed: this package runs without DOM or Node globals, so no `URL`.
  // The authority must be exactly the host, so a port, a user name, or a
  // longer host such as `uploads.linear.app.example` does not match.
  const match = LINEAR_UPLOAD_URL.exec(value.trim());
  const path = match?.[1];
  if (!path || path === "/") return undefined;
  return `https://${LINEAR_UPLOADS_HOSTNAME}${path}`;
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
  const url = normalizeLinearUploadUrl(src);
  if (!url) return undefined;
  const name = normalizeAlt(alt);
  return { url, ...(name ? { alt: name } : {}) };
}

function normalizeAlt(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 120) : undefined;
}
