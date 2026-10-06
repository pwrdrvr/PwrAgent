import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PWRAGENT_HOME_ENV,
  PWRAGENT_PROFILE_ENV,
  ensureNamedProfileExists,
  resetCachedActiveProfileNameForTests,
  readProfilesRegistry,
  setDefaultProfileName,
  startProfileRuntimeHeartbeat,
  updateLastUsed,
} from "../profile";
import { SECRET_STORAGE_DISABLED_ENV } from "../settings/desktop-secret-store";
import {
  PROFILES_REORDER_CHANNEL,
  PROFILES_SET_DEFAULT_CHANNEL,
  PROFILES_SET_MENU_VISIBILITY_CHANNEL,
} from "../../shared/ipc";

const spawnMock = vi.fn(() => ({
  unref: vi.fn(),
}));

const safeStorageEncryptMock = vi.fn((value: string) => Buffer.from(`enc:${value}`));
const safeStorageDecryptMock = vi.fn((buf: Buffer) =>
  buf.toString("utf8").replace(/^enc:/, ""),
);
const safeStorageIsAvailableMock = vi.fn(() => true);
const ipcMainHandleMock = vi.fn();
const ipcMainRemoveHandlerMock = vi.fn();

vi.mock("electron", () => ({
  ipcMain: {
    handle: ipcMainHandleMock,
    removeHandler: ipcMainRemoveHandlerMock,
  },
  shell: {
    trashItem: vi.fn(async () => undefined),
  },
  safeStorage: {
    encryptString: safeStorageEncryptMock,
    decryptString: safeStorageDecryptMock,
    isEncryptionAvailable: safeStorageIsAvailableMock,
  },
}));

vi.mock("../app-server/backend-registry", () => ({
  disposeDesktopBackendRegistry: vi.fn(async () => undefined),
}));

const getAppStateModeMock = vi.fn<() => "active-profile" | "bootstrap" | null>(
  () => "active-profile",
);
vi.mock("../state/app-state", () => ({
  // graduateDesktopBootstrapConfigToProfile branches on this; default to
  // active-profile so the pre-existing tests stay no-op-only on the
  // graduation path. Tests that want to exercise the bootstrap branch
  // override this mock per-case.
  getAppStateMode: getAppStateModeMock,
  initializeAppState: vi.fn(),
  isAppStateInitialized: vi.fn(() => false),
  getAppStateDb: vi.fn(),
  getAppMessagingStore: vi.fn(),
  getAppOverlayStore: vi.fn(),
  getAppRuntimeInstanceStore: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  // Other parts of the import graph bind execFile at module load. We never
  // call them in these tests; a no-op mock suffices.
  execFile: vi.fn(),
}));

const roots: string[] = [];

afterEach(() => {
  // `resolveActiveProfileName()` caches its first-call result for
  // the process lifetime. Without this reset, a previous test's
  // PWRAGENT_PROFILE stub leaks into the next test's listing calls.
  resetCachedActiveProfileNameForTests();
  getAppStateModeMock.mockReset();
  getAppStateModeMock.mockReturnValue("active-profile");
  ipcMainHandleMock.mockReset();
  ipcMainRemoveHandlerMock.mockReset();
  vi.unstubAllEnvs();
  spawnMock.mockClear();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-profile-ipc-"));
  roots.push(root);
  return root;
}

describe("profile IPC helpers", () => {
  it("does not synthesize a phantom 'default' profile when no such profile exists on disk (#524 wizard Multiple-mode finish)", async () => {
    // Reproduces the bug surfaced by the wizard's Multiple-mode
    // finish: operator picks personal + work, completes the wizard,
    // graduation creates personal/ and work/ on disk plus the
    // registry entries. No `default/` dir gets created. But pre-fix,
    // listDesktopPwrAgentProfiles unconditionally added a "default"
    // entry to the listing, which surfaced as a misleading
    // "Not launched yet" row in the Profiles UI.
    //
    // After the fix, the listing reflects what actually exists.
    const root = createRoot();
    const env = { [PWRAGENT_HOME_ENV]: root } as NodeJS.ProcessEnv;
    const activeEnv = {
      ...env,
      [PWRAGENT_PROFILE_ENV]: "personal",
    } as NodeJS.ProcessEnv;
    // Wizard Multiple-mode finish provisions personal + work, sets
    // default_profile=personal, and graduates settings. Reproduce
    // that final on-disk state here.
    ensureNamedProfileExists("personal", { env: activeEnv });
    ensureNamedProfileExists("work", { env });
    setDefaultProfileName("personal", { env });
    vi.stubEnv(PWRAGENT_HOME_ENV, root);
    vi.stubEnv(PWRAGENT_PROFILE_ENV, "personal");

    const { listDesktopPwrAgentProfiles } = await import("../ipc/profiles");
    const result = listDesktopPwrAgentProfiles();

    expect(result.profiles.map((profile) => profile.name)).toEqual([
      "personal",
      "work",
    ]);
    expect(result.profiles.some((profile) => profile.name === "default")).toBe(false);
  });

  it("does not move the startup default row when listing profiles", async () => {
    // Variant of the test above with a `default/` dir actually
    // present on disk — pre-#524 installs that have an upgraded
    // `default` profile should still see it listed.
    const root = createRoot();
    const env = {
      [PWRAGENT_HOME_ENV]: root,
    } as NodeJS.ProcessEnv;
    const activeEnv = {
      ...env,
      [PWRAGENT_PROFILE_ENV]: "dev",
    } as NodeJS.ProcessEnv;
    ensureNamedProfileExists("dev", { env: activeEnv });
    // Pre-existing default dir on disk: it should keep being listed.
    ensureNamedProfileExists("default", { env });
    ensureNamedProfileExists("scratch", { env });
    ensureNamedProfileExists("work", { env });
    setDefaultProfileName("scratch", { env });
    vi.stubEnv(PWRAGENT_HOME_ENV, root);
    vi.stubEnv(PWRAGENT_PROFILE_ENV, "dev");
    const {
      listDesktopPwrAgentProfiles,
      setDefaultDesktopPwrAgentProfile,
    } = await import("../ipc/profiles");

    expect(listDesktopPwrAgentProfiles().profiles.map((profile) => profile.name)).toEqual([
      "dev",
      "default",
      "scratch",
      "work",
    ]);

    setDefaultDesktopPwrAgentProfile({ profile: "work" });

    expect(listDesktopPwrAgentProfiles().profiles.map((profile) => profile.name)).toEqual([
      "dev",
      "default",
      "scratch",
      "work",
    ]);
    expect(
      listDesktopPwrAgentProfiles().profiles.find((profile) => profile.name === "work")
        ?.default,
    ).toBe(true);
  });

  describe("operator order and Profiles menu visibility", () => {
    function seedProfiles(active: string, names: string[]): NodeJS.ProcessEnv {
      const root = createRoot();
      const env = { [PWRAGENT_HOME_ENV]: root } as NodeJS.ProcessEnv;
      for (const name of names) {
        ensureNamedProfileExists(name, { env });
      }
      vi.stubEnv(PWRAGENT_HOME_ENV, root);
      vi.stubEnv(PWRAGENT_PROFILE_ENV, active);
      return env;
    }

    it("lists profiles in creation order, not active-first or alphabetical", async () => {
      seedProfiles("dev", ["work", "dev", "alpha"]);
      const { listDesktopPwrAgentProfiles } = await import("../ipc/profiles");

      const profiles = listDesktopPwrAgentProfiles().profiles;

      expect(profiles.map((profile) => profile.name)).toEqual([
        "work",
        "dev",
        "alpha",
      ]);
      expect(profiles.map((profile) => profile.showInMenu)).toEqual([
        true,
        true,
        true,
      ]);
    });

    it("persists a reorder, and a new profile lands at the bottom", async () => {
      const env = seedProfiles("dev", ["dev", "work", "alpha"]);
      const {
        listDesktopPwrAgentProfiles,
        reorderDesktopPwrAgentProfiles,
      } = await import("../ipc/profiles");

      expect(
        reorderDesktopPwrAgentProfiles({ order: ["alpha", "dev", "work"] }),
      ).toEqual({ order: ["alpha", "dev", "work"] });
      ensureNamedProfileExists("beta", { env });

      expect(
        listDesktopPwrAgentProfiles().profiles.map((profile) => profile.name),
      ).toEqual(["alpha", "dev", "work", "beta"]);
    });

    it.each([
      ["missing a profile", ["dev", "work"]],
      ["naming an unknown profile", ["dev", "work", "alpha", "ghost"]],
      ["repeating a profile", ["dev", "work", "work"]],
    ])("refuses a stale order %s and leaves the registry alone", async (_case, order) => {
      seedProfiles("dev", ["dev", "work", "alpha"]);
      const {
        listDesktopPwrAgentProfiles,
        reorderDesktopPwrAgentProfiles,
      } = await import("../ipc/profiles");

      expect(() => reorderDesktopPwrAgentProfiles({ order })).toThrow(
        "The profile list changed while you were reordering it.",
      );
      expect(
        listDesktopPwrAgentProfiles().profiles.map((profile) => profile.name),
      ).toEqual(["dev", "work", "alpha"]);
    });

    it("hides a profile from the menu without moving it, and survives a last-used stamp", async () => {
      const env = seedProfiles("dev", ["dev", "scratch", "work"]);
      const {
        listDesktopPwrAgentProfiles,
        setDesktopPwrAgentProfileMenuVisibility,
      } = await import("../ipc/profiles");

      expect(
        setDesktopPwrAgentProfileMenuVisibility({
          profile: "scratch",
          showInMenu: false,
        }),
      ).toEqual({ profile: "scratch", showInMenu: false });
      // Another launch of that profile stamps last_used through the same
      // registry; the flag must ride along.
      updateLastUsed("scratch", { env });

      expect(
        listDesktopPwrAgentProfiles().profiles.map((profile) => [
          profile.name,
          profile.showInMenu,
        ]),
      ).toEqual([
        ["dev", true],
        ["scratch", false],
        ["work", true],
      ]);
      expect(
        readProfilesRegistry({ env }).profiles.find(
          (entry) => entry.name === "scratch",
        )?.show_in_menu,
      ).toBe(false);

      setDesktopPwrAgentProfileMenuVisibility({
        profile: "scratch",
        showInMenu: true,
      });

      // Shown is the default, so the key leaves the file rather than
      // turning into `show_in_menu = true`.
      const registryText = fs.readFileSync(
        path.join(env[PWRAGENT_HOME_ENV]!, "profiles.toml"),
        "utf8",
      );
      expect(registryText).not.toContain("show_in_menu");
    });

    it("refuses to change the visibility of a profile that does not exist", async () => {
      seedProfiles("dev", ["dev"]);
      const { setDesktopPwrAgentProfileMenuVisibility } = await import(
        "../ipc/profiles"
      );

      expect(() =>
        setDesktopPwrAgentProfileMenuVisibility({
          profile: "ghost",
          showInMenu: false,
        }),
      ).toThrow('Profile "ghost" does not exist.');
    });

    it("rebuilds the menus after a reorder or a visibility change, and only on success", async () => {
      seedProfiles("dev", ["dev", "work"]);
      const { registerProfilesIpcHandlers } = await import("../ipc/profiles");
      const onProfilesChanged = vi.fn();
      registerProfilesIpcHandlers({ onProfilesChanged });
      const handler = (channel: string) => {
        const found = ipcMainHandleMock.mock.calls.find(
          ([candidate]) => candidate === channel,
        )?.[1] as
          | ((event: unknown, request: unknown) => Promise<unknown>)
          | undefined;
        if (!found) {
          throw new Error(`${channel} handler was not registered`);
        }
        return found;
      };

      await expect(
        handler(PROFILES_REORDER_CHANNEL)({}, { order: ["work"] }),
      ).rejects.toThrow("The profile list changed");
      expect(onProfilesChanged).not.toHaveBeenCalled();

      await handler(PROFILES_REORDER_CHANNEL)({}, { order: ["work", "dev"] });
      await handler(PROFILES_SET_MENU_VISIBILITY_CHANNEL)(
        {},
        { profile: "work", showInMenu: false },
      );

      expect(onProfilesChanged).toHaveBeenCalledTimes(2);
    });
  });

  it("notifies profile listeners after changing the default profile", async () => {
    const root = createRoot();
    const env = {
      [PWRAGENT_HOME_ENV]: root,
      [PWRAGENT_PROFILE_ENV]: "dev",
    } as NodeJS.ProcessEnv;
    ensureNamedProfileExists("dev", { env });
    ensureNamedProfileExists("work", { env });
    vi.stubEnv(PWRAGENT_HOME_ENV, root);
    vi.stubEnv(PWRAGENT_PROFILE_ENV, "dev");
    const { registerProfilesIpcHandlers } = await import("../ipc/profiles");
    const onProfilesChanged = vi.fn();

    registerProfilesIpcHandlers({ onProfilesChanged });
    const handler = ipcMainHandleMock.mock.calls.find(
      ([channel]) => channel === PROFILES_SET_DEFAULT_CHANNEL,
    )?.[1] as
      | ((event: unknown, request: { profile: string }) => Promise<unknown>)
      | undefined;
    if (handler === undefined) {
      throw new Error("profiles:set-default handler was not registered");
    }

    await expect(handler({}, { profile: "work" })).resolves.toEqual({
      profile: "work",
    });
    expect(onProfilesChanged).toHaveBeenCalledOnce();
  });

  it("replaces inherited profile launch arguments when opening another profile", async () => {
    const { replaceProfileLaunchArgs } = await import("../ipc/profiles");

    expect(
      replaceProfileLaunchArgs(
        ["/repo/apps/desktop", "--profile", "dev", "--inspect"],
        "work",
      ),
    ).toEqual(["/repo/apps/desktop", "--inspect", "--profile", "work"]);
    expect(
      replaceProfileLaunchArgs(["/repo/apps/desktop", "--profile=dev"], "work"),
    ).toEqual(["/repo/apps/desktop", "--profile", "work"]);
  });

  it("focuses an existing profile instance instead of spawning a duplicate", async () => {
    const root = createRoot();
    const env = {
      [PWRAGENT_HOME_ENV]: root,
      [PWRAGENT_PROFILE_ENV]: "dev",
    } as NodeJS.ProcessEnv;
    ensureNamedProfileExists("dev", { env });
    ensureNamedProfileExists("scratch", { env });
    const heartbeat = startProfileRuntimeHeartbeat("scratch", {
      env,
      intervalMs: 60_000,
      processId: process.pid,
    });
    vi.stubEnv(PWRAGENT_HOME_ENV, root);
    vi.stubEnv(PWRAGENT_PROFILE_ENV, "dev");
    const { openDesktopPwrAgentProfile } = await import("../ipc/profiles");

    try {
      expect(openDesktopPwrAgentProfile({ profile: "scratch" })).toEqual({
        opened: false,
        profile: "scratch",
        reason: "focused",
      });
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      heartbeat.stop();
    }
  });

  it("createDesktopPwrAgentProfile without seedOnboardingCompleted leaves the new profile ungated", async () => {
    // Default behavior (Settings → Profiles, `PWRAGENT_PROFILE=<new>`,
    // any non-wizard creation path): new profile gets onboarding gated
    // per #500 so the wizard auto-fires on first open.
    const root = createRoot();
    const env = {
      [PWRAGENT_HOME_ENV]: root,
      [PWRAGENT_PROFILE_ENV]: "dev",
    } as NodeJS.ProcessEnv;
    ensureNamedProfileExists("dev", { env });
    vi.stubEnv(PWRAGENT_HOME_ENV, root);
    vi.stubEnv(PWRAGENT_PROFILE_ENV, "dev");
    const { createDesktopPwrAgentProfile } = await import("../ipc/profiles");

    const response = createDesktopPwrAgentProfile({ profile: "work" });
    expect(response.created).toBe(true);
    const configPath = path.join(root, "profiles", "work", "config.toml");
    // ensureNamedProfileExists writes the default `completed = false`.
    // We verify here that the optional seed flag, when absent, does NOT
    // flip that to true.
    const contents = fs.existsSync(configPath)
      ? fs.readFileSync(configPath, "utf8")
      : "";
    expect(contents).not.toContain("completed = true");
    expect(contents).not.toContain('completed_source = "wizard"');
  });

  it("createDesktopPwrAgentProfile normalizes arbitrary profile names", async () => {
    const root = createRoot();
    const env = {
      [PWRAGENT_HOME_ENV]: root,
      [PWRAGENT_PROFILE_ENV]: "dev",
    } as NodeJS.ProcessEnv;
    ensureNamedProfileExists("dev", { env });
    vi.stubEnv(PWRAGENT_HOME_ENV, root);
    vi.stubEnv(PWRAGENT_PROFILE_ENV, "dev");
    const { createDesktopPwrAgentProfile } = await import("../ipc/profiles");

    const response = createDesktopPwrAgentProfile({ profile: "My Work Profile" });

    expect(response.profile).toBe("my-work-profile");
    expect(response.profileDir).toBe(
      path.join(root, "profiles", "my-work-profile"),
    );
    expect(fs.existsSync(response.profileDir)).toBe(true);
  });

  it("openDesktopPwrAgentProfile normalizes and preserves E2E network and secret-storage isolation", async () => {
    const root = createRoot();
    const env = {
      [PWRAGENT_HOME_ENV]: root,
      [PWRAGENT_PROFILE_ENV]: "dev",
    } as NodeJS.ProcessEnv;
    ensureNamedProfileExists("dev", { env });
    ensureNamedProfileExists("my-work-profile", { env });
    vi.stubEnv(PWRAGENT_HOME_ENV, root);
    vi.stubEnv(PWRAGENT_PROFILE_ENV, "dev");
    vi.stubEnv(SECRET_STORAGE_DISABLED_ENV, "1");
    vi.stubEnv("PWRAGENT_E2E", "1");
    vi.stubEnv("NODE_OPTIONS", '--require "/fixture/github-release-stubs.cjs"');
    const { openDesktopPwrAgentProfile } = await import("../ipc/profiles");

    const previousArgv = process.argv;
    const previousDefaultApp = Object.getOwnPropertyDescriptor(process, "defaultApp");
    process.argv = [process.execPath, "/fixture/electron-bootstrap.mjs"];
    Object.defineProperty(process, "defaultApp", { configurable: true, value: true });
    let response;
    try {
      response = openDesktopPwrAgentProfile({ profile: "My Work Profile" });
    } finally {
      process.argv = previousArgv;
      if (previousDefaultApp) {
        Object.defineProperty(process, "defaultApp", previousDefaultApp);
      } else {
        Reflect.deleteProperty(process, "defaultApp");
      }
    }

    expect(response).toEqual({ opened: true, profile: "my-work-profile" });
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(["/fixture/electron-bootstrap.mjs", "--profile", "my-work-profile"]),
      expect.objectContaining({
        env: expect.objectContaining({
          [PWRAGENT_PROFILE_ENV]: "my-work-profile",
          [SECRET_STORAGE_DISABLED_ENV]: "1",
          PWRAGENT_E2E: "1",
          NODE_OPTIONS: '--require "/fixture/github-release-stubs.cjs"',
        }),
      }),
    );
  });

  it("launches the graduated profile when bootstrap requested the same profile", async () => {
    const root = createRoot();
    const env = {
      [PWRAGENT_HOME_ENV]: root,
      [PWRAGENT_PROFILE_ENV]: "test2",
    } as NodeJS.ProcessEnv;
    ensureNamedProfileExists("test2", { env });
    vi.stubEnv(PWRAGENT_HOME_ENV, root);
    vi.stubEnv(PWRAGENT_PROFILE_ENV, "test2");
    getAppStateModeMock.mockReturnValue("bootstrap");
    const { openDesktopPwrAgentProfile } = await import("../ipc/profiles");

    const response = openDesktopPwrAgentProfile({ profile: "test2" });

    expect(response).toEqual({ opened: true, profile: "test2" });
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(["--profile", "test2"]),
      expect.objectContaining({
        env: expect.objectContaining({
          [PWRAGENT_PROFILE_ENV]: "test2",
        }),
      }),
    );
  });

  it("createDesktopPwrAgentProfile with seedOnboardingCompleted=true marks the new profile as wizard-completed", async () => {
    // Wizard's Isolated + Multiple path: the operator just went through
    // the wizard to create this profile, so it should NOT re-fire the
    // wizard when they switch into it.
    const root = createRoot();
    const env = {
      [PWRAGENT_HOME_ENV]: root,
      [PWRAGENT_PROFILE_ENV]: "dev",
    } as NodeJS.ProcessEnv;
    ensureNamedProfileExists("dev", { env });
    vi.stubEnv(PWRAGENT_HOME_ENV, root);
    vi.stubEnv(PWRAGENT_PROFILE_ENV, "dev");
    const { createDesktopPwrAgentProfile } = await import("../ipc/profiles");

    createDesktopPwrAgentProfile({
      profile: "pwragent",
      seedOnboardingCompleted: true,
    });

    const configPath = path.join(root, "profiles", "pwragent", "config.toml");
    const contents = fs.readFileSync(configPath, "utf8");
    expect(contents).toContain("completed = true");
    expect(contents).toContain('completed_source = "wizard"');
  });

  describe("graduateDesktopBootstrapConfigToProfile", () => {
    afterEach(() => {
      getAppStateModeMock.mockReset();
      getAppStateModeMock.mockReturnValue("active-profile");
    });

    it("is a no-op when the main process is not in bootstrap mode", async () => {
      const root = createRoot();
      vi.stubEnv(PWRAGENT_HOME_ENV, root);
      getAppStateModeMock.mockReturnValue("active-profile");

      const { graduateDesktopBootstrapConfigToProfile } = await import("../ipc/profiles");

      const result = graduateDesktopBootstrapConfigToProfile({ targetProfile: "personal" });

      expect(result).toEqual({
        graduated: false,
        reason: "not-bootstrap-mode",
        targetProfile: "personal",
      });
      // No profile dir should have been created.
      expect(fs.existsSync(path.join(root, "profiles", "personal"))).toBe(false);
    });

    it("returns no-bootstrap-config when bootstrap mode but the dir is missing", async () => {
      const root = createRoot();
      vi.stubEnv(PWRAGENT_HOME_ENV, root);
      getAppStateModeMock.mockReturnValue("bootstrap");

      const { graduateDesktopBootstrapConfigToProfile } = await import("../ipc/profiles");

      const result = graduateDesktopBootstrapConfigToProfile({ targetProfile: "personal" });

      expect(result).toEqual({
        graduated: false,
        reason: "no-bootstrap-config",
        targetProfile: "personal",
      });
    });

    it("copies bootstrap config to target and sets default_profile when graduating", async () => {
      const root = createRoot();
      vi.stubEnv(PWRAGENT_HOME_ENV, root);
      getAppStateModeMock.mockReturnValue("bootstrap");

      // Seed a bootstrap profile with operator's wizard choices.
      const bootstrapDir = path.join(root, ".bootstrap");
      fs.mkdirSync(bootstrapDir, { recursive: true });
      fs.writeFileSync(
        path.join(bootstrapDir, "config.toml"),
        [
          "[general]",
          'developer_mode = false',
          "[general.appearance]",
          'theme = "dark"',
          'density = "compact"',
          "[onboarding]",
          "completed = false",
          "",
        ].join("\n"),
        "utf8",
      );

      const { graduateDesktopBootstrapConfigToProfile } = await import("../ipc/profiles");

      const result = graduateDesktopBootstrapConfigToProfile({ targetProfile: "personal" });

      expect(result).toEqual({ graduated: true, targetProfile: "personal" });

      // Target profile config gets the bootstrap settings (minus onboarding).
      const targetConfig = fs.readFileSync(
        path.join(root, "profiles", "personal", "config.toml"),
        "utf8",
      );
      expect(targetConfig).toContain('theme = "dark"');
      expect(targetConfig).toContain('density = "compact"');
      // Onboarding section MUST NOT be stamped from bootstrap (which
      // has completed=false). The target was just created by the
      // wizard with completed=true via createPwrAgentProfile, and
      // overwriting that would re-fire the wizard on next launch.
      // ensureNamedProfileExists, called inside graduate, seeds a
      // fresh [onboarding] completed=false IF the target dir didn't
      // already exist — but that's an edge case where the operator
      // is graduating to a never-before-seen profile name and the
      // wizard will run again. The caller (wizard) creates the
      // profile beforehand with seedOnboardingCompleted, so this
      // path is exercised in production.
      const profilesToml = fs.readFileSync(path.join(root, "profiles.toml"), "utf8");
      expect(profilesToml).toContain('default_profile = "personal"');
    });
  });

  describe("writeDesktopSecretsToProfile", () => {
    afterEach(() => {
      safeStorageEncryptMock.mockClear();
      safeStorageIsAvailableMock.mockReset();
      safeStorageIsAvailableMock.mockReturnValue(true);
    });

    it("encrypts and writes each secret to the target profile's keychain", async () => {
      const root = createRoot();
      const env = { [PWRAGENT_HOME_ENV]: root } as NodeJS.ProcessEnv;
      ensureNamedProfileExists("personal", { env });
      vi.stubEnv(PWRAGENT_HOME_ENV, root);

      const { writeDesktopSecretsToProfile } = await import("../ipc/profiles");

      const result = writeDesktopSecretsToProfile({
        profile: "personal",
        secrets: {
          discordBotToken: "discord-fake-token",
          telegramBotToken: "111:bot",
        },
      });

      expect(result).toEqual({
        profile: "personal",
        written: ["discordBotToken", "telegramBotToken"],
      });
      expect(safeStorageEncryptMock).toHaveBeenCalledWith("discord-fake-token");
      expect(safeStorageEncryptMock).toHaveBeenCalledWith("111:bot");

      // Sanity-check that the encrypted values landed in the target
      // profile's state.db — open it fresh and verify the secrets
      // table holds the ciphertext we encrypted.
      const { StateDb } = await import("../state/state-db");
      const db = StateDb.open(path.join(root, "profiles", "personal", "state", "state.db"), {
        profileName: "personal",
      });
      try {
        expect(db.getSecret("discordBotToken")?.toString("utf8")).toBe("enc:discord-fake-token");
        expect(db.getSecret("telegramBotToken")?.toString("utf8")).toBe("enc:111:bot");
      } finally {
        db.close();
      }
    });

    it("empty-string values delete the secret instead of writing", async () => {
      const root = createRoot();
      const env = { [PWRAGENT_HOME_ENV]: root } as NodeJS.ProcessEnv;
      ensureNamedProfileExists("personal", { env });
      vi.stubEnv(PWRAGENT_HOME_ENV, root);

      const { writeDesktopSecretsToProfile } = await import("../ipc/profiles");
      writeDesktopSecretsToProfile({
        profile: "personal",
        secrets: { discordBotToken: "first-value" },
      });
      // Replay-style clear: empty string deletes.
      writeDesktopSecretsToProfile({
        profile: "personal",
        secrets: { discordBotToken: "" },
      });

      const { StateDb } = await import("../state/state-db");
      const db = StateDb.open(path.join(root, "profiles", "personal", "state", "state.db"), {
        profileName: "personal",
      });
      try {
        expect(db.getSecret("discordBotToken")).toBeUndefined();
      } finally {
        db.close();
      }
    });

    it("rejects invalid profile names without opening any DB", async () => {
      const root = createRoot();
      vi.stubEnv(PWRAGENT_HOME_ENV, root);

      const { writeDesktopSecretsToProfile } = await import("../ipc/profiles");
    expect(() =>
      writeDesktopSecretsToProfile({
        profile: "!!!",
        secrets: { discordBotToken: "x" },
      }),
    ).toThrow(/must contain at least one letter or number/);
      expect(safeStorageEncryptMock).not.toHaveBeenCalled();
    });

    it("rejects when the target profile dir doesn't exist", async () => {
      const root = createRoot();
      vi.stubEnv(PWRAGENT_HOME_ENV, root);
      const { writeDesktopSecretsToProfile } = await import("../ipc/profiles");
      expect(() =>
        writeDesktopSecretsToProfile({
          profile: "ghost",
          secrets: { discordBotToken: "x" },
        }),
      ).toThrow(/does not exist/);
    });

    it("throws when safeStorage encryption is unavailable rather than writing plaintext", async () => {
      const root = createRoot();
      const env = { [PWRAGENT_HOME_ENV]: root } as NodeJS.ProcessEnv;
      ensureNamedProfileExists("personal", { env });
      vi.stubEnv(PWRAGENT_HOME_ENV, root);
      safeStorageIsAvailableMock.mockReturnValue(false);

      const { writeDesktopSecretsToProfile } = await import("../ipc/profiles");
      expect(() =>
        writeDesktopSecretsToProfile({
          profile: "personal",
          secrets: { discordBotToken: "x" },
        }),
      ).toThrow(/encryption is unavailable/);
    });

    it("PWRAGENT_DEV_DISABLE_SECRET_STORAGE=1 silently skips the keychain write", async () => {
      // Dev-only escape hatch for unsigned Electron builds on
      // macOS that trigger a "Keychain Not Found" prompt. With the
      // env var set, the IPC returns success but doesn't touch
      // safeStorage and doesn't write to state.db.
      const root = createRoot();
      const env = { [PWRAGENT_HOME_ENV]: root } as NodeJS.ProcessEnv;
      ensureNamedProfileExists("personal", { env });
      vi.stubEnv(PWRAGENT_HOME_ENV, root);
      vi.stubEnv("PWRAGENT_DEV_DISABLE_SECRET_STORAGE", "1");

      const { writeDesktopSecretsToProfile } = await import("../ipc/profiles");
      const result = writeDesktopSecretsToProfile({
        profile: "personal",
        secrets: { discordBotToken: "would-have-been-encrypted" },
      });

      expect(result).toEqual({ profile: "personal", written: [] });
      // Crucially: safeStorage was NOT called — that's the whole
      // point of the env var. Calling encryptString in an unsigned
      // dev build would have prompted the operator.
      expect(safeStorageEncryptMock).not.toHaveBeenCalled();

      const { StateDb } = await import("../state/state-db");
      const db = StateDb.open(path.join(root, "profiles", "personal", "state", "state.db"), {
        profileName: "personal",
      });
      try {
        // No ciphertext was written to the secrets table — the
        // typed value was silently dropped, as documented.
        expect(db.getSecret("discordBotToken")).toBeUndefined();
      } finally {
        db.close();
      }
    });
  });

  it("keeps listing profiles when an inactive profile config is malformed", async () => {
    const root = createRoot();
    const env = {
      [PWRAGENT_HOME_ENV]: root,
      [PWRAGENT_PROFILE_ENV]: "dev",
    } as NodeJS.ProcessEnv;
    ensureNamedProfileExists("dev", { env });
    ensureNamedProfileExists("scratch", { env });
    fs.writeFileSync(
      path.join(root, "profiles", "scratch", "config.toml"),
      "[models.codex\nprofile = \"work\"\n",
      "utf8",
    );
    vi.stubEnv(PWRAGENT_HOME_ENV, root);
    vi.stubEnv(PWRAGENT_PROFILE_ENV, "dev");
    const { listDesktopPwrAgentProfiles } = await import("../ipc/profiles");

    // Pre-#524: this assertion included "default" because the
    // listing unconditionally synthesized it. Post-#524 fix: only
    // real on-disk profiles surface, so "default" is absent unless
    // a `default/` dir exists.
    expect(listDesktopPwrAgentProfiles().profiles.map((profile) => profile.name)).toEqual([
      "dev",
      "scratch",
    ]);
  });
});
