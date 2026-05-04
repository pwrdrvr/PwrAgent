import { describe, expect, it } from "vitest";
import { resolveScratchProjectsRoot } from "../app-server/scratch-projects";
import { PWRAGENT_HOME_ENV } from "../profile";

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
});
