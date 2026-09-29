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

  it("offers dismissal only for the Skill Questions development warning", () => {
    const warning = {
      threadLabel: "Package lookup",
      notification: {
        method: "warning",
        params: {
          threadId: "thread-1",
          message: "Under-development features enabled: default_mode_request_user_input. Under-development features are incomplete and may behave unpredictably.",
        },
      },
    };
    expect(resolveCodexStreamNotice(warning, [])).toMatchObject({
      notice: { skillQuestionsWarning: true },
    });
    expect(resolveCodexStreamNotice({
      ...warning,
      skillQuestionsWarningDismissed: true,
    }, [])).toBeUndefined();
    for (const features of [
      "default_mode_request_user_input, another_feature",
      "another_feature, default_mode_request_user_input",
    ]) {
      const multiFeatureWarning = {
        ...warning,
        notification: {
          ...warning.notification,
          params: {
            ...warning.notification.params,
            message: `Under-development features enabled: ${features}. Under-development features are incomplete.`,
          },
        },
      };
      expect(resolveCodexStreamNotice(multiFeatureWarning, [])).toMatchObject({
        notice: { skillQuestionsWarning: true },
      });
      expect(resolveCodexStreamNotice({
        ...multiFeatureWarning,
        skillQuestionsWarningDismissed: true,
      }, [])).toBeUndefined();
    }
    expect(resolveCodexStreamNotice({
      ...warning,
      skillQuestionsWarningDismissed: true,
      notification: {
        ...warning.notification,
        params: {
          ...warning.notification.params,
          message: "Under-development features enabled: another_feature. default_mode_request_user_input is not enabled.",
        },
      },
    }, [])).toMatchObject({
      notice: {
        message: "Under-development features enabled: another_feature. default_mode_request_user_input is not enabled.",
      },
    });
  });
});
