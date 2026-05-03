import { describe, expect, it } from "vitest";
import { resolveScratchProjectsRoot } from "../app-server/scratch-projects";
import { PWRAGNT_HOME_ENV } from "../pwragnt-home";

describe("resolveScratchProjectsRoot", () => {
  it("defaults to ~/.pwragnt/projects under the home directory", () => {
    expect(
      resolveScratchProjectsRoot({
        env: {} as NodeJS.ProcessEnv,
        homeDir: "/Users/tester",
      }),
    ).toBe("/Users/tester/.pwragnt/projects");
  });

  it("places the projects root under PWRAGNT_HOME when set", () => {
    expect(
      resolveScratchProjectsRoot({
        env: {
          [PWRAGNT_HOME_ENV]: "/tmp/pwragnt-home",
        } as NodeJS.ProcessEnv,
        homeDir: "/Users/tester",
      }),
    ).toBe("/tmp/pwragnt-home/projects");
  });
});
