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
});
