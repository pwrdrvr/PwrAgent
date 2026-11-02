import { expect, it } from "vitest";
import { ReplayController } from "../testing/replay-controller";
import {
  validateReplayFixture,
  type ReplayFixture,
  type ReplayResponseStep,
  type ReplayStep,
} from "../testing/replay-fixture";

it("tracks concurrent requests separately and waits for every answer before progressing", () => {
  const controller = new ReplayController({ metadata: { backend: "codex", scenario: "concurrent-input" }, steps: [
    ...["57", "58"].map((requestId) => ({
      id: requestId, kind: "request" as const, request: {
        method: "mcpServer/elicitation/request" as const, params: {
          threadId: "thread-1", turnId: "turn-1", requestId,
          serverName: "codex_apps", mode: "url" as const, message: "Reconnect GitHub",
          url: "https://chatgpt.com/connector", elicitationId: requestId,
        },
      },
    })),
    { id: "idle", kind: "notification", notification: {
      method: "thread/status/changed", params: { threadId: "thread-1", status: { type: "idle" } },
    } },
  ] });
  controller.advance({ stepId: "57" });
  controller.advance({ stepId: "58" });
  expect(controller.getPendingRequest()?.request.params.requestId).toBe("58");
  controller.resolvePendingRequest("58");
  expect(controller.getPendingRequest()?.request.params.requestId).toBe("57");
  expect(() => controller.advance({ stepId: "idle" })).toThrow("Replay is waiting for request 57");
  controller.resolvePendingRequest("57");
  expect(controller.getPendingRequest()).toBeUndefined();
  expect(controller.advance({ stepId: "idle" }).id).toBe("idle");
});

it("does not expose a created thread when independent startup reads repeat", () => {
  const controller = new ReplayController({ metadata: { backend: "codex", scenario: "causal-list" }, steps: [
    { id: "before", kind: "response", method: "thread/list", result: [] },
    { id: "start", kind: "response", method: "thread/start", result: { threadId: "new" } },
    { id: "after", kind: "response", method: "thread/list", afterResponseId: "start", result: [{ id: "new" }] },
  ] });
  for (let i = 0; i < 20; i += 1) expect(controller.consumeResponse("thread/list").result).toEqual([]);
  controller.consumeResponse("thread/start");
  expect(controller.consumeResponse("thread/list").result).toEqual([{ id: "new" }]);
  expect(controller.consumeResponse("thread/list").result).toEqual([{ id: "new" }]);
});

it("rejects a fixture whose causal response does not exist", () => {
  expect(() => new ReplayController({ metadata: { backend: "codex", scenario: "invalid-causality" }, steps: [
    { id: "after", kind: "response", method: "thread/list", afterResponseId: "missing", result: [] },
  ] })).toThrow("unknown causal response");
});

it("serves the archived listing after archive however many active reads came first", () => {
  const controller = new ReplayController({ metadata: { backend: "codex", scenario: "archived-list" }, steps: [
    { id: "active", kind: "response", method: "thread/list", result: [{ id: "t" }] },
    { id: "archive", kind: "response", method: "thread/archive", result: { threadId: "t" } },
    { id: "active-after", kind: "response", method: "thread/list", afterResponseId: "archive", result: [] },
    { id: "archived-after", kind: "response", method: "thread/list", afterResponseId: "archive", archived: true, result: [{ id: "t" }] },
  ] });
  expect(controller.tryConsumeResponse("thread/list", { archived: true })).toBeUndefined();
  for (let i = 0; i < 20; i += 1) expect(controller.consumeResponse("thread/list").result).toEqual([{ id: "t" }]);
  controller.consumeResponse("thread/archive");
  for (let i = 0; i < 3; i += 1) expect(controller.consumeResponse("thread/list").result).toEqual([]);
  expect(controller.tryConsumeResponse("thread/list", { archived: true })?.result).toEqual([{ id: "t" }]);
  expect(controller.tryConsumeResponse("thread/list", { archived: true })?.result).toEqual([{ id: "t" }]);
});

it("rejects an archived flag on a response other than thread/list", () => {
  expect(() => new ReplayController({ metadata: { backend: "codex", scenario: "invalid-archived" }, steps: [
    { id: "read", kind: "response", method: "thread/read", archived: true, result: {} },
  ] })).toThrow("only thread/list answers");
});

const fixture = (steps: ReplayStep[]): ReplayFixture => ({ metadata: { backend: "codex", scenario: "guard" }, steps });
const list = (id: string, result: unknown[], extra: Partial<ReplayResponseStep> = {}): ReplayResponseStep => (
  { id, kind: "response", method: "thread/list", result, ...extra }
);
const read = (id: string, text: string, extra: Partial<ReplayResponseStep> = {}): ReplayResponseStep => (
  { id, kind: "response", method: "thread/read", result: { entries: [{ id: text }] }, ...extra }
);
const start: ReplayResponseStep = { id: "start", kind: "response", method: "thread/start", result: { threadId: "new" } };
const idle: ReplayStep = { id: "idle", kind: "notification", notification: {
  method: "thread/status/changed", params: { threadId: "t", status: { type: "idle" } },
} };

it("rejects a later listing that a startup refresh could take before its cause", () => {
  expect(() => validateReplayFixture(fixture([list("before", []), start, list("after", [{ id: "new" }])])))
    .toThrow("Replay response after is a second thread/list answer after before in one response block;"
      + " set afterResponseId to the response that changes it");
  expect(() => new ReplayController(fixture([list("active", []), list("archived", [{ id: "t" }], { archived: true }),
    list("archived-later", [], { archived: true })]))).toThrow("second thread/list#archived answer after archived");
  expect(() => validateReplayFixture(fixture([
    list("before", []), start, list("after", [{ id: "new" }], { afterResponseId: "start" }),
    list("after-again", [{ id: "new" }, { id: "other" }]),
  ]))).toThrow("after-again is a second thread/list answer after after");
});

it("accepts repeated answers that cannot change what the app sees", () => {
  expect(() => validateReplayFixture(fixture([
    { id: "initialize-1", kind: "response", method: "initialize", result: { methods: [] } },
    { id: "initialize-2", kind: "response", method: "initialize", result: { methods: [] } },
    list("same-1", [{ id: "t" }]),
    list("same-2", [{ id: "t" }]),
    { id: "turn-1", kind: "response", method: "turn/start", result: { turnId: "1" } },
    { id: "turn-2", kind: "response", method: "turn/start", result: { turnId: "2" } },
  ]))).not.toThrow();
  // A live step separates blocks: the later listing cannot be served before it.
  expect(() => validateReplayFixture(fixture([list("before", []), idle, list("after", [{ id: "t" }])]))).not.toThrow();
});

it("accepts a later answer that waits for the earlier answer to the same call", () => {
  // The next lookup after that one, as thread-title-generation.spec.ts scripts.
  const controller = new ReplayController(fixture([
    list("current", [{ id: "t" }]),
    list("latest", [], { afterResponseId: "current" }),
  ]));
  expect(controller.consumeResponse("thread/list").id).toBe("current");
  expect(controller.consumeResponse("thread/list").id).toBe("latest");
});

it("answers each thread's reads from its own responses, in any order", () => {
  const controller = new ReplayController(fixture([
    read("read-a", "a", { threadId: "thread-a" }),
    read("read-b", "b", { threadId: "thread-b" }),
  ]));
  expect(controller.consumeResponse("thread/read", { threadId: "thread-b" }).id).toBe("read-b");
  for (let i = 0; i < 3; i += 1) expect(controller.consumeResponse("thread/read", { threadId: "thread-b" }).id).toBe("read-b");
  expect(controller.consumeResponse("thread/read", { threadId: "thread-a" }).id).toBe("read-a");
  expect(controller.consumeResponse("thread/read", { threadId: "thread-b" }).id).toBe("read-b");
  // A thread the fixture never scripts keeps the last read, as before.
  expect(controller.consumeResponse("thread/read", { threadId: "thread-c" }).id).toBe("read-a");
});

it("requires reads of different threads to name their thread", () => {
  expect(() => validateReplayFixture(fixture([read("read-a", "a"), read("read-b", "b")])))
    .toThrow("set afterResponseId to the response that changes it,"
      + " or threadId or before when it reads another thread or page");
  expect(() => validateReplayFixture(fixture([read("read-a", "a", { threadId: "thread-a" }), read("read-b", "b")])))
    .toThrow("Replay response read-b and read-a share a response block; set threadId on every thread/read in it or on none");
  expect(() => validateReplayFixture(fixture([
    read("read-a", "a", { threadId: "thread-a" }),
    read("read-a-later", "a2", { threadId: "thread-a" }),
  ]))).toThrow("read-a-later is a second thread/read@thread-a answer after read-a");
  expect(() => validateReplayFixture(fixture([list("list", [], { threadId: "thread-a" })])))
    .toThrow("Replay response list sets threadId, which only thread/read answers");
});

it("answers an older page only for its cursor and keeps the newest page for refreshes", () => {
  const controller = new ReplayController(fixture([
    read("newest", "new", { threadId: "t" }),
    read("older", "old", { threadId: "t", before: "cursor-1" }),
  ]));
  expect(controller.consumeResponse("thread/read", { threadId: "t" }).id).toBe("newest");
  expect(controller.consumeResponse("thread/read", { threadId: "t", before: "cursor-1" }).id).toBe("older");
  expect(controller.consumeResponse("thread/read", { threadId: "t" }).id).toBe("newest");
  expect(controller.consumeResponse("thread/read", { threadId: "t", before: "cursor-1" }).id).toBe("older");
  expect(() => validateReplayFixture(fixture([list("list", [], { before: "cursor-1" })])))
    .toThrow("Replay response list sets before, which only thread/read answers");
});
