import { mkdtemp, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureNamedProfileExists, readProfilesRegistry, resolveProfilesRegistryPath } from "../src/main/profile";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import { launchElectronApp } from "./fixtures/electron-app";
import { expect, test } from "./fixtures/electron-test";
import { removeTempRoot } from "./fixtures/temp-root-cleanup";

test("Windows starts an unregistered profile while the registry is open and registers it after release", async () => {
  test.skip(process.platform !== "win32", "Windows can reject replacing an open registry file.");
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-e2e-profile-registry-"));
  const env = { PWRAGENT_HOME: root, PWRAGENT_PROFILE: "dev" };
  let app: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
  const registeredProfiles = () => readProfilesRegistry({ env }).profiles.map(({ name }) => name);
  try {
    // The harness seeds the dev directory. Only default starts in the registry.
    ensureNamedProfileExists("default", { env });
    const registry = await open(resolveProfilesRegistryPath({ env }), "r");
    try {
      app = await launchElectronApp({
        fixturePath: path.join(import.meta.dirname, "fixtures/smoke/replay.fixture.json"),
        env,
      });
      const profiles = await app.window.evaluate(async () =>
        await (window as unknown as { pwragent: DesktopApi }).pwragent.listPwrAgentProfiles!());
      expect(profiles.activeProfile).toBe("dev");
      expect(registeredProfiles()).toEqual(["default"]);
    } finally {
      await registry.close();
    }
    await expect.poll(registeredProfiles).toEqual(["default", "dev"]);
  } finally {
    try {
      await app?.close();
    } finally {
      await removeTempRoot(root);
    }
  }
});
