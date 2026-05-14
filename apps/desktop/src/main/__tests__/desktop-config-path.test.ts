import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultDesktopConfigDir,
  resolveDesktopConfigPath,
} from "../settings/desktop-config";
import { PWRAGENT_HOME_ENV } from "../profile";

describe("desktop config path", () => {
  it("defaults to ~/.config/pwragent under the home directory", () => {
    expect(
      defaultDesktopConfigDir({
        env: {} as NodeJS.ProcessEnv,
        homeDir: "/Users/tester",
      }),
    ).toBe("/Users/tester/.config/pwragent");
  });

  it("prefers XDG_CONFIG_HOME when present", () => {
    expect(
      defaultDesktopConfigDir({
        env: {} as NodeJS.ProcessEnv,
        homeDir: "/Users/tester",
        xdgConfigHome: "/tmp/xdg-config",
      }),
    ).toBe("/tmp/xdg-config/pwragent");
  });

  it("places config under the active profile when PWRAGENT_HOME is set", () => {
    expect(
      resolveDesktopConfigPath({
        env: {
          [PWRAGENT_HOME_ENV]: "/tmp/pwragent-home",
        } as NodeJS.ProcessEnv,
        homeDir: "/Users/tester",
      }),
    ).toBe(path.join("/tmp/pwragent-home/profiles/default", "config.toml"));
  });

  it("defaults to the profile path under ~/.pwragent/", () => {
    expect(
      resolveDesktopConfigPath({
        env: {} as NodeJS.ProcessEnv,
        homeDir: "/Users/tester",
      }),
    ).toBe("/Users/tester/.pwragent/profiles/default/config.toml");
  });

  it("uses --profile for the profile path", () => {
    expect(
      resolveDesktopConfigPath({
        argv: ["PwrAgent", "--profile", "work"],
        env: {} as NodeJS.ProcessEnv,
        homeDir: "/Users/tester",
      }),
    ).toBe("/Users/tester/.pwragent/profiles/work/config.toml");
  });
});
