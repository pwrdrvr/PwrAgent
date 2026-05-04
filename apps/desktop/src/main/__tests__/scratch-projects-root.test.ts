import { describe, expect, it } from "vitest";
import { resolveScratchProjectsRoot } from "../app-server/scratch-projects";
import { PWRAGNT_HOME_ENV } from "../profile";

describe("resolveScratchProjectsRoot", () => {
  it("defaults to the profile path under ~/.pwragnt/", () => {
    expect(
      resolveScratchProjectsRoot({
        env: {} as NodeJS.ProcessEnv,
        homeDir: "/Users/tester",
      }),
    ).toBe("/Users/tester/.pwragnt/profiles/default/projects");
  });

  it("places the projects root under the active profile when PWRAGNT_HOME is set", () => {
    expect(
      resolveScratchProjectsRoot({
        env: {
          [PWRAGNT_HOME_ENV]: "/tmp/pwragnt-home",
        } as NodeJS.ProcessEnv,
        homeDir: "/Users/tester",
      }),
    ).toBe("/tmp/pwragnt-home/profiles/default/projects");
  });
});
