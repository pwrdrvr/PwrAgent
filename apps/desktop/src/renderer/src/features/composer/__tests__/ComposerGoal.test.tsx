import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import type { ThreadGoalState } from "@pwragent/shared/contracts/thread-goal";
import type { DesktopApi } from "../../../lib/desktop-api";
import { useComposerGoal } from "../ComposerGoal";

it.each([false, true])("only releases the completed thread's pending request (concurrent: %s)", async (concurrent) => {
  const a = Promise.withResolvers<ThreadGoalState>();
  const b = Promise.withResolvers<ThreadGoalState>();
  const empty = { supported: true, goal: null };
  const api: DesktopApi = {
    readThreadGoal: async () => empty,
    setThreadGoal: (threadId) => threadId === "a" ? a.promise : b.promise,
  };
  const hook = renderHook(({ threadId }) => useComposerGoal(api, threadId), { initialProps: { threadId: "a" } });
  const set = () => { void hook.result.current.run({ action: "set", objective: "Check the billing export" }, () => undefined); };
  await act(async () => set());
  expect(hook.result.current.busy).toBe("set");
  await act(async () => hook.rerender({ threadId: "b" }));
  if (concurrent) await act(async () => set());
  await act(async () => a.resolve(empty));
  expect(hook.result.current.busy).toBe(concurrent ? "set" : undefined);
  await act(async () => hook.rerender({ threadId: "a" }));
  expect(hook.result.current.busy).toBeUndefined();
  await act(async () => hook.rerender({ threadId: "b" }));
  await act(async () => b.resolve(empty));
  expect(hook.result.current.busy).toBeUndefined();
});
