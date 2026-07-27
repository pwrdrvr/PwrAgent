import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DesktopSettingsSnapshot } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { BACKEND_SUMMARIES_REFRESH_EVENT } from "../../../lib/useBackendSummaries";
import { useDesktopSettings } from "../useDesktopSettings";

describe("useDesktopSettings", () => {
  it("refreshes backend summaries after ACP provider settings change", async () => {
    const onRefresh = vi.fn();
    const writeSettingsConfig = vi
      .fn<NonNullable<DesktopApi["writeSettingsConfig"]>>()
      .mockResolvedValue({
        snapshot: {} as DesktopSettingsSnapshot,
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
    } finally {
      window.removeEventListener(BACKEND_SUMMARIES_REFRESH_EVENT, onRefresh);
    }
  });
});
