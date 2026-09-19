import { describe, expect, it, vi } from "vitest";
import { extractThreadReplayFromReadResult } from "../codex-app-server/client";

// Synthetic protocol snapshots only. Count operations, never elapsed time.
function measureSnapshot(size: number, tools: boolean) {
  let identityReads = 0;
  let detailComparisons = 0;
  const items = Array.from({ length: size }, (_, index) => new Proxy(
    tools
      ? { type: "function_call", id: `call-${index}`, name: "exec_command", arguments: JSON.stringify({ cmd: `echo ${index}` }) }
      : { type: "agentMessage", id: `message-${index}`, text: `message ${index}` },
    { get(target, key, receiver) {
      if (["id", "itemId", "item_id", "call_id", "callId"].includes(String(key))) identityReads += 1;
      return Reflect.get(target, key, receiver);
    } },
  ));
  const outputs = tools ? Array.from({ length: size }, (_, index) => ({
    type: "function_call_output", call_id: `call-${index}`, output: `output ${index}`,
  })) : [];
  const originalFind = Array.prototype.find;
  const spy = vi.spyOn(Array.prototype, "find").mockImplementation(function (this: unknown[], predicate, thisArg) {
    return originalFind.call(this, (value, index, array) => {
      if (value && typeof value === "object" && "label" in value) detailComparisons += 1;
      return predicate.call(thisArg, value, index, array);
    });
  });
  let replay;
  try {
    replay = extractThreadReplayFromReadResult({ thread: {
      id: "synthetic", turns: [{ id: "turn", items: [...items, ...outputs] }],
    } });
  } finally {
    spy.mockRestore();
  }
  return { replay, identityReads, detailComparisons };
}

describe("Codex snapshot normalization scaling", () => {
  it("joins growing messages and entries with linear identity reads", () => {
    const small = measureSnapshot(128, false);
    const large = measureSnapshot(256, false);
    expect(large.replay.messages).toHaveLength(256);
    expect(large.replay.entries).toHaveLength(256);
    expect(large.replay.messages[255]).toMatchObject({ id: "message-255", text: "message 255" });
    expect(large.identityReads).toBeLessThanOrEqual(small.identityReads * 2.2);
  });

  it("joins late function outputs without scanning all pending calls", () => {
    const small = measureSnapshot(128, true);
    const large = measureSnapshot(256, true);
    const activity = large.replay.entries[0];
    expect(activity.type).toBe("activity");
    if (activity.type !== "activity") throw new Error("Missing activity");
    expect(activity.details).toHaveLength(256);
    expect(activity.details?.[0]).toMatchObject({ id: "call-0", command: { output: "output 0" } });
    expect(activity.details?.[255]).toMatchObject({ id: "call-255", command: { output: "output 255" } });
    // Measured after indexing: 897 / 1,793 identity reads (128 / 256 calls).
    expect(large.identityReads).toBeLessThanOrEqual(256 * 8);
    expect(large.identityReads, JSON.stringify({ small: small.identityReads, large: large.identityReads }))
      .toBeLessThanOrEqual(small.identityReads * 2.2);
  });

  it("deduplicates growing activity details without pairwise label comparisons", () => {
    const small = measureSnapshot(128, true);
    const large = measureSnapshot(256, true);
    expect(large.detailComparisons, JSON.stringify({ small: small.detailComparisons, large: large.detailComparisons }))
      .toBeLessThanOrEqual(small.detailComparisons * 2.2 + 256);
  });
});

// The production client installs this handler on its JSON-RPC connection.
// Replace only the connection boundary: no process, agent turn, or profile.
const connection = vi.hoisted(() => ({
  notify: undefined as undefined | ((method: string, params: unknown) => Promise<void>),
}));
vi.mock("@pwrdrvr/agent-transport", async (importOriginal) => ({
  ...await importOriginal<typeof import("@pwrdrvr/agent-transport")>(),
  JsonRpcConnection: class {
    setNotificationHandler(handler: typeof connection.notify) { connection.notify = handler; }
    setRequestHandler() {}
  },
}));

it("normalizes live chunks and late tool progress without revisiting earlier notification payloads", async () => {
  const { CodexAppServerClient } = await import("../codex-app-server/client");
  for (const historySize of [128, 256]) {
    const client = new CodexAppServerClient({ directoryResolver: async () => [] });
    const delivered: Array<{ method: string; params: unknown }> = [];
    const unsubscribe = client.onNotification((notification) => { delivered.push(notification); });
    await connection.notify?.("item/started", {
      threadId: "synthetic", turnId: "turn", item: {
        type: "commandExecution", id: "early-tool", command: "echo synthetic", status: "inProgress",
      },
    });
    let historicalReads = 0;
    for (let index = 0; index < historySize; index += 1) {
      await connection.notify?.("item/completed", new Proxy({
        threadId: "synthetic", turnId: "turn", item: {
          type: "agentMessage", id: `message-${index}`, text: `message ${index}`,
        },
      }, { get(target, key, receiver) {
        historicalReads += 1;
        return Reflect.get(target, key, receiver);
      } }));
    }
    historicalReads = 0;
    delivered.length = 0;
    for (let index = 0; index < 128; index += 1) {
      await connection.notify?.("item/agentMessage/delta", {
        threadId: "synthetic", turnId: "turn", itemId: "answer", delta: "x",
      });
      await connection.notify?.("item/commandExecution/outputDelta", {
        threadId: "synthetic", turnId: "turn", itemId: "early-tool", delta: `${index}\n`,
      });
      await connection.notify?.("item/mcpToolCall/progress", {
        threadId: "synthetic", turnId: "turn", itemId: "early-tool", message: "progress",
      });
    }
    expect(historicalReads).toBe(0);
    expect(delivered).toHaveLength(384);
    expect(delivered[0]).toMatchObject({ method: "item/agentMessage/delta", params: { itemId: "answer", delta: "x" } });
    expect(delivered[382]).toMatchObject({ method: "item/commandExecution/outputDelta", params: { itemId: "early-tool", delta: "127\n" } });
    expect(delivered[383]).toMatchObject({ method: "item/mcpToolCall/progress", params: { itemId: "early-tool", message: "progress" } });
    unsubscribe();
  }
});

it("retains newest alias matches, output replacement, group boundaries, and first-label status semantics", () => {
  const call = (id: string, cmd: string, extra = {}) => ({
    type: "function_call", id, name: "exec_command", arguments: JSON.stringify({ cmd }), ...extra,
  });
  const output = (callId: string, text: string) => ({ type: "function_call_output", call_id: callId, output: text });
  const replay = extractThreadReplayFromReadResult({ thread: { turns: [{ id: "turn", items: [
    call("old", "echo old", { call_id: "alias" }),
    call("new", "echo new", { item_id: "alias" }),
    output("alias", "first"), output("alias", "replacement"),
    call("duplicate-label", "echo new", { status: "failed" }),
    call("completed-duplicate", "echo new", { status: "completed" }),
    { type: "agentMessage", id: "boundary", text: "boundary" },
    output("alias", "must not cross boundary"),
    call("later", "echo later"), output("later", "later output"),
  ] }] } });
  const first = replay.entries[0];
  const last = replay.entries[2];
  expect(first.type).toBe("activity");
  expect(last.type).toBe("activity");
  if (first.type !== "activity" || last.type !== "activity") throw new Error("Missing activities");
  expect(first.details).toHaveLength(2);
  expect(first.details[0].command?.output).toBeUndefined();
  expect(first.details[1]).toMatchObject({ id: "new", status: "failed", command: { output: "replacement" } });
  expect(last.details[0]).toMatchObject({ id: "later", command: { output: "later output" } });
});
