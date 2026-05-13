import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function createWorktreeHandoffFixture(): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
  repoDir: string;
  threadId: string;
  worktreePath: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-worktree-handoff-"));
  const repoDir = path.join(rootDir, "FixtureRepo");
  const worktreePath = path.join(rootDir, ".worktrees", "pwragent-feature-handoff");
  const threadId = "thread-worktree-handoff";
  await mkdir(repoDir, { recursive: true });
  await mkdir(path.dirname(worktreePath), { recursive: true });

  execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["checkout", "-B", "main"], { cwd: repoDir, stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=PwrAgent Tests",
      "-c",
      "user.email=pwragent-tests@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "Seed handoff fixture repo",
    ],
    { cwd: repoDir, stdio: "ignore" },
  );
  execFileSync("git", ["worktree", "add", "-b", "feature/handoff", worktreePath, "main"], {
    cwd: repoDir,
    stdio: "ignore",
  });

  const fixturePath = path.join(rootDir, "worktree-handoff.fixture.json");
  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        metadata: {
          backend: "codex",
          scenario: "worktree-handoff-dialog",
          threadId,
        },
        steps: [
          {
            id: "initialize-1",
            kind: "response",
            method: "initialize",
            result: {
              serverInfo: {
                name: "Replay Codex",
                version: "1.0.0",
              },
              methods: ["thread/list", "thread/read", "skills/list", "turn/start"],
            },
          },
          {
            id: "thread-list-1",
            kind: "response",
            method: "thread/list",
            result: [
              {
                id: threadId,
                title: "Worktree handoff thread",
                titleSource: "explicit",
                summary: "Move this worktree back to Local",
                source: "codex",
                executionMode: "default",
                gitBranch: "feature/handoff",
                observedGitBranch: "feature/handoff",
                linkedDirectories: [
                  {
                    id: "fixture-worktree",
                    label: "FixtureRepo",
                    path: repoDir,
                    worktreePath,
                    kind: "worktree",
                  },
                ],
                updatedAt: 1_760_000_000_000,
              },
            ],
          },
          {
            id: "thread-read-1",
            kind: "response",
            method: "thread/read",
            result: {
              entries: [
                {
                  type: "message",
                  id: "message-1",
                  role: "assistant",
                  text: "The worktree handoff replay is loaded.",
                },
              ],
              messages: [
                {
                  id: "message-1",
                  role: "assistant",
                  text: "The worktree handoff replay is loaded.",
                },
              ],
              lastAssistantMessage: "The worktree handoff replay is loaded.",
              pagination: {
                supportsPagination: false,
                hasPreviousPage: false,
              },
            },
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    cleanup: async () => {
      await rm(rootDir, { recursive: true, force: true });
    },
    fixturePath,
    repoDir,
    threadId,
    worktreePath,
  };
}
