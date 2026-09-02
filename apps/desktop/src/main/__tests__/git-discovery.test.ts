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

// Many cases mock Unix git locations (/usr/bin, /opt/homebrew); those are gated off Windows. Windows git discovery coverage is tracked separately.
describe("Git discovery", () => {
  it.skipIf(process.platform === "win32")("selects a working Homebrew git when Apple git is blocked by Xcode license", async () => {
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

  it.skipIf(process.platform === "win32")("uses user git paths in the app-server executor", async () => {
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

  it.skipIf(process.platform === "win32")("uses the supplied hydrated PATH when resolving app-server git", async () => {
    const missingError = new Error("missing") as NodeJS.ErrnoException;
    missingError.code = "ENOENT";
    const hydratedEnv = {
      PATH: "/nix/profile/bin:/usr/bin",
      ELECTRON_RENDERER_URL: "http://localhost:5175",
    } as NodeJS.ProcessEnv;
    accessMock.mockImplementation(async (candidate: string) => {
      if (candidate === "/nix/profile/bin/git") {
        return undefined;
      }
      throw missingError;
    });
    execFileMock.mockImplementation(
      (
        command: string,
        args: string[],
        options: { env?: NodeJS.ProcessEnv },
        callback: (
          error: Error | null,
          result?: { stdout: string; stderr?: string },
        ) => void,
      ) => {
        if (
          (command === "git" || command === "/nix/profile/bin/git")
          && options.env?.PATH === hydratedEnv.PATH
          && options.env?.ELECTRON_RENDERER_URL === undefined
        ) {
          callback(null, {
            stdout: args[0] === "--version" ? "git version 2.49.0\n" : "ok\n",
          });
          return;
        }
        callback(missingError);
      },
    );
    const { runGitCommand } = await import("../app-server/git-executable");

    await expect(
      runGitCommand("/repo", ["status", "--short"], { env: hydratedEnv }),
    ).resolves.toEqual({
      stdout: "ok",
      stderr: "",
    });
    expect(execFileMock).toHaveBeenCalledWith(
      "git",
      ["--version"],
      expect.objectContaining({
        env: expect.objectContaining({ PATH: hydratedEnv.PATH }),
      }),
      expect.any(Function),
    );
    expect(execFileMock).toHaveBeenCalledWith(
      "/nix/profile/bin/git",
      ["-C", "/repo", "status", "--short"],
      expect.objectContaining({
        env: expect.objectContaining({ PATH: hydratedEnv.PATH }),
      }),
      expect.any(Function),
    );
    for (const [, , options] of execFileMock.mock.calls) {
      expect((options as { env?: NodeJS.ProcessEnv }).env).not.toHaveProperty(
        "ELECTRON_RENDERER_URL",
      );
    }
  });

  it.skipIf(process.platform === "win32")("does not reuse app-server git resolution across different PATH values", async () => {
    const missingError = new Error("missing") as NodeJS.ErrnoException;
    missingError.code = "ENOENT";
    const finderEnv = { PATH: "/usr/bin:/bin" } as NodeJS.ProcessEnv;
    const hydratedEnv = {
      PATH: "/custom/bin:/usr/bin:/bin",
      ELECTRON_RENDERER_URL: "http://localhost:5175",
    } as NodeJS.ProcessEnv;
    accessMock.mockImplementation(async (candidate: string) => {
      if (candidate === "/custom/bin/git") {
        return undefined;
      }
      throw missingError;
    });
    execFileMock.mockImplementation(
      (
        command: string,
        args: string[],
        options: { env?: NodeJS.ProcessEnv },
        callback: (
          error: Error | null,
          result?: { stdout: string; stderr?: string },
        ) => void,
      ) => {
        if (
          (command === "git" || command === "/custom/bin/git")
          && args[0] === "--version"
          && options.env?.PATH === hydratedEnv.PATH
          && options.env?.ELECTRON_RENDERER_URL === undefined
        ) {
          callback(null, { stdout: "git version 2.49.0\n" });
          return;
        }
        callback(missingError);
      },
    );
    const { resolveGitExecutable } = await import("../app-server/git-executable");

    await expect(resolveGitExecutable(finderEnv)).rejects.toThrow(
      "Git executable unavailable",
    );

    await expect(resolveGitExecutable(hydratedEnv)).resolves.toBe(
      "/custom/bin/git",
    );
  });

  it.skipIf(process.platform === "win32")("skips an executable PATH directory named git", async () => {
    const directoryError = new Error("permission denied") as NodeJS.ErrnoException;
    directoryError.code = "EACCES";
    const missingError = new Error("missing") as NodeJS.ErrnoException;
    missingError.code = "ENOENT";
    const env = { PATH: "/bad/bin:/good/bin" } as NodeJS.ProcessEnv;
    execFileMock.mockImplementation(
      (
        command: string,
        args: string[],
        _options: { env?: NodeJS.ProcessEnv },
        callback: (
          error: Error | null,
          result?: { stdout: string; stderr?: string },
        ) => void,
      ) => {
        if (command === "git" && args[0] === "--version") {
          // PATH lookup skips the directory and reaches the real Git.
          callback(null, { stdout: "git version 2.49.0\n" });
          return;
        }
        if (command === "/bad/bin/git") {
          callback(directoryError);
          return;
        }
        if (command === "/good/bin/git") {
          callback(null, { stdout: "git version 2.49.0\n" });
          return;
        }
        callback(missingError);
      },
    );
    const { resolveGitExecutable } = await import("../app-server/git-executable");

    await expect(resolveGitExecutable(env)).resolves.toBe("/good/bin/git");
    expect(execFileMock).toHaveBeenCalledWith(
      "/bad/bin/git",
      ["--version"],
      expect.any(Object),
      expect.any(Function),
    );
    expect(execFileMock).toHaveBeenCalledWith(
      "/good/bin/git",
      ["--version"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it.skipIf(process.platform === "win32")("retries app-server git resolution after an initial failure", async () => {
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

  it.skipIf(process.platform === "win32")("selects the configured git and keeps the discovered source label", async () => {
    const missingError = new Error("missing") as NodeJS.ErrnoException;
    missingError.code = "ENOENT";
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
          callback(null, { stdout: "git version 2.50.1\n" });
          return;
        }
        if (command === "/opt/homebrew/bin/git") {
          callback(null, { stdout: "git version 2.54.0\n" });
          return;
        }
        callback(missingError);
      },
    );
    const { discoverGitCommands } = await import("../settings/git-discovery");

    // Without a preference, first-executable wins and Homebrew is ahead of
    // Apple in the candidate order — the exact behaviour that made Apple's
    // git unselectable.
    const env = { PATH: "/nowhere" };
    const unset = await discoverGitCommands({ env });
    expect(unset.selectedCommand).toBe("/opt/homebrew/bin/git");

    const configured = await discoverGitCommands({
      configuredCommand: "/usr/bin/git",
      env,
    });

    expect(configured.selectedCommand).toBe("/usr/bin/git");
    // The row still reads "Apple", not "config": a configured path that is
    // also a well-known location keeps the source that names it, and no
    // duplicate row is added for it.
    expect(configured.selectedSource).toBe("xcode");
    expect(
      configured.candidates.filter(
        (candidate) => candidate.command === "/usr/bin/git",
      ),
    ).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32")("adds a config candidate for a path discovery would never find", async () => {
    const missingError = new Error("missing") as NodeJS.ErrnoException;
    missingError.code = "ENOENT";
    accessMock.mockImplementation(async (candidate: string) => {
      if (candidate === "/opt/custom/git" || candidate === "/opt/homebrew/bin/git") {
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
        if (command === "/opt/custom/git" || command === "/opt/homebrew/bin/git") {
          callback(null, { stdout: "git version 2.51.0\n" });
          return;
        }
        callback(missingError);
      },
    );
    const { discoverGitCommands } = await import("../settings/git-discovery");

    const snapshot = await discoverGitCommands({
      configuredCommand: "/opt/custom/git",
      env: { PATH: "/usr/bin" },
    });

    expect(snapshot.selectedCommand).toBe("/opt/custom/git");
    expect(snapshot.selectedSource).toBe("config");
  });

  it.skipIf(process.platform === "win32")("keeps the env override ahead of the configured path", async () => {
    const missingError = new Error("missing") as NodeJS.ErrnoException;
    missingError.code = "ENOENT";
    accessMock.mockImplementation(async () => undefined);
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
        if (command === "/opt/env/git" || command === "/opt/custom/git") {
          callback(null, { stdout: "git version 2.51.0\n" });
          return;
        }
        callback(missingError);
      },
    );
    const { discoverGitCommands } = await import("../settings/git-discovery");

    const snapshot = await discoverGitCommands({
      configuredCommand: "/opt/custom/git",
      env: { PATH: "/usr/bin", PWRAGENT_GIT_PATH: "/opt/env/git" },
    });

    expect(snapshot.selectedCommand).toBe("/opt/env/git");
    expect(snapshot.selectedSource).toBe("env");
  });

  it.skipIf(process.platform === "win32")("resolves the app-server git executable through the configured path", async () => {
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
        if (command === "/opt/custom/git" || command === "/opt/homebrew/bin/git") {
          callback(null, { stdout: "git version 2.51.0\n" });
          return;
        }
        callback(missingError);
      },
    );
    const { setGitCommandResolver } = await import("../git-command");
    const { resolveGitExecutable } = await import("../app-server/git-executable");

    // Without a preference the first working well-known candidate wins.
    await expect(resolveGitExecutable()).resolves.toBe("/opt/homebrew/bin/git");

    // With one, the same resolver every git spawn shares picks it up — the
    // step that turns the Settings picker from a label into a selection.
    setGitCommandResolver(() => "/opt/custom/git");
    try {
      await expect(resolveGitExecutable()).resolves.toBe("/opt/custom/git");
    } finally {
      setGitCommandResolver(undefined);
    }
  });
});
