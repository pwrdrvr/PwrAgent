import { isGitHubAttachmentImageUrl } from "@pwragent/shared";

export const MAX_GITHUB_ATTACHMENT_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const RASTER_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function isAllowedRedirect(value: string): boolean {
  if (isGitHubAttachmentImageUrl(value)) {
    return true;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && !url.port
      && !url.hash
      && (
        url.hostname === "github-production-user-asset-6210df.s3.amazonaws.com"
        || url.hostname === "user-attachments.githubusercontent.com"
      );
  } catch {
    return false;
  }
}

function hasRasterSignature(bytes: Uint8Array, mimeType: string): boolean {
  const buffer = Buffer.from(bytes);
  switch (mimeType) {
    case "image/png":
      return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case "image/jpeg":
      return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    case "image/gif":
      return ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"));
    case "image/webp":
      return buffer.subarray(0, 4).toString("ascii") === "RIFF"
        && buffer.subarray(8, 12).toString("ascii") === "WEBP";
    default:
      return false;
  }
}

/** No Electron session, gh, cookie jar, or renderer-supplied request headers. */
export async function fetchGitHubAttachmentImage(
  source: string,
  fetchImage: typeof globalThis.fetch = globalThis.fetch,
): Promise<Response> {
  if (!isGitHubAttachmentImageUrl(source)) {
    return new Response("GitHub attachment URL is not allowed", { status: 403 });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
  try {
    let target = source;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const response = await fetchImage(target, {
        credentials: "omit",
        redirect: "manual",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location || redirects === MAX_REDIRECTS) {
          throw new Error("Invalid attachment redirect");
        }
        target = new URL(location, target).href;
        if (!isAllowedRedirect(target)) {
          throw new Error("Attachment redirect is not allowed");
        }
        continue;
      }

      const mimeType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
      const declaredSize = Number(response.headers.get("content-length"));
      if (
        !response.ok
        || !response.body
        || !RASTER_MIME_TYPES.has(mimeType)
        || declaredSize > MAX_GITHUB_ATTACHMENT_IMAGE_BYTES
      ) {
        await response.body?.cancel();
        throw new Error("Invalid attachment image response");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          size += value.byteLength;
          if (size > MAX_GITHUB_ATTACHMENT_IMAGE_BYTES) {
            throw new Error("Attachment image is too large");
          }
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      const bytes = Buffer.concat(chunks, size);
      if (!hasRasterSignature(bytes, mimeType)) {
        throw new Error("Attachment image signature does not match its type");
      }
      return new Response(new Uint8Array(bytes), {
        headers: {
          "content-type": mimeType,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; sandbox",
        },
      });
    }
  } catch {
    // Do not expose signed redirect URLs or upstream response bodies.
    return new Response("GitHub attachment image unavailable", { status: 502 });
  } finally {
    controller.abort();
    clearTimeout(timeout);
  }
  return new Response("GitHub attachment image unavailable", { status: 502 });
}
