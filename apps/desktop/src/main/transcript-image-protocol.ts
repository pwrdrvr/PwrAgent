import { protocol } from "electron";
import type {
  AppServerBackendKind,
  AppServerReadThreadResponse,
  AppServerThreadEntry,
  AppServerThreadImagePart,
  AppServerThreadMessage,
  AppServerThreadMessageEntry,
  AppServerThreadMessagePart,
} from "@pwragent/shared";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveActiveProfilePath, resolvePwragentRoot } from "./profile";
import { resolveDefaultCodexHome } from "@pwrdrvr/codex-discovery";

export const TRANSCRIPT_IMAGE_PROTOCOL_SCHEME = "pwragent-image";

const IMAGE_MIME_TYPES = new Map<string, string>([
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

const DATA_IMAGE_EXTENSIONS = new Map<string, string>([
  ["image/avif", "avif"],
  ["image/bmp", "bmp"],
  ["image/gif", "gif"],
  ["image/jpeg", "jpg"],
  ["image/jpg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

const MARKDOWN_LINKED_IMAGE_PATTERN = /!?\[([^\]\r\n]*)\]\(\s*(?:<([^>\r\n]+)>|([^\s)]+))[^)]*\)/g;

export type TranscriptImageProtocolOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

export type TranscriptImageMaterializerDependencies = {
  resolveRoot: (request: {
    backend: AppServerBackendKind;
    threadId: string;
  }) => string;
  mkdir: (dirPath: string, options: { recursive: true }) => Promise<unknown>;
  resolveLocalImageLink: (sourcePath: string) => Promise<TranscriptImageFileResolution>;
  writeFile: (filePath: string, data: Buffer) => Promise<unknown>;
};

export type TranscriptImageFileResolution =
  | { ok: true; path: string; mimeType: string }
  | { ok: false; status: number; message: string };

const defaultMaterializerDependencies: TranscriptImageMaterializerDependencies = {
  resolveRoot: ({ backend, threadId }) =>
    resolveActiveProfilePath(
      path.join(
        "state",
        "thread-images",
        encodePathSegment(backend),
        encodePathSegment(threadId),
      ),
    ),
  mkdir,
  resolveLocalImageLink: resolveTranscriptImageFile,
  writeFile,
};

export function toTranscriptImageProtocolUrl(src: string): string {
  return `pwragent-image://file/${encodeURIComponent(src)}`;
}

export function rewriteTranscriptImageUrlsForRenderer(
  response: AppServerReadThreadResponse,
): AppServerReadThreadResponse {
  return {
    ...response,
    replay: {
      ...response.replay,
      entries: response.replay.entries.map(rewriteTranscriptEntryImageUrls),
      messages: response.replay.messages.map(rewriteTranscriptMessageImageUrls),
    },
  };
}

export async function materializeTranscriptImageUrlsForRenderer(
  response: AppServerReadThreadResponse,
  dependencies: Partial<TranscriptImageMaterializerDependencies> = {},
): Promise<AppServerReadThreadResponse> {
  const deps = { ...defaultMaterializerDependencies, ...dependencies };
  const materializedFileWrites = new Map<string, Promise<void>>();
  const markdownLinkImageResolutions = new Map<
    string,
    Promise<TranscriptImageFileResolution>
  >();

  return {
    ...response,
    replay: {
      ...response.replay,
      entries: await Promise.all(
        response.replay.entries.map((entry) =>
          materializeTranscriptEntryImageUrls(
            entry,
            response,
            deps,
            materializedFileWrites,
            markdownLinkImageResolutions,
          ),
        ),
      ),
      messages: await Promise.all(
        response.replay.messages.map((message) =>
          materializeTranscriptMessageImageUrls(
            message,
            response,
            deps,
            materializedFileWrites,
            markdownLinkImageResolutions,
          ),
        ),
      ),
    },
  };
}

export function registerTranscriptImageProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: TRANSCRIPT_IMAGE_PROTOCOL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
      },
    },
  ]);
}

async function materializeTranscriptEntryImageUrls(
  entry: AppServerThreadEntry,
  response: AppServerReadThreadResponse,
  deps: TranscriptImageMaterializerDependencies,
  materializedFileWrites: Map<string, Promise<void>>,
  markdownLinkImageResolutions: Map<string, Promise<TranscriptImageFileResolution>>,
): Promise<AppServerThreadEntry> {
  if (entry.type !== "message") {
    return entry;
  }

  return (await materializeTranscriptMessageImageUrls(
    entry,
    response,
    deps,
    materializedFileWrites,
    markdownLinkImageResolutions,
  )) as AppServerThreadMessageEntry;
}

async function materializeTranscriptMessageImageUrls<T extends AppServerThreadMessage>(
  message: T,
  response: AppServerReadThreadResponse,
  deps: TranscriptImageMaterializerDependencies,
  materializedFileWrites: Map<string, Promise<void>>,
  markdownLinkImageResolutions: Map<string, Promise<TranscriptImageFileResolution>>,
): Promise<T> {
  const messageWithMarkdownLinkImages = await appendMarkdownLinkImageParts(
    message,
    deps,
    markdownLinkImageResolutions,
  );
  if (
    !messageWithMarkdownLinkImages.parts?.some(
      (part) => part.type === "image" && isMaterializableImageUrl(part.url),
    )
  ) {
    return messageWithMarkdownLinkImages;
  }

  return {
    ...messageWithMarkdownLinkImages,
    parts: await Promise.all(
      messageWithMarkdownLinkImages.parts.map((part) =>
        materializeTranscriptMessagePartImageUrl(
          part,
          response,
          deps,
          materializedFileWrites,
        ),
      ),
    ),
  };
}

async function materializeTranscriptMessagePartImageUrl(
  part: AppServerThreadMessagePart,
  response: AppServerReadThreadResponse,
  deps: TranscriptImageMaterializerDependencies,
  materializedFileWrites: Map<string, Promise<void>>,
): Promise<AppServerThreadMessagePart> {
  if (part.type !== "image") {
    return part;
  }

  if (isFileImageUrl(part.url)) {
    return {
      ...part,
      url: toTranscriptImageProtocolUrl(part.url),
    };
  }

  const dataImage = parseSupportedImageDataUrl(part.url);
  if (!dataImage) {
    return part;
  }

  const root = deps.resolveRoot({
    backend: response.backend,
    threadId: response.threadId,
  });
  try {
    await deps.mkdir(root, { recursive: true });
    const filePath = path.join(root, `${dataImage.sha256}.${dataImage.extension}`);
    let writePromise = materializedFileWrites.get(filePath);
    if (!writePromise) {
      writePromise = deps.writeFile(filePath, dataImage.buffer).then(() => undefined);
      materializedFileWrites.set(filePath, writePromise);
    }
    await writePromise;

    return {
      ...part,
      url: toTranscriptImageProtocolUrl(pathToFileURL(filePath).toString()),
    };
  } catch {
    return part;
  }
}

async function appendMarkdownLinkImageParts<T extends AppServerThreadMessage>(
  message: T,
  deps: TranscriptImageMaterializerDependencies,
  markdownLinkImageResolutions: Map<string, Promise<TranscriptImageFileResolution>>,
): Promise<T> {
  const textParts = message.parts?.filter(
    (part): part is Extract<AppServerThreadMessagePart, { type: "text" }> =>
      part.type === "text",
  ) ?? (message.text ? [{ type: "text", text: message.text }] : []);
  const imageLinks = textParts.flatMap((part) => extractMarkdownLinkedImageParts(part.text));
  if (imageLinks.length === 0) {
    return message;
  }

  const existingParts = message.parts ?? textParts;
  const existingSourceUrls = new Set(
    existingParts.flatMap((part) =>
      part.type === "image"
        ? [part.sourceUrl, isFileImageUrl(part.url) ? part.url : undefined]
        : [],
    ).filter((url): url is string => Boolean(url)),
  );
  const imageParts: AppServerThreadImagePart[] = [];

  for (const imageLink of imageLinks) {
    const resolution = await resolveMarkdownLinkedImage(
      imageLink.sourcePath,
      deps,
      markdownLinkImageResolutions,
    );
    if (!resolution.ok) {
      continue;
    }

    const sourceUrl = pathToFileURL(imageLink.sourcePath).toString();
    if (existingSourceUrls.has(sourceUrl)) {
      continue;
    }
    existingSourceUrls.add(sourceUrl);
    imageParts.push({
      type: "image",
      url: toTranscriptImageProtocolUrl(pathToFileURL(resolution.path).toString()),
      sourceUrl,
      alt: imageLink.alt || path.basename(resolution.path),
    });
  }

  if (imageParts.length === 0) {
    return message;
  }

  return {
    ...message,
    parts: [...existingParts, ...imageParts],
  };
}

function resolveMarkdownLinkedImage(
  sourcePath: string,
  deps: TranscriptImageMaterializerDependencies,
  resolutions: Map<string, Promise<TranscriptImageFileResolution>>,
): Promise<TranscriptImageFileResolution> {
  const existing = resolutions.get(sourcePath);
  if (existing) {
    return existing;
  }

  const resolution = deps.resolveLocalImageLink(sourcePath).catch(() => ({
    ok: false as const,
    status: 500,
    message: "could not resolve Markdown-linked image",
  }));
  resolutions.set(sourcePath, resolution);
  return resolution;
}

function extractMarkdownLinkedImageParts(text: string): Array<{
  alt?: string;
  sourcePath: string;
}> {
  const output: Array<{ alt?: string; sourcePath: string }> = [];
  let fenceMarker: "`" | "~" | undefined;

  for (const line of text.split(/\r?\n/u)) {
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      const marker = fence[0] as "`" | "~";
      if (!fenceMarker) {
        fenceMarker = marker;
      } else if (fenceMarker === marker) {
        fenceMarker = undefined;
      }
      continue;
    }
    if (fenceMarker) {
      continue;
    }

    MARKDOWN_LINKED_IMAGE_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MARKDOWN_LINKED_IMAGE_PATTERN.exec(line))) {
      if (isInsideInlineCode(line, match.index)) {
        continue;
      }

      const sourcePath = localImageLinkPath(match[2] ?? match[3] ?? "");
      if (!sourcePath || !mimeTypeForImagePath(sourcePath)) {
        continue;
      }
      output.push({
        alt: match[1]?.trim() || undefined,
        sourcePath,
      });
    }
  }

  return output;
}

function localImageLinkPath(destination: string): string | undefined {
  const trimmed = destination.trim();
  if (trimmed.startsWith("file://")) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      return undefined;
    }
  }

  if (trimmed.startsWith("/")) {
    return safelyDecodeUriComponent(trimmed);
  }

  if (trimmed.startsWith("~/")) {
    return path.join(os.homedir(), safelyDecodeUriComponent(trimmed.slice(2)));
  }

  return undefined;
}

function safelyDecodeUriComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isInsideInlineCode(line: string, offset: number): boolean {
  let markerLength = 0;
  for (let index = 0; index < offset; index += 1) {
    if (line[index] !== "`" || line[index - 1] === "\\") {
      continue;
    }
    let length = 1;
    while (line[index + length] === "`") {
      length += 1;
    }
    if (markerLength === 0) {
      markerLength = length;
    } else if (markerLength === length) {
      markerLength = 0;
    }
    index += length - 1;
  }
  return markerLength > 0;
}

function rewriteTranscriptEntryImageUrls(entry: AppServerThreadEntry): AppServerThreadEntry {
  if (entry.type !== "message") {
    return entry;
  }

  return rewriteTranscriptMessageImageUrls(entry) as AppServerThreadMessageEntry;
}

function rewriteTranscriptMessageImageUrls<T extends AppServerThreadMessage>(
  message: T,
): T {
  if (!message.parts?.some((part) => part.type === "image" && isFileImageUrl(part.url))) {
    return message;
  }

  return {
    ...message,
    parts: message.parts.map(rewriteTranscriptMessagePartImageUrl),
  };
}

function rewriteTranscriptMessagePartImageUrl(
  part: AppServerThreadMessagePart,
): AppServerThreadMessagePart {
  if (part.type !== "image" || !isFileImageUrl(part.url)) {
    return part;
  }

  return {
    ...part,
    url: toTranscriptImageProtocolUrl(part.url),
  };
}

function isFileImageUrl(url: string): boolean {
  return url.startsWith("file://");
}

function isMaterializableImageUrl(url: string): boolean {
  return isFileImageUrl(url) || url.startsWith("data:image/");
}

export function installTranscriptImageProtocol(): void {
  protocol.handle(TRANSCRIPT_IMAGE_PROTOCOL_SCHEME, async (request) => {
    const resolution = await resolveTranscriptImageProtocolRequest(request.url);
    if (!resolution.ok) {
      return new Response(resolution.message, {
        status: resolution.status,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    const bytes = await readFile(resolution.path);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "cache-control": "public, max-age=31536000, immutable",
        "content-type": resolution.mimeType,
      },
    });
  });
}

export async function resolveTranscriptImageProtocolRequest(
  requestUrl: string,
  options?: TranscriptImageProtocolOptions,
): Promise<TranscriptImageFileResolution> {
  const sourcePath = decodeTranscriptImageProtocolRequest(requestUrl);
  if (!sourcePath) {
    return { ok: false, status: 400, message: "invalid transcript image URL" };
  }

  return await resolveTranscriptImageFile(sourcePath, options);
}

function decodeTranscriptImageProtocolRequest(requestUrl: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return undefined;
  }

  if (
    parsed.protocol !== `${TRANSCRIPT_IMAGE_PROTOCOL_SCHEME}:` ||
    parsed.hostname !== "file"
  ) {
    return undefined;
  }

  const encodedSource = parsed.pathname.replace(/^\//, "");
  if (!encodedSource) {
    return undefined;
  }

  let sourceUrl: string;
  try {
    sourceUrl = decodeURIComponent(encodedSource);
  } catch {
    return undefined;
  }

  if (!sourceUrl.startsWith("file://")) {
    return undefined;
  }

  try {
    return fileURLToPath(sourceUrl);
  } catch {
    return undefined;
  }
}

async function resolveTranscriptImageFile(
  sourcePath: string,
  options?: TranscriptImageProtocolOptions,
): Promise<TranscriptImageFileResolution> {
  const mimeType = mimeTypeForImagePath(sourcePath);
  if (!mimeType) {
    return { ok: false, status: 415, message: "unsupported transcript image type" };
  }

  let resolvedPath: string;
  try {
    resolvedPath = await realpath(sourcePath);
  } catch {
    return { ok: false, status: 404, message: "transcript image not found" };
  }

  let fileStat;
  try {
    fileStat = await stat(resolvedPath);
  } catch {
    return { ok: false, status: 404, message: "transcript image not found" };
  }

  if (!fileStat.isFile()) {
    return { ok: false, status: 404, message: "transcript image not found" };
  }

  if (!(await isAllowedTranscriptImagePath(resolvedPath, options))) {
    return { ok: false, status: 403, message: "transcript image path is not allowed" };
  }

  return { ok: true, path: resolvedPath, mimeType };
}

async function isAllowedTranscriptImagePath(
  resolvedPath: string,
  options?: TranscriptImageProtocolOptions,
): Promise<boolean> {
  const roots = collectTranscriptImageRoots(options);
  for (const root of roots) {
    let resolvedRoot: string;
    try {
      resolvedRoot = await realpath(root);
    } catch {
      continue;
    }

    if (isPathInsideRoot(resolvedPath, resolvedRoot)) {
      return true;
    }
  }

  return false;
}

function collectTranscriptImageRoots(options?: TranscriptImageProtocolOptions): string[] {
  const env = options?.env ?? process.env;
  const homeDir = options?.homeDir ?? os.homedir();
  const roots = new Set<string>();

  roots.add(path.join(resolvePwragentRoot({ env, homeDir }), "profiles"));
  roots.add(path.join(resolvePwragentRoot({ env: {}, homeDir }), "profiles"));
  roots.add(resolveDefaultCodexHome({ env, homeDir }));
  roots.add(resolveDefaultCodexHome({ env: {}, homeDir }));

  return [...roots];
}

function isPathInsideRoot(targetPath: string, rootPath: string): boolean {
  const relativePath = path.relative(rootPath, targetPath);
  return (
    relativePath === "" ||
    (relativePath !== "" &&
      !relativePath.startsWith("..") &&
      !path.isAbsolute(relativePath))
  );
}

function mimeTypeForImagePath(filePath: string): string | undefined {
  return IMAGE_MIME_TYPES.get(path.extname(filePath).toLowerCase());
}

function parseSupportedImageDataUrl(
  url: string,
): { buffer: Buffer; extension: string; sha256: string } | undefined {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/]+={0,2})$/iu.exec(
    url,
  );
  if (!match) {
    return undefined;
  }

  const mimeType = match[1]?.toLowerCase();
  const extension = mimeType ? DATA_IMAGE_EXTENSIONS.get(mimeType) : undefined;
  const payload = match[2] ?? "";
  if (!extension || payload.length % 4 === 1) {
    return undefined;
  }

  const buffer = Buffer.from(payload, "base64");
  if (buffer.byteLength === 0) {
    return undefined;
  }

  return {
    buffer,
    extension,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  };
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}
