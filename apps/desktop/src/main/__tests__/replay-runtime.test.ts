import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listingDiagnostics } from "../diagnostics/listing-diagnostics";
import { createReplayClientsFromEnv } from "../shell/testing/replay-runtime";

const app = vi.hoisted(() => ({ isPackaged: false }));
vi.mock("electron", () => ({ app }));

const REPLAY_FIXTURE_PATH_ENV = "PWRAGENT_REPLAY_FIXTURE_PATH";

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  app.isPackaged = false;
  delete process.env[REPLAY_FIXTURE_PATH_ENV];
  delete globalThis.__PWRAGENT_REPLAY_DRIVER__;
  delete globalThis.__PWRAGENT_E2E_MAIN_PROCESS_TIMING__;
  listingDiagnostics.setEnabled(false);
  listingDiagnostics.setEnabled(false, "replay");

  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("replay-runtime", () => {
  it("handles consecutive tool calls outside the active SQLite step", async () => {
    const requestIds = ["notify-1", "notify-2"];
    vi.stubEnv(REPLAY_FIXTURE_PATH_ENV, writeFixture({
      metadata: { backend: "codex", scenario: "consecutive-tool-calls" },
      steps: requestIds.map((requestId) => ({
        id: requestId,
        kind: "request",
        request: {
          method: "item/tool/call",
          params: {
            requestId,
            threadId: "thread-1",
            turnId: "turn-1",
            callId: requestId,
            tool: "notify_operator",
            arguments: { message: requestId },
          },
        },
      })),
    }));
    const { codexClient } = createReplayClientsFromEnv()!;
    const driver = globalThis.__PWRAGENT_REPLAY_DRIVER__!;
    const db = new Database(":memory:");
    const handled: string[] = [];
    try {
      codexClient.onRequest(({ params }) => {
        db.prepare("SELECT 1").get();
        handled.push(params.requestId);
      });
      await driver.advance({ stepId: "notify-1" });

      // Model an inspector interrupt by entering the same driver while SQLite
      // has control of the connection and is calling back into JavaScript.
      let secondAdvance: Promise<void> | undefined;
      db.function("advance_replay", () => {
        secondAdvance = driver.advance({ stepId: "notify-2" });
        return 1;
      });
      db.prepare("SELECT advance_replay()").get();

      await Promise.resolve();
      const handledBeforeNextTask = [...handled];
      await expect(secondAdvance).resolves.toBeUndefined();
      expect(handledBeforeNextTask).toEqual(["notify-1"]);
      expect(handled).toEqual(requestIds);
      expect(driver.getPendingRequest()).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it.each([
    { replay: true, e2e: true, packaged: false, armed: true },
    { replay: false, e2e: true, packaged: false, armed: false },
    { replay: true, e2e: false, packaged: false, armed: false },
    { replay: true, e2e: true, packaged: true, armed: false },
  ])("gates listing history on unpackaged E2E replay ($replay, $e2e, $packaged)", async ({ replay, e2e, packaged, armed }) => {
    app.isPackaged = packaged;
    vi.stubEnv("PWRAGENT_E2E", e2e ? "1" : undefined);
    if (replay) vi.stubEnv(REPLAY_FIXTURE_PATH_ENV, writeFixture({
      metadata: { backend: "codex", scenario: "replay-timing" }, steps: [],
    }));
    createReplayClientsFromEnv();
    expect(listingDiagnostics.snapshot().enabled).toBe(armed);
    if (!armed) {
      expect(globalThis.__PWRAGENT_E2E_MAIN_PROCESS_TIMING__).toBeUndefined();
      return;
    }

    await listingDiagnostics.trace("ipc", { query: "lens", logical: 137 }, async () => undefined);
    listingDiagnostics.setEnabled(true);
    listingDiagnostics.setEnabled(false);
    const snapshot = globalThis.__PWRAGENT_E2E_MAIN_PROCESS_TIMING__?.();
    const start = snapshot?.listings.events.find((entry) => entry.phase === "start");
    expect(start).toMatchObject({ stage: "ipc", query: "lens", logical: 137 });
    expect(snapshot?.listings.events.find((entry) => entry.phase === "end")).toMatchObject({ id: start?.id, outcome: "ok" });
  });

  it("routes driver interactions through the single codex replay client (executionMode param accepted but ignored)", async () => {
    const fixturePath = writeFixture({
      metadata: {
        backend: "codex",
        scenario: "replay-runtime-mode-routing"
      },
      steps: [
        {
          id: "initialize-1",
          kind: "response",
          method: "initialize",
          result: {
            serverInfo: {
              name: "Replay Codex",
              version: "1.0.0"
            },
            methods: ["thread/list", "turn/start"]
          }
        },
        {
          id: "list-1",
          kind: "response",
          method: "thread/list",
          result: []
        },
        {
          id: "turn-start-1",
          kind: "response",
          method: "turn/start",
          result: {
            threadId: "thread-full-access",
            turnId: "turn-1"
          }
        },
        {
          id: "req-1",
          kind: "request",
          request: {
            method: "turn/requestApproval",
            params: {
              threadId: "thread-full-access",
              turnId: "turn-1",
              requestId: "approval-1"
            }
          }
        }
      ]
    });

    process.env[REPLAY_FIXTURE_PATH_ENV] = fixturePath;

    const clients = createReplayClientsFromEnv();
    expect(clients).toBeDefined();

    await clients!.codexClient.getInitializeResult();
    await clients!.codexClient.listThreads();
    await clients!.codexClient.startTurn({
      threadId: "thread-full-access",
      input: [{ type: "text", text: "Check payload capture" }]
    });

    expect(
      globalThis.__PWRAGENT_REPLAY_DRIVER__?.getLastStartTurn({
        executionMode: "full-access"
      })
    ).toEqual({
      threadId: "thread-full-access",
      input: [{ type: "text", text: "Check payload capture" }]
    });

    await globalThis.__PWRAGENT_REPLAY_DRIVER__?.advance({
      executionMode: "full-access",
      stepId: "req-1"
    });

    expect(
      globalThis.__PWRAGENT_REPLAY_DRIVER__?.getPendingRequest({
        executionMode: "full-access"
      })
    ).toMatchObject({
      method: "turn/requestApproval",
      params: {
        requestId: "approval-1"
      }
    });

    // The driver's executionMode param is now ignored — both modes share
    // the single codex replay client, so the same pending request is
    // visible whether called with or without an explicit executionMode.
    expect(globalThis.__PWRAGENT_REPLAY_DRIVER__?.getPendingRequest()).toMatchObject({
      method: "turn/requestApproval",
      params: {
        requestId: "approval-1"
      }
    });

    const response = globalThis.__PWRAGENT_REPLAY_DRIVER__?.respondToPendingRequest({
      executionMode: "full-access",
      requestId: "approval-1"
    });
    await Promise.resolve();
    const pendingBeforeNextTask = globalThis.__PWRAGENT_REPLAY_DRIVER__?.getPendingRequest();
    await response;
    expect(pendingBeforeNextTask?.params.requestId).toBe("approval-1");

    expect(
      globalThis.__PWRAGENT_REPLAY_DRIVER__?.getPendingRequest({
        executionMode: "full-access"
      })
    ).toBeUndefined();
  });});

function writeFixture(fixture: unknown): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-replay-runtime-"));
  tempDirs.push(tempDir);

  const fixturePath = path.join(tempDir, "replay.fixture.json");
  fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2), "utf8");
  return fixturePath;
}
