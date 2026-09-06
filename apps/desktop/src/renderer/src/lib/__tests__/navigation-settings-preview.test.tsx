import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NavigationDirectoryRow, NavigationQueryPage } from "@pwragent/shared";
import type { DesktopApi } from "../desktop-api";
import { readNavigationLaunchpadKeys, readNavigationModelInventory, useNavigationSettingsPreview } from "../navigation-settings-preview";

function page(patch: Partial<NavigationQueryPage> = {}): NavigationQueryPage {
  return { protocol: 2, queryKey: "query", generation: "generation", ownerEpoch: "owner", countsRevision: "revision",
    counts: { total: 1000, active: 0, unread: 0, review: 0 }, coverage: { state: "complete" }, entries: [], complete: true, ...patch };
}
function directory(key: string, backend?: NavigationDirectoryRow["launchpadBackend"]): NavigationDirectoryRow {
  return { key, kind: "directory", label: key, counts: { total: 0, active: 0, unread: 0, review: 0 },
    pinnedRootCount: 0, unpinnedRootCount: 0, launchpadPresent: Boolean(backend), launchpadBackend: backend };
}
function apiWith(read: DesktopApi["getNavigationQueryPage"]) {
  return { getNavigationQueryPage: read, releaseNavigationQuery: vi.fn(async () => {}), getNavigationSnapshot: vi.fn() } as unknown as DesktopApi;
}

describe("bounded settings previews", () => {
  it("reads every compact launchpad page and keeps only matching backend identities", async () => {
    const read = vi.fn().mockResolvedValueOnce(page({ complete: false, nextCursor: "next", directories: [directory("first", "codex")] }))
      .mockResolvedValueOnce(page({ directories: [directory("second", "acp:grok"), directory("third", "codex"), directory("no-launchpad")] }));
    const api = apiWith(read);
    expect(await readNavigationLaunchpadKeys(api, "codex")).toEqual(["first", "third"]);
    expect(read.mock.calls[0]![0]).toMatchObject({ consumer: "settings", query: { kind: "directory-index" }, pageSize: 100 });
    expect(read.mock.calls[1]![0].cursor).toBe("next");
    expect(read.mock.calls[0]![1]).toBe(read.mock.calls[1]![1]);
    expect(api.releaseNavigationQuery).toHaveBeenCalledWith(read.mock.calls[0]![1]);
    expect(api.getNavigationSnapshot).not.toHaveBeenCalled();
  });

  it("keeps all model inventory groups without retaining or requesting thread rows", async () => {
    const group = { backend: "codex" as const, model: "model", threadCount: 900, fastThreadCount: 500 };
    const read = vi.fn().mockResolvedValueOnce(page({ complete: false, nextCursor: "next", modelGroups: [group] }))
      .mockResolvedValueOnce(page({ modelGroups: [{ ...group, model: "other", threadCount: 100, fastThreadCount: 0 }] }));
    const api = apiWith(read);
    expect((await readNavigationModelInventory(api, "codex")).reduce((count, item) => count + item.threadCount, 0)).toBe(1000);
    expect(read.mock.calls[0]![0]).toMatchObject({ backend: "codex", query: { kind: "model-inventory" } });
    expect(api.getNavigationSnapshot).not.toHaveBeenCalled();
  });

  it("does not turn incomplete provider coverage or a missing resource into a zero count", async () => {
    const api = apiWith(vi.fn().mockResolvedValue(page({ coverage: { state: "degraded", failedProviders: 1 }, modelGroups: [] })));
    await expect(readNavigationModelInventory(api, "codex")).rejects.toThrow("inventory is incomplete");
    const missing = apiWith(vi.fn().mockResolvedValue(page()));
    await expect(readNavigationModelInventory(missing, "codex")).rejects.toThrow("Upgrade");
  });

  it("releases a pending query when its settings surface closes and rejects late results", async () => {
    let resolve!: (value: NavigationQueryPage) => void;
    const pending = new Promise<NavigationQueryPage>((done) => { resolve = done; });
    const read = vi.fn().mockReturnValue(pending);
    const api = apiWith(read);
    const hook = renderHook(() => useNavigationSettingsPreview(api));
    const result = hook.result.current.readModelInventory("codex").catch((error: unknown) => error);
    hook.unmount();
    expect(api.releaseNavigationQuery).toHaveBeenCalledWith(read.mock.calls[0]![1]);
    await act(async () => resolve(page({ modelGroups: [] })));
    expect(await result).toMatchObject({ name: "AbortError" });
  });
});
