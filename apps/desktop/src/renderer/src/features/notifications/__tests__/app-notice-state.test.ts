import { describe, expect, it } from "vitest";
import {
  appNoticeReducer,
  INITIAL_APP_NOTICE_STATE,
  type AppNoticeState,
} from "../app-notice-state";
import type { AppNoticeToastNotice } from "../AppNoticeToast";

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

  it("retires same-incident failure notices when recovery starts", () => {
    let state: AppNoticeState = {
      durable: [
        {
          autoDismiss: false,
          id: "turn-failed:codex:thread-a:turn-1",
          message: "invalid message id",
          title: "Turn failed",
        },
        {
          autoDismiss: false,
          id: "system-error:codex:thread-a",
          message: "The active turn may have stopped.",
          title: "Agent backend error",
        },
        {
          autoDismiss: false,
          id: "turn-failed:codex:thread-a:turn-older",
          message: "unrelated earlier failure",
          title: "Turn failed",
        },
        {
          autoDismiss: false,
          id: "turn-failed:codex:thread-b:turn-1",
          message: "unrelated thread failure",
          title: "Turn failed",
        },
      ],
      transient: [],
    };

    state = appNoticeReducer(state, {
      type: "backend-error",
      signal: {
        kind: "codex-invalid-id-recovery",
        failureMessage: "invalid message id",
        status: "repairing",
        threadId: "thread-a",
        threadLabel: "Repair PR",
        turnId: "turn-1",
      },
    });

    expect(state.durable.map((notice) => notice.id)).toEqual([
      "turn-failed:codex:thread-a:turn-older",
      "turn-failed:codex:thread-b:turn-1",
      "codex-invalid-id-recovery:codex:thread-a:turn-1",
    ]);
  });

  it("leaves only auto-dismissing success after repairing a failed turn", () => {
    let state = appNoticeReducer(INITIAL_APP_NOTICE_STATE, {
      type: "backend-error",
      signal: {
        kind: "turn-failed",
        backend: "codex",
        threadId: "thread-a",
        turnId: "turn-1",
        errorMessage: "invalid message id",
        threadLabel: "Repair PR",
      },
    });
    const recoverySignal = {
      kind: "codex-invalid-id-recovery" as const,
      failureMessage: "invalid message id",
      threadId: "thread-a",
      threadLabel: "Repair PR",
      turnId: "turn-1",
    };
    state = appNoticeReducer(state, {
      type: "backend-error",
      signal: { ...recoverySignal, status: "repairing" },
    });
    state = appNoticeReducer(state, {
      type: "backend-error",
      signal: { ...recoverySignal, status: "succeeded" },
    });

    expect(state.durable).toEqual([]);
    expect(state.transient).toEqual([
      expect.objectContaining({
        autoDismiss: true,
        id: "codex-invalid-id-recovery:codex:thread-a:turn-1",
        title: "Codex thread repaired",
      }),
    ]);
  });

  it("leaves one durable repair failure instead of the superseded turn failure", () => {
    let state = appNoticeReducer(INITIAL_APP_NOTICE_STATE, {
      type: "backend-error",
      signal: {
        kind: "turn-failed",
        backend: "codex",
        threadId: "thread-a",
        turnId: "turn-1",
        errorMessage: "invalid message id",
        threadLabel: "Repair PR",
      },
    });
    state = appNoticeReducer(state, {
      type: "backend-error",
      signal: {
        kind: "codex-invalid-id-recovery",
        failureMessage: "invalid message id",
        recoveryError: "repair target did not match",
        status: "failed",
        threadId: "thread-a",
        threadLabel: "Repair PR",
        turnId: "turn-1",
      },
    });

    expect(state.durable).toEqual([
      expect.objectContaining({
        autoDismiss: false,
        id: "codex-invalid-id-recovery:codex:thread-a:turn-1",
        title: "Codex repair failed",
      }),
    ]);
  });

  it("replaces transient notices from the same producer slot", () => {
    let state = appNoticeReducer(INITIAL_APP_NOTICE_STATE, {
      type: "show",
      notice: {
        id: "composer-notice-1",
        title: "First warning",
        message: "First",
        transientSlot: "composer",
      },
    });
    state = appNoticeReducer(state, {
      type: "show",
      notice: {
        id: "repair-succeeded",
        title: "Repair complete",
        message: "Repaired",
      },
    });
    state = appNoticeReducer(state, {
      type: "show",
      notice: {
        id: "composer-notice-2",
        title: "Second warning",
        message: "Second",
        transientSlot: "composer",
      },
    });

    expect(state.transient.map((notice) => notice.id)).toEqual([
      "composer-notice-2",
      "repair-succeeded",
    ]);
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

  it("keeps only the highest-priority cost notice for each thread", () => {
    let state = appNoticeReducer(INITIAL_APP_NOTICE_STATE, {
      type: "show",
      notice: costNotice({
        id: "tool-accounting:codex:thread-a",
        priority: 0,
        threadKey: "local:codex:thread-a",
        title: "Tool output hit the cap",
      }),
    });
    state = appNoticeReducer(state, {
      type: "show",
      notice: costNotice({
        id: "spend-alert:active-turn:codex:thread-a:turn-1:5000000",
        priority: 1,
        threadKey: "local:codex:thread-a",
        title: "Active turn spend threshold reached",
      }),
    });
    state = appNoticeReducer(state, {
      type: "show",
      notice: costNotice({
        id: "spend-alert:thread:codex:thread-a:25000000",
        priority: 2,
        threadKey: "local:codex:thread-a",
        title: "Thread spend threshold reached",
      }),
    });

    expect(state.durable).toEqual([
      expect.objectContaining({
        id: "spend-alert:thread:codex:thread-a:25000000",
      }),
    ]);
  });

  it("does not let a late lower-priority event replace a worse cost notice", () => {
    let state = appNoticeReducer(INITIAL_APP_NOTICE_STATE, {
      type: "show",
      notice: costNotice({
        id: "spend-alert:thread:codex:thread-a:25000000",
        priority: 2,
        threadKey: "remote-a:codex:thread-a",
        title: "Thread spend threshold reached",
      }),
    });
    state = appNoticeReducer(state, {
      type: "show",
      notice: costNotice({
        id: "tool-accounting:codex:thread-a",
        priority: 0,
        threadKey: "remote-a:codex:thread-a",
        title: "Tool output hit the cap",
      }),
    });

    expect(state.durable.map((notice) => notice.title)).toEqual([
      "Thread spend threshold reached",
    ]);
  });

  it("replaces an earlier active-turn cost notice from the same thread", () => {
    let state = appNoticeReducer(INITIAL_APP_NOTICE_STATE, {
      type: "show",
      notice: costNotice({
        id: "spend-alert:active-turn:codex:thread-a:turn-1:5000000",
        priority: 1,
        threadKey: "remote-a:codex:thread-a",
        title: "First active turn",
      }),
    });
    state = appNoticeReducer(state, {
      type: "show",
      notice: costNotice({
        id: "spend-alert:active-turn:codex:thread-a:turn-2:5000000",
        priority: 1,
        threadKey: "remote-a:codex:thread-a",
        title: "Second active turn",
      }),
    });

    expect(state.durable.map((notice) => notice.title)).toEqual([
      "Second active turn",
    ]);
  });

  it("coalesces a remote viewer per owning instance without merging peers", () => {
    let state = appNoticeReducer(INITIAL_APP_NOTICE_STATE, {
      type: "show",
      notice: costNotice({
        id: "tool-accounting:codex:thread-a",
        priority: 0,
        threadKey: "remote-a:codex:thread-a",
        title: "Remote A tool output",
      }),
    });
    state = appNoticeReducer(state, {
      type: "show",
      notice: costNotice({
        id: "spend-alert:active-turn:codex:thread-a:turn-1:5000000",
        priority: 1,
        threadKey: "remote-a:codex:thread-a",
        title: "Remote A turn spend",
      }),
    });
    state = appNoticeReducer(state, {
      type: "show",
      notice: costNotice({
        id: "tool-accounting:codex:thread-a",
        priority: 0,
        threadKey: "remote-b:codex:thread-a",
        title: "Remote B tool output",
      }),
    });

    expect(state.durable.map((notice) => notice.title)).toEqual([
      "Remote A turn spend",
      "Remote B tool output",
    ]);
  });
});

function costNotice(params: {
  id: string;
  priority: number;
  threadKey: string;
  title: string;
}): AppNoticeToastNotice {
  return {
    autoDismiss: false,
    coalescing: {
      key: `thread-cost:${params.threadKey}`,
      priority: params.priority,
    },
    dismissGroup: {
      key: "thread-cost",
      label: "cost notices",
    },
    id: params.id,
    message: params.title,
    title: params.title,
  } as AppNoticeToastNotice;
}
