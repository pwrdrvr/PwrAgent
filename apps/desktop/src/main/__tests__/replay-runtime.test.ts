import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReplayClientsFromEnv } from "../testing/replay-runtime";

const REPLAY_FIXTURE_PATH_ENV = "PWRAGENT_REPLAY_FIXTURE_PATH";

const tempDirs: string[] = [];

afterEach(() => {
  delete process.env[REPLAY_FIXTURE_PATH_ENV];
  delete globalThis.__PWRAGENT_REPLAY_DRIVER__;

  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("replay-runtime", () => {
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

    await globalThis.__PWRAGENT_REPLAY_DRIVER__?.respondToPendingRequest({
      executionMode: "full-access",
      requestId: "approval-1"
    });

    expect(
      globalThis.__PWRAGENT_REPLAY_DRIVER__?.getPendingRequest({
        executionMode: "full-access"
      })
    ).toBeUndefined();
  });

  it("routes driver interactions to the replay fixture backend by default", async () => {
    const fixturePath = writeFixture({
      metadata: {
        backend: "grok",
        scenario: "replay-runtime-grok-routing"
      },
      steps: [
        {
          id: "initialize-1",
          kind: "response",
          method: "initialize",
          result: {
            serverInfo: {
              name: "Replay Grok",
              version: "1.0.0"
            },
            methods: ["thread/list"]
          }
        },
        {
          id: "notif-1",
          kind: "notification",
          notification: {
            method: "thread/status/changed",
            params: {
              threadId: "thread-grok",
              status: { type: "active" }
            }
          }
        }
      ]
    });

    process.env[REPLAY_FIXTURE_PATH_ENV] = fixturePath;

    const clients = createReplayClientsFromEnv();
    expect(clients).toBeDefined();

    const notifications: string[] = [];
    clients!.grokClient.onNotification((notification) => {
      notifications.push(notification.method);
    });

    await clients!.grokClient.getInitializeResult();
    await globalThis.__PWRAGENT_REPLAY_DRIVER__?.advance({ stepId: "notif-1" });

    expect(notifications).toEqual(["thread/status/changed"]);
    await expect(clients!.codexClient.getInitializeResult()).rejects.toThrow(
      "Replay fixture backend is grok; codex is unavailable in replay mode."
    );
  });
});

function writeFixture(fixture: unknown): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-replay-runtime-"));
  tempDirs.push(tempDir);

  const fixturePath = path.join(tempDir, "replay.fixture.json");
  fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2), "utf8");
  return fixturePath;
}
