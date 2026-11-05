import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  findLinearPastedImages,
  type FetchLinearPastedImagesResponse,
  type LinearPastedImage,
  type LinearPastedImageData,
} from "@pwragent/shared";
import type { SandboxerCleanupTransport } from "./sandboxer-pr-cleanup";

/**
 * Fetch the images in text pasted from Linear. Loaded on the first paste that
 * carries a Linear image.
 *
 * Each image link carries a signature that expires five minutes after the
 * copy. While it is valid, the signed link alone fetches the file, so a paste
 * made right after the copy needs no Linear connection. Anything left over is
 * read through Linear's own MCP tool, `extract_images`, which authenticates
 * as the signed-in account whatever the signature says.
 *
 * The direct fetch only ever runs for a link the operator pasted, never for
 * text an agent wrote. It sends no credentials, follows no redirects, reaches
 * exactly `uploads.linear.app`, and keeps only bytes that are a raster image.
 */

const EXTRACT_IMAGES_TOOL = "extract_images";
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Matches the composer's own ceiling on a pasted image before it resizes. */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;
const DIRECT_FETCH_TIMEOUT_MS = 15_000;
/** A signature this close to expiring is left to the MCP. */
const SIGNATURE_EXPIRY_MARGIN_MS = 10_000;

export type LinearPastedImagesOptions = {
  /** The Linear connections to try in order, or `undefined` when the setting is off. */
  connectionIds: string[] | undefined;
  openSession: (params: {
    connectionId: string;
    scopeKey: string;
    signal: AbortSignal;
  }) => Promise<Pick<SandboxerCleanupTransport, "callTool" | "close">>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  timeoutMs?: number;
};

export async function fetchLinearPastedImages(
  text: string,
  options: LinearPastedImagesOptions,
): Promise<FetchLinearPastedImagesResponse> {
  const images = findLinearPastedImages(text);
  if (images.length === 0) return { status: "fetched", images: [], failed: 0 };
  if (!options.connectionIds) return { status: "disabled" };

  const signal = AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS);
  const results: Array<LinearPastedImageData | undefined> = await Promise.all(
    images.map(async (image, index) =>
      await fetchSignedImage(image, index, options, signal).catch(() => undefined)
    ),
  );
  const remaining = images.flatMap((image, index) => (results[index] ? [] : [{ image, index }]));
  let failure: string | undefined;
  if (remaining.length > 0 && options.connectionIds.length > 0 && !signal.aborted) {
    const viaMcp = await fetchThroughConnections(
      remaining.map((entry) => entry.image),
      options.connectionIds,
      options,
      signal,
    );
    if ("images" in viaMcp) {
      viaMcp.images.forEach((data, position) => {
        if (data) results[remaining[position]!.index] = data;
      });
    } else {
      failure = viaMcp.message;
    }
  }

  const fetched = results.filter((data): data is LinearPastedImageData => data !== undefined);
  if (fetched.length > 0) {
    const failed = images.length - fetched.length;
    return {
      status: "fetched",
      images: fetched,
      failed,
      ...(failed > 0 && options.connectionIds.length === 0 ? { needsConnection: true } : {}),
    };
  }
  if (options.connectionIds.length === 0) return { status: "unavailable" };
  return { status: "failed", message: failure ?? "Linear returned no images." };
}

/** The pasted signed link, fetched as it is, while its signature is valid. */
async function fetchSignedImage(
  image: LinearPastedImage,
  index: number,
  options: LinearPastedImagesOptions,
  signal: AbortSignal,
): Promise<LinearPastedImageData | undefined> {
  if (!image.signedUrl) return undefined;
  const claims = readSignatureClaims(image.signedUrl);
  const now = options.now?.() ?? Date.now();
  if (!claims || claims.expiresAt - SIGNATURE_EXPIRY_MARGIN_MS <= now) return undefined;
  // The signature names the file it grants; one for another file is not used.
  if (claims.path !== new URL(image.url).pathname) return undefined;

  // Main's fetch keeps no cookie jar and sends no referrer.
  const response = await (options.fetch ?? globalThis.fetch)(image.signedUrl, {
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(DIRECT_FETCH_TIMEOUT_MS)]),
  });
  if (!response.ok || !response.body) return undefined;
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_IMAGE_BYTES) return undefined;
  const bytes = await readCapped(response.body, MAX_IMAGE_BYTES);
  if (!bytes) return undefined;
  // Trust the bytes, not the header.
  const mimeType = sniffImageType(bytes);
  if (!mimeType) return undefined;
  return {
    name: imageName(image, index, mimeType),
    mimeType,
    dataBase64: Buffer.from(bytes).toString("base64"),
  };
}

/**
 * The `path` and `exp` claims of a Linear upload signature. The signature is
 * not verified here: Linear does that. These only decide whether a request is
 * worth making.
 */
function readSignatureClaims(signedUrl: string): { path: string; expiresAt: number } | undefined {
  const token = new URL(signedUrl).searchParams.get("signature");
  const payload = token?.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      path?: unknown;
      exp?: unknown;
    };
    if (typeof claims.path !== "string" || typeof claims.exp !== "number") return undefined;
    return { path: claims.path, expiresAt: claims.exp * 1000 };
  } catch {
    return undefined;
  }
}

async function readCapped(
  body: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array | undefined> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function sniffImageType(bytes: Uint8Array): string | undefined {
  const startsWith = (signature: number[], at = 0) =>
    signature.every((byte, offset) => bytes[at + offset] === byte);
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith([0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  return undefined;
}

function imageName(image: LinearPastedImage, index: number, mimeType: string): string {
  return (image.alt ?? `linear-image-${index + 1}.${mimeType.split("/")[1]}`).slice(0, 120);
}

/**
 * The given images through `extract_images`, one result slot per image. A
 * file belongs to one workspace, and nothing in its URL names the connection
 * signed in to it, so each Linear connection gets a turn.
 */
async function fetchThroughConnections(
  images: LinearPastedImage[],
  connectionIds: string[],
  options: LinearPastedImagesOptions,
  signal: AbortSignal,
): Promise<{ images: Array<LinearPastedImageData | undefined> } | { message: string }> {
  let lastError: unknown;
  for (const connectionId of connectionIds) {
    let session: Awaited<ReturnType<LinearPastedImagesOptions["openSession"]>> | undefined;
    try {
      session = await options.openSession({
        connectionId,
        scopeKey: JSON.stringify(["pwragent-linear-paste"]),
        signal,
      });
      const result = await session.callTool(EXTRACT_IMAGES_TOOL, {
        markdown: images.map(toMarkdown).join("\n"),
      });
      const fetched = readImages(result, images);
      if (fetched.some(Boolean)) return { images: fetched };
      lastError = new Error(readText(result) || "Linear returned no images.");
    } catch (error) {
      lastError = error;
    } finally {
      try {
        await session?.close();
      } catch {
        // The registration is already gone; nothing else holds it.
      }
    }
    if (signal.aborted) break;
  }
  return { message: lastError instanceof Error ? lastError.message : String(lastError) };
}

function toMarkdown(image: LinearPastedImage, index: number): string {
  // The name only labels the tool's answer; keep Markdown syntax out of it.
  const label = (image.alt ?? `image-${index + 1}`).replace(/[[\]()\\]/g, "");
  return `![${label}](${image.url})`;
}

/**
 * The tool answers with a text block naming each image ("Image: <name>")
 * before the image block itself, in request order. A name the tool does not
 * give falls back to the pasted one. One slot per requested image.
 */
function readImages(
  result: CallToolResult,
  requested: LinearPastedImage[],
): Array<LinearPastedImageData | undefined> {
  const images: Array<LinearPastedImageData | undefined> = requested.map(() => undefined);
  if (result.isError) return images;
  let seen = 0;
  let pendingName: string | undefined;
  for (const block of result.content ?? []) {
    if (block.type === "text") {
      const match = /^Image:\s*(.+)$/m.exec(block.text);
      if (match) pendingName = match[1]!.trim();
      continue;
    }
    if (block.type !== "image") continue;
    const mimeType = block.mimeType.toLowerCase();
    const index = seen;
    seen += 1;
    const name = pendingName ?? requested[index]?.alt ?? `linear-image-${index + 1}`;
    pendingName = undefined;
    if (
      IMAGE_MIME_TYPES.has(mimeType)
      // Base64 carries 3 bytes in every 4 characters.
      && (block.data.length * 3) / 4 <= MAX_IMAGE_BYTES
    ) {
      images[index] = { name: name.slice(0, 120), mimeType, dataBase64: block.data };
    }
    if (seen >= requested.length) break;
  }
  return images;
}

function readText(result: CallToolResult): string {
  return (result.content ?? [])
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join(" ")
    .slice(0, 300);
}
