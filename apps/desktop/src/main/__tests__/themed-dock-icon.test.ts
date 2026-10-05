import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DESKTOP_DARK_THEMES } from "@pwragent/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  setIcon: vi.fn(),
  isPackaged: false,
  createFromPath: vi.fn((file: string) => ({ file, isEmpty: () => false })),
  createEmpty: vi.fn(() => ({ file: "<empty>", isEmpty: () => true })),
}));

vi.mock("electron", () => ({
  app: {
    dock: { setIcon: electronMocks.setIcon },
    get isPackaged() {
      return electronMocks.isPackaged;
    },
    getAppPath: () => "/app",
  },
  nativeImage: {
    createFromPath: electronMocks.createFromPath,
    createEmpty: electronMocks.createEmpty,
  },
}));

import {
  resetThemedDockIconForTests,
  syncThemedDockIcon,
  themedDockIconFile,
} from "../themed-dock-icon";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const iconsDir = path.resolve(testDir, "../../../build/dock-icons");
const originalPlatform = process.platform;
// Electron types `resourcesPath` as always set; under vitest it is absent.
const originalResourcesPath = Object.getOwnPropertyDescriptor(process, "resourcesPath");

function appliedFiles(): string[] {
  return electronMocks.setIcon.mock.calls.map(([icon]) => (icon as { file: string }).file);
}

describe("themed dock icon", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    electronMocks.isPackaged = false;
    electronMocks.setIcon.mockClear();
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

  it("ships an icon for every dark theme but Tangerine", () => {
    for (const theme of DESKTOP_DARK_THEMES) {
      const file = themedDockIconFile(theme, true);
      if (theme === "tangerine-dark") {
        expect(file).toBeNull();
      } else {
        expect(existsSync(path.join(iconsDir, file ?? "")), theme).toBe(true);
      }
    }
  });

  it("follows the dark theme, and leaves the app icon alone until it changes", () => {
    syncThemedDockIcon({ darkTheme: "tangerine-dark", themedDockIcon: true });
    expect(electronMocks.setIcon).not.toHaveBeenCalled();

    syncThemedDockIcon({ darkTheme: "blue-dark", themedDockIcon: true });
    syncThemedDockIcon({ darkTheme: "blue-dark", themedDockIcon: true });
    expect(appliedFiles()).toEqual(["/app/build/dock-icons/blue-dark.png"]);

    // Back to the app's own icon: the padded development icon here.
    syncThemedDockIcon({ darkTheme: "tangerine-dark", themedDockIcon: true });
    expect(appliedFiles().at(-1)).toBe("/app/build/icon-macos.png");
  });

  it("restores the bundle icon in a packaged app when the operator opts out", () => {
    electronMocks.isPackaged = true;
    Object.defineProperty(process, "resourcesPath", {
      value: "/Applications/PwrAgent.app/Contents/Resources",
      configurable: true,
    });
    syncThemedDockIcon({ darkTheme: "solarized-dark", themedDockIcon: true });
    expect(appliedFiles().at(-1)).toBe(
      "/Applications/PwrAgent.app/Contents/Resources/dock-icons/solarized-dark.png",
    );

    syncThemedDockIcon({ darkTheme: "solarized-dark", themedDockIcon: false });
    expect(appliedFiles().at(-1)).toBe("<empty>");
  });

  it("does nothing off macOS", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    syncThemedDockIcon({ darkTheme: "blue-dark", themedDockIcon: true });
    expect(electronMocks.setIcon).not.toHaveBeenCalled();
  });
});
