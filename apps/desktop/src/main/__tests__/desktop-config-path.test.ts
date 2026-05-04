import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultDesktopConfigDir,
  resolveDesktopConfigPath,
} from "../settings/desktop-config";
import { PWRAGNT_HOME_ENV } from "../profile";

describe("desktop config path", () => {
  it("defaults to ~/.config/pwragnt under the home directory", () => {
    expect(
      defaultDesktopConfigDir({
        env: {} as NodeJS.ProcessEnv,
        homeDir: "/Users/tester",
      }),
    ).toBe("/Users/tester/.config/pwragnt");
  });

  it("prefers XDG_CONFIG_HOME when present", () => {
    expect(
      defaultDesktopConfigDir({
        env: {} as NodeJS.ProcessEnv,
        homeDir: "/Users/tester",
        xdgConfigHome: "/tmp/xdg-config",
      }),
    ).toBe("/tmp/xdg-config/pwragnt");
  });

  it("places config under the active profile when PWRAGNT_HOME is set", () => {
    expect(
      resolveDesktopConfigPath({
        env: {
          [PWRAGNT_HOME_ENV]: "/tmp/pwragnt-home",
        } as NodeJS.ProcessEnv,
        homeDir: "/Users/tester",
      }),
    ).toBe(path.join("/tmp/pwragnt-home/profiles/default", "config.toml"));
  });

  it("defaults to the profile path under ~/.pwragnt/", () => {
    expect(
      resolveDesktopConfigPath({
        env: {} as NodeJS.ProcessEnv,
        homeDir: "/Users/tester",
      }),
    ).toBe("/Users/tester/.pwragnt/profiles/default/config.toml");
  });
});
