import { protocol } from "electron";
import type {
  AppServerBackendKind,
  AppServerReadThreadResponse,
  AppServerThreadEntry,
  AppServerThreadImagePart,
  AppServerThreadMessage,
  AppServerThreadMessageEntry,
  AppServerThreadMessagePart,
  FederationInstanceId,
} from "@pwragent/shared";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveActiveProfilePath, resolvePwragentRoot } from "./profile";
import { isPwrSnapSignedMediaUrl } from "./pwrsnap-media-url";
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
// PwrSnap links can point to full-resolution captures, not just UI-sized previews.
const MAX_FETCHED_TRANSCRIPT_IMAGE_BYTES = 64 * 1024 * 1024;
const FETCHED_TRANSCRIPT_IMAGE_TIMEOUT_MS = 10_000;

export type TranscriptImageProtocolOptions = {
  /** Extra local roots approved for the current thread's Markdown image links. */
  additionalAllowedRoots?: readonly string[];
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

export type FederatedTranscriptImageRequest = {
  instanceId: FederationInstanceId;
  url: string;
};

export type FederatedTranscriptImageResponse = {
  dataBase64: string;
  mimeType: string;
};

export type TranscriptImageProtocolInstallOptions = {
  resolveFederatedImage?: (
    request: FederatedTranscriptImageRequest,
  ) => Promise<FederatedTranscriptImageResponse>;
};

export type TranscriptImageMaterializationOptions = {
  /** Linked project/worktree roots approved for this thread's Markdown image links. */
  approvedLocalImageRoots?: readonly string[];
  /** Agent-authored screenshots commonly live in the OS temporary directories. */
  includeTemporaryImageRoots?: boolean;
  /** Lazily resolves approved roots only when the transcript contains a Markdown image link. */
  resolveApprovedLocalImageRoots?: () => Promise<readonly string[]>;
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
    init: { redirect: "error"; signal: AbortSignal },
  ) => Promise<TranscriptImageFetchResponse>;
  resolveRoot: (request: {
    backend: AppServerBackendKind;
    threadId: string;
  }) => string;
  mkdir: (dirPath: string, options: { recursive: true }) => Promise<unknown>;
  resolveLocalImageLink: (
    sourcePath: string,
    options?: TranscriptImageProtocolOptions,
  ) => Promise<TranscriptImageFileResolution>;
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

type MaterializedMarkdownLinkedImage = {
  sourceUrl: string;
  url: string;
};

type ApprovedLocalImageRootResolver = () => Promise<readonly string[]>;

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

function createApprovedLocalImageRootResolver(
  options: TranscriptImageMaterializationOptions,
): ApprovedLocalImageRootResolver {
  let roots: Promise<readonly string[]> | undefined;
  return async () => {
    if (!roots) {
      roots = (async () => {
        const configuredRoots = options.approvedLocalImageRoots
          ?? await options.resolveApprovedLocalImageRoots?.().catch(() => [])
          ?? [];
        if (!options.includeTemporaryImageRoots) {
          return configuredRoots;
        }

        const temporaryRoots = [os.tmpdir()];
        // macOS agent/browser tools frequently return explicit `/tmp/...`
        // paths even though Node's TMPDIR points at `/var/folders/...`.
        if (path.sep === "/") {
          temporaryRoots.push("/tmp");
        }
        return [...new Set([...configuredRoots, ...temporaryRoots])];
      })();
    }
    return await roots;
  };
}

export function toTranscriptImageProtocolUrl(src: string): string {
  return `pwragent-image://file/${encodeURIComponent(src)}`;
}

export function toFederatedTranscriptImageProtocolUrl(
  instanceId: FederationInstanceId,
  src: string,
): string {
  return `pwragent-image://federation/${encodeURIComponent(instanceId)}/${encodeURIComponent(src)}`;
}

export function rewriteTranscriptImageUrlsForRenderer(
  response: AppServerReadThreadResponse,
): AppServerReadThreadResponse {
  return rewriteTranscriptImageUrls(response, (url) =>
    isFileImageUrl(url) ? toTranscriptImageProtocolUrl(url) : undefined,
  );
}

export function rewriteFederatedTranscriptImageUrlsForRenderer(
  response: AppServerReadThreadResponse,
  instanceId: FederationInstanceId,
): AppServerReadThreadResponse {
  return rewriteTranscriptImageUrls(response, (url) =>
    isLocalTranscriptImageUrl(url)
      ? toFederatedTranscriptImageProtocolUrl(instanceId, url)
      : undefined,
  );
}

export async function materializeTranscriptImageUrlsForRenderer(
  response: AppServerReadThreadResponse,
  dependencies: Partial<TranscriptImageMaterializerDependencies> = {},
  options: TranscriptImageMaterializationOptions = {},
): Promise<AppServerReadThreadResponse> {
  const deps = { ...defaultMaterializerDependencies, ...dependencies };
  const resolveApprovedLocalImageRoots = createApprovedLocalImageRootResolver(options);
  const materializedFileWrites = new Map<string, Promise<void>>();
  const fetchedLoopbackImages = new Map<
    string,
    Promise<MaterializedTranscriptImage | undefined>
  >();
  const markdownLinkImageResolutions = new Map<
    string,
    Promise<TranscriptImageFileResolution>
  >();
  const materializedMarkdownLinkedImages = new Map<
    string,
    Promise<MaterializedMarkdownLinkedImage | undefined>
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
            materializedMarkdownLinkedImages,
            resolveApprovedLocalImageRoots,
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
            materializedMarkdownLinkedImages,
            resolveApprovedLocalImageRoots,
          ),
        ),
      ),
    },
  };
}

/**
 * Resolve the images belonging to one assistant message into provider-safe
 * image parts. Local files, data images, and signed PwrSnap loopback URLs are
 * first copied into the durable transcript cache, then returned as data URLs
 * so messaging adapters never receive renderer-only `pwragent-image://` URLs.
 * Ordinary remote URLs remain remote URLs for adapters that can embed them.
 */
export async function materializeTranscriptMessageImagesForMessaging(
  response: AppServerReadThreadResponse,
  message: AppServerThreadMessage,
  dependencies: Partial<TranscriptImageMaterializerDependencies> = {},
  options: TranscriptImageMaterializationOptions = {},
): Promise<AppServerThreadImagePart[]> {
  const scopedMessage = message.parts?.some((part) => part.type === "text")
    ? message
    : {
        ...message,
        parts: [
          { type: "text" as const, text: message.text },
          ...(message.parts ?? []),
        ],
      };
  const scopedResponse: AppServerReadThreadResponse = {
    ...response,
    replay: {
      ...response.replay,
      entries: [],
      messages: [scopedMessage],
    },
  };
  const materialized = await materializeTranscriptImageUrlsForRenderer(
    scopedResponse,
    dependencies,
    options,
  );
  const materializedMessage = materialized.replay.messages[0];
  if (!materializedMessage) {
    return [];
  }

  const approvedLocalImageRoots = await createApprovedLocalImageRootResolver(options)();
  const imageParts = materializedMessage.parts?.filter(
    (part): part is AppServerThreadImagePart => part.type === "image",
  ) ?? [];
  const output: AppServerThreadImagePart[] = [];
  for (const part of imageParts) {
    const providerUrl = await transcriptImageUrlForMessaging(
      part.url,
      approvedLocalImageRoots,
    );
    if (!providerUrl) {
      continue;
    }
    output.push({
      ...part,
      url: providerUrl,
    });
  }
  return output;
}

async function transcriptImageUrlForMessaging(
  url: string,
  approvedLocalImageRoots: readonly string[],
): Promise<string | undefined> {
  if (url.startsWith("data:image/") || /^https:\/\//iu.test(url)) {
    return url;
  }

  const sourcePath = url.startsWith(`${TRANSCRIPT_IMAGE_PROTOCOL_SCHEME}://`)
    ? decodeTranscriptImageProtocolRequest(url)
    : isFileImageUrl(url)
      ? localImageLinkPath(url)
      : undefined;
  if (!sourcePath) {
    return undefined;
  }

  const resolution = await resolveTranscriptImageFile(sourcePath, {
    additionalAllowedRoots: approvedLocalImageRoots,
  });
  if (!resolution.ok) {
    return undefined;
  }
  let buffer: Buffer;
  try {
    buffer = await readFile(resolution.path);
  } catch {
    return undefined;
  }
  if (
    buffer.byteLength === 0
    || buffer.byteLength > MAX_FETCHED_TRANSCRIPT_IMAGE_BYTES
  ) {
    return undefined;
  }
  return `data:${resolution.mimeType};base64,${buffer.toString("base64")}`;
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
  materializedMarkdownLinkedImages: Map<
    string,
    Promise<MaterializedMarkdownLinkedImage | undefined>
  >,
  resolveApprovedLocalImageRoots: ApprovedLocalImageRootResolver,
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
    materializedMarkdownLinkedImages,
    resolveApprovedLocalImageRoots,
  )) as AppServerThreadMessageEntry;
}

async function materializeTranscriptMessageImageUrls<T extends AppServerThreadMessage>(
  message: T,
  response: AppServerReadThreadResponse,
  deps: TranscriptImageMaterializerDependencies,
  materializedFileWrites: Map<string, Promise<void>>,
  fetchedLoopbackImages: Map<string, Promise<MaterializedTranscriptImage | undefined>>,
  markdownLinkImageResolutions: Map<string, Promise<TranscriptImageFileResolution>>,
  materializedMarkdownLinkedImages: Map<
    string,
    Promise<MaterializedMarkdownLinkedImage | undefined>
  >,
  resolveApprovedLocalImageRoots: ApprovedLocalImageRootResolver,
): Promise<T> {
  const messageWithMarkdownLinkImages = await appendMarkdownLinkImageParts(
    message,
    response,
    deps,
    materializedFileWrites,
    markdownLinkImageResolutions,
    materializedMarkdownLinkedImages,
    resolveApprovedLocalImageRoots,
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
    const response = await deps.fetch(url, {
      redirect: "error",
      signal: controller.signal,
    });
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

async function appendMarkdownLinkImageParts<T extends AppServerThreadMessage>(
  message: T,
  response: AppServerReadThreadResponse,
  deps: TranscriptImageMaterializerDependencies,
  materializedFileWrites: Map<string, Promise<void>>,
  markdownLinkImageResolutions: Map<string, Promise<TranscriptImageFileResolution>>,
  materializedMarkdownLinkedImages: Map<
    string,
    Promise<MaterializedMarkdownLinkedImage | undefined>
  >,
  resolveApprovedLocalImageRoots: ApprovedLocalImageRootResolver,
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
    const image = await materializeMarkdownLinkedImage(
      message.id,
      imageLink.sourcePath,
      response,
      deps,
      materializedFileWrites,
      markdownLinkImageResolutions,
      materializedMarkdownLinkedImages,
      resolveApprovedLocalImageRoots,
    );
    if (!image) {
      continue;
    }

    if (existingSourceUrls.has(image.sourceUrl)) {
      continue;
    }
    existingSourceUrls.add(image.sourceUrl);
    imageParts.push({
      type: "image",
      url: image.url,
      sourceUrl: image.sourceUrl,
      alt: imageLink.alt || path.basename(imageLink.sourcePath),
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

async function materializeMarkdownLinkedImage(
  messageId: string,
  sourcePath: string,
  response: AppServerReadThreadResponse,
  deps: TranscriptImageMaterializerDependencies,
  materializedFileWrites: Map<string, Promise<void>>,
  resolutions: Map<string, Promise<TranscriptImageFileResolution>>,
  materializedImages: Map<string, Promise<MaterializedMarkdownLinkedImage | undefined>>,
  resolveApprovedLocalImageRoots: ApprovedLocalImageRootResolver,
): Promise<MaterializedMarkdownLinkedImage | undefined> {
  const associationKey = markdownLinkedImageAssociationKey(messageId, sourcePath);
  const existing = materializedImages.get(associationKey);
  if (existing) {
    return await existing;
  }

  const materialization = materializeMarkdownLinkedImageOnce(
    messageId,
    sourcePath,
    response,
    deps,
    materializedFileWrites,
    resolutions,
    resolveApprovedLocalImageRoots,
  );
  materializedImages.set(associationKey, materialization);
  return await materialization;
}

async function materializeMarkdownLinkedImageOnce(
  messageId: string,
  sourcePath: string,
  response: AppServerReadThreadResponse,
  deps: TranscriptImageMaterializerDependencies,
  materializedFileWrites: Map<string, Promise<void>>,
  resolutions: Map<string, Promise<TranscriptImageFileResolution>>,
  resolveApprovedLocalImageRoots: ApprovedLocalImageRootResolver,
): Promise<MaterializedMarkdownLinkedImage | undefined> {
  const sourceUrl = pathToFileURL(sourcePath).toString();
  const cachedImage = await readCachedMarkdownLinkedImage(
    messageId,
    sourceUrl,
    sourcePath,
    response,
    deps,
  );
  if (cachedImage) {
    return cachedImage;
  }

  const approvedLocalImageRoots = await resolveApprovedLocalImageRoots();
  const resolution = await resolveMarkdownLinkedImage(
    sourcePath,
    deps,
    resolutions,
    approvedLocalImageRoots,
  );
  if (!resolution.ok) {
    return undefined;
  }

  const image = await readMarkdownLinkedTranscriptImage(resolution);
  if (!image) {
    return undefined;
  }

  return await writeCachedMarkdownLinkedImage(
    messageId,
    sourceUrl,
    image,
    response,
    deps,
    materializedFileWrites,
  );
}

async function readCachedMarkdownLinkedImage(
  messageId: string,
  sourceUrl: string,
  sourcePath: string,
  response: AppServerReadThreadResponse,
  deps: TranscriptImageMaterializerDependencies,
): Promise<MaterializedMarkdownLinkedImage | undefined> {
  const mimeType = mimeTypeForImagePath(sourcePath);
  const extension = mimeType ? DATA_IMAGE_EXTENSIONS.get(mimeType) : undefined;
  if (!extension) {
    return undefined;
  }

  const filePath = markdownLinkedImageCachePath(
    messageId,
    sourceUrl,
    extension,
    response,
    deps,
  );
  try {
    const fileStat = await stat(filePath);
    if (
      !fileStat.isFile()
      || fileStat.size === 0
      || fileStat.size > MAX_FETCHED_TRANSCRIPT_IMAGE_BYTES
    ) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  return {
    sourceUrl,
    url: toTranscriptImageProtocolUrl(pathToFileURL(filePath).toString()),
  };
}

async function writeCachedMarkdownLinkedImage(
  messageId: string,
  sourceUrl: string,
  image: MaterializedTranscriptImage,
  response: AppServerReadThreadResponse,
  deps: TranscriptImageMaterializerDependencies,
  materializedFileWrites: Map<string, Promise<void>>,
): Promise<MaterializedMarkdownLinkedImage | undefined> {
  const root = deps.resolveRoot({
    backend: response.backend,
    threadId: response.threadId,
  });
  const filePath = markdownLinkedImageCachePath(
    messageId,
    sourceUrl,
    image.extension,
    response,
    deps,
  );
  try {
    await deps.mkdir(root, { recursive: true });
    let writePromise = materializedFileWrites.get(filePath);
    if (!writePromise) {
      writePromise = deps.writeFile(filePath, image.buffer).then(() => undefined);
      materializedFileWrites.set(filePath, writePromise);
    }
    await writePromise;
  } catch {
    return undefined;
  }

  return {
    sourceUrl,
    url: toTranscriptImageProtocolUrl(pathToFileURL(filePath).toString()),
  };
}

function markdownLinkedImageCachePath(
  messageId: string,
  sourceUrl: string,
  extension: string,
  response: AppServerReadThreadResponse,
  deps: TranscriptImageMaterializerDependencies,
): string {
  const root = deps.resolveRoot({
    backend: response.backend,
    threadId: response.threadId,
  });
  const associationHash = createHash("sha256")
    .update(markdownLinkedImageAssociationKey(messageId, sourceUrl))
    .digest("hex");
  return path.join(root, `markdown-${associationHash}.${extension}`);
}

function markdownLinkedImageAssociationKey(
  messageId: string,
  source: string,
): string {
  return `${messageId}\0${source}`;
}

async function readMarkdownLinkedTranscriptImage(
  resolution: Extract<TranscriptImageFileResolution, { ok: true }>,
): Promise<MaterializedTranscriptImage | undefined> {
  const extension = DATA_IMAGE_EXTENSIONS.get(resolution.mimeType);
  if (!extension) {
    return undefined;
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(resolution.path);
  } catch {
    return undefined;
  }
  if (
    buffer.byteLength === 0
    || buffer.byteLength > MAX_FETCHED_TRANSCRIPT_IMAGE_BYTES
  ) {
    return undefined;
  }

  return {
    buffer,
    extension,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  };
}

function resolveMarkdownLinkedImage(
  sourcePath: string,
  deps: TranscriptImageMaterializerDependencies,
  resolutions: Map<string, Promise<TranscriptImageFileResolution>>,
  approvedLocalImageRoots: readonly string[] | undefined,
): Promise<TranscriptImageFileResolution> {
  const existing = resolutions.get(sourcePath);
  if (existing) {
    return existing;
  }

  const resolution = deps.resolveLocalImageLink(sourcePath, {
    additionalAllowedRoots: approvedLocalImageRoots,
  }).catch(() => ({
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

  if (path.isAbsolute(trimmed)) {
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

type TranscriptImageUrlRewriter = (url: string) => string | undefined;

function rewriteTranscriptImageUrls(
  response: AppServerReadThreadResponse,
  rewriteUrl: TranscriptImageUrlRewriter,
): AppServerReadThreadResponse {
  return {
    ...response,
    replay: {
      ...response.replay,
      entries: response.replay.entries.map((entry) =>
        rewriteTranscriptEntryImageUrls(entry, rewriteUrl),
      ),
      messages: response.replay.messages.map((message) =>
        rewriteTranscriptMessageImageUrls(message, rewriteUrl),
      ),
    },
  };
}

function rewriteTranscriptEntryImageUrls(
  entry: AppServerThreadEntry,
  rewriteUrl: TranscriptImageUrlRewriter,
): AppServerThreadEntry {
  if (entry.type !== "message") {
    return entry;
  }

  return rewriteTranscriptMessageImageUrls(
    entry,
    rewriteUrl,
  ) as AppServerThreadMessageEntry;
}

function rewriteTranscriptMessageImageUrls<T extends AppServerThreadMessage>(
  message: T,
  rewriteUrl: TranscriptImageUrlRewriter,
): T {
  let changed = false;
  const parts = message.parts?.map((part) => {
    if (part.type !== "image") {
      return part;
    }
    const url = rewriteUrl(part.url);
    if (!url) {
      return part;
    }
    changed = true;
    return { ...part, url };
  });

  return changed ? { ...message, parts } : message;
}

function isLocalTranscriptImageUrl(url: string): boolean {
  return url.startsWith(`${TRANSCRIPT_IMAGE_PROTOCOL_SCHEME}://file/`);
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

export function installTranscriptImageProtocol(
  options: TranscriptImageProtocolInstallOptions = {},
): void {
  protocol.handle(TRANSCRIPT_IMAGE_PROTOCOL_SCHEME, async (request) => {
    const federatedRequest = decodeFederatedTranscriptImageProtocolRequest(
      request.url,
    );
    if (federatedRequest) {
      if (!options.resolveFederatedImage) {
        return new Response("federated transcript image transport unavailable", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }

      try {
        const remote = await options.resolveFederatedImage(federatedRequest);
        const bytes = Buffer.from(remote.dataBase64, "base64");
        if (
          !remote.mimeType.startsWith("image/")
          || bytes.byteLength === 0
          || bytes.byteLength > MAX_FETCHED_TRANSCRIPT_IMAGE_BYTES
        ) {
          return new Response("invalid federated transcript image response", {
            status: 502,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }
        return transcriptImageResponse(bytes, remote.mimeType);
      } catch (error) {
        return new Response(
          error instanceof Error ? error.message : String(error),
          {
            status: 502,
            headers: { "content-type": "text/plain; charset=utf-8" },
          },
        );
      }
    }

    const resolution = await resolveTranscriptImageProtocolRequest(request.url);
    if (!resolution.ok) {
      return new Response(resolution.message, {
        status: resolution.status,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    const bytes = await readFile(resolution.path);
    return transcriptImageResponse(bytes, resolution.mimeType);
  });
}

function transcriptImageResponse(
  bytes: Uint8Array,
  mimeType: string,
): Response {
  return new Response(new Uint8Array(bytes), {
    headers: {
      "cache-control": "public, max-age=31536000, immutable",
      "content-type": mimeType,
    },
  });
}

function decodeFederatedTranscriptImageProtocolRequest(
  requestUrl: string,
): FederatedTranscriptImageRequest | undefined {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return undefined;
  }

  if (
    parsed.protocol !== `${TRANSCRIPT_IMAGE_PROTOCOL_SCHEME}:`
    || parsed.hostname !== "federation"
  ) {
    return undefined;
  }

  const [encodedInstanceId, encodedUrl, ...unexpected] = parsed.pathname
    .replace(/^\//, "")
    .split("/");
  if (!encodedInstanceId || !encodedUrl || unexpected.length > 0) {
    return undefined;
  }

  try {
    const instanceId = decodeURIComponent(encodedInstanceId);
    const url = decodeURIComponent(encodedUrl);
    if (!instanceId || !isLocalTranscriptImageUrl(url)) {
      return undefined;
    }
    return { instanceId, url };
  } catch {
    return undefined;
  }
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

export async function readTranscriptImageProtocolRequest(
  requestUrl: string,
  options?: TranscriptImageProtocolOptions,
): Promise<FederatedTranscriptImageResponse> {
  const resolution = await resolveTranscriptImageProtocolRequest(
    requestUrl,
    options,
  );
  if (!resolution.ok) {
    throw new Error(resolution.message);
  }

  const fileStat = await stat(resolution.path);
  if (fileStat.size === 0 || fileStat.size > MAX_FETCHED_TRANSCRIPT_IMAGE_BYTES) {
    throw new Error("transcript image size is not supported");
  }
  const bytes = await readFile(resolution.path);
  return {
    dataBase64: bytes.toString("base64"),
    mimeType: resolution.mimeType,
  };
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
  for (const root of options?.additionalAllowedRoots ?? []) {
    const trimmed = root.trim();
    if (trimmed) {
      roots.add(trimmed);
    }
  }

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
