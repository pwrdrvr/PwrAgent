import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveScratchProjectsRoot,
  resolveScratchProjectsRoots,
} from "../app-server/scratch-projects";
import { PWRAGENT_HOME_ENV, PWRAGENT_PROFILE_ENV } from "../profile";

describe("resolveScratchProjectsRoot", () => {
  it("defaults to the profile path under ~/.pwragent/", () => {
    expect(
      resolveScratchProjectsRoot({
        env: {} as NodeJS.ProcessEnv,
        homeDir: "/Users/tester",
      }),
    ).toBe(
      path.join(
        "/Users/tester",
        ".pwragent",
        "profiles",
        "default",
        "projects",
      ),
    );
  });

  it("places the projects root under the active profile when PWRAGENT_HOME is set", () => {
    expect(
      resolveScratchProjectsRoot({
        env: {
          [PWRAGENT_HOME_ENV]: "/tmp/pwragent-home",
        } as NodeJS.ProcessEnv,
        homeDir: "/Users/tester",
      }),
    ).toBe(
      // The product `path.resolve`s PWRAGENT_HOME, so mirror that here to pick
      // up the drive prefix on Windows.
      path.join(
        path.resolve("/tmp/pwragent-home"),
        "profiles",
        "default",
        "projects",
      ),
    );
  });

  it("allows only the active profile workspace plus legacy scratch root", () => {
    expect(
      resolveScratchProjectsRoots({
        env: {} as NodeJS.ProcessEnv,
        homeDir: "/Users/tester",
      }),
    ).toEqual([
      path.join(
        "/Users/tester",
        ".pwragent",
        "profiles",
        "default",
        "projects",
      ),
      path.join("/Users/tester", ".pwragent", "projects"),
      path.join("/Users/tester", ".pwragnt", "projects"),
    ]);

    expect(
      resolveScratchProjectsRoots({
        env: {
          [PWRAGENT_PROFILE_ENV]: "dev",
        } as NodeJS.ProcessEnv,
        homeDir: "/Users/tester",
      }),
    ).toEqual([
      path.join("/Users/tester", ".pwragent", "profiles", "dev", "projects"),
    ]);
  });
});
