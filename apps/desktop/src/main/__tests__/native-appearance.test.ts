import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DesktopDarkTheme, DesktopLightTheme } from "@pwragent/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  getAllWindows: vi.fn(),
  nativeThemeOn: vi.fn(),
  systemUsesDarkColors: false,
}));

const appearanceMocks = vi.hoisted(() => ({
  appearance: {
    density: "mission-control" as const,
    darkTheme: "tangerine-dark" as DesktopDarkTheme,
    lightTheme: "tangerine-light" as DesktopLightTheme,
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
  appearanceMocks.appearance.darkTheme = "tangerine-dark";
  appearanceMocks.appearance.lightTheme = "tangerine-light";
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

  it("paints the dark or light theme the scheme resolves to", async () => {
    const {
      themedTitleBarOverlay,
      themedWindowBackgroundColor,
    } = await import("../native-appearance");

    appearanceMocks.appearance.darkTheme = "solarized-dark";
    appearanceMocks.appearance.lightTheme = "catppuccin-latte";
    expect(themedWindowBackgroundColor(appearanceMocks.appearance)).toBe(
      "#eff1f5",
    );
    expect(themedTitleBarOverlay(appearanceMocks.appearance).color).toBe(
      "#e6e9ef",
    );

    electronMocks.systemUsesDarkColors = true;
    expect(themedWindowBackgroundColor(appearanceMocks.appearance)).toBe(
      "#002b36",
    );
    expect(themedTitleBarOverlay(appearanceMocks.appearance).color).toBe(
      "#073642",
    );
  });

  it("matches every color theme's window colors to its app.css block", async () => {
    const { COLOR_THEME_WINDOW_COLORS } = await import("../native-appearance");
    const css = readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../renderer/src/styles/app.css",
      ),
      "utf8",
    );
    for (const [theme, colors] of Object.entries(COLOR_THEME_WINDOW_COLORS)) {
      if (theme.startsWith("tangerine-")) continue;
      const block = css.match(
        new RegExp(`:root\\[data-color-theme="${theme}"\\] \\{([\\s\\S]*?)\\n\\}`),
      )?.[1];
      expect(block, theme).toBeDefined();
      expect(block, theme).toContain(`--bg-app: ${colors.window};`);
      expect(block, theme).toContain(`--bg-sidebar: ${colors.titleBar};`);
    }
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
