import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DesktopAppearanceTheme, DesktopDarkTheme, DesktopLightTheme } from "@pwragent/shared";
import { DESKTOP_DARK_THEMES, DESKTOP_LIGHT_THEMES } from "@pwragent/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  setIcon: vi.fn(),
  isPackaged: false,
  createFromPath: vi.fn((file: string) => ({ file, isEmpty: () => false })),
  createEmpty: vi.fn(() => ({ file: "<empty>", isEmpty: () => true })),
  osDark: true,
  nativeThemeListeners: [] as Array<() => void>,
}));

const osMocks = vi.hoisted(() => ({ release: "25.6.0" }));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  release: () => osMocks.release,
}));

vi.mock("electron", () => ({
  app: {
    dock: { setIcon: electronMocks.setIcon },
    get isPackaged() {
      return electronMocks.isPackaged;
    },
    getAppPath: () => "/app",
  },
  nativeTheme: {
    get shouldUseDarkColors() {
      return electronMocks.osDark;
    },
    on: (_event: string, listener: () => void) => {
      electronMocks.nativeThemeListeners.push(listener);
    },
  },
  nativeImage: {
    createFromPath: electronMocks.createFromPath,
    createEmpty: electronMocks.createEmpty,
  },
}));

import {
  developmentDockIconPath,
  drawsLiquidGlassIcons,
  resetThemedDockIconForTests,
  syncThemedDockIcon,
  themedDockIconFile,
} from "../themed-dock-icon";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const iconsDir = path.resolve(testDir, "../../../build/dock-icons");
const originalPlatform = process.platform;
// Electron types `resourcesPath` as always set; under vitest it is absent.
const originalResourcesPath = Object.getOwnPropertyDescriptor(process, "resourcesPath");

/** A profile appearance: dark Tangerine and light Tangerine unless given. */
function appearance(options: {
  theme?: DesktopAppearanceTheme;
  darkTheme?: DesktopDarkTheme;
  lightTheme?: DesktopLightTheme;
  themedDockIcon?: boolean;
}) {
  return {
    theme: options.theme ?? "dark",
    darkTheme: options.darkTheme ?? "tangerine-dark",
    lightTheme: options.lightTheme ?? "tangerine-light",
    themedDockIcon: options.themedDockIcon ?? true,
  };
}

function appliedFiles(): string[] {
  return electronMocks.setIcon.mock.calls.map(([icon]) => (icon as { file: string }).file);
}

describe("themed dock icon", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    electronMocks.isPackaged = false;
    electronMocks.setIcon.mockClear();
    electronMocks.osDark = true;
    osMocks.release = "25.6.0";
    resetThemedDockIconForTests();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    if (originalResourcesPath) {
      Object.defineProperty(process, "resourcesPath", originalResourcesPath);
    } else {
      Reflect.deleteProperty(process, "resourcesPath");
    }
  });

  it("ships a flat and a glass icon for every color theme but Tangerine's", () => {
    for (const liquidGlass of [false, true]) {
      for (const theme of [...DESKTOP_DARK_THEMES, ...DESKTOP_LIGHT_THEMES]) {
        const file = themedDockIconFile(theme, true, liquidGlass);
        if (theme === "tangerine-dark" || theme === "tangerine-light") {
          expect(file).toBeNull();
        } else {
          expect(existsSync(path.join(iconsDir, file ?? "")), `${theme} ${file}`).toBe(true);
        }
      }
    }
    expect(themedDockIconFile("blue-dark", true, true)).toBe(path.join("glass", "blue-dark.png"));
    expect(themedDockIconFile("blue-dark", true, false)).toBe("blue-dark.png");
  });

  it("draws Liquid Glass icons from macOS 26 (Darwin 25)", () => {
    expect(drawsLiquidGlassIcons("24.6.0")).toBe(false);
    expect(drawsLiquidGlassIcons("25.0.0")).toBe(true);
    expect(drawsLiquidGlassIcons("26.1.0")).toBe(true);
  });

  it("shows the flat icons before macOS 26", () => {
    osMocks.release = "24.6.0";
    syncThemedDockIcon(appearance({ darkTheme: "blue-dark" }));
    syncThemedDockIcon(appearance({ darkTheme: "tangerine-dark" }));
    expect(appliedFiles()).toEqual([
      path.join("/app", "build/dock-icons", "blue-dark.png"),
      path.join("/app", "build/icon-macos.png"),
    ]);
  });

  it("ships a flat and a glass development icon", () => {
    const appPath = path.resolve(testDir, "../../..");
    for (const liquidGlass of [false, true]) {
      expect(existsSync(developmentDockIconPath(appPath, liquidGlass)), String(liquidGlass)).toBe(true);
    }
    expect(developmentDockIconPath("/app", true)).toBe(path.join("/app", "build/icon-macos-glass.png"));
    expect(developmentDockIconPath("/app", false)).toBe(path.join("/app", "build/icon-macos.png"));
  });

  it("follows the dark theme, and leaves the app icon alone until it changes", () => {
    syncThemedDockIcon(appearance({ darkTheme: "tangerine-dark" }));
    expect(electronMocks.setIcon).not.toHaveBeenCalled();

    syncThemedDockIcon(appearance({ darkTheme: "blue-dark" }));
    syncThemedDockIcon(appearance({ darkTheme: "blue-dark" }));
    expect(appliedFiles()).toEqual([path.join("/app", "build/dock-icons", "glass", "blue-dark.png")]);

    // Back to the app's own icon: the glass development icon here.
    syncThemedDockIcon(appearance({ darkTheme: "tangerine-dark" }));
    expect(appliedFiles().at(-1)).toBe(path.join("/app", "build/icon-macos-glass.png"));
  });

  it("restores the bundle icon in a packaged app when the operator opts out", () => {
    electronMocks.isPackaged = true;
    Object.defineProperty(process, "resourcesPath", {
      value: "/Applications/PwrAgent.app/Contents/Resources",
      configurable: true,
    });
    syncThemedDockIcon(appearance({ darkTheme: "solarized-dark" }));
    expect(appliedFiles().at(-1)).toBe(
      path.join("/Applications/PwrAgent.app/Contents/Resources", "dock-icons", "glass", "solarized-dark.png"),
    );

    syncThemedDockIcon(appearance({ darkTheme: "solarized-dark", themedDockIcon: false }));
    expect(appliedFiles().at(-1)).toBe("<empty>");
  });

  it("shows the light theme's icon in the light appearance", () => {
    syncThemedDockIcon(appearance({ theme: "light", darkTheme: "blue-dark", lightTheme: "solarized-light" }));
    expect(appliedFiles()).toEqual([path.join("/app", "build/dock-icons", "glass", "solarized-light.png")]);

    // Tangerine Light is the app's own icon, like Tangerine dark.
    syncThemedDockIcon(appearance({ theme: "light", darkTheme: "blue-dark" }));
    expect(appliedFiles().at(-1)).toBe(path.join("/app", "build/icon-macos-glass.png"));
  });

  it("flips with the OS in the System appearance", () => {
    syncThemedDockIcon(appearance({ theme: "system", darkTheme: "blue-dark", lightTheme: "blue-light" }));
    electronMocks.osDark = false;
    for (const listener of electronMocks.nativeThemeListeners) listener();
    // An `updated` that changes nothing repaints nothing.
    for (const listener of electronMocks.nativeThemeListeners) listener();
    electronMocks.osDark = true;
    for (const listener of electronMocks.nativeThemeListeners) listener();
    expect(appliedFiles()).toEqual([
      path.join("/app", "build/dock-icons", "glass", "blue-dark.png"),
      path.join("/app", "build/dock-icons", "glass", "blue-light.png"),
      path.join("/app", "build/dock-icons", "glass", "blue-dark.png"),
    ]);
  });

  it("does nothing off macOS", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    syncThemedDockIcon(appearance({ darkTheme: "blue-dark" }));
    expect(electronMocks.setIcon).not.toHaveBeenCalled();
  });
});
