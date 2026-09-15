import {
  AGENT_PERSONA_INSTRUCTIONS_LINE_GUIDANCE,
  type ThreadHandoffOrigin,
} from "@pwragent/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import {
  createTempStateDb,
  openInMemoryStateDb,
  removeTempStateDbDir,
} from "./sqlite-test-utils";

let stateDb: StateDb;
let store: SqliteOverlayStore;
let tempDir: string | undefined;

/**
 * Move this test onto a real database file and return its path. Only the
 * tests that close the database and reopen the same path need one: a second
 * `:memory:` open is a second empty database, so those assertions would hold
 * while testing nothing.
 */
function useFileStateDb(): string {
  stateDb.close();
  const temp = createTempStateDb("pwragent-agent-test-");
  tempDir = temp.tempDir;
  stateDb = StateDb.open(temp.dbPath);
  store = new SqliteOverlayStore(stateDb);
  return temp.dbPath;
}

beforeEach(() => {
  tempDir = undefined;
  stateDb = openInMemoryStateDb();
  store = new SqliteOverlayStore(stateDb);
});

afterEach(() => {
  stateDb.close();
  if (tempDir !== undefined) {
    removeTempStateDbDir(tempDir);
  }
});

describe("SqliteOverlayStore - thread Agent metadata", () => {
  it("sets and clears Agent metadata for a thread", async () => {
    const marked = await store.setThreadAgent({
      backend: "codex",
      threadId: "thread-1",
      agent: {
        name: "Inbox Triage",
        instructions: "  Keep updates concise.  ",
      },
      now: 1_000,
    });

    expect(marked.agent).toEqual({
      name: "Inbox Triage",
      instructions: "Keep updates concise.",
      instructionLineCount: 1,
      instructionsTooLong: false,
      updatedAt: 1_000,
    });

    const cleared = await store.setThreadAgent({
      backend: "codex",
      threadId: "thread-1",
      agent: null,
    });
    expect(cleared.agent).toBeUndefined();
  });

  it("flags persona instructions longer than the compact guidance", async () => {
    const instructions = Array.from(
      { length: AGENT_PERSONA_INSTRUCTIONS_LINE_GUIDANCE + 1 },
      (_, index) => `Line ${index + 1}`,
    ).join("\n");

    const marked = await store.setThreadAgent({
      backend: "codex",
      threadId: "thread-1",
      agent: {
        name: "Verbose Agent",
        instructions,
      },
      now: 2_000,
    });

    expect(marked.agent?.instructionLineCount).toBe(
      AGENT_PERSONA_INSTRUCTIONS_LINE_GUIDANCE + 1,
    );
    expect(marked.agent?.instructionsTooLong).toBe(true);
  });

  it("preserves Agent metadata across sqlite handles", async () => {
    const dbPath = useFileStateDb();
    await store.setThreadAgent({
      backend: "codex",
      threadId: "thread-1",
      agent: {
        name: "Daily Planner",
      },
      now: 3_000,
    });
    stateDb.close();

    const reopenedDb = StateDb.open(dbPath);
    const reopenedStore = new SqliteOverlayStore(reopenedDb);
    await expect(
      reopenedStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toMatchObject({
      agent: {
        name: "Daily Planner",
        instructionLineCount: 0,
        instructionsTooLong: false,
        updatedAt: 3_000,
      },
    });
    reopenedDb.close();
  });

  it("reconciles a stale Agent name to the current thread title", async () => {
    await store.setThreadAgent({
      backend: "codex",
      threadId: "thread-1",
      agent: {
        name: "Old Agent name",
        instructions: "Keep the existing personality.",
      },
      now: 3_000,
    });

    const snapshot = await store.reconcileNavigationSnapshot({
      backend: "all",
      fetchedAt: 4_000,
      threads: [
        {
          id: "thread-1",
          title: "Jeeves Reborn",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
        },
      ],
    });

    expect(snapshot.threads[0]?.agent).toMatchObject({
      name: "Jeeves Reborn",
      instructions: "Keep the existing personality.",
    });
    await expect(
      store.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-1",
      }),
    ).resolves.toMatchObject({
      agent: {
        name: "Jeeves Reborn",
        instructions: "Keep the existing personality.",
      },
    });
  });

  it("drops legacy auto-created handoff Agent metadata on read", async () => {
    await store.setThreadAgent({
      backend: "codex",
      threadId: "child-thread",
      agent: {
        name: "Investigate issue XYZ",
        instructions:
          "Work only on the delegated task from the parent PwrAgent thread. Keep progress and results in this thread.",
      },
      now: 4_000,
    });
    await store.setThreadHandoffOrigin({
      backend: "codex",
      threadId: "child-thread",
      handoffOrigin: {
        sourceBackend: "codex",
        sourceThreadId: "parent-thread",
        taskTitle: "Investigate issue XYZ",
        seedMode: "clean",
        groupingMode: "none",
        createdAt: 4_000,
        workspace: {
          mode: "same",
          cwd: "/tmp/project",
          git: {
            kind: "git_local",
            worktreeCreationAvailable: true,
          },
        },
      },
    });

    const overlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "child-thread",
    });
    expect(overlay).toMatchObject({
      handoffOrigin: {
        taskTitle: "Investigate issue XYZ",
      },
    });
    expect(overlay).not.toHaveProperty("agent");
  });

  it("rejects blank Agent names", async () => {
    await expect(
      store.setThreadAgent({
        backend: "codex",
        threadId: "thread-1",
        agent: {
          name: "   ",
        },
      }),
    ).rejects.toThrow("Agent thread name is required.");
  });

  it("persists handoff origin metadata across sqlite handles", async () => {
    const dbPath = useFileStateDb();
    const handoffOrigin: ThreadHandoffOrigin = {
      sourceBackend: "codex",
      sourceThreadId: "parent-thread",
      sourceTurnId: "turn-1",
      seedMode: "clean",
      groupingMode: "none",
      createdAt: 1_773_000_000_000,
      workspace: {
        mode: "same",
        cwd: "/tmp/project",
        git: {
          kind: "git_local",
          worktreeCreationAvailable: true,
        },
      },
    };

    await store.setThreadHandoffOrigin({
      backend: "codex",
      threadId: "child-thread",
      handoffOrigin,
    });
    stateDb.close();

    const reopenedDb = StateDb.open(dbPath);
    const reopenedStore = new SqliteOverlayStore(reopenedDb);
    await expect(
      reopenedStore.getThreadOverlayState({
        backend: "codex",
        threadId: "child-thread",
      }),
    ).resolves.toMatchObject({ handoffOrigin });
    reopenedDb.close();
  });

  it("persists injected message origins by message across sqlite handles", async () => {
    const dbPath = useFileStateDb();
    await store.upsertThreadMessageOrigin({
      backend: "codex",
      threadId: "child-thread",
      messageId: "message-injected",
      origin: {
        kind: "agent",
        sourceThread: {
          backend: "codex",
          threadId: "parent-thread",
          title: "Branch picker error handling",
        },
      },
      createdAt: 1_773_000_000_000,
    });
    stateDb.close();

    const reopenedDb = StateDb.open(dbPath);
    const reopenedStore = new SqliteOverlayStore(reopenedDb);
    await expect(
      reopenedStore.readThreadMessageOrigins({
        backend: "codex",
        threadId: "child-thread",
        messageIds: ["message-injected", "message-other"],
      }),
    ).resolves.toEqual({
      "message-injected": {
        kind: "agent",
        sourceThread: {
          backend: "codex",
          threadId: "parent-thread",
          title: "Branch picker error handling",
        },
      },
    });
    reopenedDb.close();
  });
});
