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
        args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, result?: { stdout: string }) => void,
      ) => {
        if (command === "/usr/bin/which") {
          callback(null, { stdout: `/usr/local/bin/${args[0]}\n` });
          return;
        }
        callback(null, {
          stdout: command.includes("env") ? "codex 0.130.0\n" : "codex 0.120.0\n",
        });
      },
    );
    const { discoverCodexCommands } = await import("../settings/codex-discovery");

    const snapshot = await discoverCodexCommands({
      configuredCommand: "codex-config",
      env: {
        PWRAGNT_CODEX_COMMAND: "codex-env",
      },
    });

    expect(snapshot.selectedSource).toBe("env");
    expect(snapshot.selectedCommand).toBe("/usr/local/bin/codex-env");
    expect(snapshot.candidates.find((candidate) => candidate.source === "env")).toMatchObject({
      selected: true,
      version: "0.130.0",
    });
  });

  it("keeps invalid configured commands visible with a failure reason", async () => {
    accessMock.mockRejectedValue(new Error("not executable"));
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
      failureReason: "not_executable",
    });
  });
});
