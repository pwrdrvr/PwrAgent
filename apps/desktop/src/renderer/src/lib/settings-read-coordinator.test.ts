import { describe, expect, it, vi } from "vitest";
import type { ReadDesktopSettingsResponse } from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";
import { readDesktopSettingsCoalesced } from "./settings-read-coordinator";

function response(fetchedAt: number): ReadDesktopSettingsResponse {
  return {
    snapshot: { fetchedAt } as ReadDesktopSettingsResponse["snapshot"],
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("renderer settings read coordinator", () => {
  it("coalesces concurrent reads from layered renderer consumers", async () => {
    const pending = deferred<ReadDesktopSettingsResponse>();
    const readSettings = vi.fn(() => pending.promise);
    const desktopApi = { readSettings } as DesktopApi;

    const first = readDesktopSettingsCoalesced(desktopApi);
    const second = readDesktopSettingsCoalesced(desktopApi);
    expect(readSettings).toHaveBeenCalledOnce();

    pending.resolve(response(1));
    await expect(first).resolves.toEqual(response(1));
    await expect(second).resolves.toEqual(response(1));
  });

  it("reuses a completed read for five seconds but honors a forced refresh", async () => {
    let now = 0;
    const readSettings = vi.fn()
      .mockResolvedValueOnce(response(1))
      .mockResolvedValueOnce(response(2));
    const desktopApi = { readSettings } as DesktopApi;

    await expect(
      readDesktopSettingsCoalesced(desktopApi, { now: () => now }),
    ).resolves.toEqual(response(1));
    now = 4_999;
    await expect(
      readDesktopSettingsCoalesced(desktopApi, { now: () => now }),
    ).resolves.toEqual(response(1));
    expect(readSettings).toHaveBeenCalledOnce();

    await expect(
      readDesktopSettingsCoalesced(desktopApi, {
        force: true,
        now: () => now,
      }),
    ).resolves.toEqual(response(2));
    expect(readSettings).toHaveBeenCalledTimes(2);
  });
});
