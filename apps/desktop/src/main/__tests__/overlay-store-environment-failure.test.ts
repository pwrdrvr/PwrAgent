import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { openInMemoryStateDb } from "./sqlite-test-utils";

let stateDb: StateDb;
let store: SqliteOverlayStore;

async function seedFailedSetup(): Promise<void> {
  await store.setThreadCodexEnvironmentRuntime({
    backend: "codex",
    threadId: "thread-1",
    codexEnvironmentRuntime: {
      environmentId: "environment-1",
      environmentName: "PwrAgent",
      executionTarget: "local",
      setupStatus: "failed",
      setupCommand: "pnpm install",
      setupExitCode: 1,
      setupOutput: "boom",
    },
  });
}

async function readRuntime() {
  const overlay = await store.getThreadOverlayState({
    backend: "codex",
    threadId: "thread-1",
  });
  return overlay?.codexEnvironmentRuntime;
}

beforeEach(() => {
  stateDb = openInMemoryStateDb();
  store = new SqliteOverlayStore(stateDb);
});

afterEach(() => {
  stateDb.close();
});

/**
 * The durable half of the environment-failure prompt. The prompt used to be
 * dismissed only in renderer state, so it came back on every app launch — and
 * `setupStatus: "failed"` is permanent history that nothing ever rewrites, so
 * there was nothing else to distinguish "not answered yet" from "answered
 * weeks ago".
 */
describe("SqliteOverlayStore — environment failure acknowledgement", () => {
  it("records the acknowledgement without disturbing the failure record", async () => {
    await seedFailedSetup();

    expect(
      await store.acknowledgeThreadEnvironmentFailure({
        acknowledgedAt: 5_000,
        backend: "codex",
        threadId: "thread-1",
      }),
    ).toBe(true);

    const runtime = await readRuntime();
    expect(runtime?.setupFailureAcknowledgedAt).toBe(5_000);
    // The failure itself is history — the transcript's
    // `codex-environment-setup-*` activity entry still reports it.
    expect(runtime?.setupStatus).toBe("failed");
    expect(runtime?.setupExitCode).toBe(1);
    expect(runtime?.setupOutput).toBe("boom");
  });

  it("is idempotent so a repeat acknowledgement writes nothing", async () => {
    await seedFailedSetup();
    await store.acknowledgeThreadEnvironmentFailure({
      acknowledgedAt: 5_000,
      backend: "codex",
      threadId: "thread-1",
    });

    // The renderer re-sends this whenever it opens a thread whose snapshot it
    // has not refreshed yet; a false return is what keeps that off sqlite.
    expect(
      await store.acknowledgeThreadEnvironmentFailure({
        acknowledgedAt: 4_000,
        backend: "codex",
        threadId: "thread-1",
      }),
    ).toBe(false);
    expect((await readRuntime())?.setupFailureAcknowledgedAt).toBe(5_000);
  });

  it("advances the acknowledgement so a later failure can raise the prompt again", async () => {
    await seedFailedSetup();
    await store.acknowledgeThreadEnvironmentFailure({
      acknowledgedAt: 5_000,
      backend: "codex",
      threadId: "thread-1",
    });

    expect(
      await store.acknowledgeThreadEnvironmentFailure({
        acknowledgedAt: 9_000,
        backend: "codex",
        threadId: "thread-1",
      }),
    ).toBe(true);
    expect((await readRuntime())?.setupFailureAcknowledgedAt).toBe(9_000);
  });

  it("writes nothing for a thread with no environment runtime", async () => {
    // A remote/federated thread has no local overlay row. Acknowledging one
    // must not conjure a local row keyed by the peer's thread id.
    expect(
      await store.acknowledgeThreadEnvironmentFailure({
        backend: "codex",
        threadId: "thread-unknown",
      }),
    ).toBe(false);
    expect(
      await store.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-unknown",
      }),
    ).toBeUndefined();
  });
});
