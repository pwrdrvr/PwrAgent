import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";

let stateDb: StateDb;
let store: SqliteOverlayStore;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-questionnaire-test-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  store = new SqliteOverlayStore(stateDb);
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("SqliteOverlayStore - questionnaire activity log", () => {
  it("persists completed questionnaire answers across sqlite handles", async () => {
    const activity = {
      id: "questionnaire:request-1",
      requestId: "request-1",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "input-1",
      status: "submitted" as const,
      createdAt: 2_000,
      updatedAt: 2_000,
      questions: [
        {
          id: "food",
          header: "Food",
          question: "What should breakfast feature?",
          isOther: true,
          options: [{ label: "Waffles", description: "Crisp and golden" }],
        },
        {
          id: "token",
          header: "Secret",
          question: "What is the token?",
          isOther: true,
          isSecret: true,
        },
      ],
      answers: {
        food: { answers: ["Waffles"] },
        token: { answers: ["[REDACTED]"] },
      },
    };
    const first = await store.appendQuestionnaireActivity({
      backend: "codex",
      threadId: "thread-1",
      activity,
    });
    const duplicate = await store.appendQuestionnaireActivity({
      backend: "codex",
      threadId: "thread-1",
      activity,
    });
    expect(duplicate).toEqual(first);

    stateDb.close();
    const reopenedDb = StateDb.open(path.join(tempDir, "state.db"));
    const reopenedStore = new SqliteOverlayStore(reopenedDb);

    await expect(
      reopenedStore.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-1",
      }),
    ).resolves.toMatchObject({
      questionnaireActivityLog: [
        {
          requestId: "request-1",
          status: "submitted",
          updatedAt: 2_000,
          questions: [
            {
              id: "food",
            },
            {
              id: "token",
              isSecret: true,
            },
          ],
          answers: {
            food: { answers: ["Waffles"] },
            token: { answers: ["[REDACTED]"] },
          },
        },
      ],
    });

    reopenedDb.close();
  });
});
