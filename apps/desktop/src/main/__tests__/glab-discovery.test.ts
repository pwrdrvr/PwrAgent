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
    callback: (
      error: Error | null,
      result?: { stdout: string; stderr?: string },
    ) => void,
  ) => {
    execFileMock(command, args, options, callback);
  },
}));

// Many cases mock Unix glab locations (/usr/bin, /opt/homebrew); those are gated off Windows. Windows glab discovery coverage is tracked separately (see the PATHEXT case below).
describe("GitLab CLI discovery", () => {
  it.skipIf(process.platform === "win32")("returns usable candidates and selects a Homebrew glab outside PATH", async () => {
    const missingError = new Error("missing") as NodeJS.ErrnoException;
    missingError.code = "ENOENT";
    accessMock.mockImplementation(async (candidate: string) => {
      if (candidate === "/opt/homebrew/bin/glab") return undefined;
      throw missingError;
    });
    execFileMock.mockImplementation(
      (
        command: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (
          error: Error | null,
          result?: { stdout: string; stderr?: string },
        ) => void,
      ) => {
        if (command === "/opt/homebrew/bin/glab") {
          callback(null, { stdout: "glab version 2.88.1 (2026-04-30)\n" });
          return;
        }
        callback(missingError);
      },
    );
    const { discoverGlabCommands } = await import("../settings/glab-discovery");

    const snapshot = await discoverGlabCommands({ env: {} });

    expect(snapshot.selectedCommand).toBe("/opt/homebrew/bin/glab");
    expect(snapshot.selectedSource).toBe("homebrew");
    expect(snapshot.candidates).toEqual([
      expect.objectContaining({
        command: "/opt/homebrew/bin/glab",
        executable: true,
        selected: true,
        source: "homebrew",
        version: "2.88.1",
      }),
    ]);
  });

  it.skipIf(process.platform === "win32")("dedupes PATH and well-known candidates that resolve to the same glab", async () => {
    accessMock.mockResolvedValue(undefined);
    execFileMock.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (
          error: Error | null,
          result?: { stdout: string; stderr?: string },
        ) => void,
      ) => {
        callback(null, { stdout: "glab version 2.92.0 (2026-05-01)\n" });
      },
    );
    const { discoverGlabCommands } = await import("../settings/glab-discovery");

    const snapshot = await discoverGlabCommands({ env: { PATH: "/opt/homebrew/bin" } });

    expect(
      snapshot.candidates.filter((candidate) => candidate.command === "/opt/homebrew/bin/glab"),
    ).toHaveLength(1);
    expect(snapshot.selectedCommand).toBe("/opt/homebrew/bin/glab");
    expect(snapshot.candidates[0]).toMatchObject({
      command: "/opt/homebrew/bin/glab",
      executable: true,
      selected: true,
      source: "homebrew",
      version: "2.92.0",
    });
  });

  it.skipIf(process.platform === "win32")("shows checked well-known paths when no executable glab is found", async () => {
    const missingError = new Error("missing") as NodeJS.ErrnoException;
    missingError.code = "ENOENT";
    accessMock.mockRejectedValue(missingError);
    execFileMock.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null) => void,
      ) => {
        callback(missingError);
      },
    );
    const { discoverGlabCommands } = await import("../settings/glab-discovery");

    const snapshot = await discoverGlabCommands({ env: {} });

    expect(snapshot.selectedCommand).toBeUndefined();
    expect(snapshot.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "glab",
          executable: false,
          failureReason: "not_found",
          source: "path",
        }),
        expect.objectContaining({
          command: "/opt/homebrew/bin/glab",
          executable: false,
          failureReason: "not_found",
          source: "homebrew",
        }),
      ]),
    );
  });

  it.skipIf(process.platform === "win32")("selects PWRAGENT_GLAB_COMMAND above config and auto discovery", async () => {
    accessMock.mockResolvedValue(undefined);
    execFileMock.mockImplementation(
      (
        command: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (
          error: Error | null,
          result?: { stdout: string; stderr?: string },
        ) => void,
      ) => {
        callback(null, {
          stdout: command.includes("env")
            ? "glab version 2.90.0\n"
            : "glab version 2.80.0\n",
        });
      },
    );
    const { discoverGlabCommands } = await import("../settings/glab-discovery");

    const snapshot = await discoverGlabCommands({
      configuredCommand: "glab-config",
      env: { PATH: "/resolved", PWRAGENT_GLAB_COMMAND: "glab-env" },
    });

    expect(snapshot.selectedSource).toBe("env");
    expect(snapshot.selectedCommand).toBe("/resolved/glab-env");
    expect(snapshot.candidates.find((candidate) => candidate.source === "env")).toMatchObject({
      selected: true,
      version: "2.90.0",
    });
  });

  it("resolves a Windows PATH-only glab througlab PATHEXT", async () => {
    const windowsGlab = "C:\\Tools\\GitLab CLI\\bin\\glab.EXE";
    accessMock.mockImplementation(async (candidate: string) => {
      if (candidate === windowsGlab) return undefined;
      const missingError = new Error("missing") as NodeJS.ErrnoException;
      missingError.code = "ENOENT";
      throw missingError;
    });
    execFileMock.mockImplementation(
      (
        command: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (
          error: Error | null,
          result?: { stdout: string; stderr?: string },
        ) => void,
      ) => {
        if (command === windowsGlab) {
          callback(null, { stdout: "glab version 2.91.0 (2026-05-01)\n" });
          return;
        }
        const missingError = new Error("missing") as NodeJS.ErrnoException;
        missingError.code = "ENOENT";
        callback(missingError);
      },
    );
    const { discoverGlabCommands } = await import("../settings/glab-discovery");

    const snapshot = await discoverGlabCommands({
      env: {
        Path: "C:\\Tools\\GitLab CLI\\bin",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      },
      platform: "win32",
    });

    expect(snapshot.selectedCommand).toBe(windowsGlab);
    expect(snapshot.selectedSource).toBe("path");
    expect(snapshot.candidates).toEqual([
      expect.objectContaining({
        command: windowsGlab,
        executable: true,
        selected: true,
        source: "path",
        version: "2.91.0",
      }),
    ]);
  });

  it("parses common glab --version output", async () => {
    const { parseGlabVersionOutput } = await import("../settings/glab-discovery");

    expect(parseGlabVersionOutput("glab version 2.88.1 (2026-04-30)\n")).toBe(
      "2.88.1",
    );
    expect(parseGlabVersionOutput("glab version 2.90.0-pre.1\n")).toBe(
      "2.90.0-pre.1",
    );
  });
});
