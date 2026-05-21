import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PWRAGENT_HOME_ENV,
  PWRAGENT_PROFILE_ENV,
  ensureNamedProfileExists,
  resetCachedActiveProfileNameForTests,
  setDefaultProfileName,
  startProfileRuntimeHeartbeat,
} from "../profile";

const spawnMock = vi.fn(() => ({
  unref: vi.fn(),
}));

const safeStorageEncryptMock = vi.fn((value: string) => Buffer.from(`enc:${value}`));
const safeStorageDecryptMock = vi.fn((buf: Buffer) =>
  buf.toString("utf8").replace(/^enc:/, ""),
);
const safeStorageIsAvailableMock = vi.fn(() => true);

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
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
  // Other parts of the import graph (e.g. agent-core's review-runner
  // module, loaded transitively when this test imports profile IPC
  // helpers that now reference state/app-state) bind execFile at
  // module load. We never call them in these tests; a no-op mock
  // suffices.
  execFile: vi.fn(),
}));

const roots: string[] = [];

afterEach(() => {
  // `resolveActiveProfileName()` caches its first-call result for
  // the process lifetime. Without this reset, a previous test's
  // PWRAGENT_PROFILE stub leaks into the next test's listing calls.
  resetCachedActiveProfileNameForTests();
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
          grokApiKey: "xai-fake-key",
          telegramBotToken: "111:bot",
        },
      });

      expect(result).toEqual({
        profile: "personal",
        written: ["grokApiKey", "telegramBotToken"],
      });
      expect(safeStorageEncryptMock).toHaveBeenCalledWith("xai-fake-key");
      expect(safeStorageEncryptMock).toHaveBeenCalledWith("111:bot");

      // Sanity-check that the encrypted values landed in the target
      // profile's state.db — open it fresh and verify the secrets
      // table holds the ciphertext we encrypted.
      const { StateDb } = await import("../state/state-db");
      const db = StateDb.open(path.join(root, "profiles", "personal", "state", "state.db"), {
        profileName: "personal",
      });
      try {
        expect(db.getSecret("grokApiKey")?.toString("utf8")).toBe("enc:xai-fake-key");
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
        secrets: { grokApiKey: "first-value" },
      });
      // Replay-style clear: empty string deletes.
      writeDesktopSecretsToProfile({
        profile: "personal",
        secrets: { grokApiKey: "" },
      });

      const { StateDb } = await import("../state/state-db");
      const db = StateDb.open(path.join(root, "profiles", "personal", "state", "state.db"), {
        profileName: "personal",
      });
      try {
        expect(db.getSecret("grokApiKey")).toBeUndefined();
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
          profile: "Bad Name",
          secrets: { grokApiKey: "x" },
        }),
      ).toThrow(/Invalid profile name/);
      expect(safeStorageEncryptMock).not.toHaveBeenCalled();
    });

    it("rejects when the target profile dir doesn't exist", async () => {
      const root = createRoot();
      vi.stubEnv(PWRAGENT_HOME_ENV, root);
      const { writeDesktopSecretsToProfile } = await import("../ipc/profiles");
      expect(() =>
        writeDesktopSecretsToProfile({
          profile: "ghost",
          secrets: { grokApiKey: "x" },
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
          secrets: { grokApiKey: "x" },
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
        secrets: { grokApiKey: "would-have-been-encrypted" },
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
        expect(db.getSecret("grokApiKey")).toBeUndefined();
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
