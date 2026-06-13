import { describe, expect, it } from "vitest";
import type { AppNoticeToastNotice } from "../AppNoticeToast";
import { resolveBackendErrorNotice } from "../backend-error-notice";

describe("resolveBackendErrorNotice", () => {
  it("builds a sticky, thread-scoped, copyable notice for a failed turn", () => {
    const notice = resolveBackendErrorNotice(
      {
        kind: "turn-failed",
        backend: "codex",
        threadId: "thread-1",
        turnId: "turn-9",
        errorMessage: "stream disconnected before completion",
        threadLabel: "Fix the flaky test",
      },
      undefined,
    );
    expect(notice).toEqual({
      autoDismiss: false,
      id: "turn-failed:codex:thread-1:turn-9",
      title: "Turn failed",
      message: "stream disconnected before completion",
      detail: "Fix the flaky test",
      copyText: "stream disconnected before completion",
    });
  });

  it("builds a generic system-error notice when nothing is showing", () => {
    const notice = resolveBackendErrorNotice(
      {
        kind: "system-error",
        backend: "codex",
        threadId: "thread-1",
        threadLabel: "Codex thread",
      },
      undefined,
    );
    expect(notice).toMatchObject({
      autoDismiss: false,
      id: "system-error:codex:thread-1",
      title: "Agent backend error",
      detail: "Codex thread",
    });
  });

  it("does NOT downgrade a same-thread turn/failed notice with the generic message", () => {
    const current: AppNoticeToastNotice = {
      autoDismiss: false,
      id: "turn-failed:codex:thread-1:turn-9",
      title: "Turn failed",
      message: "the real error",
    };
    const next = resolveBackendErrorNotice(
      {
        kind: "system-error",
        backend: "codex",
        threadId: "thread-1",
        threadLabel: "Codex thread",
      },
      current,
    );
    expect(next).toBe(current);
  });

  it("does NOT suppress a different thread's system error behind an old toast", () => {
    // The regression this fixes: a stale turn-failed toast from thread A
    // must not swallow a fresh systemError from thread B.
    const current: AppNoticeToastNotice = {
      autoDismiss: false,
      id: "turn-failed:codex:thread-A:turn-1",
      title: "Turn failed",
      message: "thread A error",
    };
    const next = resolveBackendErrorNotice(
      {
        kind: "system-error",
        backend: "codex",
        threadId: "thread-B",
        threadLabel: "Thread B",
      },
      current,
    );
    expect(next).not.toBe(current);
    expect(next?.id).toBe("system-error:codex:thread-B");
  });

  it("treats the same turnId on different threads as distinct notices", () => {
    const a = resolveBackendErrorNotice(
      {
        kind: "turn-failed",
        backend: "codex",
        threadId: "thread-A",
        turnId: "turn-1",
        errorMessage: "e",
        threadLabel: "A",
      },
      undefined,
    );
    const b = resolveBackendErrorNotice(
      {
        kind: "turn-failed",
        backend: "codex",
        threadId: "thread-B",
        turnId: "turn-1",
        errorMessage: "e",
        threadLabel: "B",
      },
      undefined,
    );
    expect(a?.id).not.toBe(b?.id);
  });
});
