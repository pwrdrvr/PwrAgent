import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  findLinearPastedImages,
  type FetchLinearPastedImagesResponse,
  type LinearPastedImage,
  type LinearPastedImageData,
} from "@pwragent/shared";
import type { SandboxerCleanupTransport } from "./sandboxer-pr-cleanup";

/**
 * Fetch the images in text pasted from Linear.
 *
 * The URL in a paste carries a signature that expires five minutes after the
 * copy, so it is never fetched directly. Linear's own MCP tool,
 * `extract_images`, reads the same file as the signed-in account whatever the
 * signature says. Loaded on the first paste that carries a Linear image.
 */

const EXTRACT_IMAGES_TOOL = "extract_images";
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Matches the composer's own ceiling on a pasted image before it resizes. */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;

export type LinearPastedImagesOptions = {
  /** The Linear connections to try in order, or `undefined` when the setting is off. */
  connectionIds: string[] | undefined;
  openSession: (params: {
    connectionId: string;
    scopeKey: string;
    signal: AbortSignal;
  }) => Promise<Pick<SandboxerCleanupTransport, "callTool" | "close">>;
  timeoutMs?: number;
};

export async function fetchLinearPastedImages(
  text: string,
  options: LinearPastedImagesOptions,
): Promise<FetchLinearPastedImagesResponse> {
  const images = findLinearPastedImages(text);
  if (images.length === 0) return { status: "fetched", images: [], failed: 0 };
  if (!options.connectionIds) return { status: "disabled" };
  if (options.connectionIds.length === 0) return { status: "unavailable" };

  const signal = AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS);
  let lastError: unknown;
  // A file belongs to one workspace, and nothing in its URL names the
  // connection signed in to it, so each Linear connection gets a turn.
  for (const connectionId of options.connectionIds) {
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
      if (fetched.length > 0) {
        return { status: "fetched", images: fetched, failed: images.length - fetched.length };
      }
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
  return {
    status: "failed",
    message: lastError instanceof Error ? lastError.message : String(lastError),
  };
}

function toMarkdown(image: LinearPastedImage, index: number): string {
  // The name only labels the tool's answer; keep Markdown syntax out of it.
  const label = (image.alt ?? `image-${index + 1}`).replace(/[[\]()\\]/g, "");
  return `![${label}](${image.url})`;
}

/**
 * The tool answers with a text block naming each image ("Image: <name>")
 * before the image block itself. Images arrive in request order; a name the
 * tool does not give falls back to the pasted one.
 */
function readImages(
  result: CallToolResult,
  requested: LinearPastedImage[],
): LinearPastedImageData[] {
  if (result.isError) return [];
  const images: LinearPastedImageData[] = [];
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
    if (!IMAGE_MIME_TYPES.has(mimeType)) continue;
    // Base64 carries 3 bytes in every 4 characters.
    if ((block.data.length * 3) / 4 > MAX_IMAGE_BYTES) continue;
    images.push({ name: name.slice(0, 120), mimeType, dataBase64: block.data });
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
