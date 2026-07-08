import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AGENT_PERSONA_INSTRUCTIONS_LINE_GUIDANCE,
  type ThreadHandoffOrigin,
} from "@pwragent/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";

let stateDb: StateDb;
let store: SqliteOverlayStore;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-agent-test-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  store = new SqliteOverlayStore(stateDb);
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
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
    await store.setThreadAgent({
      backend: "codex",
      threadId: "thread-1",
      agent: {
        name: "Daily Planner",
      },
      now: 3_000,
    });
    stateDb.close();

    const reopenedDb = StateDb.open(path.join(tempDir, "state.db"));
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

    const reopenedDb = StateDb.open(path.join(tempDir, "state.db"));
    const reopenedStore = new SqliteOverlayStore(reopenedDb);
    await expect(
      reopenedStore.getThreadOverlayState({
        backend: "codex",
        threadId: "child-thread",
      }),
    ).resolves.toMatchObject({ handoffOrigin });
    reopenedDb.close();
  });
});
