import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { NavigationLaunchpadConfigResponse } from "@pwragent/shared";
import type { DesktopApi } from "../desktop-api";
import { useNavigationLaunchpadConfiguration } from "../useNavigationLaunchpadConfiguration";

it("fences late owner configuration and retains the current baseline after a failed refresh", async () => {
  let resolve!: (response: NavigationLaunchpadConfigResponse) => void;
  const pending = new Promise<NavigationLaunchpadConfigResponse>((done) => { resolve = done; });
  const current: NavigationLaunchpadConfigResponse = { protocol: 2, revision: "current", directoryKey: "directory:/repo",
    defaults: { backend: "codex", executionMode: "default" } };
  const read = vi.fn<NonNullable<DesktopApi["getNavigationLaunchpadConfig"]>>()
    .mockReturnValueOnce(pending).mockResolvedValueOnce(current).mockRejectedValueOnce(new Error("Disconnected"));
  const api: DesktopApi = { getNavigationLaunchpadConfig: read };
  const { result, rerender, unmount } = renderHook(({ owner }) => useNavigationLaunchpadConfiguration({ desktopApi: api,
    enabled: true, directoryKey: "directory:/repo", federationTarget: { scope: "remote", instanceId: owner } }),
  { initialProps: { owner: "old" } });
  rerender({ owner: "current" });
  await waitFor(() => expect(result.current.ready).toBe(true));
  await act(async () => resolve({ ...current, revision: "late-old-owner" }));
  expect(result.current.value?.revision).toBe("current");
  await act(async () => { await result.current.refresh(); });
  expect(result.current.ready).toBe(false);
  expect(result.current.error).toBe("Disconnected");
  expect(result.current.value?.revision).toBe("current");
  expect(read.mock.calls[2]?.[0].federationTarget).toEqual({ scope: "remote", instanceId: "current" });
  unmount();
});
