import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexDiscoverySnapshot } from "@pwrdrvr/codex-discovery";
import type { OpenAiCodexCheckMode, OpenAiCodexRuntime } from "../codex-openai-runtime";
import { DesktopConfigStore } from "../settings/config-store/desktop-config-store";
import { MemoryDesktopSecretStore } from "../settings/desktop-secret-store";
import { DesktopSettingsService } from "../settings/desktop-settings-service";
import { issueProviderDiscoveryPermit } from "../settings/provider-discovery-permit";

// See desktop-settings-service.test.ts: the real kit probes every install
// location on this machine.
vi.mock("@pwrdrvr/codex-discovery", async (importOriginal) => {
  const { stubbedCodexDiscovery } = await import("./helpers/codex-discovery-stub");
  return stubbedCodexDiscovery(await importOriginal<typeof import("@pwrdrvr/codex-discovery")>());
});

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const STOCK: OpenAiCodexRuntime = {
  command: "/pwragent/agents/codex/openai/versions/0.172.0/bin/codex",
  version: "0.172.0",
  versionRoot: "/pwragent/agents/codex/openai/versions/0.172.0",
  metadata: {
    schemaVersion: 1,
    version: "0.172.0",
    target: "aarch64-apple-darwin",
    sha256: "0".repeat(64),
    installedAt: 0,
    checkedAt: 0,
  },
};

const NOTHING_FOUND: CodexDiscoverySnapshot = { candidates: [] };
const CURRENT_PATH_CODEX: CodexDiscoverySnapshot = {
  candidates: [{ command: "/usr/local/bin/codex", source: "path", executable: true, selected: true, version: "0.165.0" }],
  selectedCommand: "/usr/local/bin/codex",
  selectedSource: "path",
};

function createService(params: {
  discovery: CodexDiscoverySnapshot;
  installed: () => OpenAiCodexRuntime | undefined;
  install?: () => OpenAiCodexRuntime | undefined;
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-openai-codex-"));
  tempRoots.push(root);
  const configPath = path.join(root, "config.toml");
  const ensure = vi.fn(async ({ checkMode }: { checkMode: OpenAiCodexCheckMode }) =>
    checkMode === "force" ? params.install?.() : params.installed());
  const service = new DesktopSettingsService({
    configPath,
    configStore: new DesktopConfigStore({ configPath }),
    env: {},
    secretStore: new MemoryDesktopSecretStore(),
    codexDiscoveryCoordinator: {
      discover: vi.fn(async () => params.discovery),
      invalidate: vi.fn(),
      resolve: vi.fn(),
    },
    ensureOpenAiCodexRuntime: ensure,
  });
  return { service, ensure };
}

describe("PwrAgent-installed OpenAI Codex", () => {
  it("installs on request and becomes the Codex a machine without one launches", async () => {
    let installed: OpenAiCodexRuntime | undefined;
    const { service, ensure } = createService({
      discovery: NOTHING_FOUND,
      installed: () => installed,
      install: () => (installed = STOCK),
    });
    const snapshot = await service.refreshCodexDiscovery(
      issueProviderDiscoveryPermit("setup-user-action"),
      { installOpenAiCodex: true },
    );
    expect(ensure.mock.calls.map(([options]) => options.checkMode)).toEqual(["force", "read", "ttl"]);
    expect(await service.resolveCodexCommand()).toMatchObject({ command: STOCK.command, version: "0.172.0" });
    expect(snapshot.models.codex.discovery?.selectedCommand).toBe(STOCK.command);
  });

  it("surfaces a failed install instead of discovering without it", async () => {
    const { service } = createService({
      discovery: NOTHING_FOUND,
      installed: () => undefined,
      install: () => { throw new Error("offline"); },
    });
    await expect(service.refreshCodexDiscovery(
      issueProviderDiscoveryPermit("setup-user-action"),
      { installOpenAiCodex: true },
    )).rejects.toThrow("offline");
  });

  it("leaves a working PATH Codex in charge and does not update an install nobody runs", async () => {
    const { service, ensure } = createService({ discovery: CURRENT_PATH_CODEX, installed: () => STOCK });
    await service.refreshCodexDiscovery(issueProviderDiscoveryPermit("settings-user-action"));
    expect((await service.resolveCodexCommand()).command).toBe("/usr/local/bin/codex");
    expect(ensure.mock.calls.map(([options]) => options.checkMode)).toEqual(["read"]);
  });

  it("does nothing on a routine refresh when nothing is installed", async () => {
    const { service, ensure } = createService({ discovery: NOTHING_FOUND, installed: () => undefined });
    await service.refreshCodexDiscovery(issueProviderDiscoveryPermit("settings-user-action"));
    await expect(service.resolveCodexCommand()).rejects.toThrow("has not selected");
    expect(ensure.mock.calls.map(([options]) => options.checkMode)).toEqual(["read"]);
  });
});
