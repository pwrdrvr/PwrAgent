import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_STATE_ROOT_ENV,
  defaultDesktopStateRoot,
  resolveDesktopOverlayStorePath,
  resolveDesktopStateRoot,
} from "../app-server/desktop-state-root";
import { PWRAGNT_HOME_ENV } from "../pwragnt-home";

describe("desktop state root", () => {
  it("defaults to an XDG-style state directory under the home directory", () => {
    expect(
      defaultDesktopStateRoot({
        env: {} as NodeJS.ProcessEnv,
        homeDir: "/Users/tester",
      }),
    ).toBe("/Users/tester/.local/state/pwragnt");
  });

  it("prefers XDG_STATE_HOME when present", () => {
    expect(
      defaultDesktopStateRoot({
        env: {} as NodeJS.ProcessEnv,
        homeDir: "/Users/tester",
        xdgStateHome: "/tmp/xdg-state",
      }),
    ).toBe("/tmp/xdg-state/pwragnt");
  });

  it("allows an explicit desktop state root override", () => {
    expect(
      resolveDesktopStateRoot({
        env: {
          [DESKTOP_STATE_ROOT_ENV]: "/tmp/pwragnt-state",
        } as NodeJS.ProcessEnv,
        homeDir: "/Users/tester",
      }),
    ).toBe("/tmp/pwragnt-state");
  });

  it("derives the overlay store path from the resolved state root", () => {
    expect(
      resolveDesktopOverlayStorePath({
        env: {
          [DESKTOP_STATE_ROOT_ENV]: "/tmp/pwragnt-state",
        } as NodeJS.ProcessEnv,
      }),
    ).toBe(path.join("/tmp/pwragnt-state", "overlay-state.json"));
  });

  it("places state under PWRAGNT_HOME when that env var is set", () => {
    expect(
      resolveDesktopStateRoot({
        env: {
          [PWRAGNT_HOME_ENV]: "/tmp/pwragnt-home",
        } as NodeJS.ProcessEnv,
        homeDir: "/Users/tester",
      }),
    ).toBe("/tmp/pwragnt-home/state");
  });

  it("prefers PWRAGNT_STATE_ROOT over PWRAGNT_HOME for backward compatibility", () => {
    expect(
      resolveDesktopStateRoot({
        env: {
          [DESKTOP_STATE_ROOT_ENV]: "/tmp/legacy",
          [PWRAGNT_HOME_ENV]: "/tmp/pwragnt-home",
        } as NodeJS.ProcessEnv,
        homeDir: "/Users/tester",
      }),
    ).toBe("/tmp/legacy");
  });

  it("falls back to XDG when neither override is set", () => {
    expect(
      resolveDesktopStateRoot({
        env: {} as NodeJS.ProcessEnv,
        homeDir: "/Users/tester",
      }),
    ).toBe("/Users/tester/.local/state/pwragnt");
  });
});
