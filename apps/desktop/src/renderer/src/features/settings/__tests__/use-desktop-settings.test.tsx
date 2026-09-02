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

  it("observes normalized config changes published by another process", async () => {
    let runtimeChanged:
      | Parameters<NonNullable<DesktopApi["onSettingsRuntimeChanged"]>>[0]
      | undefined;
    const firstSnapshot = {} as DesktopSettingsSnapshot;
    const externalSnapshot = {
      models: { codex: { path: { value: "/external/codex" } } },
    } as unknown as DesktopSettingsSnapshot;
    const readSettings = vi
      .fn<NonNullable<DesktopApi["readSettings"]>>()
      .mockResolvedValueOnce({ snapshot: firstSnapshot })
      .mockResolvedValueOnce({ snapshot: externalSnapshot });
    const desktopApi: DesktopApi = {
      onSettingsRuntimeChanged: (callback) => {
        runtimeChanged = callback;
        return () => {
          runtimeChanged = undefined;
        };
      },
      readSettings,
    };
    const { result } = renderHook(() => useDesktopSettings(desktopApi));
    await vi.waitFor(() => expect(result.current.snapshot).toBe(firstSnapshot));

    act(() => runtimeChanged?.({
      version: 2,
      configRevision: "external",
      changedDomains: ["providers"],
    }));

    await vi.waitFor(() => {
      expect(readSettings).toHaveBeenCalledTimes(2);
      expect(result.current.snapshot).toBe(externalSnapshot);
    });
  });

  it("coalesces its own config event while preserving a newer external edit", async () => {
    let runtimeChanged:
      | Parameters<NonNullable<DesktopApi["onSettingsRuntimeChanged"]>>[0]
      | undefined;
    let resolveWrite:
      | ((value: Awaited<ReturnType<
        NonNullable<DesktopApi["writeSettingsConfig"]>
      >>) => void)
      | undefined;
    const initialSnapshot = {} as DesktopSettingsSnapshot;
    const writtenSnapshot = {
      models: { codex: { path: { value: "/written/codex" } } },
    } as unknown as DesktopSettingsSnapshot;
    const externalSnapshot = {
      models: { codex: { path: { value: "/external/codex" } } },
    } as unknown as DesktopSettingsSnapshot;
    const readSettings = vi
      .fn<NonNullable<DesktopApi["readSettings"]>>()
      .mockResolvedValueOnce({ snapshot: initialSnapshot })
      .mockResolvedValueOnce({ snapshot: externalSnapshot });
    const writeSettingsConfig = vi
      .fn<NonNullable<DesktopApi["writeSettingsConfig"]>>()
      .mockImplementation(async () => await new Promise((resolve) => {
        resolveWrite = resolve;
      }));
    const desktopApi: DesktopApi = {
      onSettingsRuntimeChanged: (callback) => {
        runtimeChanged = callback;
        return () => {
          runtimeChanged = undefined;
        };
      },
      readSettings,
      writeSettingsConfig,
    };
    const { result } = renderHook(() => useDesktopSettings(desktopApi));
    await vi.waitFor(() => expect(result.current.snapshot).toBe(initialSnapshot));

    const write = result.current.writeConfig({
      models: { codex: { path: "/written/codex" } },
    });
    await vi.waitFor(() => expect(writeSettingsConfig).toHaveBeenCalledOnce());
    act(() => {
      runtimeChanged?.({
        version: 2,
        configRevision: "written",
        changedDomains: ["providers"],
      });
      runtimeChanged?.({
        version: 3,
        configRevision: "external",
        changedDomains: ["providers"],
      });
    });
    await act(async () => {
      resolveWrite?.({
        update: {
          version: 2,
          configRevision: "written",
          changedDomains: ["providers"],
          normalizedPatch: {
            models: { codex: { path: "/written/codex" } },
          },
          scheduledProviderRefreshes: [],
        },
        snapshot: writtenSnapshot,
      });
      await write;
    });

    await vi.waitFor(() => {
      expect(readSettings).toHaveBeenCalledTimes(2);
      expect(result.current.snapshot).toBe(externalSnapshot);
    });
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
