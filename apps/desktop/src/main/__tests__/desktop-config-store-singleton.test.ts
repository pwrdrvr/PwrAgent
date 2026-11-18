import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const paths = vi.hoisted(() => ({ configPath: "" }));

vi.mock("../storage/desktop-settings-storage", () => ({
  createDesktopConfigSnapshotStorage: () => undefined,
  getAppStateMode: () => "profile",
}));

vi.mock("../settings/desktop-config", async (importOriginal) => ({
  ...await importOriginal<typeof import("../settings/desktop-config")>(),
  resolveDesktopConfigPath: () => paths.configPath,
}));

const { disposeDesktopConfigStore, initializeDesktopConfigStore } = await import(
  "../settings/config-store/desktop-config-store-singleton"
);

const LEGACY = [
  "[experimental]",
  "incremental_markdown_rendering = false",
  "",
].join("\n");

const tempRoots: string[] = [];

afterEach(() => {
  disposeDesktopConfigStore();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function useConfig(text: string): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-store-init-"));
  tempRoots.push(root);
  paths.configPath = path.join(root, "config.toml");
  fs.writeFileSync(paths.configPath, text);
}

describe("initializeDesktopConfigStore legacy retirement", () => {
  it("retires due legacy keys before the store first reads the file", () => {
    useConfig(LEGACY);

    const store = initializeDesktopConfigStore({ appVersion: "1.6.0" });

    const text = fs.readFileSync(paths.configPath, "utf8");
    expect(text).not.toContain("incremental_markdown_rendering");
    expect(text).toContain("incremental_rendering = false");
    expect(store.read("general").settings.markdown?.incrementalRendering).toBe(false);
  });

  it("leaves the file alone in the kept series and without a version", () => {
    useConfig(LEGACY);
    initializeDesktopConfigStore({ appVersion: "1.5.4" });
    expect(fs.readFileSync(paths.configPath, "utf8")).toBe(LEGACY);
    disposeDesktopConfigStore();

    initializeDesktopConfigStore();
    expect(fs.readFileSync(paths.configPath, "utf8")).toBe(LEGACY);
  });
});
