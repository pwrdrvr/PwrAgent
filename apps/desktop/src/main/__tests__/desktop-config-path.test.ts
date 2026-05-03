import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultDesktopConfigDir,
  resolveDesktopConfigPath,
} from "../settings/desktop-config";
import { DESKTOP_CONFIG_PATH_ENV } from "../settings/desktop-settings-env";
import { PWRAGNT_HOME_ENV } from "../pwragnt-home";

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

  it("places config under PWRAGNT_HOME when that env var is set", () => {
    expect(
      resolveDesktopConfigPath({
        env: {
          [PWRAGNT_HOME_ENV]: "/tmp/pwragnt-home",
        } as NodeJS.ProcessEnv,
        homeDir: "/Users/tester",
      }),
    ).toBe(path.join("/tmp/pwragnt-home", "config.toml"));
  });

  it("prefers PWRAGNT_CONFIG_PATH over PWRAGNT_HOME for backward compatibility", () => {
    expect(
      resolveDesktopConfigPath({
        env: {
          [DESKTOP_CONFIG_PATH_ENV]: "/tmp/explicit/config.toml",
          [PWRAGNT_HOME_ENV]: "/tmp/pwragnt-home",
        } as NodeJS.ProcessEnv,
        homeDir: "/Users/tester",
      }),
    ).toBe("/tmp/explicit/config.toml");
  });

  it("falls back to XDG-style ~/.config/pwragnt/config.toml when no override is set", () => {
    expect(
      resolveDesktopConfigPath({
        env: {} as NodeJS.ProcessEnv,
        homeDir: "/Users/tester",
      }),
    ).toBe("/Users/tester/.config/pwragnt/config.toml");
  });
});
