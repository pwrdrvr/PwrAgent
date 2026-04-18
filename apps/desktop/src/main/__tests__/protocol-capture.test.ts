import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProtocolCaptureStore } from "../testing/capture-store";
import { createProtocolCaptureObserver, createProtocolCaptureFromEnv } from "../testing/protocol-capture";

async function createTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "pwragnt-protocol-capture-"));
}

describe("ProtocolCaptureStore", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    delete process.env.PWRAGNT_PROTOCOL_CAPTURE;
    delete process.env.PWRAGNT_PROTOCOL_CAPTURE_ROOT;

    await Promise.all(
      cleanupPaths.splice(0).map(async (target) => {
        await fs.rm(target, { recursive: true, force: true });
      })
    );
  });

  it("captures request and notification traffic with thread ids in order", async () => {
    const rootDir = await createTempDir();
    cleanupPaths.push(rootDir);
    const store = new ProtocolCaptureStore({
      backend: "codex",
      captureId: "capture-1",
      rootDir
    });
    const observer = createProtocolCaptureObserver({
      backend: "codex",
      store
    });

    await observer.onMessage({
      direction: "outbound",
      raw: '{"jsonrpc":"2.0","id":"rpc-1","method":"thread/read","params":{"threadId":"thread-1"}}',
      envelope: {
        jsonrpc: "2.0",
        id: "rpc-1",
        method: "thread/read",
        params: {
          threadId: "thread-1"
        }
      }
    });

    await observer.onMessage({
      direction: "inbound",
      raw: '{"jsonrpc":"2.0","method":"turn/requestApproval","id":"request-1","params":{"threadId":"thread-1","requestId":"approval-1"}}',
      envelope: {
        jsonrpc: "2.0",
        id: "request-1",
        method: "turn/requestApproval",
        params: {
          threadId: "thread-1",
          requestId: "approval-1"
        }
      }
    });

    await store.close();

    const lines = (await fs.readFile(path.join(rootDir, "capture-1.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      backend: "codex",
      captureId: "capture-1",
      direction: "outbound",
      kind: "request",
      method: "thread/read",
      id: "rpc-1",
      sequence: 1,
      threadIds: ["thread-1"]
    });
    expect(lines[1]).toMatchObject({
      direction: "inbound",
      kind: "request",
      method: "turn/requestApproval",
      id: "request-1",
      sequence: 2,
      threadIds: ["thread-1"]
    });

    const index = JSON.parse(
      await fs.readFile(path.join(rootDir, "index.json"), "utf8")
    ) as Record<string, { threadIds: string[] }>;
    expect(index["capture-1"]?.threadIds).toEqual(["thread-1"]);
  });

  it("creates an env-backed capture session only when recording is enabled", async () => {
    const rootDir = await createTempDir();
    cleanupPaths.push(rootDir);

    expect(
      createProtocolCaptureFromEnv({
        backend: "codex",
        userDataPath: rootDir
      })
    ).toBeUndefined();

    process.env.PWRAGNT_PROTOCOL_CAPTURE = "true";
    process.env.PWRAGNT_PROTOCOL_CAPTURE_ROOT = rootDir;

    const capture = createProtocolCaptureFromEnv({
      backend: "codex",
      userDataPath: "/unused"
    });

    expect(capture).toBeDefined();
    await capture?.observer.onMessage({
      direction: "outbound",
      raw: '{"jsonrpc":"2.0","method":"initialized","params":{}}',
      envelope: {
        jsonrpc: "2.0",
        method: "initialized",
        params: {}
      }
    });
    await capture?.store.close();

    const index = JSON.parse(
      await fs.readFile(path.join(rootDir, "index.json"), "utf8")
    ) as Record<string, { backend: string }>;
    expect(Object.values(index)).toHaveLength(1);
    expect(Object.values(index)[0]?.backend).toBe("codex");
  });
});
