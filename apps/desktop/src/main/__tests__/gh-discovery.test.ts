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

describe("GitHub CLI discovery", () => {
  it("returns usable candidates and selects a Homebrew gh outside PATH", async () => {
    const missingError = new Error("missing") as NodeJS.ErrnoException;
    missingError.code = "ENOENT";
    accessMock.mockImplementation(async (candidate: string) => {
      if (candidate === "/opt/homebrew/bin/gh") return undefined;
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
        if (command === "/opt/homebrew/bin/gh") {
          callback(null, { stdout: "gh version 2.88.1 (2026-04-30)\n" });
          return;
        }
        callback(missingError);
      },
    );
    const { discoverGhCommands } = await import("../settings/gh-discovery");

    const snapshot = await discoverGhCommands({ env: {} });

    expect(snapshot.selectedCommand).toBe("/opt/homebrew/bin/gh");
    expect(snapshot.selectedSource).toBe("homebrew");
    expect(snapshot.candidates).toEqual([
      expect.objectContaining({
        command: "/opt/homebrew/bin/gh",
        executable: true,
        selected: true,
        source: "homebrew",
        version: "2.88.1",
      }),
    ]);
  });

  it("dedupes PATH and well-known candidates that resolve to the same gh", async () => {
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
        callback(null, { stdout: "gh version 2.92.0 (2026-05-01)\n" });
      },
    );
    const { discoverGhCommands } = await import("../settings/gh-discovery");

    const snapshot = await discoverGhCommands({ env: { PATH: "/opt/homebrew/bin" } });

    expect(
      snapshot.candidates.filter((candidate) => candidate.command === "/opt/homebrew/bin/gh"),
    ).toHaveLength(1);
    expect(snapshot.selectedCommand).toBe("/opt/homebrew/bin/gh");
    expect(snapshot.candidates[0]).toMatchObject({
      command: "/opt/homebrew/bin/gh",
      executable: true,
      selected: true,
      source: "homebrew",
      version: "2.92.0",
    });
  });

  it("shows checked well-known paths when no executable gh is found", async () => {
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
    const { discoverGhCommands } = await import("../settings/gh-discovery");

    const snapshot = await discoverGhCommands({ env: {} });

    expect(snapshot.selectedCommand).toBeUndefined();
    expect(snapshot.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "gh",
          executable: false,
          failureReason: "not_found",
          source: "path",
        }),
        expect.objectContaining({
          command: "/opt/homebrew/bin/gh",
          executable: false,
          failureReason: "not_found",
          source: "homebrew",
        }),
      ]),
    );
  });

  it("selects PWRAGENT_GH_COMMAND above config and auto discovery", async () => {
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
            ? "gh version 2.90.0\n"
            : "gh version 2.80.0\n",
        });
      },
    );
    const { discoverGhCommands } = await import("../settings/gh-discovery");

    const snapshot = await discoverGhCommands({
      configuredCommand: "gh-config",
      env: { PATH: "/resolved", PWRAGENT_GH_COMMAND: "gh-env" },
    });

    expect(snapshot.selectedSource).toBe("env");
    expect(snapshot.selectedCommand).toBe("/resolved/gh-env");
    expect(snapshot.candidates.find((candidate) => candidate.source === "env")).toMatchObject({
      selected: true,
      version: "2.90.0",
    });
  });

  it("resolves a Windows PATH-only gh through PATHEXT", async () => {
    const windowsGh = "C:\\Tools\\GitHub CLI\\bin\\gh.EXE";
    accessMock.mockImplementation(async (candidate: string) => {
      if (candidate === windowsGh) return undefined;
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
        if (command === windowsGh) {
          callback(null, { stdout: "gh version 2.91.0 (2026-05-01)\n" });
          return;
        }
        const missingError = new Error("missing") as NodeJS.ErrnoException;
        missingError.code = "ENOENT";
        callback(missingError);
      },
    );
    const { discoverGhCommands } = await import("../settings/gh-discovery");

    const snapshot = await discoverGhCommands({
      env: {
        Path: "C:\\Tools\\GitHub CLI\\bin",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      },
      platform: "win32",
    });

    expect(snapshot.selectedCommand).toBe(windowsGh);
    expect(snapshot.selectedSource).toBe("path");
    expect(snapshot.candidates).toEqual([
      expect.objectContaining({
        command: windowsGh,
        executable: true,
        selected: true,
        source: "path",
        version: "2.91.0",
      }),
    ]);
  });

  it("parses common gh --version output", async () => {
    const { parseGhVersionOutput } = await import("../settings/gh-discovery");

    expect(parseGhVersionOutput("gh version 2.88.1 (2026-04-30)\n")).toBe(
      "2.88.1",
    );
    expect(parseGhVersionOutput("gh version 2.90.0-pre.1\n")).toBe(
      "2.90.0-pre.1",
    );
  });
});
