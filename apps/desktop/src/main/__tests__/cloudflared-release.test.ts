import { describe, expect, it, vi } from "vitest";
import {
  CLOUDFLARED_LATEST_RELEASE_URL,
  compareCloudflaredVersions,
  createCloudflaredReleaseCheck,
} from "../federation/cloudflared-release";

function release(tag: unknown, status = 200) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify({ tag_name: tag }), { status }));
}

describe("cloudflared release check", () => {
  it("compares calendar versions by number, not by text", () => {
    expect(compareCloudflaredVersions("2026.10.0", "2026.9.1")).toBe(1);
    expect(compareCloudflaredVersions("2026.8.3", "2026.8.3")).toBe(0);
    expect(compareCloudflaredVersions("2025.12.9", "2026.1.0")).toBe(-1);
    expect(compareCloudflaredVersions("2026.8", "2026.8.3")).toBeUndefined();
  });

  it("reads the latest release tag and reuses it for a day", async () => {
    let now = 0;
    const fetch = release("2026.9.0");
    const check = createCloudflaredReleaseCheck({ fetch, now: () => now });
    await expect(check()).resolves.toBe("2026.9.0");
    expect(fetch).toHaveBeenCalledWith(CLOUDFLARED_LATEST_RELEASE_URL, expect.anything());
    now = 23 * 60 * 60_000;
    await check();
    expect(fetch).toHaveBeenCalledTimes(1);
    now = 25 * 60 * 60_000;
    await check();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reports nothing for a failed or malformed lookup and retries after an hour", async () => {
    let now = 0;
    const fetch = release("2026.9.0", 403);
    const check = createCloudflaredReleaseCheck({ fetch, now: () => now });
    await expect(check()).resolves.toBeUndefined();
    await check();
    expect(fetch).toHaveBeenCalledTimes(1);
    now = 61 * 60_000;
    await check();
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(createCloudflaredReleaseCheck({ fetch: release("nightly") })()).resolves.toBeUndefined();
    await expect(createCloudflaredReleaseCheck({
      fetch: vi.fn(async () => { throw new TypeError("fetch failed"); }),
    })()).resolves.toBeUndefined();
  });

  it("shares one lookup between concurrent status reads", async () => {
    const fetch = release("2026.9.0");
    const check = createCloudflaredReleaseCheck({ fetch });
    await expect(Promise.all([check(), check()])).resolves.toEqual(["2026.9.0", "2026.9.0"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
