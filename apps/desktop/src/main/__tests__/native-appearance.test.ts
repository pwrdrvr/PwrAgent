import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  getAllWindows: vi.fn(),
  nativeThemeOn: vi.fn(),
  systemUsesDarkColors: false,
}));

const appearanceMocks = vi.hoisted(() => ({
  appearance: {
    density: "mission-control" as const,
    sidebarTextSize: "md" as const,
    theme: "system" as "system" | "dark" | "light",
    transcriptTextSize: "md" as const,
  },
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: electronMocks.getAllWindows,
  },
  nativeTheme: {
    get shouldUseDarkColors() {
      return electronMocks.systemUsesDarkColors;
    },
    on: electronMocks.nativeThemeOn,
  },
}));

vi.mock("../settings/appearance-bootstrap", async (importOriginal) => ({
  ...await importOriginal<typeof import("../settings/appearance-bootstrap")>(),
  readBootstrapAppearance: () => appearanceMocks.appearance,
}));

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

beforeEach(() => {
  setPlatform("win32");
  electronMocks.getAllWindows.mockReset();
  electronMocks.getAllWindows.mockReturnValue([]);
  electronMocks.nativeThemeOn.mockReset();
  electronMocks.systemUsesDarkColors = false;
  appearanceMocks.appearance.theme = "system";
  vi.resetModules();
});

afterEach(() => {
  setPlatform(originalPlatform);
});

describe("native appearance", () => {
  it("resolves the system theme through Electron for window and title-bar colors", async () => {
    const {
      themedTitleBarOverlay,
      themedWindowBackgroundColor,
    } = await import("../native-appearance");

    expect(themedWindowBackgroundColor(appearanceMocks.appearance)).toBe(
      "#fdfcfa",
    );
    expect(themedTitleBarOverlay(appearanceMocks.appearance)).toEqual({
      color: "#f7f4ef",
      height: 40,
      symbolColor: "#3a3a3a",
    });

    electronMocks.systemUsesDarkColors = true;

    expect(themedWindowBackgroundColor(appearanceMocks.appearance)).toBe(
      "#10151f",
    );
    expect(themedTitleBarOverlay(appearanceMocks.appearance)).toEqual({
      color: "#050505",
      height: 40,
      symbolColor: "#c8ccd4",
    });
  });

  it("keeps explicit themes independent of the OS appearance", async () => {
    const { themedTitleBarOverlay } = await import("../native-appearance");

    electronMocks.systemUsesDarkColors = true;
    appearanceMocks.appearance.theme = "light";
    expect(themedTitleBarOverlay(appearanceMocks.appearance).color).toBe(
      "#f7f4ef",
    );

    electronMocks.systemUsesDarkColors = false;
    appearanceMocks.appearance.theme = "dark";
    expect(themedTitleBarOverlay(appearanceMocks.appearance).color).toBe(
      "#050505",
    );
  });

  it("refreshes every overlay when the Windows system appearance changes", async () => {
    const setTitleBarOverlay = vi.fn();
    electronMocks.getAllWindows.mockReturnValue([
      { setTitleBarOverlay },
      {
        setTitleBarOverlay: vi.fn(() => {
          throw new Error("no overlay");
        }),
      },
    ]);
    const { installWindowsTitleBarAppearanceSync } = await import(
      "../native-appearance"
    );

    installWindowsTitleBarAppearanceSync();
    installWindowsTitleBarAppearanceSync();

    expect(electronMocks.nativeThemeOn).toHaveBeenCalledOnce();
    expect(electronMocks.nativeThemeOn).toHaveBeenCalledWith(
      "updated",
      expect.any(Function),
    );

    const handleUpdated = electronMocks.nativeThemeOn.mock.calls[0]?.[1] as
      | (() => void)
      | undefined;
    expect(handleUpdated).toBeDefined();
    handleUpdated?.();
    expect(setTitleBarOverlay).toHaveBeenLastCalledWith({
      color: "#f7f4ef",
      height: 40,
      symbolColor: "#3a3a3a",
    });

    electronMocks.systemUsesDarkColors = true;
    handleUpdated?.();
    expect(setTitleBarOverlay).toHaveBeenLastCalledWith({
      color: "#050505",
      height: 40,
      symbolColor: "#c8ccd4",
    });
  });
});
