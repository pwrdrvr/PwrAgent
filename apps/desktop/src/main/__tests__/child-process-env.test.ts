import { describe, expect, it } from "vitest";
import {
  buildPwrAgentChildProcessEnv,
  mergePwrAgentChildProcessEnv,
} from "../child-process-env";

describe("PwrAgent child process environment", () => {
  it("blocks the renderer URL after inherited and later override layers", () => {
    const inherited = {
      ELECTRON_RENDERER_URL: "http://localhost:5173",
      PATH: "/usr/bin",
      KEEP_PARENT: "parent",
    } as NodeJS.ProcessEnv;
    const overrides = {
      ELECTRON_RENDERER_URL: "http://localhost:5175",
      KEEP_PARENT: "overridden",
      KEEP_OVERRIDE: "override",
    } as NodeJS.ProcessEnv;

    const env = buildPwrAgentChildProcessEnv(inherited, overrides);

    expect(env).not.toHaveProperty("ELECTRON_RENDERER_URL");
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      KEEP_PARENT: "overridden",
      KEEP_OVERRIDE: "override",
    });
    expect(inherited.ELECTRON_RENDERER_URL).toBe("http://localhost:5173");
    expect(overrides.ELECTRON_RENDERER_URL).toBe("http://localhost:5175");
  });

  it("removes every casing from a mutable hydrated environment after a merge", () => {
    const target = {
      Electron_Renderer_Url: "http://localhost:5173",
      PATH: "/usr/bin",
    } as NodeJS.ProcessEnv;

    mergePwrAgentChildProcessEnv(target, {
      ELECTRON_RENDERER_URL: "http://localhost:5175",
      PATH: "/opt/homebrew/bin:/usr/bin",
    });

    expect(target).not.toHaveProperty("Electron_Renderer_Url");
    expect(target).not.toHaveProperty("ELECTRON_RENDERER_URL");
    expect(target.PATH).toBe("/opt/homebrew/bin:/usr/bin");
  });
});
