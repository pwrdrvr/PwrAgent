import { expect, it } from "vitest";
import { ReplayController } from "../testing/replay-controller";

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
