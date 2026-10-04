import { isGitHubAttachmentImageUrl } from "@pwragent/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGitHubAttachmentImage, MAX_GITHUB_ATTACHMENT_IMAGE_BYTES } from "../github-attachment-image";

const source = "https://github.com/user-attachments/assets/11111111-2222-3333-4444-555555555555";
const bucket = "https://github-production-user-asset-6210df.s3.amazonaws.com/1/preview.png?signature=fixture";
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const imageResponse = () => new Response(png, { headers: { "content-type": "image/png" } });

afterEach(() => vi.useRealTimers());

describe("public GitHub attachment images", () => {
  it.each([
    "http://github.com/user-attachments/assets/11111111-2222-3333-4444-555555555555",
    source.replace("github.com", "github.com.evil.test"),
    source.replace("github.com", "github.com@127.0.0.1"),
    source.replace("github.com", "user:password@github.com"),
    source.replace("github.com", "github.com:8443"),
    "https://github.com/login",
    "https://github.com/user-attachments/assets/not-an-asset",
    `${source}?secret=fixture`,
    `${source}#fragment`,
    `${source}\n`,
    source.replace("/assets/", "/assets/%2e%2e/"),
    "file:///tmp/image.png",
    "data:image/png;base64,fixture",
    "https://127.0.0.1/image.png",
    bucket,
  ])("rejects an authored URL before any network request: %s", async (url) => {
    const fetchImage = vi.fn<typeof fetch>();
    expect(isGitHubAttachmentImageUrl(url)).toBe(false);
    expect((await fetchGitHubAttachmentImage(url, fetchImage)).status).toBe(403);
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it("loads a public attachment through an allowed redirect without credentials or referrer", async () => {
    const fetchImage = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: bucket } }))
      .mockResolvedValueOnce(imageResponse());
    const response = await fetchGitHubAttachmentImage(source, fetchImage);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetchImage.mock.calls.map(([url]) => url)).toEqual([source, bucket]);
    for (const [, options] of fetchImage.mock.calls) {
      expect(options).toEqual({
        credentials: "omit",
        redirect: "manual",
        referrerPolicy: "no-referrer",
        signal: expect.any(AbortSignal),
      });
    }
  });

  it.each([
    ["image/jpeg", new Uint8Array([255, 216, 255])],
    ["image/gif", new TextEncoder().encode("GIF89a")],
    ["image/webp", new TextEncoder().encode("RIFF0000WEBP")],
  ])("accepts the other supported raster signatures: %s", async (mimeType, bytes) => {
    const fetchImage = vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes, {
      headers: { "content-type": mimeType },
    }));
    expect((await fetchGitHubAttachmentImage(source, fetchImage)).status).toBe(200);
  });

  it.each([
    "http://127.0.0.1/private", "https://192.168.1.1/private", "https://evil.test/track",
    "file:///etc/passwd", "http://github-production-user-asset-6210df.s3.amazonaws.com/image.png",
    "https://github-production-user-asset-6210df.s3.amazonaws.com.evil.test/image.png",
    "https://user:password@user-attachments.githubusercontent.com/image.png",
    "https://user-attachments.githubusercontent.com:8443/image.png",
    "/login",
  ])("never follows an unsafe redirect: %s", async (location) => {
    const fetchImage = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status: 302, headers: { location } }),
    );
    expect((await fetchGitHubAttachmentImage(source, fetchImage)).status).toBe(502);
    expect(fetchImage).toHaveBeenCalledTimes(1);
  });

  it("revalidates later redirect hops and bounds redirect loops", async () => {
    const fetchImage = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: bucket } }))
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "http://localhost/private" } }));
    expect((await fetchGitHubAttachmentImage(source, fetchImage)).status).toBe(502);
    expect(fetchImage).toHaveBeenCalledTimes(2);
    fetchImage.mockReset().mockImplementation(async () => new Response(null, {
      status: 302, headers: { location: source },
    }));
    expect((await fetchGitHubAttachmentImage(source, fetchImage)).status).toBe(502);
    expect(fetchImage).toHaveBeenCalledTimes(4);
  });

  it.each([
    () => new Response("private", { status: 404 }),
    () => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }),
    () => new Response("<html/>", { headers: { "content-type": "text/html" } }),
    () => new Response("<svg/>", { headers: { "content-type": "image/png" } }),
    () => new Response(png, { headers: { "content-type": "image/jpeg" } }),
    () => new Response(null, { headers: { "content-type": "image/png" } }),
    () => new Response(png, { headers: {
      "content-type": "image/png", "content-length": String(MAX_GITHUB_ATTACHMENT_IMAGE_BYTES + 1),
    } }),
  ])("rejects unavailable, active, mismatched, or oversized responses", async (makeResponse) => {
    const fetchImage = vi.fn<typeof fetch>().mockResolvedValue(makeResponse());
    const response = await fetchGitHubAttachmentImage(source, fetchImage);
    expect(response.status).toBe(502);
    expect(await response.text()).toBe("GitHub attachment image unavailable");
  });

  it("enforces the actual streamed size even without a Content-Length", async () => {
    const cancel = vi.fn();
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks += 1;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel,
    });
    const fetchImage = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, {
      headers: { "content-type": "image/png" },
    }));
    expect((await fetchGitHubAttachmentImage(source, fetchImage)).status).toBe(502);
    expect(cancel).toHaveBeenCalledOnce();
    expect(chunks).toBeLessThanOrEqual(12);
  });

  it("aborts a stalled download after ten seconds", async () => {
    vi.useFakeTimers();
    const fetchImage = vi.fn<typeof fetch>().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const pending = fetchGitHubAttachmentImage(source, fetchImage);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await pending).status).toBe(502);
    expect(fetchImage.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
});
