import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PWRAGENT_HOME_ENV,
  PWRAGENT_PROFILE_ENV,
  ensureNamedProfileExists,
  setDefaultProfileName,
  startProfileRuntimeHeartbeat,
} from "../profile";

const spawnMock = vi.fn(() => ({
  unref: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
  shell: {
    trashItem: vi.fn(async () => undefined),
  },
}));

vi.mock("../app-server/backend-registry", () => ({
  disposeDesktopBackendRegistry: vi.fn(async () => undefined),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

const roots: string[] = [];

afterEach(() => {
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
  it("does not move the startup default row when listing profiles", async () => {
    const root = createRoot();
    const env = {
      [PWRAGENT_HOME_ENV]: root,
    } as NodeJS.ProcessEnv;
    const activeEnv = {
      ...env,
      [PWRAGENT_PROFILE_ENV]: "dev",
    } as NodeJS.ProcessEnv;
    ensureNamedProfileExists("dev", { env: activeEnv });
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

    expect(listDesktopPwrAgentProfiles().profiles.map((profile) => profile.name)).toEqual([
      "dev",
      "default",
      "scratch",
    ]);
  });
});
