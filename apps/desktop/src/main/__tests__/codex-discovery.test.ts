import { describe, expect, it, vi } from "vitest";

const accessMock = vi.fn();
const execFileMock = vi.fn();

vi.mock("node:fs/promises", () => ({
  access: accessMock,
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
  it("selects env overrides above configured and auto-discovered commands", async () => {
    accessMock.mockResolvedValue(undefined);
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
