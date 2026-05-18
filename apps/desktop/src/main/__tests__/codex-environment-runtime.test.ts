import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyLocalCodexEnvironmentSelection,
  CODEX_ENVIRONMENT_SETUP_TIMEOUT_MS_ENV,
  startLocalCodexEnvironmentAction,
} from "../app-server/codex-environment-runtime";

describe("codex environment runtime", () => {
  it("rejects detached actions that fail before spawn", async () => {
    await expect(
      startLocalCodexEnvironmentAction({
        actionId: "start-dev",
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
    ).rejects.toThrow();
  });

  it("runs detached actions with the provided hydrated environment", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-env-runtime-"));
    const outputPath = path.join(root, "env.txt");

    try {
      await expect(
        startLocalCodexEnvironmentAction({
          actionId: "start-dev",
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
        }),
      ).resolves.toMatchObject({
        actionStatus: "started",
      });

      await expect(expectEventually(async () => await readFile(outputPath, "utf8"))).resolves.toBe(
        "hydrated",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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

      await expect(
        startLocalCodexEnvironmentAction({
          actionId: "start-dev",
          env: {
            ...process.env,
            ELECTRON_RENDERER_URL: "http://127.0.0.1:5173",
            ELECTRON_RUN_AS_NODE: "1",
            PWRAGENT_TEST_HYDRATED_ENV: "hydrated",
            SHELL: shellPath,
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
        }),
      ).resolves.toMatchObject({
        actionStatus: "started",
      });

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
      await rm(root, { recursive: true, force: true });
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
            SHELL: shellPath,
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

      await expect(readFile(markerPath, "utf8")).resolves.toBe("shell-used");
      await expect(readFile(outputPath, "utf8")).resolves.toBe("setup");
    } finally {
      await rm(root, { recursive: true, force: true });
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
            SHELL: shellPath,
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
      await rm(root, { recursive: true, force: true });
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
            SHELL: shellPath,
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
      await rm(root, { recursive: true, force: true });
    }
  });

  it("times out setup commands that do not finish", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-env-timeout-"));

    try {
      let error: unknown;
      try {
        await applyLocalCodexEnvironmentSelection({
          cwd: root,
          env: {
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
      await rm(root, { recursive: true, force: true });
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
            [CODEX_ENVIRONMENT_SETUP_TIMEOUT_MS_ENV]: "1000",
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
        message: expect.stringContaining("timed out after 1000ms"),
        phase: "setup",
      });
      await expect(readFile(markerPath, "utf8")).resolves.toBe(
        "before\nterm\nafter-term\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
