import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DesktopSettingsSnapshot } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { BACKEND_SUMMARIES_REFRESH_EVENT } from "../../../lib/useBackendSummaries";
import { useDesktopSettings } from "../useDesktopSettings";

describe("useDesktopSettings", () => {
  it("refreshes when a delayed managed runtime switch completes", async () => {
    let runtimeChanged: (() => void) | undefined;
    const readSettings = vi
      .fn<NonNullable<DesktopApi["readSettings"]>>()
      .mockResolvedValue({ snapshot: {} as DesktopSettingsSnapshot });
    const desktopApi: DesktopApi = {
      onSettingsRuntimeChanged: (callback) => {
        runtimeChanged = callback;
        return () => {
          runtimeChanged = undefined;
        };
      },
      readSettings,
    };
    renderHook(() => useDesktopSettings(desktopApi));
    await vi.waitFor(() => expect(readSettings).toHaveBeenCalledTimes(1));

    act(() => runtimeChanged?.());

    await vi.waitFor(() => expect(readSettings).toHaveBeenCalledTimes(2));
  });

  it("refreshes backend summaries after ACP provider settings change", async () => {
    const onRefresh = vi.fn();
    const normalizedSnapshot = {
      worktrees: {
        storage: { value: "custom" },
        effectivePath: "/normalized/worktrees",
      },
    } as unknown as DesktopSettingsSnapshot;
    const writeSettingsConfig = vi
      .fn<NonNullable<DesktopApi["writeSettingsConfig"]>>()
      .mockResolvedValue({
        update: {
          version: 2,
          configRevision: "next",
          changedDomains: ["providers"],
          normalizedPatch: {
            acpAgents: { gemini: { enabled: false } },
          },
          scheduledProviderRefreshes: ["gemini"],
        },
        snapshot: normalizedSnapshot,
      });
    const desktopApi: DesktopApi = {
      writeSettingsConfig,
    };
    window.addEventListener(BACKEND_SUMMARIES_REFRESH_EVENT, onRefresh);

    try {
      const { result } = renderHook(() => useDesktopSettings(desktopApi));

      await act(async () => {
        await expect(
          result.current.writeConfig({
            acpAgents: {
              gemini: {
                enabled: false,
              },
            },
          }),
        ).resolves.toBe(true);
      });

      expect(onRefresh).toHaveBeenCalledTimes(1);
      expect(result.current.snapshot).toBe(normalizedSnapshot);
    } finally {
      window.removeEventListener(BACKEND_SUMMARIES_REFRESH_EVENT, onRefresh);
    }
  });
});
