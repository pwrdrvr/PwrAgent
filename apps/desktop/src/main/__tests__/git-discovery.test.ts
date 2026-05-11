import { beforeEach, describe, expect, it, vi } from "vitest";

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

beforeEach(() => {
  vi.resetModules();
  accessMock.mockReset();
  execFileMock.mockReset();
});

describe("Git discovery", () => {
  it("selects a working Homebrew git when Apple git is blocked by Xcode license", async () => {
    const missingError = new Error("missing") as NodeJS.ErrnoException;
    missingError.code = "ENOENT";
    const xcodeError = new Error(
      "You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license'",
    );
    accessMock.mockImplementation(async (candidate: string) => {
      if (candidate === "/usr/bin/git" || candidate === "/opt/homebrew/bin/git") {
        return undefined;
      }
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
        if (command === "/usr/bin/git") {
          callback(xcodeError);
          return;
        }
        if (command === "/opt/homebrew/bin/git") {
          callback(null, { stdout: "git version 2.39.1\n" });
          return;
        }
        callback(missingError);
      },
    );
    const { discoverGitCommands, isXcodeLicenseFailure } = await import(
      "../settings/git-discovery"
    );

    const snapshot = await discoverGitCommands({ env: { PATH: "/usr/bin" } });

    expect(snapshot.selectedCommand).toBe("/opt/homebrew/bin/git");
    expect(snapshot.selectedSource).toBe("homebrew");
    expect(snapshot.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "/usr/bin/git",
          executable: false,
          selected: false,
          source: "path",
          failureReason: expect.stringContaining("Xcode license"),
        }),
        expect.objectContaining({
          command: "/opt/homebrew/bin/git",
          executable: true,
          selected: true,
          source: "homebrew",
          version: "2.39.1",
        }),
      ]),
    );
    expect(isXcodeLicenseFailure(snapshot.candidates[0]?.failureReason)).toBe(true);
  });

  it("parses git --version output", async () => {
    const { parseGitVersionOutput } = await import("../settings/git-discovery");

    expect(parseGitVersionOutput("git version 2.39.1\n")).toBe("2.39.1");
    expect(parseGitVersionOutput("git version 2.45.0.windows.1\n")).toBe(
      "2.45.0.windows.1",
    );
  });

  it("uses user git paths in the app-server executor", async () => {
    const homeGit = "/Users/test/bin/git";
    const missingError = new Error("missing") as NodeJS.ErrnoException;
    missingError.code = "ENOENT";
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
        if (command === homeGit) {
          callback(null, { stdout: "git version 2.48.0\n" });
          return;
        }
        callback(missingError);
      },
    );
    vi.doMock("node:os", () => ({
      default: {
        homedir: () => "/Users/test",
      },
    }));
    const { resolveGitExecutable } = await import("../app-server/git-executable");

    await expect(resolveGitExecutable()).resolves.toBe(homeGit);
  });

  it("retries app-server git resolution after an initial failure", async () => {
    const missingError = new Error("missing") as NodeJS.ErrnoException;
    missingError.code = "ENOENT";
    let failAll = true;
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
        if (!failAll && command === "/opt/homebrew/bin/git") {
          callback(null, { stdout: "git version 2.39.1\n" });
          return;
        }
        callback(missingError);
      },
    );
    const { resolveGitExecutable } = await import("../app-server/git-executable");

    await expect(resolveGitExecutable()).rejects.toThrow("Git executable unavailable");

    failAll = false;

    await expect(resolveGitExecutable()).resolves.toBe("/opt/homebrew/bin/git");
  });
});
