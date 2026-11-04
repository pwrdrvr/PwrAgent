import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE, type AppearancePreference } from "../appearance";
import { useAppearance } from "../useAppearance";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-motion");
});

function mount(snapshotPreference: AppearancePreference | undefined) {
  const writeConfig = vi.fn(async () => true);
  const hook = renderHook(
    (props: { snapshotPreference: AppearancePreference | undefined }) =>
      useAppearance({
        snapshotPreference: props.snapshotPreference,
        writeConfig,
      }),
    { initialProps: { snapshotPreference } },
  );
  return { ...hook, writeConfig };
}

describe("useAppearance calm motion", () => {
  it("applies data-motion=calm, removes it again, and writes only the axis", () => {
    const { result, writeConfig } = mount(DEFAULT_APPEARANCE);
    expect(document.documentElement.hasAttribute("data-motion")).toBe(false);

    act(() => {
      result.current.setCalmMotion(true);
    });
    expect(result.current.appearance.calmMotion).toBe(true);
    expect(document.documentElement.dataset.motion).toBe("calm");
    expect(writeConfig).toHaveBeenLastCalledWith({
      general: { appearance: { calmMotion: true } },
    });

    act(() => {
      result.current.setCalmMotion(false);
    });
    expect(document.documentElement.hasAttribute("data-motion")).toBe(false);
    expect(writeConfig).toHaveBeenLastCalledWith({
      general: { appearance: { calmMotion: false } },
    });
  });

  it("adopts calm motion from a snapshot another window wrote", () => {
    const { result, rerender, writeConfig } = mount(DEFAULT_APPEARANCE);

    rerender({ snapshotPreference: { ...DEFAULT_APPEARANCE, calmMotion: true } });
    expect(result.current.appearance.calmMotion).toBe(true);
    expect(document.documentElement.dataset.motion).toBe("calm");
    // Adopting a snapshot is a read, never a write back.
    expect(writeConfig).not.toHaveBeenCalled();
  });
});
