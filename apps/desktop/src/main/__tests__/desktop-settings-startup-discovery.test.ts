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
