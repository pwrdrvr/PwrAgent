import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReplayClientsFromEnv } from "../testing/replay-runtime";

const REPLAY_FIXTURE_PATH_ENV = "PWRAGNT_REPLAY_FIXTURE_PATH";

const tempDirs: string[] = [];

afterEach(() => {
  delete process.env[REPLAY_FIXTURE_PATH_ENV];
  delete globalThis.__PWRAGNT_REPLAY_DRIVER__;

  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("replay-runtime", () => {
  it("routes driver interactions to the requested execution mode", async () => {
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
          id: "req-1",
          kind: "request",
          request: {
            method: "turn/requestApproval",
            params: {
              threadId: "thread-full-access",
              runId: "turn-1",
              requestId: "approval-1"
            }
          }
        }
      ]
    });

    process.env[REPLAY_FIXTURE_PATH_ENV] = fixturePath;

    const clients = createReplayClientsFromEnv();
    expect(clients).toBeDefined();

    await clients!.fullAccessClient.getInitializeResult();
    await clients!.fullAccessClient.listThreads();

    await globalThis.__PWRAGNT_REPLAY_DRIVER__?.advance({
      executionMode: "full-access",
      stepId: "req-1"
    });

    expect(
      globalThis.__PWRAGNT_REPLAY_DRIVER__?.getPendingRequest({
        executionMode: "full-access"
      })
    ).toMatchObject({
      method: "turn/requestApproval",
      params: {
        requestId: "approval-1"
      }
    });

    expect(globalThis.__PWRAGNT_REPLAY_DRIVER__?.getPendingRequest()).toBeUndefined();

    await globalThis.__PWRAGNT_REPLAY_DRIVER__?.respondToPendingRequest({
      executionMode: "full-access",
      requestId: "approval-1"
    });

    expect(
      globalThis.__PWRAGNT_REPLAY_DRIVER__?.getPendingRequest({
        executionMode: "full-access"
      })
    ).toBeUndefined();
  });
});

function writeFixture(fixture: unknown): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pwragnt-replay-runtime-"));
  tempDirs.push(tempDir);

  const fixturePath = path.join(tempDir, "replay.fixture.json");
  fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2), "utf8");
  return fixturePath;
}
