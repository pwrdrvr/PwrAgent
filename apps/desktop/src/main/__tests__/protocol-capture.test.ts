import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProtocolCaptureStore, readProtocolCaptureFile } from "../testing/capture-store";
import { analyzeProtocolCaptureTraffic } from "../testing/protocol-capture-analysis";
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

  it("captures optional diagnostics without changing the raw JSON-RPC envelope", async () => {
    const rootDir = await createTempDir();
    cleanupPaths.push(rootDir);
    const store = new ProtocolCaptureStore({
      backend: "grok",
      captureId: "diagnostic-capture",
      rootDir
    });
    const observer = createProtocolCaptureObserver({
      backend: "grok",
      store
    });

    await observer.onMessage({
      direction: "outbound",
      diagnostics: {
        callerReason: "backend-summary",
        ownerId: "model-catalog-1",
      },
      raw: '{"jsonrpc":"2.0","id":"rpc-1","method":"model/list","params":{}}',
      envelope: {
        jsonrpc: "2.0",
        id: "rpc-1",
        method: "model/list",
        params: {},
      }
    });
    await store.close();

    const [line] = (await fs.readFile(
      path.join(rootDir, "diagnostic-capture.jsonl"),
      "utf8",
    )).trim().split("\n").map((entry) => JSON.parse(entry) as Record<string, unknown>);

    expect(line).toMatchObject({
      diagnostics: {
        callerReason: "backend-summary",
        ownerId: "model-catalog-1",
      },
      raw: '{"jsonrpc":"2.0","id":"rpc-1","method":"model/list","params":{}}',
    });
  });

  it("creates an env-backed capture session only when recording is enabled", async () => {
    const rootDir = await createTempDir();
    cleanupPaths.push(rootDir);

    expect(
      createProtocolCaptureFromEnv({
        backend: "codex",
        backendInstance: "default",
        userDataPath: rootDir
      })
    ).toBeUndefined();

    process.env.PWRAGNT_PROTOCOL_CAPTURE = "true";
    process.env.PWRAGNT_PROTOCOL_CAPTURE_ROOT = rootDir;

    const capture = createProtocolCaptureFromEnv({
      backend: "codex",
      backendInstance: "default",
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
    ) as Record<string, { backend: string; backendInstance?: string }>;
    expect(Object.values(index)).toHaveLength(1);
    expect(Object.values(index)[0]?.backend).toBe("codex");
    expect(Object.values(index)[0]?.backendInstance).toBe("default");
  });

  it("serializes index writes shared by concurrent backend captures", async () => {
    const rootDir = await createTempDir();
    cleanupPaths.push(rootDir);
    const codexStore = new ProtocolCaptureStore({
      backend: "codex",
      captureId: "codex-capture",
      rootDir,
    });
    const grokStore = new ProtocolCaptureStore({
      backend: "grok",
      captureId: "grok-capture",
      rootDir,
    });

    await Promise.all([
      codexStore.append({
        direction: "outbound",
        raw: '{"jsonrpc":"2.0","id":"rpc-1","method":"thread/read","params":{"threadId":"codex-thread"}}',
        envelope: {
          id: "rpc-1",
          method: "thread/read",
          params: { threadId: "codex-thread" },
        },
      }),
      grokStore.append({
        direction: "outbound",
        raw: '{"jsonrpc":"2.0","id":"rpc-1","method":"thread/read","params":{"threadId":"grok-thread"}}',
        envelope: {
          id: "rpc-1",
          method: "thread/read",
          params: { threadId: "grok-thread" },
        },
      }),
    ]);
    await Promise.all([codexStore.close(), grokStore.close()]);

    const index = JSON.parse(
      await fs.readFile(path.join(rootDir, "index.json"), "utf8"),
    ) as Record<string, { backend: string; threadIds: string[] }>;
    expect(index["codex-capture"]).toMatchObject({
      backend: "codex",
      threadIds: ["codex-thread"],
    });
    expect(index["grok-capture"]).toMatchObject({
      backend: "grok",
      threadIds: ["grok-thread"],
    });
  });

  it("resets the index and keeps capturing when capture index JSON is malformed", async () => {
    const rootDir = await createTempDir();
    cleanupPaths.push(rootDir);
    const indexPath = path.join(rootDir, "index.json");
    const store = new ProtocolCaptureStore({
      backend: "codex",
      captureId: "capture-with-bad-index",
      rootDir,
    });

    await fs.writeFile(indexPath, "", "utf8");

    await store.append({
      direction: "outbound",
      raw: '{"jsonrpc":"2.0","id":"rpc-1","method":"initialize","params":{}}',
      envelope: {
        id: "rpc-1",
        method: "initialize",
        params: {},
      },
    });

    const index = JSON.parse(
      await fs.readFile(indexPath, "utf8"),
    ) as Record<string, { backend: string; captureId: string }>;
    expect(index["capture-with-bad-index"]).toMatchObject({
      backend: "codex",
      captureId: "capture-with-bad-index",
    });
  });

  it("reads capture files with parsed envelopes and optional redactions", async () => {
    const rootDir = await createTempDir();
    cleanupPaths.push(rootDir);
    const capturePath = path.join(rootDir, "capture.jsonl");

    await fs.writeFile(
      capturePath,
      `${JSON.stringify({
        backend: "codex",
        captureId: "capture-2",
        direction: "outbound",
        kind: "request",
        method: "thread/list",
        id: "rpc-2",
        sequence: 1,
        timestamp: 1,
        threadIds: [],
        raw: JSON.stringify({
          jsonrpc: "2.0",
          id: "rpc-2",
          method: "thread/list",
          params: {
            archived: false,
            limit: 100,
            cwd: "/Users/huntharo/pwrdrvr/PwrAgnt",
          },
        }),
      })}\n`,
      "utf8",
    );

    const records = await readProtocolCaptureFile(capturePath, [
      {
        match: "/Users/huntharo",
        replace: "/repo-user",
      },
    ]);

    expect(records).toEqual([
      expect.objectContaining({
        record: expect.objectContaining({
          captureId: "capture-2",
          method: "thread/list",
          sequence: 1,
        }),
        envelope: expect.objectContaining({
          method: "thread/list",
          params: expect.objectContaining({
            cwd: "/repo-user/pwrdrvr/PwrAgnt",
          }),
        }),
      }),
    ]);
  });

  it("analyzes method counts separately and skips malformed capture rows", async () => {
    const rootDir = await createTempDir();
    cleanupPaths.push(rootDir);
    const capturePath = path.join(rootDir, "startup.jsonl");

    await fs.writeFile(
      capturePath,
      [
        JSON.stringify({
          backend: "grok",
          backendInstance: "default",
          captureId: "startup-grok",
          diagnostics: {
            callerReason: "backend-summary",
            ownerId: "model-catalog-1",
          },
          direction: "outbound",
          kind: "request",
          method: "initialize",
          id: "rpc-1",
          sequence: 1,
          timestamp: 100,
          threadIds: [],
          raw: '{"jsonrpc":"2.0","id":"rpc-1","method":"initialize","params":{}}',
        }),
        JSON.stringify({
          backend: "grok",
          backendInstance: "default",
          captureId: "startup-grok",
          diagnostics: {
            callerReason: "backend-summary",
            ownerId: "model-catalog-1",
          },
          direction: "outbound",
          kind: "request",
          method: "model/list",
          id: "rpc-2",
          sequence: 2,
          timestamp: 120,
          threadIds: [],
          raw: '{"jsonrpc":"2.0","id":"rpc-2","method":"model/list","params":{}}',
        }),
        JSON.stringify({
          backend: "grok",
          backendInstance: "default",
          captureId: "startup-grok",
          direction: "outbound",
          kind: "request",
          method: "thread/list",
          id: "rpc-3",
          sequence: 3,
          timestamp: 140,
          threadIds: [],
          raw: '{"jsonrpc":"2.0","id":"rpc-3","method":"thread/list","params":{}}',
        }),
        "{malformed",
        JSON.stringify({
          backend: "grok",
          backendInstance: "default",
          captureId: "startup-grok",
          direction: "outbound",
          kind: "request",
          method: "thread/list",
          id: "rpc-4",
          sequence: 4,
          timestamp: 150,
          threadIds: [],
          raw: '{"jsonrpc":"2.0","id":"rpc-4","method":"thread/list","params":{}}',
        }),
      ].join("\n"),
      "utf8",
    );

    const analysis = await analyzeProtocolCaptureTraffic({ capturePath });

    expect(analysis.malformedRecordCount).toBe(1);
    expect(analysis.backendInstances).toEqual(["grok:default"]);
    expect(analysis.summaries.grok?.requestCounts).toMatchObject({
      initialize: 1,
      "model/list": 1,
      "thread/list": 2,
    });
    expect(analysis.summaries.grok?.requests["model/list"]).toMatchObject({
      count: 1,
      callerReasons: ["backend-summary"],
      ownerIds: ["model-catalog-1"],
      firstAt: 120,
      lastAt: 120,
    });
  });
});
