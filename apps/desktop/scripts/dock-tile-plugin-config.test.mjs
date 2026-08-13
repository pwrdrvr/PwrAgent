import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readDesktopFile = (path) =>
  readFile(resolve(desktopRoot, path), "utf8");

describe("macOS Dock tile plug-in packaging", () => {
  it("embeds and registers the nested plug-in", async () => {
    const builderConfig = await readDesktopFile("electron-builder.yml");

    expect(builderConfig).toContain(
      "afterPack: \"scripts/afterpack-sign-dock-tile-plugin.mjs\"",
    );
    expect(builderConfig).toContain(
      "from: build/native/PwrAgentDockTilePlugin.plugin",
    );
    expect(builderConfig).toContain(
      "to: PlugIns/PwrAgentDockTilePlugin.plugin",
    );
    expect(builderConfig).toContain(
      "NSDockTilePlugIn: PwrAgentDockTilePlugin.plugin",
    );
  });

  it("builds a universal loadable bundle", async () => {
    const buildScript = await readDesktopFile(
      "scripts/build-dock-tile-plugin.mjs",
    );

    expect(buildScript).toContain("\"-bundle\"");
    expect(buildScript).toContain("\"arm64\"");
    expect(buildScript).toContain("\"x86_64\"");
    expect(buildScript).toContain("codesign");
  });

  it("launches only the containing app with a profile argument", async () => {
    const source = await readDesktopFile(
      "native/dock-tile-plugin/PwrAgentDockTilePlugin.m",
    );

    expect(source).toContain(".pwragent/dock-profiles.json");
    expect(source).toContain("@[@\"--profile\", profile]");
    expect(source).toContain("openApplicationAtURL:applicationURL");
    expect(source).not.toMatch(/NSTask|\/bin\/sh|sqlite/i);
  });
});
