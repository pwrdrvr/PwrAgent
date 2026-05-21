import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PWRAGENT_HOME_ENV,
  PWRAGENT_PROFILE_AUTO_CREATE_ENV,
  PWRAGENT_PROFILE_ENV,
  bootstrapProfileExists,
  cleanupBootstrapProfile,
  deleteProfile,
  ensureBootstrapProfileDir,
  ensureNamedProfileExists,
  readProfileArg,
  readProfilesRegistry,
  requestProfileInstanceFocus,
  resetCachedActiveProfileNameForTests,
  resolveActiveProfileName,
  resolveBootstrapProfileDir,
  resolveBootstrapProfilePath,
  resolveDefaultProfileName,
  resolveProfileBootDecision,
  setDefaultProfileName,
  startProfileFocusRequestWatcher,
  startProfileRuntimeHeartbeat,
} from "../profile";

const roots: string[] = [];

afterEach(() => {
  resetCachedActiveProfileNameForTests();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createRoot(): { env: NodeJS.ProcessEnv; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-profile-"));
  roots.push(root);
  return {
    env: {
      [PWRAGENT_HOME_ENV]: root,
    } as NodeJS.ProcessEnv,
    root,
  };
}

describe("PwrAgent profiles", () => {
  it("uses the registry default only when PWRAGENT_PROFILE is not set", () => {
    const { env } = createRoot();
    ensureNamedProfileExists("dev", { env });
    setDefaultProfileName("dev", { env });

    expect(resolveDefaultProfileName({ env })).toBe("dev");
    expect(resolveActiveProfileName({ env })).toBe("dev");
    expect(
      resolveActiveProfileName({
        argv: ["PwrAgent", "--profile", "work"],
        env: {
          ...env,
          [PWRAGENT_PROFILE_ENV]: "personal",
        },
      }),
    ).toBe("work");
  });

  it("keeps the process active profile stable after the startup default changes", () => {
    const { env, root } = createRoot();
    ensureNamedProfileExists("dev", { env });
    ensureNamedProfileExists("work", { env });
    setDefaultProfileName("dev", { env });
    vi.stubEnv(PWRAGENT_HOME_ENV, root);
    vi.stubEnv(PWRAGENT_PROFILE_ENV, "");

    expect(resolveActiveProfileName()).toBe("dev");

    setDefaultProfileName("work", { env });

    expect(resolveDefaultProfileName({ env })).toBe("work");
    expect(resolveActiveProfileName()).toBe("dev");
  });

  it("seeds [onboarding] completed=false in a freshly created profile's config.toml", () => {
    const { env, root } = createRoot();
    const result = ensureNamedProfileExists("scratch", { env });
    expect(result.created).toBe(true);

    const configPath = path.join(root, "profiles", "scratch", "config.toml");
    const contents = fs.readFileSync(configPath, "utf8");
    expect(contents).toContain("[onboarding]");
    expect(contents).toContain("completed = false");

    // Idempotent: calling again on an existing dir must not stomp the
    // file. The marker is only seeded when the directory is first
    // created, otherwise we would wipe out an in-flight wizard's
    // `completed = true` write between two app launches.
    fs.writeFileSync(configPath, "[onboarding]\ncompleted = true\n", "utf8");
    const secondResult = ensureNamedProfileExists("scratch", { env });
    expect(secondResult.created).toBe(false);
    expect(fs.readFileSync(configPath, "utf8")).toContain("completed = true");
  });

  it("does not overwrite an existing config.toml on a re-create of an existing dir", () => {
    const { env, root } = createRoot();
    const profileDir = path.join(root, "profiles", "preserved");
    fs.mkdirSync(path.join(profileDir, "state"), { recursive: true });
    const configPath = path.join(profileDir, "config.toml");
    fs.writeFileSync(
      configPath,
      ["[general]", "developer_mode = true", ""].join("\n"),
      "utf8",
    );

    const result = ensureNamedProfileExists("preserved", { env });
    expect(result.created).toBe(false);
    expect(fs.readFileSync(configPath, "utf8")).not.toContain("[onboarding]");
  });

  it("reads --profile arguments from argv", () => {
    expect(readProfileArg(["PwrAgent", "--profile", "work"])).toBe("work");
    expect(readProfileArg(["PwrAgent", "--profile=dev"])).toBe("dev");
    expect(() => readProfileArg(["PwrAgent", "--profile"])).toThrow(
      "--profile requires a profile name",
    );
  });

  it("deletes inactive custom profiles and clears the startup default", () => {
    const { env, root } = createRoot();
    const activeEnv = {
      ...env,
      [PWRAGENT_PROFILE_ENV]: "dev",
    } as NodeJS.ProcessEnv;
    ensureNamedProfileExists("dev", { env: activeEnv });
    ensureNamedProfileExists("scratch", { env });
    setDefaultProfileName("scratch", { env });

    const profileDir = path.join(root, "profiles", "scratch");
    expect(fs.existsSync(path.join(profileDir, "state"))).toBe(true);

    deleteProfile("scratch", { env: activeEnv });

    expect(fs.existsSync(profileDir)).toBe(false);
    expect(resolveDefaultProfileName({ env })).toBe("default");
    expect(readProfilesRegistry({ env }).profiles).not.toContainEqual(
      expect.objectContaining({ name: "scratch" }),
    );
  });

  it("does not delete the active profile", () => {
    const { env } = createRoot();
    ensureNamedProfileExists("dev", { env });

    expect(() =>
      deleteProfile("dev", {
        env: {
          ...env,
          [PWRAGENT_PROFILE_ENV]: "dev",
        },
      }),
    ).toThrow("active profile");
  });

  it("does not delete a profile with a live runtime heartbeat", () => {
    const { env } = createRoot();
    const activeEnv = {
      ...env,
      [PWRAGENT_PROFILE_ENV]: "dev",
    } as NodeJS.ProcessEnv;
    ensureNamedProfileExists("dev", { env: activeEnv });
    ensureNamedProfileExists("scratch", { env });
    const heartbeat = startProfileRuntimeHeartbeat("scratch", {
      env,
      instanceId: "scratch-instance",
      intervalMs: 60_000,
      processId: process.pid,
    });

    expect(() => deleteProfile("scratch", { env: activeEnv })).toThrow(
      "open in another PwrAgent instance",
    );

    heartbeat.stop();
    deleteProfile("scratch", { env: activeEnv });
    expect(readProfilesRegistry({ env }).profiles).not.toContainEqual(
      expect.objectContaining({ name: "scratch" }),
    );
  });

  it("requests focus only for profiles with a live runtime heartbeat", () => {
    const { env } = createRoot();
    ensureNamedProfileExists("scratch", { env });

    expect(requestProfileInstanceFocus("scratch", { env })).toBe(false);

    const heartbeat = startProfileRuntimeHeartbeat("scratch", {
      env,
      intervalMs: 60_000,
      processId: process.pid,
    });
    try {
      expect(requestProfileInstanceFocus("scratch", { env })).toBe(true);
    } finally {
      heartbeat.stop();
    }
  });

  describe("resolveProfileBootDecision", () => {
    it("returns no-profile-configured on a brand-new PWRAGENT_HOME", () => {
      const { env } = createRoot();
      // Fresh root: no profiles.toml, no default/ dir, no env override.
      // Old behavior would silently mkdir default/ — now we return the
      // tagged union so the bootstrap can pop the wizard instead.
      const decision = resolveProfileBootDecision({ env });
      expect(decision).toEqual({ kind: "no-profile-configured" });
    });

    it("returns missing-named-profile when PWRAGENT_PROFILE names a non-existent profile", () => {
      const { env } = createRoot();
      const decision = resolveProfileBootDecision({
        env: { ...env, [PWRAGENT_PROFILE_ENV]: "ghost" },
      });
      expect(decision).toEqual({
        kind: "missing-named-profile",
        requestedName: "ghost",
        source: "env",
      });
    });

    it("returns missing-named-profile (source=cli) for a --profile flag on a missing profile", () => {
      const { env } = createRoot();
      const decision = resolveProfileBootDecision({
        env,
        argv: ["PwrAgent", "--profile", "ghost"],
      });
      expect(decision).toEqual({
        kind: "missing-named-profile",
        requestedName: "ghost",
        source: "cli",
      });
    });

    it("returns open when --profile names an existing profile", () => {
      const { env, root } = createRoot();
      ensureNamedProfileExists("dev", { env });
      const decision = resolveProfileBootDecision({
        env,
        argv: ["PwrAgent", "--profile", "dev"],
      });
      expect(decision).toEqual({
        kind: "open",
        profileName: "dev",
        profileDir: path.join(root, "profiles", "dev"),
        source: "cli",
      });
    });

    it("returns missing-default-profile when profiles.toml points at a deleted profile", () => {
      const { env, root } = createRoot();
      ensureNamedProfileExists("dev", { env });
      setDefaultProfileName("dev", { env });
      // Operator manually removed the profile dir, but the registry
      // still has dev as default. Old behavior would happily return
      // "dev" and try to use the missing dir; now we surface the
      // mismatch so the wizard can ask "set up dev again, or pick
      // something else?".
      fs.rmSync(path.join(root, "profiles", "dev"), { recursive: true, force: true });
      const decision = resolveProfileBootDecision({ env });
      expect(decision).toEqual({
        kind: "missing-default-profile",
        configuredName: "dev",
      });
    });

    it("honors a pre-existing default/ dir as migration (no registry entry needed)", () => {
      const { env, root } = createRoot();
      // Simulate an install that pre-dates #524: default/ exists on
      // disk, profiles.toml is either missing or has no default_profile.
      // The pre-#524 behavior was "fall back to default" — we keep
      // that on the migration path so existing operators aren't sent
      // through the wizard on upgrade.
      fs.mkdirSync(path.join(root, "profiles", "default", "state"), { recursive: true });
      const decision = resolveProfileBootDecision({ env });
      expect(decision).toEqual({
        kind: "open",
        profileName: "default",
        profileDir: path.join(root, "profiles", "default"),
        source: "migration",
      });
    });

    it("PWRAGENT_PROFILE_AUTO_CREATE=1 turns missing-named into open for E2E", () => {
      const { env, root } = createRoot();
      const decision = resolveProfileBootDecision({
        env: {
          ...env,
          [PWRAGENT_PROFILE_ENV]: "ephemeral",
          [PWRAGENT_PROFILE_AUTO_CREATE_ENV]: "1",
        },
      });
      expect(decision).toEqual({
        kind: "open",
        profileName: "ephemeral",
        profileDir: path.join(root, "profiles", "ephemeral"),
        source: "env",
      });
    });

    it("PWRAGENT_PROFILE_AUTO_CREATE=1 turns no-profile-configured into a default open", () => {
      const { env, root } = createRoot();
      const decision = resolveProfileBootDecision({
        env: { ...env, [PWRAGENT_PROFILE_AUTO_CREATE_ENV]: "1" },
      });
      expect(decision).toEqual({
        kind: "open",
        profileName: "default",
        profileDir: path.join(root, "profiles", "default"),
        source: "migration",
      });
    });

    it("CLI flag wins over env var, even when env names an existing profile", () => {
      const { env } = createRoot();
      ensureNamedProfileExists("envchoice", { env });
      const decision = resolveProfileBootDecision({
        env: { ...env, [PWRAGENT_PROFILE_ENV]: "envchoice" },
        argv: ["PwrAgent", "--profile", "clichoice"],
      });
      expect(decision).toMatchObject({
        kind: "missing-named-profile",
        requestedName: "clichoice",
        source: "cli",
      });
    });

    it("rejects invalid names from CLI before deciding existence", () => {
      const { env } = createRoot();
      expect(() =>
        resolveProfileBootDecision({
          env,
          argv: ["PwrAgent", "--profile", "Bad Name"],
        }),
      ).toThrow(/Invalid profile name/);
    });

    it("rejects invalid names from env var before deciding existence", () => {
      const { env } = createRoot();
      expect(() =>
        resolveProfileBootDecision({
          env: { ...env, [PWRAGENT_PROFILE_ENV]: "Bad Name" },
        }),
      ).toThrow(/Invalid PWRAGENT_PROFILE/);
    });

    it("ignores a stale .bootstrap/ dir — only profiles/ counts for decisions", () => {
      const { env } = createRoot();
      // A previous wizard session crashed without graduating; .bootstrap/
      // is left over on disk. The decision must NOT treat it as a
      // profile — otherwise a single failed wizard run would forever
      // suppress the fresh-install wizard on subsequent launches.
      ensureBootstrapProfileDir({ env });
      const decision = resolveProfileBootDecision({ env });
      expect(decision).toEqual({ kind: "no-profile-configured" });
    });
  });

  describe("bootstrap profile (.bootstrap/)", () => {
    it("resolves to a sibling of profiles/, not a child", () => {
      const { env, root } = createRoot();
      expect(resolveBootstrapProfileDir({ env })).toBe(path.join(root, ".bootstrap"));
      expect(resolveBootstrapProfilePath("config.toml", { env })).toBe(
        path.join(root, ".bootstrap", "config.toml"),
      );
    });

    it("ensureBootstrapProfileDir seeds an [onboarding] marker like a real profile", () => {
      const { env, root } = createRoot();
      const result = ensureBootstrapProfileDir({ env });
      expect(result.created).toBe(true);
      expect(result.profileDir).toBe(path.join(root, ".bootstrap"));

      const configPath = path.join(root, ".bootstrap", "config.toml");
      const contents = fs.readFileSync(configPath, "utf8");
      // Without the marker the wizard wouldn't fire — it gates on
      // onboarding.completed === false. Bootstrap profile MUST look
      // like a fresh real profile to the wizard's perspective.
      expect(contents).toContain("[onboarding]");
      expect(contents).toContain("completed = false");
      expect(fs.existsSync(path.join(root, ".bootstrap", "state"))).toBe(true);
    });

    it("ensureBootstrapProfileDir is idempotent and does not stomp an in-flight config.toml", () => {
      const { env, root } = createRoot();
      ensureBootstrapProfileDir({ env });
      const configPath = path.join(root, ".bootstrap", "config.toml");
      // Wizard wrote some choices mid-flow. A second ensure call
      // (e.g. operator quit + relaunch without graduating) must
      // preserve them — the marker is only seeded on first creation.
      fs.writeFileSync(configPath, "[general]\n[appearance]\ntheme = \"dark\"\n", "utf8");
      const second = ensureBootstrapProfileDir({ env });
      expect(second.created).toBe(false);
      expect(fs.readFileSync(configPath, "utf8")).toContain('theme = "dark"');
    });

    it("cleanupBootstrapProfile removes the dir; subsequent existence check is false", () => {
      const { env, root } = createRoot();
      ensureBootstrapProfileDir({ env });
      expect(bootstrapProfileExists({ env })).toBe(true);
      cleanupBootstrapProfile({ env });
      expect(bootstrapProfileExists({ env })).toBe(false);
      expect(fs.existsSync(path.join(root, ".bootstrap"))).toBe(false);
    });

    it("cleanupBootstrapProfile is a no-op when the dir doesn't exist", () => {
      const { env } = createRoot();
      expect(bootstrapProfileExists({ env })).toBe(false);
      // Should not throw.
      cleanupBootstrapProfile({ env });
    });

    it("bootstrap dir is NOT enumerated by profiles registry / listing", () => {
      const { env } = createRoot();
      ensureBootstrapProfileDir({ env });
      ensureNamedProfileExists("dev", { env });
      const registry = readProfilesRegistry({ env });
      // The registry tracks `profiles/`-style entries via explicit
      // writes through ensureNamedProfileExists / setDefaultProfileName.
      // `.bootstrap/` lives outside `profiles/` and is never added,
      // so a listing shows only the real profile.
      expect(registry.profiles.map((entry) => entry.name)).toEqual(["dev"]);
    });
  });

  it("consumes profile focus requests and invokes the focus callback", () => {
    const { env } = createRoot();
    ensureNamedProfileExists("scratch", { env });
    const heartbeat = startProfileRuntimeHeartbeat("scratch", {
      env,
      intervalMs: 60_000,
      processId: process.pid,
    });
    const onFocus = vi.fn();

    try {
      expect(requestProfileInstanceFocus("scratch", { env })).toBe(true);
      const watcher = startProfileFocusRequestWatcher("scratch", {
        env,
        intervalMs: 60_000,
        onFocus,
      });
      try {
        expect(onFocus).toHaveBeenCalledOnce();
      } finally {
        watcher.stop();
      }
    } finally {
      heartbeat.stop();
    }
  });
});
