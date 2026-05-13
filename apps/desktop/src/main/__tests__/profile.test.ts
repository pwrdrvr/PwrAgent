import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PWRAGENT_HOME_ENV,
  PWRAGENT_PROFILE_ENV,
  deleteProfile,
  ensureNamedProfileExists,
  readProfileArg,
  readProfilesRegistry,
  resolveActiveProfileName,
  resolveDefaultProfileName,
  setDefaultProfileName,
} from "../profile";

const roots: string[] = [];

afterEach(() => {
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
});
