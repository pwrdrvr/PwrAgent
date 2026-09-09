import { describe, expect, it } from "vitest";
import type { AppNoticeToastNotice } from "../AppNoticeToast";
import { resolveBackendErrorNotice } from "../backend-error-notice";

describe("resolveBackendErrorNotice", () => {
  const invalidIdFailure =
    "[ApiIdParam] [input[169].id] [invalid_id_prefix] "
    + "Invalid 'input[169].id': 'review_rollout_user'. "
    + "Expected an ID that begins with 'msg'.";

  it("tracks a known Codex repair from progress through auto-dismissing success", () => {
    const repairing = resolveBackendErrorNotice(
      {
        kind: "codex-invalid-id-recovery",
        failureMessage: invalidIdFailure,
        status: "repairing",
        threadId: "thread-1",
        threadLabel: "Fix the flaky test",
        turnId: "turn-9",
      },
      undefined,
    );
    expect(repairing).toEqual({
      autoDismiss: false,
      copyText: invalidIdFailure,
      detail: "Fix the flaky test",
      id: "codex-invalid-id-recovery:codex:thread-1:turn-9",
      message: invalidIdFailure,
      status: {
        label:
          "PwrAgent is repairing the saved thread history and will retry your message.",
        state: "progress",
      },
      title: "Known Codex issue",
      tone: "warning",
    });

    const succeeded = resolveBackendErrorNotice(
      {
        kind: "codex-invalid-id-recovery",
        failureMessage: invalidIdFailure,
        status: "succeeded",
        threadId: "thread-1",
        threadLabel: "Fix the flaky test",
        turnId: "turn-9",
      },
      repairing,
    );
    expect(succeeded).toMatchObject({
      autoDismiss: true,
      copyText: invalidIdFailure,
      id: repairing?.id,
      status: {
        label: "Saved history repaired. Your message was retried.",
        state: "success",
      },
      title: "Codex thread repaired",
      tone: "success",
    });
  });

  it("keeps a failed Codex repair sticky with both errors visible or copyable", () => {
    const notice = resolveBackendErrorNotice(
      {
        kind: "codex-invalid-id-recovery",
        failureMessage: invalidIdFailure,
        recoveryError: "rollout path did not belong to the requested thread",
        status: "failed",
        threadId: "thread-1",
        threadLabel: "Fix the flaky test",
        turnId: "turn-9",
      },
      undefined,
    );
    expect(notice).toMatchObject({
      autoDismiss: false,
      copyText: invalidIdFailure,
      message: invalidIdFailure,
      status: {
        label:
          "Automatic repair failed: rollout path did not belong to the requested thread",
        state: "error",
      },
      title: "Codex repair failed",
      tone: "error",
    });
  });

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

  it("does NOT downgrade a same-thread Codex recovery with a generic system error", () => {
    const current = resolveBackendErrorNotice(
      {
        kind: "codex-invalid-id-recovery",
        failureMessage: invalidIdFailure,
        status: "repairing",
        threadId: "thread-1",
        threadLabel: "Codex thread",
        turnId: "turn-9",
      },
      undefined,
    );
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
