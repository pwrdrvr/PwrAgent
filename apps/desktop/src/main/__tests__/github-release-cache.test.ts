import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchGitHubReleaseMetadata,
  RELEASE_AUTOMATIC_TTL_MS,
  RELEASE_FIRST_CHECK_DELAY_MS,
  ReleaseCheckDeferredError,
  reserveAppReleaseCheck,
} from "../github-release-cache";

const APP = "https://api.github.com/repos/pwrdrvr/PwrAgent/releases?per_page=30";
const GIT = "https://api.github.com/repos/pwrdrvr/PwrGit/releases/latest";
const SNAP = "https://api.github.com/repos/pwrdrvr/PwrSnap/releases/latest";
const CLOUD = "https://api.github.com/repos/cloudflare/cloudflared/releases/latest";
let directory: string;
let network: ReturnType<typeof vi.fn<typeof fetch>>;
const options = () => ({ directory, fetch: network });
const read = (url = APP, extra = {}) => fetchGitHubReleaseMetadata(url, {}, { ...options(), ...extra });
const defer = async (request: Promise<unknown>) => {
  await expect(request).rejects.toBeInstanceOf(ReleaseCheckDeferredError);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-30T00:00:00Z"));
  directory = mkdtempSync(path.join(tmpdir(), "release-cache-"));
  network = vi.fn<typeof fetch>(async () => new Response(JSON.stringify([{ tag_name: "v1.2.3" }]), {
    headers: { etag: '"release-1"' },
  }));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
});

describe("persistent GitHub release budget", () => {
  it("defers 20 launches/minute, then shares results across profiles, versions and windows", async () => {
    for (let launch = 0; launch < 20; launch++) {
      // Each call reads disk afresh; there is deliberately no singleton cache.
      expect(() => reserveAppReleaseCheck(false, options())).toThrow(ReleaseCheckDeferredError);
      for (const url of [APP, GIT, SNAP]) await defer(read(url));
      vi.setSystemTime(Date.now() + 3_000);
    }
    expect(network).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 9 * 60_000);
    reserveAppReleaseCheck(false, options());
    for (const url of [APP, GIT, SNAP]) await read(url);
    expect(network).toHaveBeenCalledTimes(3);
    for (let launch = 0; launch < 20; launch++) {
      expect(() => reserveAppReleaseCheck(false, options())).toThrow(ReleaseCheckDeferredError);
      for (const url of [APP, GIT, SNAP]) expect((await read(url)).ok).toBe(true);
    }
    expect(network).toHaveBeenCalledTimes(3);
  });

  it("caps six computers at 36 automatic requests in a rolling hour", async () => {
    const computers = Array.from({ length: 6 }, (_, index) => path.join(directory, `computer-${index}`));
    for (const computer of computers) await defer(read(APP, { directory: computer }));
    vi.setSystemTime(Date.now() + RELEASE_FIRST_CHECK_DELAY_MS);
    for (const computer of computers) {
      for (const url of [APP, GIT, SNAP, CLOUD]) {
        await read(url, { directory: computer, ttlMs: 30 * 60_000 });
      }
    }
    expect(network).toHaveBeenCalledTimes(24);
    vi.setSystemTime(Date.now() + 30 * 60_000);
    for (const computer of computers) {
      for (const url of [GIT, SNAP]) await read(url, { directory: computer, ttlMs: 30 * 60_000 });
      // The seventh endpoint is still blocked, including in another process.
      await defer(read(`${APP}&extra=1`, { directory: computer }));
    }
    expect(network).toHaveBeenCalledTimes(36);
  });

  it("allows check now on a new root and bypasses the normal cache TTL", async () => {
    reserveAppReleaseCheck(true, options());
    await read(APP, { manual: true });
    await read(APP, { manual: true });
    expect(network).toHaveBeenCalledTimes(2);
    expect(() => reserveAppReleaseCheck(false, options())).toThrow(ReleaseCheckDeferredError);
  });

  it("persists conditional data and success/attempt timestamps across module reloads", async () => {
    await read(APP, { manual: true });
    vi.setSystemTime(Date.now() + RELEASE_AUTOMATIC_TTL_MS);
    network.mockResolvedValueOnce(new Response(null, { status: 304 }));
    vi.resetModules();
    const restarted = await import("../github-release-cache");
    expect(await (await restarted.fetchGitHubReleaseMetadata(APP, {}, options())).json())
      .toEqual([{ tag_name: "v1.2.3" }]);
    expect(new Headers(network.mock.calls[1][1]?.headers).get("if-none-match")).toBe('"release-1"');
    const state = JSON.parse(readFileSync(path.join(directory, "state.json"), "utf8"));
    expect(Object.values(state.entries)).toEqual([expect.objectContaining({
      lastAttempt: Date.now(), lastSuccess: Date.now(), etag: '"release-1"',
    })]);
  });

  it("persists rate-limit reset across endpoints, profiles, and manual checks", async () => {
    const resetAt = Date.now() + 60 * 60_000;
    network.mockResolvedValueOnce(new Response("limited", { status: 403, headers: {
      "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetAt / 1_000),
    } }));
    expect((await read(APP, { manual: true })).status).toBe(403);
    await defer(read(GIT, { manual: true }));
    await defer(read(SNAP));
    expect(() => reserveAppReleaseCheck(true, options())).toThrow(ReleaseCheckDeferredError);
    expect(network).toHaveBeenCalledTimes(1);
    vi.setSystemTime(resetAt);
    await read(GIT);
    expect(network).toHaveBeenCalledTimes(2);
  });

  it("persists exponential failure backoff and honors Retry-After", async () => {
    await defer(read());
    vi.setSystemTime(Date.now() + RELEASE_FIRST_CHECK_DELAY_MS);
    network.mockResolvedValue(new Response("unavailable", { status: 503 }));
    await read();
    await defer(read());
    vi.setSystemTime(Date.now() + 5 * 60_000);
    await read();
    vi.setSystemTime(Date.now() + 5 * 60_000);
    await defer(read());
    expect(network).toHaveBeenCalledTimes(2);
    network.mockResolvedValueOnce(new Response("limited", { status: 429, headers: { "retry-after": "7200" } }));
    await read(APP, { manual: true });
    vi.setSystemTime(Date.now() + 60 * 60_000);
    await defer(read(GIT, { manual: true }));
    expect(network).toHaveBeenCalledTimes(3);
  });

  it("reserves before awaiting HTTP so concurrent processes cannot both spend a request", async () => {
    let complete!: (response: Response) => void;
    network.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const first = read(APP, { manual: true });
    vi.resetModules();
    const otherProcess = await import("../github-release-cache");
    await expect(otherProcess.fetchGitHubReleaseMetadata(APP, {}, { ...options(), manual: true }))
      .rejects.toMatchObject({ name: "ReleaseCheckDeferredError" });
    expect(network).toHaveBeenCalledTimes(1);
    complete(new Response("[]"));
    await first;
  });

  it("retains the attempt reservation after an interrupted request", async () => {
    await defer(read());
    vi.setSystemTime(Date.now() + RELEASE_FIRST_CHECK_DELAY_MS);
    await read(APP, { manual: true });
    const file = path.join(directory, "state.json");
    const state = JSON.parse(readFileSync(file, "utf8"));
    const entry = Object.values(state.entries)[0] as Record<string, unknown>;
    delete entry.body;
    entry.pendingUntil = Date.now() + 30_000;
    writeFileSync(file, JSON.stringify(state));
    await defer(read(APP, { manual: true }));
    vi.setSystemTime(Date.now() + 31_000);
    await defer(read());
    expect(network).toHaveBeenCalledTimes(1);
  });
});
