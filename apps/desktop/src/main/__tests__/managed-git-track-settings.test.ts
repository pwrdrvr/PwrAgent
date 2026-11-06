import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopSettingsService } from "../settings/desktop-settings-service";
import { MemoryDesktopSecretStore } from "../settings/desktop-secret-store";

// `DesktopSettingsService` builds a real `CodexDiscoveryCoordinator` unless the
// test injects one; keep its probe off this machine's Codex installs.
vi.mock("@pwrdrvr/codex-discovery", async (importOriginal) => {
  const { stubbedCodexDiscovery } = await import(
    "./helpers/codex-discovery-stub"
  );
  return stubbedCodexDiscovery(
    await importOriginal<typeof import("@pwrdrvr/codex-discovery")>(),
  );
});

const tempRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const SELECTION = [
  "[applications.git]",
  "path = \"\"",
  "managed = \"2.56.0-dev-pwrgit.5-1a2b3c4\"",
  "managed_previous = \"bundled\"",
  "",
].join("\n");

function createService(): { service: DesktopSettingsService; configPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-git-track-"));
  tempRoots.push(root);
  const configPath = path.join(root, "config.toml");
  fs.writeFileSync(configPath, SELECTION);
  return {
    service: new DesktopSettingsService({ configPath, env: {}, secretStore: new MemoryDesktopSecretStore() }),
    configPath,
  };
}

// No PwrDrvr Git runtime ships for Windows, so it has no track to follow.
describe.skipIf(process.platform === "win32")("Settings → Git → Build track", () => {
  it("writes only the track: no network, and the chosen Git stays chosen", async () => {
    const { service, configPath } = createService();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const before = service.resolveManagedGitSelection();

    const { snapshot, error } = await service.managedGitAction({ action: "track", track: "prerelease" });

    expect(error).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(snapshot.applications.git.managed?.track).toBe("prerelease");
    expect(service.resolveManagedGitSelection()).toBe(before);
    const written = fs.readFileSync(configPath, "utf8");
    expect(written).toContain("managed_build_channel = \"prerelease\"");
    expect(written.replace(/\nmanaged_build_channel = "prerelease"/u, "")).toBe(SELECTION.trimEnd() + "\n");
  });

  it("defaults to Latest and refuses a track it does not know", async () => {
    const { service, configPath } = createService();
    const { snapshot, error } = await service.managedGitAction({
      action: "track",
      track: "nightly" as "latest",
    });
    expect(error).toBe("Not a build track.");
    expect(snapshot.applications.git.managed?.track).toBe("latest");
    expect(fs.readFileSync(configPath, "utf8")).toBe(SELECTION);
  });
});
