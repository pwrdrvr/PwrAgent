import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function createReplayFixture(params: {
  fixturePath: string;
  gitBranch?: string;
  linkedDirectory: Record<string, unknown>;
  observedGitBranch?: string;
  scenario: string;
  summary: string;
  threadId: string;
  title: string;
}): Promise<void> {
  return writeFile(
    params.fixturePath,
    JSON.stringify(
      {
        metadata: {
          backend: "codex",
          scenario: params.scenario,
          threadId: params.threadId,
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
                id: params.threadId,
                title: params.title,
                titleSource: "explicit",
                summary: params.summary,
                source: "codex",
                executionMode: "default",
                gitBranch: params.gitBranch ?? "main",
                observedGitBranch: params.observedGitBranch ?? params.gitBranch ?? "main",
                linkedDirectories: [params.linkedDirectory],
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
                  text: "The workspace handoff replay is loaded.",
                },
              ],
              messages: [
                {
                  id: "message-1",
                  role: "assistant",
                  text: "The workspace handoff replay is loaded.",
                },
              ],
              lastAssistantMessage: "The workspace handoff replay is loaded.",
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
}

export async function createLocalHandoffFixture(): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
  repoDir: string;
  threadId: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-local-handoff-"));
  const repoDir = path.join(rootDir, "FixtureRepo");
  const threadId = "thread-local-handoff";
  await mkdir(repoDir, { recursive: true });

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
  execFileSync("git", ["branch", "release"], { cwd: repoDir, stdio: "ignore" });

  const fixturePath = path.join(rootDir, "local-handoff.fixture.json");
  await createReplayFixture({
    fixturePath,
    linkedDirectory: {
      id: "fixture-local",
      label: "FixtureRepo",
      path: repoDir,
      kind: "local",
    },
    scenario: "local-handoff-dialog",
    summary: "Move this local checkout into a worktree",
    threadId,
    title: "Local handoff thread",
  });

  return {
    cleanup: async () => {
      await rm(rootDir, { recursive: true, force: true });
    },
    fixturePath,
    repoDir,
    threadId,
  };
}

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
  await createReplayFixture({
    fixturePath,
    gitBranch: "feature/handoff",
    linkedDirectory: {
      id: "fixture-worktree",
      label: "FixtureRepo",
      path: repoDir,
      worktreePath,
      kind: "worktree",
    },
    observedGitBranch: "feature/handoff",
    scenario: "worktree-handoff-dialog",
    summary: "Move this worktree back to Local",
    threadId,
    title: "Worktree handoff thread",
  });

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
