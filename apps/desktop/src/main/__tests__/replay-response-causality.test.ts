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
