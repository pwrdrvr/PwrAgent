import { describe, expect, it } from "vitest";
import {
  appNoticeReducer,
  INITIAL_APP_NOTICE_STATE,
  type AppNoticeState,
} from "../app-notice-state";

describe("appNoticeReducer", () => {
  it("keeps failed turns in arrival order instead of overwriting them", () => {
    let state: AppNoticeState = INITIAL_APP_NOTICE_STATE;
    state = appNoticeReducer(state, {
      type: "backend-error",
      signal: {
        kind: "turn-failed",
        backend: "codex",
        threadId: "thread-a",
        turnId: "turn-1",
        errorMessage: "The token budget was exhausted.",
        threadLabel: "Repair PR 1",
      },
    });
    state = appNoticeReducer(state, {
      type: "backend-error",
      signal: {
        kind: "turn-failed",
        backend: "codex",
        threadId: "thread-b",
        turnId: "turn-2",
        errorMessage: "The context window was exceeded.",
        threadLabel: "Repair PR 2",
      },
    });

    expect(state.durable.map((notice) => notice.id)).toEqual([
      "turn-failed:codex:thread-a:turn-1",
      "turn-failed:codex:thread-b:turn-2",
    ]);
    expect(state.durable[0]?.message).toBe("The token budget was exhausted.");
  });

  it("does not add a generic system error behind a richer same-thread failure", () => {
    let state = appNoticeReducer(INITIAL_APP_NOTICE_STATE, {
      type: "backend-error",
      signal: {
        kind: "turn-failed",
        backend: "codex",
        threadId: "thread-a",
        turnId: "turn-1",
        errorMessage: "provider error",
        threadLabel: "Repair PR",
      },
    });
    state = appNoticeReducer(state, {
      type: "backend-error",
      signal: {
        kind: "system-error",
        backend: "codex",
        threadId: "thread-a",
        threadLabel: "Repair PR",
      },
    });

    expect(state.durable).toHaveLength(1);
    expect(state.durable[0]?.message).toBe("provider error");
  });

  it("updates a notice in place and moves repaired success to transient", () => {
    const repairingSignal = {
      kind: "codex-invalid-id-recovery" as const,
      status: "repairing" as const,
      threadId: "thread-a",
      turnId: "turn-1",
      failureMessage: "invalid message id",
      threadLabel: "Repair PR",
    };
    let state = appNoticeReducer(INITIAL_APP_NOTICE_STATE, {
      type: "backend-error",
      signal: repairingSignal,
    });
    state = appNoticeReducer(state, {
      type: "backend-error",
      signal: { ...repairingSignal, status: "succeeded" },
    });

    expect(state.durable).toEqual([]);
    expect(state.transient).toHaveLength(1);
    expect(state.transient[0]).toMatchObject({
      id: "codex-invalid-id-recovery:codex:thread-a:turn-1",
      title: "Codex thread repaired",
      autoDismiss: true,
    });
  });

  it("dismisses one durable notice without disturbing the rest", () => {
    let state: AppNoticeState = {
      durable: [
        { id: "first", title: "First", message: "One", autoDismiss: false },
        { id: "second", title: "Second", message: "Two", autoDismiss: false },
      ],
      transient: [],
    };
    state = appNoticeReducer(state, { type: "dismiss", id: "first" });

    expect(state.durable.map((notice) => notice.id)).toEqual(["second"]);
  });
});
