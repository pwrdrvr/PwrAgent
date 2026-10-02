import { act, cleanup, render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTurnFailureDismissed } from "../LinkedTurnFailureMessage";
import {
  createTurnFailureAcknowledgements,
  turnFailureAcknowledgements,
  turnFailureNoticeId,
  turnFailureScopeKey,
} from "../turn-failure-acknowledgements";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("turn failure acknowledgements", () => {
  it("matches owner, backend, thread and message, and dismisses an incident once", () => {
    const store = createTurnFailureAcknowledgements();
    const scope = turnFailureScopeKey("codex", "thread-a");
    const remote = turnFailureScopeKey("codex", "thread-a", "peer-a");
    const other = turnFailureScopeKey("acp:claude", "thread-a");
    const dismissed = vi.fn();
    const localChanged = vi.fn();
    store.subscribeDismissals(dismissed);
    store.subscribe(scope, localChanged);
    store.report(scope, "local-turn", "Capacity");
    store.report(remote, "remote-turn", "Capacity");
    store.report(other, "other-turn", "Capacity");
    store.dismissMatching(scope, "Different error");
    expect(dismissed).not.toHaveBeenCalled();
    store.dismissMatching(scope, "Capacity");
    store.dismiss("local-turn");
    expect(dismissed).toHaveBeenCalledExactlyOnceWith("local-turn");
    expect(localChanged).toHaveBeenCalledTimes(2);
    expect(store.isDismissed(remote, "Capacity")).toBe(false);
    expect(store.isDismissed(other, "Capacity")).toBe(false);
    store.report(scope, "local-turn", "Capacity");
    expect(store.isDismissed(scope, "Capacity")).toBe(true);
    store.report(scope, "different-turn", "Different failure");
    expect(store.isDismissed(scope, "Capacity")).toBe(true);
    store.report(scope, "next-turn", "Capacity");
    expect(store.isDismissed(scope, "Capacity")).toBe(false);
    store.dismiss("local-turn");
    expect(store.isDismissed(scope, "Capacity")).toBe(false);
  });

  it("keeps notices from different instances distinct", () => {
    const identity = { backend: "codex" as const, threadId: "thread-a", turnId: "turn-a" };
    expect(turnFailureNoticeId(identity)).toBe("turn-failed:codex:thread-a:turn-a");
    expect(turnFailureNoticeId({ ...identity, instanceId: "peer-a" })).not.toBe(
      turnFailureNoticeId({ ...identity, instanceId: "peer-b" }),
    );
  });

  it("keeps subscriptions stable and repaints only when the row's boolean changes", () => {
    const scope = turnFailureScopeKey("codex", "render-budget-thread");
    const unrelated = turnFailureScopeKey("codex", "other-render-budget-thread");
    turnFailureAcknowledgements.report(scope, "render-turn", "Capacity");
    const subscribe = vi.spyOn(turnFailureAcknowledgements, "subscribe");
    const painted = vi.fn();
    function Probe() {
      painted(useTurnFailureDismissed(scope, "Capacity"));
      return null;
    }
    const { rerender, unmount } = render(<StrictMode><Probe /></StrictMode>);
    const subscriptions = subscribe.mock.calls.length;
    rerender(<StrictMode><Probe /></StrictMode>);
    expect(subscribe).toHaveBeenCalledTimes(subscriptions);
    const before = painted.mock.calls.length;
    act(() => turnFailureAcknowledgements.dismissMatching(scope, "Capacity"));
    expect(painted.mock.calls.length - before).toBeLessThanOrEqual(2);
    expect(painted).toHaveBeenLastCalledWith(true);
    const settled = painted.mock.calls.length;
    act(() => {
      for (let index = 0; index < 100; index += 1) {
        turnFailureAcknowledgements.dismissMatching(scope, "Capacity");
        turnFailureAcknowledgements.report(unrelated, `unrelated-${index}`, "Other error");
      }
    });
    expect(painted).toHaveBeenCalledTimes(settled);
    expect(subscribe).toHaveBeenCalledTimes(subscriptions);
    unmount();
    act(() => turnFailureAcknowledgements.report(scope, "next-render-turn", "Capacity"));
    expect(painted).toHaveBeenCalledTimes(settled);
  });
});
