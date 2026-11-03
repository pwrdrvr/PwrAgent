import { afterEach, describe, expect, it } from "vitest";
import type { AppServerBackendKind } from "@pwragent/shared";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

let stateDb: StateDb | undefined;
let tempDir: string | undefined;

afterEach(() => {
  stateDb?.close();
  if (tempDir) removeTempStateDbDir(tempDir);
});

describe("SqliteOverlayStore — rewind cleanup", () => {
  it.each<AppServerBackendKind>(["claude", "codex", "acp:grok"])(
    "drops %s transcript overlays durably and only for the rewound thread",
    async (backend) => {
      const fixture = createTempStateDb("pwragent-rewind-test-");
      tempDir = fixture.tempDir;
      stateDb = StateDb.open(fixture.dbPath);
      let store = new SqliteOverlayStore(stateDb);
      const target = { backend, threadId: "thread-1" };
      const otherThread = { backend, threadId: "thread-2" };
      const otherBackend = {
        backend: backend === "claude" ? "codex" as const : "claude" as const,
        threadId: target.threadId,
      };
      const failure = { id: "failure-1", turnId: "turn-1", error: "API error", occurredAt: 1000 };
      for (const identity of [target, otherThread, otherBackend]) {
        await store.appendTurnFailure({ ...identity, failure });
      }
      await store.setThreadExecutionMode({ ...target, executionMode: "auto", updatedAt: 1000 });
      await store.setThreadMcpConnectionIds({ ...target, connectionIds: ["fixture-mcp"] });
      await store.appendPermissionTransition({
        ...target,
        transition: {
          id: "permission-1", fromExecutionMode: "default", toExecutionMode: "auto",
          status: "applied", occurredAt: 1000,
        },
      });
      await store.appendMessagingBindingTransition({
        ...target,
        transition: { id: "binding-1", action: "bound", bindingId: "binding-1", platform: "telegram", occurredAt: 1000 },
      });
      await store.appendQuestionnaireActivity({
        ...target,
        activity: {
          id: "question-1", requestId: "request-1", threadId: target.threadId,
          status: "submitted", questions: [], createdAt: 1000, updatedAt: 1000,
        },
      });
      await store.upsertManagedReviewEntry({
        ...target,
        entry: { type: "review", id: "review-1", review: "Review changes", createdAt: 1000 },
        pendingContext: true,
      });
      const before = await store.getThreadOverlayState(target);
      const rewind = { id: "rewind-1", occurredAt: 2000, removedTurnCount: 2, undoable: true };

      await store.appendThreadRewind({ ...target, rewind });
      stateDb.close();
      stateDb = StateDb.open(fixture.dbPath);
      store = new SqliteOverlayStore(stateDb);

      const overlay = await store.getThreadOverlayState(target);
      expect(overlay?.turnFailureLog).toBeUndefined();
      expect(overlay?.permissionTransitionLog).toBeUndefined();
      expect(overlay?.messagingBindingTransitionLog).toBeUndefined();
      expect(overlay?.questionnaireActivityLog).toBeUndefined();
      expect(overlay?.managedReviewEntries).toBeUndefined();
      expect(overlay?.pendingManagedReviewContextEntryIds).toBeUndefined();
      expect(overlay?.rewindLog).toEqual([rewind]);
      expect(overlay?.executionMode).toBe("auto");
      expect(overlay?.mcpConnectionIds).toEqual(["fixture-mcp"]);
      expect(overlay?.mcpSelectionRevision).toBe(before?.mcpSelectionRevision);
      expect((await store.getThreadOverlayState(otherThread))?.turnFailureLog).toEqual([failure]);
      expect((await store.getThreadOverlayState(otherBackend))?.turnFailureLog).toEqual([failure]);
    },
  );
});
