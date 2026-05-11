import { describe, expect, it, vi } from "vitest";
import {
  mergeLoginShellEnvIntoEnv,
  resolveInteractiveLoginShellEnv,
} from "../shell-environment";

describe("shell environment", () => {
  it("reads the environment from an interactive login shell so zshrc-managed tools are visible", () => {
    const execFileSync = vi.fn(() =>
      [
        "oh-my-zsh startup noise",
        "__PWRAGENT_ENV_START__",
        "PATH=/Users/alice/.sdkman/candidates/sbt/current/bin:/opt/homebrew/bin:/usr/bin",
        "NVM_DIR=/Users/alice/.nvm",
        "IGNORED-NAME=value",
        "__PWRAGENT_ENV_END__",
      ].join("\n"),
    );

    const shellEnv = resolveInteractiveLoginShellEnv({
      env: {
        PATH: "/usr/bin",
        SHELL: "/bin/zsh",
      } as NodeJS.ProcessEnv,
      platform: "darwin",
      execFileSync,
      shellCandidates: ["/bin/zsh"],
    });

    expect(shellEnv?.PATH).toBe(
      "/Users/alice/.sdkman/candidates/sbt/current/bin:/opt/homebrew/bin:/usr/bin",
    );
    expect(shellEnv?.NVM_DIR).toBe("/Users/alice/.nvm");
    expect(shellEnv?.["IGNORED-NAME"]).toBeUndefined();
    expect(execFileSync).toHaveBeenCalledWith(
      "/bin/zsh",
      [
        "-ilc",
        "command printf '__PWRAGENT_ENV_START__\\n'; command env; command printf '__PWRAGENT_ENV_END__\\n'",
      ],
      expect.objectContaining({
        env: {
          PATH: "/usr/bin",
          SHELL: "/bin/zsh",
        },
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  });

  it("tries the next shell candidate when the first one cannot report PATH", () => {
    const execFileSync = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("shell failed");
      })
      .mockImplementationOnce(
        () => "__PWRAGENT_ENV_START__\nPATH=/bin\n__PWRAGENT_ENV_END__\n",
      );

    expect(
      resolveInteractiveLoginShellEnv({
        env: {} as NodeJS.ProcessEnv,
        platform: "darwin",
        execFileSync,
        shellCandidates: ["/missing/zsh", "/bin/bash"],
      })?.PATH,
    ).toBe("/bin");
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });

  it("does not try to hydrate PATH on Windows", () => {
    const execFileSync = vi.fn();

    expect(
      resolveInteractiveLoginShellEnv({
        env: {} as NodeJS.ProcessEnv,
        platform: "win32",
        execFileSync,
      }),
    ).toBeUndefined();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("returns a copied env with the login shell env without mutating the input", () => {
    const env = {
      PATH: "/usr/bin:/bin",
      SHELL: "/bin/zsh",
    } as NodeJS.ProcessEnv;

    const mergedEnv = mergeLoginShellEnvIntoEnv(env, {
      platform: "darwin",
      resolveShellEnv: () => ({
        NVM_DIR: "/Users/alice/.nvm",
        PATH: "/Users/alice/.sdkman/candidates/sbt/current/bin:/usr/bin",
      }),
    });

    expect(mergedEnv).not.toBe(env);
    expect(mergedEnv.PATH).toBe(
      "/Users/alice/.sdkman/candidates/sbt/current/bin:/usr/bin",
    );
    expect(mergedEnv.NVM_DIR).toBe("/Users/alice/.nvm");
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.NVM_DIR).toBeUndefined();
  });
});
