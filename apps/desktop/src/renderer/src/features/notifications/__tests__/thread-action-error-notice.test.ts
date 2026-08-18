import { describe, expect, it } from "vitest";
import { appNoticeReducer, INITIAL_APP_NOTICE_STATE } from "../app-notice-state";
import {
  resolveThreadActionErrorNotice,
  threadActionErrorNoticeId,
} from "../thread-action-error-notice";

describe("resolveThreadActionErrorNotice", () => {
  it("builds a sticky, copyable notice carrying the backend's message", () => {
    const notice = resolveThreadActionErrorNotice({
      kind: "create-thread",
      message: "Desktop backend registry is closed",
    });

    expect(notice).toMatchObject({
      // The failure the sidebar used to pin forever with no way to dismiss
      // it. Sticky is still right — a create failure the operator never saw
      // is worse — but it is now dismissible and copyable.
      autoDismiss: false,
      copyText: "Desktop backend registry is closed",
      id: "thread-action-error:create-thread",
      message: "Desktop backend registry is closed",
      title: "Could not start thread",
      tone: "error",
    });
  });

  it("titles each action distinctly so a toast says what failed", () => {
    const titles = (
      ["archive-thread", "create-thread", "rename-thread"] as const
    ).map((kind) =>
      resolveThreadActionErrorNotice({ kind, message: "boom" }).title
    );

    expect(titles).toEqual([
      "Archive failed",
      "Could not start thread",
      "Rename failed",
    ]);
  });

  it("keys each action separately so one failure cannot mask another", () => {
    // The sidebar slot this replaced rendered five errors through one `? :`
    // chain, so a stale create error hid a fresh rename error entirely.
    let state = INITIAL_APP_NOTICE_STATE;
    for (const kind of ["create-thread", "rename-thread"] as const) {
      state = appNoticeReducer(state, {
        type: "show",
        notice: resolveThreadActionErrorNotice({ kind, message: `${kind} broke` }),
      });
    }

    expect(state.durable.map((notice) => notice.id)).toEqual([
      "thread-action-error:create-thread",
      "thread-action-error:rename-thread",
    ]);
    expect(state.durable.map((notice) => notice.message)).toEqual([
      "create-thread broke",
      "rename-thread broke",
    ]);
  });

  it("replaces rather than stacks when the same action fails twice", () => {
    // The hook holds one slot per action, so a second failure supersedes the
    // first. Two toasts for one slot would leave the stale one unclearable.
    const first = appNoticeReducer(INITIAL_APP_NOTICE_STATE, {
      type: "show",
      notice: resolveThreadActionErrorNotice({
        kind: "archive-thread",
        message: "first failure",
      }),
    });
    const second = appNoticeReducer(first, {
      type: "show",
      notice: resolveThreadActionErrorNotice({
        kind: "archive-thread",
        message: "second failure",
      }),
    });

    expect(second.durable).toHaveLength(1);
    expect(second.durable[0]?.message).toBe("second failure");
  });

  it("clears through the id the producer publishes when the slot empties", () => {
    const shown = appNoticeReducer(INITIAL_APP_NOTICE_STATE, {
      type: "show",
      notice: resolveThreadActionErrorNotice({
        kind: "rename-thread",
        message: "rename failed",
      }),
    });
    const cleared = appNoticeReducer(shown, {
      type: "dismiss",
      id: threadActionErrorNoticeId("rename-thread"),
    });

    expect(shown.durable).toHaveLength(1);
    expect(cleared.durable).toEqual([]);
  });
});
