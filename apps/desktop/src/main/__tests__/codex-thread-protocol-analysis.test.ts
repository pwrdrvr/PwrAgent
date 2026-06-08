import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeCodexThreadProtocolCapture } from "../testing/codex-thread-protocol-analysis";

describe("analyzeCodexThreadProtocolCapture", () => {
  it("characterizes thread list payloads and identity fields", async () => {
    const captureDir = await fs.mkdtemp(path.join(os.tmpdir(), "pwragent-protocol-"));
    const capturePath = path.join(captureDir, "thread-list.jsonl");
    try {
      await fs.writeFile(
        capturePath,
        [
          captureRecord({
            direction: "outbound",
            id: "rpc-1",
            kind: "request",
            method: "initialize",
            raw: {
              jsonrpc: "2.0",
              id: "rpc-1",
              method: "initialize",
              params: {},
            },
            sequence: 1,
            threadIds: [],
          }),
          captureRecord({
            direction: "inbound",
            id: "rpc-1",
            kind: "response",
            raw: {
              id: "rpc-1",
              result: {},
            },
            sequence: 2,
            threadIds: [],
          }),
          captureRecord({
            direction: "outbound",
            id: "rpc-2",
            kind: "request",
            method: "thread/list",
            raw: {
              jsonrpc: "2.0",
              id: "rpc-2",
              method: "thread/list",
              params: {
                archived: false,
                limit: 100,
              },
            },
            sequence: 3,
            threadIds: [],
          }),
          captureRecord({
            direction: "inbound",
            id: "rpc-2",
            kind: "response",
            raw: {
              id: "rpc-2",
              result: {
                data: [
                  {
                    id: "thread-main",
                    cwd: "/tmp/pwragent-main",
                    gitInfo: {
                      branch: "main",
                    },
                    path: "/tmp/pwragent-main/.codex/sessions/thread-main.jsonl",
                    preview: "Implement thread list handling",
                    status: {
                      type: "idle",
                    },
                  },
                  {
                    id: "thread-worktree",
                    projectKey: "/tmp/pwragent",
                    session: {
                      cwd: "/tmp/pwragent/.worktrees/feature-a",
                    },
                    git_info: {
                      branch: "feature/a",
                    },
                    name: "Worktree thread",
                  },
                ],
              },
            },
            sequence: 4,
            threadIds: ["thread-main", "thread-worktree"],
          }),
          captureRecord({
            direction: "outbound",
            id: "rpc-3",
            kind: "request",
            method: "thread/list",
            raw: {
              jsonrpc: "2.0",
              id: "rpc-3",
              method: "thread/list",
              params: {
                archived: true,
                limit: 100,
              },
            },
            sequence: 5,
            threadIds: [],
          }),
          captureRecord({
            direction: "inbound",
            id: "rpc-3",
            kind: "response",
            raw: {
              id: "rpc-3",
              result: {
                data: [
                  {
                    id: "thread-archived",
                    cwd: "/tmp/pwragent-archived",
                    gitInfo: {
                      branch: "archived",
                    },
                    path: "/tmp/pwragent-archived/.codex/sessions/thread-archived.jsonl",
                    title: "Archived thread",
                  },
                ],
              },
            },
            sequence: 6,
            threadIds: ["thread-archived"],
          }),
        ].join("\n") + "\n",
        "utf8",
      );

      const analysis = await analyzeCodexThreadProtocolCapture({ capturePath });

      expect(analysis.captureId).toBe("temporal-order-test");
      expect(analysis.requestCounts.initialize).toBe(1);
      expect(analysis.requestCounts["thread/list"]).toBe(2);
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
      expect(analysis.threadList.activeRequestCount).toBe(1);
      expect(analysis.threadList.archivedRequestCount).toBe(1);
      expect(analysis.threadList.identityFieldCounts.cwd).toBe(2);
      expect(analysis.threadList.identityFieldCounts.sessionCwd).toBe(1);
      expect(analysis.threadList.identityFieldCounts.path).toBe(2);
      expect(analysis.threadList.identityFieldCounts.projectKey).toBe(1);
      expect(analysis.threadList.identityFieldCounts.gitBranch).toBe(3);
      expect(analysis.threadList.identityFieldCounts.status).toBe(1);
      expect(analysis.threadList.sampleThreads).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "thread-main",
            cwd: "/tmp/pwragent-main",
            gitBranch: "main",
          }),
          expect.objectContaining({
            id: "thread-worktree",
            cwd: "/tmp/pwragent/.worktrees/feature-a",
            gitBranch: "feature/a",
            projectKey: "/tmp/pwragent",
          }),
        ]),
      );
    } finally {
      await fs.rm(captureDir, { force: true, recursive: true });
    }
  });

  it("reports chronological thread message and tool order from thread/read and notifications", async () => {
    const captureDir = await fs.mkdtemp(path.join(os.tmpdir(), "pwragent-protocol-"));
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
