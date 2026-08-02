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
const MAX_FETCHED_TRANSCRIPT_IMAGE_BYTES = 16 * 1024 * 1024;
const FETCHED_TRANSCRIPT_IMAGE_TIMEOUT_MS = 10_000;

export type TranscriptImageProtocolOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

type TranscriptImageFetchResponse = {
  ok: boolean;
  headers: { get: (name: string) => string | null };
  body?: ReadableStream<Uint8Array> | null;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

export type TranscriptImageMaterializerDependencies = {
  fetch: (
    url: string,
    init: { signal: AbortSignal },
  ) => Promise<TranscriptImageFetchResponse>;
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

type MaterializedTranscriptImage = {
  buffer: Buffer;
  extension: string;
  sha256: string;
};

const defaultMaterializerDependencies: TranscriptImageMaterializerDependencies = {
  fetch: async (url, init) => await globalThis.fetch(url, init),
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
  const fetchedLoopbackImages = new Map<
    string,
    Promise<MaterializedTranscriptImage | undefined>
  >();
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
            fetchedLoopbackImages,
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
            fetchedLoopbackImages,
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
  fetchedLoopbackImages: Map<string, Promise<MaterializedTranscriptImage | undefined>>,
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
    fetchedLoopbackImages,
    markdownLinkImageResolutions,
  )) as AppServerThreadMessageEntry;
}

async function materializeTranscriptMessageImageUrls<T extends AppServerThreadMessage>(
  message: T,
  response: AppServerReadThreadResponse,
  deps: TranscriptImageMaterializerDependencies,
  materializedFileWrites: Map<string, Promise<void>>,
  fetchedLoopbackImages: Map<string, Promise<MaterializedTranscriptImage | undefined>>,
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
          fetchedLoopbackImages,
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
  fetchedLoopbackImages: Map<string, Promise<MaterializedTranscriptImage | undefined>>,
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
  if (dataImage) {
    return await materializeTranscriptImagePart(
      part,
      dataImage,
      response,
      deps,
      materializedFileWrites,
    );
  }

  const fetchedImage = await fetchLoopbackSignedImage(
    part.url,
    deps,
    fetchedLoopbackImages,
  );
  if (!fetchedImage) {
    return part;
  }

  return await materializeTranscriptImagePart(
    part,
    fetchedImage,
    response,
    deps,
    materializedFileWrites,
  );
}

async function materializeTranscriptImagePart(
  part: AppServerThreadImagePart,
  image: MaterializedTranscriptImage,
  response: AppServerReadThreadResponse,
  deps: TranscriptImageMaterializerDependencies,
  materializedFileWrites: Map<string, Promise<void>>,
): Promise<AppServerThreadImagePart> {
  const root = deps.resolveRoot({
    backend: response.backend,
    threadId: response.threadId,
  });
  try {
    await deps.mkdir(root, { recursive: true });
    const filePath = path.join(root, `${image.sha256}.${image.extension}`);
    let writePromise = materializedFileWrites.get(filePath);
    if (!writePromise) {
      writePromise = deps.writeFile(filePath, image.buffer).then(() => undefined);
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

async function fetchLoopbackSignedImage(
  url: string,
  deps: TranscriptImageMaterializerDependencies,
  fetchedImages: Map<string, Promise<MaterializedTranscriptImage | undefined>>,
): Promise<MaterializedTranscriptImage | undefined> {
  if (!isPwrSnapSignedMediaUrl(url)) {
    return undefined;
  }

  let fetchPromise = fetchedImages.get(url);
  if (!fetchPromise) {
    fetchPromise = fetchLoopbackSignedImageOnce(url, deps);
    fetchedImages.set(url, fetchPromise);
  }
  return await fetchPromise;
}

async function fetchLoopbackSignedImageOnce(
  url: string,
  deps: TranscriptImageMaterializerDependencies,
): Promise<MaterializedTranscriptImage | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCHED_TRANSCRIPT_IMAGE_TIMEOUT_MS);
  try {
    const response = await deps.fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return undefined;
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength)
      && declaredLength > MAX_FETCHED_TRANSCRIPT_IMAGE_BYTES
    ) {
      return undefined;
    }

    const mimeType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    const extension = mimeType ? DATA_IMAGE_EXTENSIONS.get(mimeType) : undefined;
    if (!extension) {
      return undefined;
    }

    const buffer = await readFetchedTranscriptImageBuffer(response, controller);
    if (!buffer) {
      return undefined;
    }

    return {
      buffer,
      extension,
      sha256: createHash("sha256").update(buffer).digest("hex"),
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function readFetchedTranscriptImageBuffer(
  response: TranscriptImageFetchResponse,
  controller: AbortController,
): Promise<Buffer | undefined> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_FETCHED_TRANSCRIPT_IMAGE_BYTES) {
      return undefined;
    }
    return buffer;
  }

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }

      byteLength += value.byteLength;
      if (byteLength > MAX_FETCHED_TRANSCRIPT_IMAGE_BYTES) {
        controller.abort();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return byteLength > 0 ? Buffer.concat(chunks, byteLength) : undefined;
}

function isPwrSnapSignedMediaUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || !isLoopbackHostname(parsed.hostname)
    || parsed.pathname !== "/media"
  ) {
    return false;
  }

  return Boolean(parsed.searchParams.get("grant"));
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost"
    || normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized.endsWith(".localhost")
  );
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
  return (
    isFileImageUrl(url)
    || url.startsWith("data:image/")
    || isPwrSnapSignedMediaUrl(url)
  );
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
