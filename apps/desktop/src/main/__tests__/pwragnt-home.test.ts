import path from "node:path";
import { describe, expect, it } from "vitest";
import { PWRAGNT_HOME_ENV, readPwragntHome } from "../pwragnt-home";

describe("readPwragntHome", () => {
  it("returns undefined when PWRAGNT_HOME is unset", () => {
    expect(readPwragntHome({ env: {} as NodeJS.ProcessEnv })).toBeUndefined();
  });

  it("returns undefined when PWRAGNT_HOME is empty after trimming", () => {
    expect(
      readPwragntHome({
        env: { [PWRAGNT_HOME_ENV]: "   " } as NodeJS.ProcessEnv,
      }),
    ).toBeUndefined();
  });

  it("returns the absolute path when PWRAGNT_HOME is set", () => {
    expect(
      readPwragntHome({
        env: { [PWRAGNT_HOME_ENV]: "/tmp/pwragnt" } as NodeJS.ProcessEnv,
      }),
    ).toBe("/tmp/pwragnt");
  });

  it("trims surrounding whitespace before resolving", () => {
    expect(
      readPwragntHome({
        env: { [PWRAGNT_HOME_ENV]: "  /tmp/pwragnt  " } as NodeJS.ProcessEnv,
      }),
    ).toBe("/tmp/pwragnt");
  });

  it("resolves relative paths against the current working directory", () => {
    expect(
      readPwragntHome({
        env: { [PWRAGNT_HOME_ENV]: "relative/sub" } as NodeJS.ProcessEnv,
      }),
    ).toBe(path.resolve("relative/sub"));
  });
});
