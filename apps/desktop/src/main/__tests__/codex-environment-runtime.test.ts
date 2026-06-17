import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyLocalCodexEnvironmentSelection,
  buildExitErrorSuffix,
  CODEX_ENVIRONMENT_SETUP_TIMEOUT_MS_ENV,
  startLocalCodexEnvironmentAction,
  stopCodexEnvironmentDetachedCommand,
} from "../app-server/codex-environment-runtime";
import { resolveWindowsBashShell } from "../windows-shell";

const mainLogEntries = vi.hoisted(
  (): Array<{
    level: "error" | "info" | "warn";
    message: string;
    payload?: Record<string, unknown>;
    scope: string;
  }> => [],
);

vi.mock("../log", () => ({
  getMainLogger: vi.fn((scope: string) => ({
    error: (message: string, payload?: Record<string, unknown>) => {
      mainLogEntries.push({ level: "error", message, payload, scope });
    },
    info: (message: string, payload?: Record<string, unknown>) => {
      mainLogEntries.push({ level: "info", message, payload, scope });
    },
    warn: (message: string, payload?: Record<string, unknown>) => {
      mainLogEntries.push({ level: "warn", message, payload, scope });
    },
  })),
}));

const isWindows = process.platform === "win32";

/**
 * Several tests provide a hand-rolled POSIX `#!/bin/sh` script as the hydrated
 * SHELL to exercise shell selection. Windows can't spawn a `.sh` shebang
 * script directly (it raises `spawn EFTYPE`), and `/bin/sh` doesn't exist, so
 * on Windows we substitute the same Git-for-Windows bash the product resolves
 * via `windowsBashCandidates()`. The setup/action scripts only use POSIX
 * features (`printf`, redirections, `set -e`, `&&`, `sleep`) that Git bash
 * supports, so the assertions still hold. On POSIX this returns the original
 * shell unchanged, keeping macOS/Linux behavior identical.
 */
function spawnableShell(posixShell: string): string {
  return isWindows ? resolveWindowsBashShell() : posixShell;
}

describe("codex environment runtime", () => {
  afterEach(() => {
    mainLogEntries.length = 0;
  });

  it("rejects detached actions with a clear missing-cwd error before spawn", async () => {
    await expect(
      startLocalCodexEnvironmentAction({
        actionId: "start-dev",
        runId: "test-run-1",
        runtime: {
          environmentId: "env",
          environmentName: "Env",
          executionTarget: "local",
          cwd: "/definitely/not/a/pwragent/worktree",
          actions: [
            {
              id: "start-dev",
              name: "Start dev",
              command: "pnpm dev",
            },
          ],
        },
      }),
    ).rejects.toThrow(
      "Codex environment working directory does not exist: /definitely/not/a/pwragent/worktree",
    );
  });

  it("runs detached actions with the provided hydrated environment", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-env-runtime-"));
    const outputPath = path.join(root, "env.txt");

    try {
      const result = await startLocalCodexEnvironmentAction({
        actionId: "start-dev",
        runId: "test-run-2",
        env: {
          ...process.env,
          PWRAGENT_TEST_HYDRATED_ENV: "hydrated",
        },
        runtime: {
          environmentId: "env",
          environmentName: "Env",
          executionTarget: "local",
          cwd: root,
          actions: [
            {
              id: "start-dev",
              name: "Start dev",
              command: `printf "$PWRAGENT_TEST_HYDRATED_ENV" > ${JSON.stringify(outputPath)}`,
            },
          ],
        },
      });
      expect(result.actionRuns).toEqual([
        expect.objectContaining({
          runId: "test-run-2",
          actionId: "start-dev",
          status: "started",
        }),
      ]);

      await expect(expectEventually(async () => await readFile(outputPath, "utf8"))).resolves.toBe(
        "hydrated",
      );
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 15_000);

  it("captures detached stdout and stderr in arrival order", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-env-output-order-"));
    try {
      const detachedExit = new Promise<{ output: string }>((resolve, reject) => {
        void startLocalCodexEnvironmentAction({
          actionId: "start-dev",
          runId: "test-run-output-order",
          env: {
            ...process.env,
            SHELL: "/bin/sh",
          },
          onDetachedExit: resolve,
          runtime: {
            environmentId: "env",
            environmentName: "Env",
            executionTarget: "local",
            cwd: root,
            actions: [
              {
                id: "start-dev",
                name: "Start dev",
                command: [
                  "printf 'stdout first\\n'",
                  "sleep 0.05",
                  "printf 'stderr second\\n' >&2",
                  "sleep 0.05",
                  "printf 'stdout third\\n'",
                  "sleep 0.05",
                  "printf 'stderr fourth\\n' >&2",
                ].join("\n"),
              },
            ],
          },
        }).catch(reject);
      });

      await expect(detachedExit).resolves.toMatchObject({
        output: [
          "stdout first",
          "stderr second",
          "stdout third",
          "stderr fourth",
        ].join("\n"),
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 15_000);

  it("stops a detached action process tree by run id", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-env-stop-"));
    const runId = "test-run-stop";
    try {
      const detachedExit = new Promise<{ exitSignal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          void startLocalCodexEnvironmentAction({
            actionId: "start-dev",
            runId,
            env: {
              ...process.env,
              SHELL: spawnableShell("/bin/sh"),
            },
            onDetachedExit: resolve,
            runtime: {
              environmentId: "env",
              environmentName: "Env",
              executionTarget: "local",
              cwd: root,
              actions: [
                {
                  id: "start-dev",
                  name: "Start dev",
                  command: "while true; do sleep 1; done",
                },
              ],
            },
          }).catch(reject);
        },
      );

      await expectEventually(async () => {
        const result = stopCodexEnvironmentDetachedCommand(runId, "stop");
        if (!result.found) {
          throw new Error("Detached process is not registered yet");
        }
        return result;
      });

      await expect(detachedExit).resolves.toMatchObject({
        exitSignal: expect.any(String),
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 15_000);

  it("strips parent Electron runtime variables from detached actions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-env-electron-"));
    const shellPath = path.join(root, "test-shell.sh");
    const outputPath = path.join(root, "env.txt");

    try {
      await writeFile(
        shellPath,
        [
          "#!/bin/sh",
          'if [ "$1" != "-lc" ]; then exit 64; fi',
          'exec /bin/sh -c "$2"',
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(shellPath, 0o755);

      const result = await startLocalCodexEnvironmentAction({
        actionId: "start-dev",
        runId: "test-run-3",
        env: {
          ...process.env,
          ELECTRON_RENDERER_URL: "http://127.0.0.1:5173",
          ELECTRON_RUN_AS_NODE: "1",
          PWRAGENT_TEST_HYDRATED_ENV: "hydrated",
          // On Windows the `.sh` passthrough script isn't directly spawnable;
          // use Git bash. Electron-var stripping is shell-independent.
          SHELL: spawnableShell(shellPath),
          VITE_DEV_SERVER_URL: "http://127.0.0.1:5174",
        },
        runtime: {
          environmentId: "env",
          environmentName: "Env",
          executionTarget: "local",
          cwd: root,
          actions: [
            {
              id: "start-dev",
              name: "Start dev",
              command: [
                `printf 'renderer=%s\\n' "\${ELECTRON_RENDERER_URL-unset}" > ${JSON.stringify(outputPath)}`,
                `printf 'run_as_node=%s\\n' "\${ELECTRON_RUN_AS_NODE-unset}" >> ${JSON.stringify(outputPath)}`,
                `printf 'vite=%s\\n' "\${VITE_DEV_SERVER_URL-unset}" >> ${JSON.stringify(outputPath)}`,
                `printf 'hydrated=%s\\n' "$PWRAGENT_TEST_HYDRATED_ENV" >> ${JSON.stringify(outputPath)}`,
              ].join("\n"),
            },
          ],
        },
      });
      expect(result.actionRuns).toEqual([
        expect.objectContaining({ runId: "test-run-3", status: "started" }),
      ]);

      const expectedOutput = [
        "renderer=unset",
        "run_as_node=unset",
        "vite=unset",
        "hydrated=hydrated",
        "",
      ].join("\n");
      await expect(
        expectEventually(async () => {
          const output = await readFile(outputPath, "utf8");
          if (output !== expectedOutput) {
            throw new Error(`Output is not complete yet: ${JSON.stringify(output)}`);
          }
          return output;
        }),
      ).resolves.toBe(expectedOutput);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("falls back when the hydrated shell path is stale", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-env-shell-fallback-"));
    const outputPath = path.join(root, "env.txt");

    try {
      const result = await startLocalCodexEnvironmentAction({
        actionId: "start-dev",
        runId: "test-run-shell-fallback",
        env: {
          ...process.env,
          SHELL: path.join(root, "missing-shell"),
        },
        runtime: {
          environmentId: "env",
          environmentName: "Env",
          executionTarget: "local",
          cwd: root,
          actions: [
            {
              id: "start-dev",
              name: "Start dev",
              command: `printf fallback > ${JSON.stringify(outputPath)}`,
            },
          ],
        },
      });

      expect(result.actionRuns).toEqual([
        expect.objectContaining({
          runId: "test-run-shell-fallback",
          actionId: "start-dev",
          status: "started",
        }),
      ]);
      await expect(
        expectEventually(async () => await readFile(outputPath, "utf8")),
      ).resolves.toBe("fallback");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("falls back when the stale hydrated shell is a Windows absolute path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-env-win-shell-fallback-"));
    const outputPath = path.join(root, "env.txt");

    try {
      const result = await startLocalCodexEnvironmentAction({
        actionId: "start-dev",
        runId: "test-run-win-shell-fallback",
        env: {
          ...process.env,
          SHELL: "C:\\Users\\operator\\missing-shell.exe",
        },
        runtime: {
          environmentId: "env",
          environmentName: "Env",
          executionTarget: "local",
          cwd: root,
          actions: [
            {
              id: "start-dev",
              name: "Start dev",
              command: `printf fallback > ${JSON.stringify(outputPath)}`,
            },
          ],
        },
      });

      expect(result.actionRuns).toEqual([
        expect.objectContaining({
          runId: "test-run-win-shell-fallback",
          actionId: "start-dev",
          status: "started",
        }),
      ]);
      await expect(
        expectEventually(async () => await readFile(outputPath, "utf8")),
      ).resolves.toBe("fallback");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("chooses the command shell from the provided hydrated environment", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-env-shell-"));
    const shellPath = path.join(root, "test-shell.sh");
    const markerPath = path.join(root, "shell-used.txt");
    const outputPath = path.join(root, "setup.txt");

    try {
      await writeFile(
        shellPath,
        [
          "#!/bin/sh",
          'if [ "$1" != "-lc" ]; then exit 64; fi',
          `printf shell-used > ${JSON.stringify(markerPath)}`,
          'exec /bin/sh -c "$2"',
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(shellPath, 0o755);

      await expect(
        applyLocalCodexEnvironmentSelection({
          cwd: root,
          env: {
            ...process.env,
            // On Windows provide a real, spawnable Git bash as the hydrated
            // SHELL. The custom `.sh` marker script can't be spawned directly
            // there, so we assert the provided shell ran by its setup output
            // (below) instead of the marker file.
            SHELL: spawnableShell(shellPath),
          },
          selection: {
            environment: {
              id: "env",
              name: "Env",
              sourcePath: path.join(root, "environment.toml"),
              setupScript: `printf setup > ${JSON.stringify(outputPath)}`,
              actions: [],
            },
            executionTarget: "local",
            setupEnabled: true,
          },
        }),
      ).resolves.toMatchObject({
        setupStatus: "completed",
      });

      if (!isWindows) {
        // The custom `.sh` shell writes this marker to prove it was the shell
        // that ran. On Windows we run real Git bash instead (the custom script
        // isn't spawnable), so the marker isn't produced — the setup-output
        // assertion below still proves the provided shell executed the script.
        await expect(readFile(markerPath, "utf8")).resolves.toBe("shell-used");
      }
      await expect(readFile(outputPath, "utf8")).resolves.toBe("setup");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("runs setup commands in an interactive login shell so startup-defined functions are available", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-env-nvm-"));
    const shellPath = path.join(root, "test-shell.sh");
    const nvmDir = path.join(root, "nvm");
    const outputPath = path.join(root, "setup.txt");

    try {
      await mkdir(nvmDir, { recursive: true });
      await writeFile(
        path.join(nvmDir, "nvm.sh"),
        [
          "nvm() {",
          `  printf 'nvm:%s\\n' "$*" >> ${JSON.stringify(outputPath)}`,
          "}",
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        shellPath,
        [
          "#!/bin/sh",
          'if [ "$1" != "-lc" ]; then exit 64; fi',
          'eval "$2"',
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(shellPath, 0o755);

      await expect(
        applyLocalCodexEnvironmentSelection({
          cwd: root,
          env: {
            ...process.env,
            NVM_DIR: nvmDir,
            // On Windows the custom `eval "$2"` shell isn't spawnable; Git bash
            // runs the same wrapped command (which sources nvm.sh and defines
            // the nvm function) via `-lc`, so the assertion still holds.
            SHELL: spawnableShell(shellPath),
          },
          selection: {
            environment: {
              id: "env",
              name: "Env",
              sourcePath: path.join(root, "environment.toml"),
              setupScript: [
                "nvm use --silent",
                `printf done >> ${JSON.stringify(outputPath)}`,
              ].join("\n"),
              actions: [],
            },
            executionTarget: "local",
            setupEnabled: true,
          },
        }),
      ).resolves.toMatchObject({
        setupStatus: "completed",
      });

      await expect(readFile(outputPath, "utf8")).resolves.toBe(
        "nvm:use --silent\ndone",
      );
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("captures the successful setup shell environment without leaking it into setup output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-env-capture-"));
    const toolPath = path.join(root, "node-bin");

    try {
      await mkdir(toolPath, { recursive: true });
      const runtime = await applyLocalCodexEnvironmentSelection({
        cwd: root,
        env: {
          ...process.env,
          SHELL: "/bin/sh",
        },
        selection: {
          environment: {
            id: "env",
            name: "Env",
            sourcePath: path.join(root, "environment.toml"),
            setupScript: [
              `export PATH=${JSON.stringify(toolPath)}:$PATH`,
              `export NVM_DIR=${JSON.stringify(path.join(root, ".nvm"))}`,
              "export PWRAGENT_SHOULD_NOT_PERSIST=1",
              "export GITHUB_TOKEN=secret",
              "printf setup-output",
            ].join("\n"),
            actions: [],
          },
          executionTarget: "local",
          setupEnabled: true,
        },
      });

      expect(runtime?.setupOutput).toBe("setup-output");
      expect(runtime?.shellEnvironment).toMatchObject({
        NVM_DIR: path.join(root, ".nvm"),
      });
      expect(runtime?.shellEnvironment?.PATH).toContain(toolPath);
      expect(runtime?.shellEnvironment).not.toHaveProperty("GITHUB_TOKEN");
      expect(runtime?.shellEnvironment).not.toHaveProperty(
        "PWRAGENT_SHOULD_NOT_PERSIST",
      );
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("omits command, PATH preview, and captured key names from successful setup logs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-env-log-redact-"));
    const toolPath = path.join(root, "node-bin");

    try {
      await mkdir(toolPath, { recursive: true });
      const runtime = await applyLocalCodexEnvironmentSelection({
        cwd: root,
        env: {
          ...process.env,
          PATH: `/private/toolchain/bin${path.delimiter}${process.env.PATH ?? ""}`,
          SHELL: "/bin/sh",
        },
        selection: {
          environment: {
            id: "env",
            name: "Env",
            sourcePath: path.join(root, "environment.toml"),
            setupScript: [
              `export PATH=${JSON.stringify(toolPath)}:$PATH`,
              "export NVM_DIR=/private/nvm",
              "export GITHUB_TOKEN=secret",
              "printf setup-output",
            ].join("\n"),
            actions: [],
          },
          executionTarget: "local",
          setupEnabled: true,
        },
      });

      const startLog = mainLogEntries.find(
        (entry) => entry.message === "codex-environment-command-start",
      );
      expect(startLog?.payload).toMatchObject({
        captureShellEnvironment: true,
        mode: "wait",
      });
      expect(startLog?.payload).not.toHaveProperty("command");
      expect(startLog?.payload).not.toHaveProperty("pathPreview");

      const exitLog = mainLogEntries.find(
        (entry) => entry.message === "codex-environment-command-exit",
      );
      expect(exitLog?.payload).toMatchObject({
        capturedEnvKeyCount: Object.keys(runtime?.shellEnvironment ?? {}).length,
        code: 0,
      });
      expect(exitLog?.payload).not.toHaveProperty("capturedEnvKeys");

      const serializedLogs = JSON.stringify(mainLogEntries);
      expect(serializedLogs).not.toContain("GITHUB_TOKEN");
      expect(serializedLogs).not.toContain("secret");
      expect(serializedLogs).not.toContain("/private/toolchain/bin");
      expect(serializedLogs).not.toContain("/private/nvm");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("does not persist allow-listed env values that contain URL credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-env-capture-secret-"));
    const pnpmHome = path.join(root, "pnpm-home");

    try {
      await mkdir(pnpmHome, { recursive: true });
      const runtime = await applyLocalCodexEnvironmentSelection({
        cwd: root,
        env: {
          ...process.env,
          SHELL: "/bin/sh",
        },
        selection: {
          environment: {
            id: "env",
            name: "Env",
            sourcePath: path.join(root, "environment.toml"),
            setupScript: [
              `export PNPM_HOME=${JSON.stringify(pnpmHome)}`,
              "export NPM_CONFIG_PROXY=http://user:pass@proxy.example.test",
              "export npm_config_registry=https://token@registry.example.test/npm/",
              "printf setup-output",
            ].join("\n"),
            actions: [],
          },
          executionTarget: "local",
          setupEnabled: true,
        },
      });

      expect(runtime?.shellEnvironment).toMatchObject({
        PNPM_HOME: pnpmHome,
      });
      expect(runtime?.shellEnvironment).not.toHaveProperty("NPM_CONFIG_PROXY");
      expect(runtime?.shellEnvironment).not.toHaveProperty("npm_config_registry");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("does not fail setup when PATH no longer contains env", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-env-capture-path-"));
    const toolPath = path.join(root, "toolchain-bin");

    try {
      await mkdir(toolPath, { recursive: true });
      const runtime = await applyLocalCodexEnvironmentSelection({
        cwd: root,
        env: {
          ...process.env,
          SHELL: "/bin/sh",
        },
        selection: {
          environment: {
            id: "env",
            name: "Env",
            sourcePath: path.join(root, "environment.toml"),
            setupScript: [
              `export PATH=${JSON.stringify(toolPath)}`,
              "printf setup-output",
            ].join("\n"),
            actions: [],
          },
          executionTarget: "local",
          setupEnabled: true,
        },
      });

      expect(runtime).toMatchObject({
        setupStatus: "completed",
        setupOutput: "setup-output",
      });
      expect(runtime?.shellEnvironment?.PATH).toBe(toolPath);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("omits successful detached action commands from info logs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-env-detached-log-"));

    try {
      const detachedExit = new Promise<{ output: string }>((resolve, reject) => {
        void startLocalCodexEnvironmentAction({
          actionId: "start-dev",
          runId: "test-run-detached-log",
          env: {
            ...process.env,
            SHELL: "/bin/sh",
          },
          onDetachedExit: resolve,
          runtime: {
            environmentId: "env",
            environmentName: "Env",
            executionTarget: "local",
            cwd: root,
            actions: [
              {
                id: "start-dev",
                name: "Start dev",
                command: "printf 'sensitive detached command output'",
              },
            ],
          },
        }).catch(reject);
      });

      await expect(detachedExit).resolves.toMatchObject({
        output: "sensitive detached command output",
      });

      const startLog = mainLogEntries.find(
        (entry) => entry.message === "codex-environment-command-start",
      );
      expect(startLog?.payload).toMatchObject({
        captureShellEnvironment: false,
        mode: "detach",
      });
      expect(startLog?.payload).not.toHaveProperty("command");
      expect(startLog?.payload).not.toHaveProperty("pathPreview");

      const detachedExitLog = mainLogEntries.find(
        (entry) => entry.message === "codex-environment-detached-exit",
      );
      expect(detachedExitLog?.payload).toMatchObject({ code: 0 });
      expect(detachedExitLog?.payload).not.toHaveProperty("command");
      expect(JSON.stringify(mainLogEntries)).not.toContain(
        "sensitive detached command output",
      );
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 15_000);

  it("reuses cached shell hydration when setup is disabled", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-env-cache-"));
    try {
      const cachedEnvironment = {
        PATH: "/cached/node/bin:/usr/bin",
        NVM_DIR: path.join(root, ".nvm"),
      };
      const runtime = await applyLocalCodexEnvironmentSelection({
        cwd: root,
        hydrationStore: {
          get: () => ({
            key: "cache-key",
            environmentId: "env",
            setupScriptHash: "hash",
            shellEnvironment: cachedEnvironment,
            updatedAt: Date.now(),
          }),
          set: () => {
            throw new Error("setup-disabled environment should not update cache");
          },
        },
        selection: {
          environment: {
            id: "env",
            name: "Env",
            sourcePath: path.join(root, "environment.toml"),
            setupScript: "printf setup",
            actions: [],
          },
          executionTarget: "local",
          setupEnabled: false,
        },
      });

      expect(runtime?.shellEnvironment).toEqual(cachedEnvironment);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("fails setup immediately when an earlier script command exits non-zero", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-env-strict-"));
    const shellPath = path.join(root, "test-shell.sh");
    const outputPath = path.join(root, "setup.txt");

    try {
      await writeFile(
        shellPath,
        [
          "#!/bin/sh",
          'if [ "$1" != "-lc" ]; then exit 64; fi',
          'exec /bin/sh -c "$2"',
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(shellPath, 0o755);

      await expect(
        applyLocalCodexEnvironmentSelection({
          cwd: root,
          env: {
            ...process.env,
            // On Windows the custom `.sh` passthrough isn't spawnable; Git bash
            // honors `set -e` identically so the early-exit assertion holds.
            SHELL: spawnableShell(shellPath),
          },
          selection: {
            environment: {
              id: "env",
              name: "Env",
              sourcePath: path.join(root, "environment.toml"),
              setupScript: [
                `printf before > ${JSON.stringify(outputPath)}`,
                "false",
                `printf after >> ${JSON.stringify(outputPath)}`,
              ].join("\n"),
              actions: [],
            },
            executionTarget: "local",
            setupEnabled: true,
          },
        }),
      ).rejects.toMatchObject({
        runtime: {
          setupStatus: "failed",
          setupExitCode: 1,
          setupOutput: "",
        },
      });

      await expect(readFile(outputPath, "utf8")).resolves.toBe("before");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("includes the tail of stdout in the exit error when the failing command writes its diagnostic to stdout", async () => {
    // Reproduces the pnpm/vite/npm pattern: an earlier command in the
    // script left a benign message on stderr (here mimicked with `echo
    // ... >&2`), then the final command writes its actual error to stdout
    // and exits non-zero. The exit error suffix must surface the stdout
    // diagnostic, not the unrelated stderr chatter, so the failure dialog
    // and main.log line point at the real cause.
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-env-stdout-error-"));
    try {
      let error: unknown;
      try {
        await applyLocalCodexEnvironmentSelection({
          cwd: root,
          env: {
            ...process.env,
            SHELL: "/bin/sh",
          },
          selection: {
            environment: {
              id: "env",
              name: "Env",
              sourcePath: path.join(root, "environment.toml"),
              setupScript: [
                "echo 'unrelated benign chatter' 1>&2",
                "echo 'ERR_PNPM_IGNORED_BUILDS the actual reason for exit 1'",
                "exit 1",
              ].join("\n"),
              actions: [],
            },
            executionTarget: "local",
            setupEnabled: true,
          },
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeDefined();
      expect((error as { message?: string }).message).toContain(
        "ERR_PNPM_IGNORED_BUILDS the actual reason for exit 1",
      );
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("times out setup commands that do not finish", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-env-timeout-"));

    try {
      let error: unknown;
      try {
        await applyLocalCodexEnvironmentSelection({
          cwd: root,
          // POSIX keeps the minimal env (the shell's compiled-in default PATH
          // resolves `sleep`). On Windows, `sleep` is an external Git-bash
          // binary that needs PATH, and the hydrated shell must be a real
          // spawnable bash — so spread process.env (for PATH) and pin Git bash.
          env: isWindows
            ? {
                ...process.env,
                [CODEX_ENVIRONMENT_SETUP_TIMEOUT_MS_ENV]: "50",
                SHELL: resolveWindowsBashShell(),
              }
            : {
                [CODEX_ENVIRONMENT_SETUP_TIMEOUT_MS_ENV]: "50",
              },
          selection: {
            environment: {
              id: "env",
              name: "Env",
              sourcePath: path.join(root, "environment.toml"),
              setupScript: "printf before && sleep 10 && printf after",
              actions: [],
            },
            executionTarget: "local",
            setupEnabled: true,
          },
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toMatchObject({
        message: expect.stringContaining("timed out after 50ms"),
        phase: "setup",
        runtime: {
          setupStatus: "failed",
        },
      });
      expect(
        ((error as { runtime?: { setupOutput?: string } }).runtime?.setupOutput ?? ""),
      ).not.toContain("after");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("waits for timed-out setup commands to exit before reporting failure", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-env-timeout-exit-"));
    const markerPath = path.join(root, "marker.txt");
    const markerShellPath = `'${markerPath.replace(/'/g, "'\\''")}'`;

    try {
      let error: unknown;
      try {
        await applyLocalCodexEnvironmentSelection({
          cwd: root,
          env: {
            ...process.env,
            [CODEX_ENVIRONMENT_SETUP_TIMEOUT_MS_ENV]: "5000",
            SHELL: "/bin/sh",
          },
          selection: {
            environment: {
              id: "env",
              name: "Env",
              sourcePath: path.join(root, "environment.toml"),
              setupScript: [
                `printf 'before\\n' > ${markerShellPath}`,
                [
                  "trap",
                  `"printf 'term\\\\n' >> ${markerShellPath}; sleep 0.2; printf 'after-term\\\\n' >> ${markerShellPath}; exit 0"`,
                  "TERM",
                ].join(" "),
                "while true; do sleep 1; done",
              ].join("\n"),
              actions: [],
            },
            executionTarget: "local",
            setupEnabled: true,
          },
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toMatchObject({
        message: expect.stringContaining("timed out after 5000ms"),
        phase: "setup",
      });
      await expect(readFile(markerPath, "utf8")).resolves.toBe(
        "before\nterm\nafter-term\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 10_000);
});

describe("buildExitErrorSuffix", () => {
  it("returns an empty suffix when both streams are blank", () => {
    expect(buildExitErrorSuffix("")).toBe("");
    expect(buildExitErrorSuffix("   \n  ")).toBe("");
  });

  it("returns the output line when only one stream has content", () => {
    expect(buildExitErrorSuffix("v24.14.1 is already installed.")).toBe(
      ": v24.14.1 is already installed.",
    );
  });

  it("returns the stdout-style content for modern CLI failures", () => {
    expect(buildExitErrorSuffix("ERR_PNPM_IGNORED_BUILDS the actual reason for exit 1")).toBe(
      ": ERR_PNPM_IGNORED_BUILDS the actual reason for exit 1",
    );
  });

  it("preserves already-interleaved stdout and stderr order", () => {
    expect(
      buildExitErrorSuffix("first stdout line\nfirst stderr line\nsecond stdout line"),
    ).toBe(
      ": first stdout line\nfirst stderr line\nsecond stdout line",
    );
  });

  it("trims to the last 8 lines of combined output", () => {
    const stdout = [
      "line 1",
      "line 2",
      "line 3",
      "line 4",
      "line 5",
      "line 6",
      "line 7",
      "line 8",
      "line 9",
      "line 10",
    ].join("\n");
    const suffix = buildExitErrorSuffix(stdout);
    // Last 8 of 10 lines, joined with newlines and prefixed by ": "
    expect(suffix).toBe(
      ": line 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10",
    );
  });

  it("preserves nvm-on-stderr alongside pnpm-on-stdout (motivating regression)", () => {
    // Reproduces the failure mode that motivated the helper: pnpm writes
    // its real exit-1 diagnostic to stdout, while stderr only contains
    // unrelated benign chatter from an earlier `nvm install`. Both must
    // survive into the suffix so the dialog headline isn't misled.
    const output = [
      "Scope: all 5 workspace projects",
      "v24.14.1 is already installed.",
      "Progress: resolved 463, reused 463, downloaded 0, added 463, done",
      "ERR_PNPM_IGNORED_BUILDS Ignored build scripts: @ffmpeg-installer/darwin-arm64",
    ].join("\n");
    const suffix = buildExitErrorSuffix(output);
    expect(suffix).toContain("ERR_PNPM_IGNORED_BUILDS");
    expect(suffix).toContain("v24.14.1 is already installed.");
  });
});

async function expectEventually<T>(
  read: () => Promise<T>,
  timeoutMs = 10_000,
): Promise<T> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await read();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}
