import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ImagePart, ModelMessage, TextPart, UserModelMessage } from "ai";
import type { AppServerTurnInputItem } from "../app-server/protocol.js";

export type AiSdkMessageHistoryEntry = {
  role: "user" | "assistant";
  text: string;
};

export async function buildAiSdkMessages(params: {
  history?: AiSdkMessageHistoryEntry[];
  input: AppServerTurnInputItem[];
}): Promise<ModelMessage[]> {
  const messages: ModelMessage[] = [];
  for (const message of params.history ?? []) {
    const text = message.text.trim();
    if (!text) {
      continue;
    }
    messages.push({
      role: message.role,
      content: text,
    });
  }

  const content: Array<TextPart | ImagePart> = [];
  for (const item of params.input) {
    if (item.type === "text") {
      content.push({ type: "text", text: item.text });
      continue;
    }
    if (item.type === "image") {
      content.push(parseImageUrl(item.url));
      continue;
    }
    content.push(await readLocalImage(item.path));
  }

  if (content.length === 0) {
    throw new Error("Grok turns require at least one input item");
  }
  messages.push({
    role: "user",
    content,
  } satisfies UserModelMessage);
  return messages;
}

function parseImageUrl(url: string): ImagePart {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("image input requires an absolute URL or data URL");
  }
  if (parsed.protocol === "file:") {
    throw new Error("file:// image URLs are not accessible to xAI; use localImage instead");
  }
  if (!["http:", "https:", "data:"].includes(parsed.protocol)) {
    throw new Error(`Unsupported image URL protocol: ${parsed.protocol}`);
  }
  if (parsed.protocol === "data:") {
    const mediaType = mediaTypeFromDataUrl(url);
    if (!mediaType || !isSupportedImageMediaType(mediaType)) {
      throw new Error(
        "image data URLs must be normalized to image/jpeg or image/png before provider submission",
      );
    }
  }
  return {
    type: "image",
    image: parsed,
    mediaType: parsed.protocol === "data:" ? mediaTypeFromDataUrl(url) : undefined,
  };
}

async function readLocalImage(filePath: string): Promise<ImagePart> {
  const mediaType = mediaTypeForImagePath(filePath);
  const data = await readFile(filePath).catch((error: unknown) => {
    throw new Error(
      `Unable to read local image ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  return {
    type: "image",
    image: data,
    mediaType,
  };
}

function mediaTypeFromDataUrl(url: string): string | undefined {
  const match = /^data:([^;,]+)[;,]/i.exec(url);
  const mediaType = match?.[1]?.toLowerCase();
  return mediaType === "image/jpg" ? "image/jpeg" : mediaType;
}

function mediaTypeForImagePath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    default:
      throw new Error(
        `Unsupported local image type for ${filePath}; normalize images to JPEG or PNG before provider submission`,
      );
  }
}

function isSupportedImageMediaType(mediaType: string): boolean {
  return mediaType === "image/jpeg" || mediaType === "image/jpg" || mediaType === "image/png";
}
