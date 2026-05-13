import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { startLocalCodexEnvironmentAction } from "../app-server/codex-environment-runtime";

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
