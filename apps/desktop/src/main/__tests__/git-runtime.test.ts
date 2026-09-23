import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setGitCommandResolver } from "../git-command";
import {
  bundledGitConfigDirectory,
  bundledGitDirectory,
  bundledGitEnvironment,
  bundledGitExecutable,
} from "../bundled-git";
import { customGitEnvironment, gitRuntimeEnvironment } from "../git-runtime";
import { resolveGitExecutable, runGitCommand, streamGitCommand } from "../app-server/git-executable";

afterEach(() => {
  setGitCommandResolver(undefined);
  vi.unstubAllEnvs();
});

describe("explicit Git runtime selection", () => {
  it("uses the configured executable and lets the environment override it", async () => {
    setGitCommandResolver(() => process.execPath);
    expect(await resolveGitExecutable({})).toBe(process.execPath);
    expect(await resolveGitExecutable({ PWRAGENT_GIT_PATH: bundledGitExecutable() })).toBe(bundledGitExecutable());
    // Node also accepts -C; its version proves which executable actually ran.
    expect((await runGitCommand(os.tmpdir(), ["--version"], { env: {} })).stdout.trim()).toBe(process.version);
  });

  it("does not fall back for a missing configured executable on either execution path", async () => {
    setGitCommandResolver(() => path.join(os.tmpdir(), "missing-selected-git", "git"));
    await expect(runGitCommand(os.tmpdir(), ["--version"], { env: {} })).rejects.toMatchObject({ code: "ENOENT" });
    await expect(streamGitCommand(os.tmpdir(), ["--version"], { env: {}, timeout: 1000, onStdout: () => true })).rejects.toThrow();
  });

  it("removes bundled helpers from custom environments and restores them when cleared", async () => {
    const base = { ...process.env, PATH: path.dirname(process.execPath), PWRAGENT_GIT_PATH: undefined };
    const bundled = bundledGitEnvironment(base);
    const custom = customGitEnvironment(bundled, process.execPath);
    expect(custom.GIT_EXEC_PATH).toBeUndefined();
    expect(custom.LOCAL_GIT_DIRECTORY).toBeUndefined();
    expect(custom.GIT_TEMPLATE_DIR).toBeUndefined();
    expect(custom.PATH).not.toContain(bundledGitDirectory());
    expect(custom.PATH?.split(path.delimiter)[0]).toBe(path.dirname(process.execPath));
    setGitCommandResolver(() => process.execPath);
    expect(gitRuntimeEnvironment(bundled).GIT_EXEC_PATH).toBeUndefined();
    setGitCommandResolver(undefined);
    expect(gitRuntimeEnvironment(custom).GIT_EXEC_PATH).toContain(bundledGitDirectory());
    expect(await resolveGitExecutable(custom)).toBe(bundledGitExecutable());
  });

  it("drops the bundle's generated system config for a selected Git", () => {
    vi.stubEnv("PWRAGENT_HOME", path.join(os.tmpdir(), "pwragent-generated-config-home"));
    const generated = path.join(bundledGitConfigDirectory(), "gitconfig-0123456789abcdef");
    const custom = customGitEnvironment({ GIT_CONFIG_SYSTEM: generated }, process.execPath);
    expect(custom.GIT_CONFIG_SYSTEM).toBeUndefined();
    // An operator's own system config is theirs to keep.
    const own = path.join(os.tmpdir(), "operator-gitconfig");
    expect(customGitEnvironment({ GIT_CONFIG_SYSTEM: own }, process.execPath).GIT_CONFIG_SYSTEM)
      .toBe(own);
  });
});
