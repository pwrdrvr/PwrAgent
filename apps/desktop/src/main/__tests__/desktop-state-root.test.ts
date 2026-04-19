import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_STATE_ROOT_ENV,
  defaultDesktopStateRoot,
  resolveDesktopOverlayStorePath,
  resolveDesktopStateRoot,
} from "../app-server/desktop-state-root";

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
});
