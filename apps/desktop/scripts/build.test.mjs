import { describe, expect, it, vi } from "vitest";
import { buildDesktop } from "./build.mjs";

describe("desktop build processes", () => {
  it("builds all targets in order with the caller's Node and heap options", () => {
    const run = vi.fn(() => ({ status: 0 }));
    const env = {
      NODE_OPTIONS: "--max-old-space-size=4096",
      PWRAGENT_BUILD_TARGET: "renderer",
    };

    expect(buildDesktop(["--mode", "production"], {
      node: "/fixture/node",
      env,
      spawnSync: run,
    })).toBe(0);
    expect(run.mock.calls.map(([, , options]) => options.env.PWRAGENT_BUILD_TARGET))
      .toEqual(["main", "preload", "renderer"]);
    for (const [node, args, options] of run.mock.calls) {
      expect(node).toBe("/fixture/node");
      expect(args).toEqual([
        expect.stringMatching(/electron-vite[\\/]bin[\\/]electron-vite\.js$/),
        "build", "--mode", "production", "--ignoreConfigWarning",
      ]);
      expect(options.env.NODE_OPTIONS).toBe(env.NODE_OPTIONS);
      expect(options.stdio).toBe("inherit");
      expect(options.shell).toBeUndefined();
    }
    expect(env.PWRAGENT_BUILD_TARGET).toBe("renderer");
  });

  it("propagates a failed build without starting later targets", () => {
    const run = vi.fn()
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 7 });

    expect(buildDesktop([], { spawnSync: run })).toBe(7);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("treats a child killed by a signal as failure", () => {
    const run = vi.fn(() => ({ status: null, signal: "SIGTERM" }));

    expect(buildDesktop([], { spawnSync: run })).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("stops if Node cannot be started", () => {
    const run = vi.fn(() => ({ status: null, error: new Error("spawn failed") }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(buildDesktop([], { spawnSync: run })).toBe(1);
      expect(run).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith("Desktop main build failed: spawn failed");
    } finally {
      error.mockRestore();
    }
  });
});
