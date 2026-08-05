import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigFromFile } from "electron-vite";
import { describe, expect, it } from "vitest";

const desktopRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const configPath = resolve(desktopRoot, "electron.vite.config.ts");
const packageJson = JSON.parse(
  await readFile(resolve(desktopRoot, "package.json"), "utf8"),
);
const dependencies = Object.keys(packageJson.dependencies);
const workspaceMessagingPackages = dependencies.filter(
  (name) =>
    name === "@pwragent/messaging-interface"
    || name.startsWith("@pwragent/messaging-provider-"),
);

async function loadDesktopConfig(command) {
  const result = await loadConfigFromFile(
    {
      command,
      mode: command === "build" ? "production" : "development",
    },
    configPath,
    desktopRoot,
  );
  return result.config;
}

describe("electron-vite dependency policy", () => {
  it.each(["build", "serve"])(
    "uses supported config-driven externalization for %s",
    async (command) => {
      const config = await loadDesktopConfig(command);
      const mainPlugins = config.main?.plugins ?? [];
      const preloadPlugins = config.preload?.plugins ?? [];

      expect(config.main?.build?.externalizeDeps).toBeTypeOf("object");
      expect(config.preload?.build?.externalizeDeps).toBeTypeOf("object");
      expect(mainPlugins).not.toContainEqual(
        expect.objectContaining({ name: "vite:externalize-deps" }),
      );
      expect(preloadPlugins).not.toContainEqual(
        expect.objectContaining({ name: "vite:externalize-deps" }),
      );
    },
  );

  it("bundles ws and every workspace messaging package in main", async () => {
    const config = await loadDesktopConfig("build");
    const excluded = config.main.build.externalizeDeps.exclude;

    expect(excluded).toEqual(expect.arrayContaining([
      "@pwragent/shared",
      ...workspaceMessagingPackages,
      "ws",
    ]));
  });

  it("keeps runtime and optional native dependencies external", async () => {
    const config = await loadDesktopConfig("build");
    const excluded = config.main.build.externalizeDeps.exclude;
    const explicitExternal = config.main.build.rollupOptions.external;
    const nativeRuntimeDependencies = [
      "@napi-rs/canvas",
      "better-sqlite3",
      "node-pty",
    ];

    expect(dependencies).toEqual(
      expect.arrayContaining(nativeRuntimeDependencies),
    );
    for (const dependency of nativeRuntimeDependencies) {
      expect(excluded).not.toContain(dependency);
    }
    expect(explicitExternal).toEqual([
      "abort-controller",
      "bufferutil",
      "node-fetch",
      "utf-8-validate",
      "zlib-sync",
    ]);
  });

  it("bundles only shared code into preload", async () => {
    const config = await loadDesktopConfig("build");

    expect(config.preload.build.externalizeDeps.exclude).toEqual([
      "@pwragent/shared",
    ]);
  });
});
