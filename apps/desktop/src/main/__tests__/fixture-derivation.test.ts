import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveReplayFixtureFromCapture,
  exportSessionCapture,
} from "../testing/fixture-derivation";

async function createTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "pwragnt-fixture-derivation-"));
}

async function writeJsonl(filePath: string, records: unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8"
  );
}

describe("fixture derivation", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupPaths.splice(0).map(async (target) => {
        await fs.rm(target, { recursive: true, force: true });
      })
    );
  });

  it("derives the checked-in edited-changes replay fixture from raw capture", async () => {
    const fixtureDir = path.resolve(
      process.cwd(),
      "apps/desktop/e2e/fixtures/edited-changes-order"
    );
    const derived = await deriveReplayFixtureFromCapture({
      capturePath: path.join(fixtureDir, "raw.capture.jsonl"),
      scenario: "edited-changes-order",
    });
    const expected = JSON.parse(
      await fs.readFile(path.join(fixtureDir, "replay.fixture.json"), "utf8")
    );

    expect(derived.fixture).toEqual(expected);
    expect(derived.rawCaptureRecords).toHaveLength(12);
  });

  it("preserves unknown notifications and inbound requests within the selected window", async () => {
    const rootDir = await createTempDir();
    cleanupPaths.push(rootDir);
    const capturePath = path.join(rootDir, "capture.jsonl");

    await writeJsonl(capturePath, [
      {
        backend: "codex",
        captureId: "capture-1",
        direction: "outbound",
        kind: "request",
        method: "initialize",
        id: "rpc-1",
        sequence: 1,
        timestamp: 1,
        threadIds: ["thread-1"],
        raw: JSON.stringify({
          jsonrpc: "2.0",
          id: "rpc-1",
          method: "initialize",
          params: {}
        })
      },
      {
        backend: "codex",
        captureId: "capture-1",
        direction: "inbound",
        kind: "response",
        id: "rpc-1",
        sequence: 2,
        timestamp: 2,
        threadIds: ["thread-1"],
        raw: JSON.stringify({
          jsonrpc: "2.0",
          id: "rpc-1",
          result: {
            serverInfo: {
              name: "Replay Codex",
              version: "1.0.0"
            }
          }
        })
      },
      {
        backend: "codex",
        captureId: "capture-1",
        direction: "inbound",
        kind: "notification",
        method: "item/unknownEvent",
        sequence: 3,
        timestamp: 3,
        threadIds: ["thread-1"],
        raw: JSON.stringify({
          jsonrpc: "2.0",
          method: "item/unknownEvent",
          params: {
            threadId: "thread-1",
            label: "keep me"
          }
        })
      },
      {
        backend: "codex",
        captureId: "capture-1",
        direction: "inbound",
        kind: "request",
        method: "turn/requestApproval",
        id: "request-1",
        sequence: 4,
        timestamp: 4,
        threadIds: ["thread-1"],
        raw: JSON.stringify({
          jsonrpc: "2.0",
          id: "request-1",
          method: "turn/requestApproval",
          params: {
            threadId: "thread-1",
            requestId: "approval-1"
          }
        })
      }
    ]);

    const derived = await deriveReplayFixtureFromCapture({
      capturePath,
      scenario: "window-test",
      startSequence: 2,
      endSequence: 4,
      stepLabels: {
        3: "unknown-event-1",
        4: "approval-1"
      }
    });

    expect(derived.fixture.steps).toEqual([
      {
        id: "initialize-1",
        kind: "response",
        method: "initialize",
        result: {
          serverInfo: {
            name: "Replay Codex",
            version: "1.0.0"
          }
        }
      },
      {
        id: "unknown-event-1",
        kind: "notification",
        notification: {
          method: "item/unknownEvent",
          params: {
            threadId: "thread-1",
            label: "keep me"
          }
        }
      },
      {
        id: "approval-1",
        kind: "request",
        request: {
          method: "turn/requestApproval",
          params: {
            threadId: "thread-1",
            requestId: "approval-1"
          }
        }
      }
    ]);
  });

  it("filters selected capture records to the requested thread while keeping global traffic", async () => {
    const rootDir = await createTempDir();
    cleanupPaths.push(rootDir);
    const capturePath = path.join(rootDir, "capture.jsonl");

    await writeJsonl(capturePath, [
      {
        backend: "codex",
        captureId: "capture-threads",
        direction: "outbound",
        kind: "request",
        method: "initialize",
        id: "rpc-1",
        sequence: 1,
        timestamp: 1,
        threadIds: [],
        raw: JSON.stringify({
          jsonrpc: "2.0",
          id: "rpc-1",
          method: "initialize",
          params: {}
        })
      },
      {
        backend: "codex",
        captureId: "capture-threads",
        direction: "inbound",
        kind: "response",
        id: "rpc-1",
        sequence: 2,
        timestamp: 2,
        threadIds: [],
        raw: JSON.stringify({
          jsonrpc: "2.0",
          id: "rpc-1",
          result: {
            serverInfo: {
              name: "Replay Codex",
              version: "1.0.0"
            }
          }
        })
      },
      {
        backend: "codex",
        captureId: "capture-threads",
        direction: "inbound",
        kind: "notification",
        method: "thread/status/changed",
        sequence: 3,
        timestamp: 3,
        threadIds: ["thread-1"],
        raw: JSON.stringify({
          jsonrpc: "2.0",
          method: "thread/status/changed",
          params: {
            threadId: "thread-1",
            status: { type: "active" }
          }
        })
      },
      {
        backend: "codex",
        captureId: "capture-threads",
        direction: "inbound",
        kind: "notification",
        method: "thread/status/changed",
        sequence: 4,
        timestamp: 4,
        threadIds: ["thread-2"],
        raw: JSON.stringify({
          jsonrpc: "2.0",
          method: "thread/status/changed",
          params: {
            threadId: "thread-2",
            status: { type: "idle" }
          }
        })
      }
    ]);

    const derived = await deriveReplayFixtureFromCapture({
      capturePath,
      scenario: "thread-filter",
      threadId: "thread-1"
    });

    expect(derived.rawCaptureRecords.map((record) => record.sequence)).toEqual([1, 2, 3]);
    expect(derived.fixture.metadata.threadId).toBe("thread-1");
    expect(derived.fixture.steps).toEqual([
      {
        id: "initialize-1",
        kind: "response",
        method: "initialize",
        result: {
          serverInfo: {
            name: "Replay Codex",
            version: "1.0.0"
          }
        }
      },
      {
        id: "thread-status-changed-1",
        kind: "notification",
        notification: {
          method: "thread/status/changed",
          params: {
            threadId: "thread-1",
            status: { type: "active" }
          }
        }
      }
    ]);
  });

  it("exports the latest recorded capture for a backend-qualified thread id", async () => {
    const rootDir = await createTempDir();
    cleanupPaths.push(rootDir);
    const oldCapturePath = path.join(rootDir, "old.jsonl");
    const newCapturePath = path.join(rootDir, "new.jsonl");
    const outputPath = path.join(rootDir, "exports", "thread.raw.capture.jsonl");

    await fs.writeFile(oldCapturePath, '{"capture":"old"}\n', "utf8");
    await fs.writeFile(newCapturePath, '{"capture":"new"}\n', "utf8");
    await fs.writeFile(
      path.join(rootDir, "index.json"),
      JSON.stringify(
        {
          "capture-old": {
            backend: "codex",
            captureId: "capture-old",
            createdAt: 1,
            path: oldCapturePath,
            threadIds: ["thread-1"],
            updatedAt: 1
          },
          "capture-new": {
            backend: "codex",
            captureId: "capture-new",
            createdAt: 2,
            path: newCapturePath,
            threadIds: ["thread-1"],
            updatedAt: 2
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const exported = await exportSessionCapture({
      captureRoot: rootDir,
      sessionId: "codex:thread-1",
      outputPath
    });

    expect(exported.captureId).toBe("capture-new");
    await expect(fs.readFile(outputPath, "utf8")).resolves.toBe('{"capture":"new"}\n');
    await expect(
      exportSessionCapture({
        captureRoot: rootDir,
        sessionId: "codex:missing-thread",
        outputPath: path.join(rootDir, "exports", "missing.jsonl")
      })
    ).rejects.toThrow(
      `No recorded capture for codex:missing-thread in ${path.join(rootDir, "index.json")}`
    );
  });

  it("rejects malformed raw capture records with the record location", async () => {
    const rootDir = await createTempDir();
    cleanupPaths.push(rootDir);
    const capturePath = path.join(rootDir, "malformed.jsonl");
    await fs.writeFile(
      capturePath,
      '{"backend":"codex","captureId":"capture-1","direction":"inbound","kind":"notification","sequence":1,"timestamp":1,"threadIds":[],"raw":"{bad json}"}\n',
      "utf8"
    );

    await expect(
      deriveReplayFixtureFromCapture({
        capturePath,
        scenario: "broken"
      })
    ).rejects.toThrow(
      `Invalid JSON-RPC envelope for sequence 1 in ${capturePath}`
    );
  });
});
