import path from "node:path";
import { describe, expect, it } from "vitest";
import { PWRAGENT_HOME_ENV, readPwragentHome } from "../pwragent-home";

describe("readPwragentHome", () => {
  it("returns undefined when PWRAGENT_HOME is unset", () => {
    expect(readPwragentHome({ env: {} as NodeJS.ProcessEnv })).toBeUndefined();
  });

  it("returns undefined when PWRAGENT_HOME is empty after trimming", () => {
    expect(
      readPwragentHome({
        env: { [PWRAGENT_HOME_ENV]: "   " } as NodeJS.ProcessEnv,
      }),
    ).toBeUndefined();
  });

  it("returns the absolute path when PWRAGENT_HOME is set", () => {
    expect(
      readPwragentHome({
        env: { [PWRAGENT_HOME_ENV]: "/tmp/pwragent" } as NodeJS.ProcessEnv,
      }),
    ).toBe("/tmp/pwragent");
  });

  it("trims surrounding whitespace before resolving", () => {
    expect(
      readPwragentHome({
        env: { [PWRAGENT_HOME_ENV]: "  /tmp/pwragent  " } as NodeJS.ProcessEnv,
      }),
    ).toBe("/tmp/pwragent");
  });

  it("resolves relative paths against the current working directory", () => {
    expect(
      readPwragentHome({
        env: { [PWRAGENT_HOME_ENV]: "relative/sub" } as NodeJS.ProcessEnv,
      }),
    ).toBe(path.resolve("relative/sub"));
  });
});
