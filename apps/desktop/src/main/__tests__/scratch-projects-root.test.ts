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
    ).toBe("/Users/tester/.pwragent/profiles/default/projects");
  });

  it("places the projects root under the active profile when PWRAGENT_HOME is set", () => {
    expect(
      resolveScratchProjectsRoot({
        env: {
          [PWRAGENT_HOME_ENV]: "/tmp/pwragent-home",
        } as NodeJS.ProcessEnv,
        homeDir: "/Users/tester",
      }),
    ).toBe("/tmp/pwragent-home/profiles/default/projects");
  });

  it("allows only the active profile workspace plus legacy scratch root", () => {
    expect(
      resolveScratchProjectsRoots({
        env: {} as NodeJS.ProcessEnv,
        homeDir: "/Users/tester",
      }),
    ).toEqual([
      "/Users/tester/.pwragent/profiles/default/projects",
      "/Users/tester/.pwragent/projects",
      "/Users/tester/.pwragnt/projects",
    ]);

    expect(
      resolveScratchProjectsRoots({
        env: {
          [PWRAGENT_PROFILE_ENV]: "dev",
        } as NodeJS.ProcessEnv,
        homeDir: "/Users/tester",
      }),
    ).toEqual(["/Users/tester/.pwragent/profiles/dev/projects"]);
  });
});
