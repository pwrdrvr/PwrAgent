import { beforeEach, describe, expect, it, vi } from "vitest";

const accessMock = vi.fn();
const execFileMock = vi.fn();
const realpathMock = vi.fn();

vi.mock("node:fs/promises", () => ({
  access: accessMock,
  realpath: realpathMock,
}));

vi.mock("node:child_process", () => ({
  execFile: (
    command: string,
    args: string[],
    options: Record<string, unknown>,
    callback: (error: Error | null, result?: { stdout: string }) => void,
  ) => {
    execFileMock(command, args, options, callback);
  },
}));

describe("Codex discovery", () => {
  beforeEach(() => {
    accessMock.mockReset();
    execFileMock.mockReset();
    realpathMock.mockReset();
  });

  it("rejects old Homebrew Caskroom Codex versions without spawning them", async () => {
    const notFoundError = new Error("missing") as NodeJS.ErrnoException;
    notFoundError.code = "ENOENT";
    accessMock.mockImplementation(async (candidate: string) => {
      if (candidate === "/opt/homebrew/bin/codex") return undefined;
      throw notFoundError;
    });
    realpathMock.mockResolvedValue(
      "/opt/homebrew/Caskroom/codex/0.94.0/codex-aarch64-apple-darwin",
    );
    execFileMock.mockImplementation(() => {
      throw new Error("old Codex should not be executed");
    });
    const { discoverCodexCommands } = await import("../settings/codex-discovery");

    const snapshot = await discoverCodexCommands({
      env: { PATH: "/opt/homebrew/bin" },
      platform: "darwin",
    });

    expect(snapshot.selectedCommand).toBeUndefined();
    expect(snapshot.candidates.find((candidate) => candidate.source === "path")).toMatchObject({
      command: "/opt/homebrew/bin/codex",
      executable: false,
      failureReason: "codex_too_old",
      version: "0.94.0",
    });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("does not fall back to spawning codex when the only resolved candidate is too old", async () => {
    const notFoundError = new Error("missing") as NodeJS.ErrnoException;
    notFoundError.code = "ENOENT";
    accessMock.mockImplementation(async (candidate: string) => {
      if (candidate === "/opt/homebrew/bin/codex") return undefined;
      throw notFoundError;
    });
    realpathMock.mockResolvedValue(
      "/opt/homebrew/Caskroom/codex/0.94.0/codex-aarch64-apple-darwin",
    );
    execFileMock.mockImplementation(() => {
      throw new Error("old Codex should not be executed");
    });
    const { resolveCodexCommand } = await import("../settings/codex-discovery");

    await expect(
      resolveCodexCommand({
        command: "codex",
        env: { PATH: "/opt/homebrew/bin" },
        platform: "darwin",
      }),
    ).rejects.toThrow("older than the minimum supported version 0.125.0");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("uses Homebrew Caskroom versions without a --version probe when they are new enough", async () => {
    const notFoundError = new Error("missing") as NodeJS.ErrnoException;
    notFoundError.code = "ENOENT";
    accessMock.mockImplementation(async (candidate: string) => {
      if (candidate === "/opt/homebrew/bin/codex") return undefined;
      throw notFoundError;
    });
    realpathMock.mockResolvedValue(
      "/opt/homebrew/Caskroom/codex/0.130.0/codex-aarch64-apple-darwin",
    );
    execFileMock.mockImplementation(() => {
      throw new Error("Codex version should come from the Caskroom path");
    });
    const { discoverCodexCommands } = await import("../settings/codex-discovery");

    const snapshot = await discoverCodexCommands({
      env: { PATH: "/opt/homebrew/bin" },
      platform: "darwin",
    });

    expect(snapshot.selectedCommand).toBe("/opt/homebrew/bin/codex");
    expect(snapshot.candidates.find((candidate) => candidate.source === "path")).toMatchObject({
      executable: true,
      selected: true,
      version: "0.130.0",
    });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("uses the Codex.app helper version instead of the Electron bundle version", async () => {
    const appCommand = "/Applications/Codex.app/Contents/Resources/codex";
    const notFoundError = new Error("missing") as NodeJS.ErrnoException;
    notFoundError.code = "ENOENT";
    accessMock.mockImplementation(async (candidate: string) => {
      if (candidate === appCommand) return undefined;
      throw notFoundError;
    });
    realpathMock.mockImplementation(async (candidate: string) => candidate);
    execFileMock.mockImplementation(
      (
        command: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, result?: { stdout: string }) => void,
      ) => {
        if (command === appCommand) {
          callback(null, { stdout: "codex-cli 0.130.0-alpha.5\n" });
          return;
        }
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        callback(error);
      },
    );
    const { discoverCodexCommands } = await import("../settings/codex-discovery");

    const snapshot = await discoverCodexCommands({
      env: {},
      platform: "darwin",
    });

    expect(snapshot.selectedCommand).toBe(appCommand);
    expect(
      snapshot.candidates.find((candidate) => candidate.source === "application"),
    ).toMatchObject({
      executable: true,
      selected: true,
      version: "0.130.0-alpha.5",
    });
    expect(execFileMock).toHaveBeenCalledWith(
      appCommand,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(execFileMock).not.toHaveBeenCalledWith(
      "/usr/bin/plutil",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("rejects old Codex.app helper versions after probing the helper binary", async () => {
    const appCommand = "/Applications/Codex.app/Contents/Resources/codex";
    const notFoundError = new Error("missing") as NodeJS.ErrnoException;
    notFoundError.code = "ENOENT";
    accessMock.mockImplementation(async (candidate: string) => {
      if (candidate === appCommand) return undefined;
      throw notFoundError;
    });
    realpathMock.mockImplementation(async (candidate: string) => candidate);
    execFileMock.mockImplementation(
      (
        command: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, result?: { stdout: string }) => void,
      ) => {
        if (command === appCommand) {
          callback(null, { stdout: "codex-cli 0.94.0\n" });
          return;
        }
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        callback(error);
      },
    );
    const { discoverCodexCommands, resolveCodexCommand } = await import(
      "../settings/codex-discovery"
    );

    const snapshot = await discoverCodexCommands({
      env: {},
      platform: "darwin",
    });

    expect(snapshot.selectedCommand).toBeUndefined();
    expect(
      snapshot.candidates.find((candidate) => candidate.source === "application"),
    ).toMatchObject({
      command: appCommand,
      executable: false,
      failureReason: "codex_too_old",
      version: "0.94.0",
    });
    await expect(
      resolveCodexCommand({
        command: "codex",
        env: {},
        platform: "darwin",
      }),
    ).rejects.toThrow("older than the minimum supported version 0.125.0");
  });

  it("selects env overrides above configured and auto-discovered commands", async () => {
    accessMock.mockResolvedValue(undefined);
    realpathMock.mockImplementation(async (candidate: string) => candidate);
    execFileMock.mockImplementation(
      (
        command: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, result?: { stdout: string }) => void,
      ) => {
        callback(null, {
          stdout: command.includes("env") ? "codex 0.130.0\n" : "codex 0.120.0\n",
        });
      },
    );
    const { discoverCodexCommands } = await import("../settings/codex-discovery");

    const snapshot = await discoverCodexCommands({
      configuredCommand: "codex-config",
      env: {
        PATH: "/usr/local/bin",
        PWRAGENT_CODEX_COMMAND: "codex-env",
      },
    });

    expect(snapshot.selectedSource).toBe("env");
    expect(snapshot.selectedCommand).toBe("/usr/local/bin/codex-env");
    expect(snapshot.candidates.find((candidate) => candidate.source === "env")).toMatchObject({
      selected: true,
      version: "0.130.0",
    });
    expect(accessMock).toHaveBeenCalledWith("/usr/local/bin/codex-env", 1);
  });

  it("keeps invalid configured commands visible with a failure reason", async () => {
    const missingError = new Error("missing") as NodeJS.ErrnoException;
    missingError.code = "ENOENT";
    accessMock.mockRejectedValue(missingError);
    realpathMock.mockImplementation(async (candidate: string) => candidate);
    execFileMock.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null) => void,
      ) => callback(new Error("missing")),
    );
    const { discoverCodexCommands } = await import("../settings/codex-discovery");

    const snapshot = await discoverCodexCommands({
      configuredCommand: "/missing/codex",
      env: {},
    });

    expect(snapshot.selectedCommand).toBeUndefined();
    expect(snapshot.candidates.find((candidate) => candidate.source === "config")).toMatchObject({
      command: "/missing/codex",
      executable: false,
      failureReason: "not_found",
    });
    expect(snapshot.candidates.some((candidate) => candidate.source === "path")).toBe(false);
    expect(snapshot.candidates.some((candidate) => candidate.source === "application")).toBe(false);
  });

  it("treats a successful version probe as executable when access fails", async () => {
    accessMock.mockRejectedValue(new Error("access denied"));
    realpathMock.mockImplementation(async (candidate: string) => candidate);
    execFileMock.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, result?: { stdout: string; stderr?: string }) => void,
      ) => {
        callback(null, { stdout: "codex-cli 0.125.0\n" });
      },
    );
    const { discoverCodexCommands } = await import("../settings/codex-discovery");

    const snapshot = await discoverCodexCommands({ env: { PATH: "/opt/homebrew/bin" } });

    expect(snapshot.selectedCommand).toBe("/opt/homebrew/bin/codex");
    expect(snapshot.candidates.find((candidate) => candidate.source === "path")).toMatchObject({
      executable: true,
      selected: true,
      version: "0.125.0",
    });
  });

  it("reads Codex versions from stderr when needed", async () => {
    accessMock.mockResolvedValue(undefined);
    realpathMock.mockImplementation(async (candidate: string) => candidate);
    execFileMock.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, result?: { stdout: string; stderr?: string }) => void,
      ) => {
        callback(null, { stdout: "", stderr: "codex-cli 0.126.0-alpha.8\n" });
      },
    );
    const { discoverCodexCommands } = await import("../settings/codex-discovery");

    const snapshot = await discoverCodexCommands({ env: { PATH: "/opt/homebrew/bin" } });

    expect(snapshot.candidates.find((candidate) => candidate.source === "path")).toMatchObject({
      executable: true,
      version: "0.126.0-alpha.8",
    });
  });
});
