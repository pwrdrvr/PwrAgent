import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeCodexThreadProtocolCapture } from "../testing/codex-thread-protocol-analysis";

describe("analyzeCodexThreadProtocolCapture", () => {
  it("characterizes thread list payloads and identity fields from a real codex capture", async () => {
    const analysis = await analyzeCodexThreadProtocolCapture({
      capturePath: path.resolve(
        "apps/desktop/e2e/fixtures/codex-todo-list/raw.capture.jsonl",
      ),
    });

    expect(analysis.captureId).toBe("2026-04-19T01-40-27-292Z-codex");
    expect(analysis.requestCounts.initialize).toBeGreaterThan(0);
    expect(analysis.requestCounts["thread/list"]).toBeGreaterThan(0);
    expect(analysis.threadList.requestMethods).toEqual(["thread/list"]);
    expect(analysis.threadList.requestVariants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "thread/list",
          paramsKeys: ["archived", "limit"],
          archived: false,
          limit: 100,
        }),
        expect.objectContaining({
          method: "thread/list",
          paramsKeys: ["archived", "limit"],
          archived: true,
          limit: 100,
        }),
      ]),
    );
    expect(analysis.threadList.responseContainerKeys).toContain("data");
    expect(analysis.threadList.responseResultKeys).toContain("data");
    expect(analysis.threadList.identityFieldCounts.cwd).toBeGreaterThan(0);
    expect(analysis.threadList.identityFieldCounts.path).toBeGreaterThan(0);
    expect(analysis.threadList.identityFieldCounts.gitBranch).toBeGreaterThan(0);
    expect(analysis.threadList.sampleThreads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "019da321-9801-70f1-a2ba-103afa135831",
          cwd: "/Users/huntharo/pwrdrvr/PwrAgnt",
          gitBranch: "main",
        }),
      ]),
    );
  });

  it("reports chronological thread message and tool order from thread/read and notifications", async () => {
    const captureDir = await fs.mkdtemp(path.join(os.tmpdir(), "pwragnt-protocol-"));
    const capturePath = path.join(captureDir, "temporal-order.jsonl");
    try {
      await fs.writeFile(
        capturePath,
        [
          captureRecord({
            direction: "outbound",
            id: "rpc-1",
            kind: "request",
            method: "thread/read",
            raw: {
              jsonrpc: "2.0",
              id: "rpc-1",
              method: "thread/read",
              params: {
                threadId: "thread-1",
                includeTurns: true,
              },
            },
            sequence: 1,
            threadIds: ["thread-1"],
          }),
          captureRecord({
            direction: "inbound",
            id: "rpc-1",
            kind: "response",
            raw: {
              id: "rpc-1",
              result: {
                thread: {
                  turns: [
                    {
                      id: "turn-1",
                      items: [
                        {
                          type: "agentMessage",
                          id: "message-1",
                          text: "First commentary.",
                        },
                        {
                          type: "commandExecution",
                          id: "read-1",
                          command: "sed -n '1,40p' src/one.ts",
                        },
                        {
                          type: "agentMessage",
                          id: "message-2",
                          text: "Second commentary.",
                        },
                      ],
                    },
                  ],
                },
              },
            },
            sequence: 2,
            threadIds: ["thread-1"],
          }),
          captureRecord({
            direction: "inbound",
            kind: "notification",
            method: "item/started",
            raw: {
              jsonrpc: "2.0",
              method: "item/started",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                item: {
                  type: "commandExecution",
                  id: "read-2",
                  command: "rg -n transcript src",
                },
              },
            },
            sequence: 3,
            threadIds: ["thread-1"],
          }),
          captureRecord({
            direction: "inbound",
            kind: "notification",
            method: "item/agentMessage/delta",
            raw: {
              jsonrpc: "2.0",
              method: "item/agentMessage/delta",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                itemId: "message-3",
                delta: "Final observed update.",
              },
            },
            sequence: 4,
            threadIds: ["thread-1"],
          }),
        ].join("\n") + "\n",
        "utf8",
      );

      const analysis = await analyzeCodexThreadProtocolCapture({ capturePath });

      expect(
        analysis.threadOrder.events.map((event) => ({
          itemId: event.itemId,
          itemIndex: event.itemIndex,
          kind: event.kind,
          label: event.label,
          sequence: event.sequence,
          source: event.source,
        })),
      ).toEqual([
        {
          itemId: "message-1",
          itemIndex: 0,
          kind: "assistant-message",
          label: "First commentary.",
          sequence: 2,
          source: "threadRead",
        },
        {
          itemId: "read-1",
          itemIndex: 1,
          kind: "tool-activity",
          label: "sed -n '1,40p' src/one.ts",
          sequence: 2,
          source: "threadRead",
        },
        {
          itemId: "message-2",
          itemIndex: 2,
          kind: "assistant-message",
          label: "Second commentary.",
          sequence: 2,
          source: "threadRead",
        },
        {
          itemId: "read-2",
          kind: "tool-activity",
          label: "rg -n transcript src",
          sequence: 3,
          source: "notification",
        },
        {
          itemId: "message-3",
          kind: "assistant-message",
          label: "Final observed update.",
          sequence: 4,
          source: "notification",
        },
      ]);
    } finally {
      await fs.rm(captureDir, { force: true, recursive: true });
    }
  });
});

function captureRecord(params: {
  direction: "inbound" | "outbound";
  id?: string;
  kind: "request" | "response" | "notification";
  method?: string;
  raw: unknown;
  sequence: number;
  threadIds: string[];
}): string {
  return JSON.stringify({
    backend: "codex",
    captureId: "temporal-order-test",
    direction: params.direction,
    kind: params.kind,
    ...(params.method ? { method: params.method } : {}),
    ...(params.id ? { id: params.id } : {}),
    sequence: params.sequence,
    timestamp: 1_777_000_000_000 + params.sequence,
    threadIds: params.threadIds,
    raw: JSON.stringify(params.raw),
  });
}
