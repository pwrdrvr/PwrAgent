import { describe, expect, it } from "vitest";
import { resolveCodexStreamNotice } from "../codex-stream-notice";

describe("Codex stream notices", () => {
  it.each(["approved", "denied", "timed out"])("does not toast a %s automatic review", (decision) => {
    const result = resolveCodexStreamNotice({
      threadLabel: "Package lookup",
      notification: {
        method: "warning",
        params: {
          threadId: "thread-1",
          message: `Automatic approval review ${decision}: Review rationale.`,
          presentation: "activity-only",
        },
      },
    }, []);
    expect(result).toBeUndefined();
  });

  it("still toasts ordinary warnings", () => {
    expect(resolveCodexStreamNotice({
      threadLabel: "Package lookup",
      notification: {
        method: "warning",
        params: { threadId: "thread-1", message: "Model fallback in use." },
      },
    }, [])).toMatchObject({
      notice: { title: "Codex warning", message: "Model fallback in use.", tone: "warning" },
    });
  });
});
