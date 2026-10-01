import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopApplicationsSnapshot,
  DesktopGitDiscoverySnapshot,
  DesktopSettingsSnapshot,
} from "@pwragent/shared";
import { DesktopSettingsService } from "../settings/desktop-settings-service";
import { MemoryDesktopSecretStore } from "../settings/desktop-secret-store";
import { issueProviderDiscoveryPermit } from "../settings/provider-discovery-permit";
import { DesktopConfigStore } from "../settings/config-store/desktop-config-store";
import { discoverDesktopApplications } from "../settings/application-discovery";
import { discoverGitCommands } from "../settings/git-discovery";
import { discoverGhCommands } from "../settings/gh-discovery";
import { discoverGlabCommands } from "../settings/glab-discovery";
import { CodexAppServerClient } from "../codex-app-server/client";
import type { ManagedCodexRuntime } from "../codex-managed-runtime";

vi.mock("../settings/git-discovery", async (importOriginal) => ({
  ...await importOriginal<typeof import("../settings/git-discovery")>(),
  discoverGitCommands: vi.fn(),
}));
vi.mock("../settings/application-discovery", async (importOriginal) => ({
  ...await importOriginal<typeof import("../settings/application-discovery")>(),
  discoverDesktopApplications: vi.fn(),
}));
vi.mock("../settings/gh-discovery", async (importOriginal) => ({
  ...await importOriginal<typeof import("../settings/gh-discovery")>(),
  discoverGhCommands: vi.fn(),
}));
vi.mock("../settings/glab-discovery", async (importOriginal) => ({
  ...await importOriginal<typeof import("../settings/glab-discovery")>(),
  discoverGlabCommands: vi.fn(),
}));

const tempRoots: string[] = [];

afterEach(() => {
  vi.resetAllMocks();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function gate<T>(): { promise: Promise<T>; release: (value: T) => void } {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { release = resolve; });
  return { promise, release };
}

const GIT_DISCOVERY: DesktopGitDiscoverySnapshot = {
  selectedCommand: "/opt/pwragent/bundled/git",
  selectedSource: "bundled",
  candidates: [{
    command: "/opt/pwragent/bundled/git",
    source: "bundled",
    executable: true,
    selected: true,
    version: "2.53.0",
    lfsVersion: "3.7.1",
  }],
};

const APPLICATIONS_DISCOVERY: DesktopApplicationsSnapshot = {
  editors: [{
    id: "vscode",
    kind: "editor",
    name: "Visual Studio Code",
    source: "application",
    appPath: "/Applications/Visual Studio Code.app",
    canOpenWorkspace: true,
  }],
  terminals: [],
  preferredEditorId: { value: "", source: "default" },
  preferredTerminalId: { value: "", source: "default" },
  gh: {
    enabled: { value: false, source: "default" },
    path: { value: "", source: "default" },
    discovery: { candidates: [] },
  },
  git: {
    path: { value: "", source: "default" },
    discovery: { candidates: [] },
  },
};

describe("DesktopSettingsService startup discovery", () => {
  it.each([true, false])("handles failed discovery with a waiting command consumer: %s", async (waitingConsumer) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-settings-"));
    tempRoots.push(root);
    const configPath = path.join(root, "config.toml");
    const configStore = new DesktopConfigStore({ configPath });
    vi.mocked(discoverGitCommands).mockResolvedValue(GIT_DISCOVERY);
    vi.mocked(discoverDesktopApplications).mockResolvedValue(APPLICATIONS_DISCOVERY);
    vi.mocked(discoverGhCommands).mockResolvedValue({ candidates: [] });
    vi.mocked(discoverGlabCommands).mockResolvedValue({ candidates: [] });
    const failure = new Error("executable discovery failed");
    const service = new DesktopSettingsService({
      configPath, configStore, env: {}, secretStore: new MemoryDesktopSecretStore(),
      codexDiscoveryCoordinator: {
        discover: vi.fn(async () => { throw failure; }),
        invalidate: vi.fn(), resolve: vi.fn(),
      },
    });
    try {
      const startup = service.refreshStartupDiscovery(issueProviderDiscoveryPermit("startup"));
      if (waitingConsumer) {
        await expect(service.resolveCodexCommand()).rejects.toBe(failure);
      }
      await startup;
      expect(service.isCodexDiscoveryPending()).toBe(false);
    } finally {
      configStore.dispose();
    }
  });

  it.each([
    ["Token Miser", "[experimental]\ntoken_miser_enabled = true\n"],
    ["PwrAgent Codex build", "[models.codex]\nmanaged_builds = true\n"],
  ])("releases an initializing client before the %s runtime notification drains it", async (_setting, config) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-settings-"));
    tempRoots.push(root);
    const configPath = path.join(root, "config.toml");
    const ordinary = path.join(root, "ordinary-codex");
    fs.writeFileSync(configPath, config);
    fs.writeFileSync(ordinary, "fixture", { mode: 0o755 });
    const configStore = new DesktopConfigStore({ configPath });
    configStore.recordProviderDiscovery("codex", {
      candidates: [{ command: ordinary, source: "application", version: "0.153.4" }],
      selectedCommand: ordinary,
      selectedVersion: "0.153.4",
    });
    vi.mocked(discoverGitCommands).mockResolvedValue(GIT_DISCOVERY);
    vi.mocked(discoverDesktopApplications).mockResolvedValue(APPLICATIONS_DISCOVERY);
    vi.mocked(discoverGhCommands).mockResolvedValue({ candidates: [] });
    vi.mocked(discoverGlabCommands).mockResolvedValue({ candidates: [] });
    const installation = gate<ManagedCodexRuntime>();
    const commandRequested = gate<void>();
    const runtime: ManagedCodexRuntime = {
      command: path.join(root, "managed-codex"),
      appServerCommand: path.join(root, "codex-app-server"),
      codeModeHostCommand: path.join(root, "codex-code-mode-host"),
      metadata: {
        asset: "bundle", checkedAt: 1, installedAt: 1,
        repository: "pwrdrvr/codex", schemaVersion: 1,
        sha256: "a".repeat(64), tag: "pwragent-v0.200.0-pwragent.1",
        version: "0.200.0-pwragent.1",
      },
    };
    const service = new DesktopSettingsService({
      configPath, configStore, env: {}, secretStore: new MemoryDesktopSecretStore(),
      ensureManagedCodexRuntime: vi.fn(() => installation.promise),
      codexDiscoveryCoordinator: {
        discover: vi.fn(async () => ({
          candidates: [{ command: runtime.command, executable: true, selected: true,
            source: "config" as const, version: runtime.metadata.version }],
          selectedCommand: runtime.command,
        })),
        invalidate: vi.fn(), resolve: vi.fn(),
      },
    });
    const resolveCommand = vi.fn(() => {
      commandRequested.release();
      return service.resolveCodexCommand();
    });
    // Exercise the actual stdio connection and the client's initialization
    // drain. Closing while command resolution is pending cancels connection
    // before spawn; no real Codex executable is needed or launched.
    const client = new CodexAppServerClient({
      resolveCommand,
      env: { CODEX_HOME: path.join(root, "codex-home") },
    });
    const close = vi.fn(async () => await client.close());
    const stop = service.watchManagedCodexRuntime(close);
    let completed = false;
    const startup = service.refreshStartupDiscovery(issueProviderDiscoveryPermit("startup"))
      .then(() => { completed = true; });
    const request = client.getInitializeResult().catch((error: unknown) => error);
    try {
      await commandRequested.promise;
      expect(close).not.toHaveBeenCalled();
      installation.release(runtime);
      await vi.waitFor(() => expect(completed).toBe(true));
      await startup;
      expect(close).toHaveBeenCalledOnce();
      expect(await request).toEqual(new Error("codex app server connection cancelled"));
      await expect(resolveCommand.mock.results[0].value)
        .resolves.toMatchObject({ command: runtime.command });
      expect(configStore.read("providers").codex.lastKnownGood?.selectedCommand)
        .toBe(runtime.command);
    } finally {
      stop();
      if (completed) await client.close();
      configStore.dispose();
    }
  });

  // A window reads settings once, when it mounts, and the projection does not
  // wait for git or the application scan. Before the announcement, a Settings
  // pane opened on a launch where git finished probing last reported "No git
  // candidates found." for the life of the process, until Re-check.
  it("announces git and application results that land after a window read settings", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-settings-"));
    tempRoots.push(root);
    const configPath = path.join(root, "config.toml");
    const configStore = new DesktopConfigStore({ configPath });
    const git = gate<DesktopGitDiscoverySnapshot>();
    const applications = gate<DesktopApplicationsSnapshot>();
    vi.mocked(discoverGitCommands).mockReturnValue(git.promise);
    vi.mocked(discoverDesktopApplications).mockReturnValue(applications.promise);
    vi.mocked(discoverGhCommands).mockResolvedValue({ candidates: [] });
    vi.mocked(discoverGlabCommands).mockResolvedValue({ candidates: [] });
    // What a window would see if it re-read settings on each announcement.
    const rereads: Array<Promise<DesktopSettingsSnapshot>> = [];
    const service = new DesktopSettingsService({
      configPath,
      configStore,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
      codexDiscoveryCoordinator: {
        discover: vi.fn(async () => ({ candidates: [] })),
        invalidate: vi.fn(),
        resolve: vi.fn(),
      },
      onStartupDiscoveryResult: () => {
        rereads.push(service.readSettingsProjection());
      },
    });

    const startup = service.refreshStartupDiscovery(
      issueProviderDiscoveryPermit("startup"),
    );
    const mounted = await service.readSettingsProjection();
    expect(mounted.applications.git.discovery.candidates).toEqual([]);
    expect(mounted.applications.editors).toEqual([]);

    applications.release(APPLICATIONS_DISCOVERY);
    await vi.waitFor(() => expect(rereads).toHaveLength(1));
    const afterApplications = await rereads[0];
    expect(afterApplications.applications.editors).toEqual(
      APPLICATIONS_DISCOVERY.editors,
    );
    expect(afterApplications.applications.git.discovery.candidates).toEqual([]);

    git.release(GIT_DISCOVERY);
    await startup;
    expect(rereads).toHaveLength(2);
    const afterGit = await rereads[1];
    expect(afterGit.applications.git.discovery).toEqual(GIT_DISCOVERY);
    configStore.dispose();
  });
});
