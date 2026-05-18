import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PWRAGENT_HOME_ENV,
  PWRAGENT_PROFILE_ENV,
  deleteProfile,
  ensureNamedProfileExists,
  readProfileArg,
  readProfilesRegistry,
  requestProfileInstanceFocus,
  resetCachedActiveProfileNameForTests,
  resolveActiveProfileName,
  resolveDefaultProfileName,
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
