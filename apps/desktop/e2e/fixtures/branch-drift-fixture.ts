import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect } from "@playwright/test";
import Database from "better-sqlite3";
import { seedProfileOverlayState } from "./overlay-state-seeding";

export async function createBranchDriftFixture(options: {
  expectedBranch?: string;
} = {}): Promise<{
  cleanup: () => Promise<void>;
  env: Record<string, string>;
  fixturePath: string;
  homeDir: string;
}> {
  const expectedBranch = options.expectedBranch ?? "codex/expected-branch";
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-branch-drift-"));
  const repoDir = path.join(rootDir, "FixtureRepo");
  await mkdir(repoDir, { recursive: true });

  execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["checkout", "-B", "codex/expected-branch"], {
    cwd: repoDir,
    stdio: "ignore",
  });
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
      "Seed expected branch",
    ],
    { cwd: repoDir, stdio: "ignore" },
  );
  execFileSync("git", ["checkout", "-B", "codex/current-branch"], {
    cwd: repoDir,
    stdio: "ignore",
  });

  await seedProfileOverlayState(rootDir, {
    launchpadDefaults: {
      backend: "codex",
      executionMode: "default",
      workMode: "local",
    },
    threads: [
      {
        backend: "codex",
        threadId: "thread-branch-drift",
        executionMode: "default",
        observedGitBranch: expectedBranch,
        extraLinkedDirectories: [
          {
            id: "pwragent-handoff:codex:thread-branch-drift",
            kind: "worktree",
            label: "FixtureRepo",
            path: repoDir,
            worktreePath: repoDir,
          },
        ],
      },
    ],
  });

  const fixturePath = path.join(rootDir, "thread-branch-drift.fixture.json");
  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        metadata: {
          backend: "codex",
          scenario: "thread-branch-drift",
          threadId: "thread-branch-drift",
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
              methods: ["thread/list", "thread/read", "turn/start"],
            },
          },
          {
            id: "thread-list-1",
            kind: "response",
            method: "thread/list",
            result: [
              {
                id: "thread-branch-drift",
                title: "Branch drift replay",
                titleSource: "explicit",
                summary: "A thread whose checkout changed branch.",
                source: "codex",
                executionMode: "default",
                gitBranch: expectedBranch,
                linkedDirectories: [],
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
                  text: "The branch drift replay is loaded.",
                },
              ],
              messages: [
                {
                  id: "message-1",
                  role: "assistant",
                  text: "The branch drift replay is loaded.",
                },
              ],
              lastAssistantMessage: "The branch drift replay is loaded.",
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
  );

  return {
    cleanup: async () => {
      await rm(rootDir, { force: true, recursive: true });
    },
    // The whole scenario rides on the app booting into the profile seeded
    // above, so the launch environment belongs to the fixture that wrote it
    // rather than to each spec that uses it.
    env: { HOME: rootDir },
    fixturePath,
    homeDir: rootDir,
  };
}

export function readThreadPayload(homeDir: string): Record<string, unknown> {
  const dbPath = path.join(
    homeDir,
    ".pwragent",
    "profiles",
    "default",
    "state",
    "state.db",
  );
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare("SELECT payload FROM threads WHERE thread_id = ?")
      .get("codex:thread-branch-drift") as { payload: string } | undefined;
    expect(row).toBeDefined();
    return JSON.parse(row!.payload) as Record<string, unknown>;
  } finally {
    db.close();
  }
}
