import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonRpcTransport } from "../codex-app-server/json-rpc";
import { ProtocolCaptureStore } from "../testing/capture-store";
import { createProtocolCaptureObserver } from "../testing/protocol-capture";

class MockTransport implements JsonRpcTransport {
  static instances: MockTransport[] = [];

  readonly sentMessages: string[] = [];
  private messageHandler: (message: string) => void = () => undefined;
  private closeHandler: (error?: Error) => void = () => undefined;

  constructor() {
    MockTransport.instances.push(this);
  }

  async connect(): Promise<void> {
    return;
  }

  async close(): Promise<void> {
    this.closeHandler();
  }

  emitRaw(message: string): void {
    this.messageHandler(message);
  }

  send(message: string): void {
    this.sentMessages.push(message);
    const payload = JSON.parse(message) as { id?: string; method?: string };

    if (payload.method === "initialize") {
      this.emitRaw(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            serverInfo: {
              name: "Codex App Server",
              version: "1.0.0"
            }
          }
        })
      );
      return;
    }
  }

  setCloseHandler(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }

  setMessageHandler(handler: (message: string) => void): void {
    this.messageHandler = handler;
  }
}

vi.mock("../codex-app-server/stdio-transport", () => {
  class MockStdioJsonRpcTransport extends MockTransport {
    constructor() {
      super();
    }
  }

  return {
    StdioJsonRpcTransport: MockStdioJsonRpcTransport
  };
});

async function createTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "pwragent-codex-recording-"));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 500,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("timed out waiting for test condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("CodexAppServerClient recording", () => {
  const cleanupPaths: string[] = [];

  beforeEach(() => {
    MockTransport.instances.length = 0;
  });

  afterEach(async () => {
    await Promise.all(
      cleanupPaths.splice(0).map(async (target) => {
        await fs.rm(target, { recursive: true, force: true });
      })
    );
  });

  it("records initialize traffic and inbound requests without capturing malformed frames", async () => {
    const rootDir = await createTempDir();
    cleanupPaths.push(rootDir);
    const store = new ProtocolCaptureStore({
      backend: "codex",
      captureId: "capture-client",
      rootDir
    });

    const { CodexAppServerClient } = await import("../codex-app-server/client");
    const client = new CodexAppServerClient({
      connectionObserver: createProtocolCaptureObserver({
        backend: "codex",
        store
      })
    });

    client.onRequest(async () => ({ decision: "approve" }));

    await client.getInitializeResult();

    const transport = MockTransport.instances.at(-1);
    expect(transport).toBeDefined();

    transport?.emitRaw("{not-json");
    transport?.emitRaw(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "request-1",
        method: "turn/requestApproval",
        params: {
          threadId: "thread-77",
          requestId: "approval-1"
        }
      })
    );

    await waitFor(() =>
      transport?.sentMessages.some((message) => {
        const payload = JSON.parse(message) as {
          id?: string;
          result?: unknown;
        };
        return payload.id === "request-1" && Object.hasOwn(payload, "result");
      }) ?? false
    );
    await store.close();
    await client.close();

    const lines = (await fs.readFile(path.join(rootDir, "capture-client.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(
      lines.some(
        (line) =>
          line.direction === "outbound" &&
          line.kind === "request" &&
          line.method === "initialize"
      )
    ).toBe(true);
    expect(
      lines.some(
        (line) =>
          line.direction === "inbound" &&
          line.kind === "response" &&
          line.id === "rpc-1"
      )
    ).toBe(true);
    expect(
      lines.some(
        (line) =>
          line.direction === "inbound" &&
          line.kind === "request" &&
          line.method === "turn/requestApproval" &&
          JSON.stringify(line.threadIds) === JSON.stringify(["thread-77"])
      )
    ).toBe(true);
    expect(
      lines.some(
        (line) =>
          line.direction === "outbound" &&
          line.kind === "response" &&
          line.id === "request-1"
      )
    ).toBe(true);
    expect(lines.some((line) => line.raw === "{not-json")).toBe(false);
  });
});
