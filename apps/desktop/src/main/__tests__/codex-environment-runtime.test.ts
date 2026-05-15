import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyLocalCodexEnvironmentSelection,
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
          'if [ "$1" != "-ilc" ]; then exit 64; fi',
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
    const outputPath = path.join(root, "setup.txt");

    try {
      await writeFile(
        shellPath,
        [
          "#!/bin/sh",
          'if [ "$1" != "-ilc" ]; then exit 64; fi',
          "nvm() {",
          `  printf 'nvm:%s\\n' "$*" >> ${JSON.stringify(outputPath)}`,
          "}",
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
          'if [ "$1" != "-ilc" ]; then exit 64; fi',
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
});

async function expectEventually<T>(
  read: () => Promise<T>,
  timeoutMs = 2_000,
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
