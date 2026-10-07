import { describe, expect, it } from "vitest";
import type { FederationInstanceId } from "@pwragent/shared";
import { codexWarningSuppressionId } from "../../codex-config/codex-warning-suppression";
import { resolveCodexStreamNotice } from "../codex-stream-notice";

const REQUIREMENT_WARNING =
  "Ignoring unknown `features` requirement `example_mode` from requirements layers: managed requirements Baseline";

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

  it("offers the Skill Questions dismissal only for its development warning", () => {
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

  it("suppresses a thread warning the config banner was told not to show again", () => {
    const warning = {
      threadLabel: "Package lookup",
      notification: {
        method: "warning",
        params: { threadId: "thread-1", message: REQUIREMENT_WARNING },
      },
    };
    expect(resolveCodexStreamNotice(warning, [])).toMatchObject({
      notice: {
        message: REQUIREMENT_WARNING,
        warningSuppressionId: codexWarningSuppressionId({ summary: REQUIREMENT_WARNING }),
      },
    });
    // The banner saves its own fields alongside the summary.
    const bannerId = codexWarningSuppressionId({
      summary: REQUIREMENT_WARNING,
      details: "Banner-only detail",
      trustedProjectPath: "/repo",
      configPath: "/repo/.codex/config.toml",
    });
    expect(resolveCodexStreamNotice({
      ...warning,
      dismissedWarningIds: [bannerId],
    }, [])).toBeUndefined();
    expect(resolveCodexStreamNotice({
      ...warning,
      dismissedWarningIds: [codexWarningSuppressionId({ summary: "A different warning" })],
    }, [])).toMatchObject({ notice: { message: REQUIREMENT_WARNING } });
  });

  it("scopes a saved warning dismissal to the instance that reported it", () => {
    const instanceId = "instance-remote" as FederationInstanceId;
    const warning = {
      threadLabel: "Package lookup",
      instanceId,
      notification: {
        method: "warning",
        params: { threadId: "thread-1", message: REQUIREMENT_WARNING },
      },
    };
    const localId = codexWarningSuppressionId({ summary: REQUIREMENT_WARNING });
    const remoteId = codexWarningSuppressionId({
      summary: REQUIREMENT_WARNING,
      remoteInstanceId: instanceId,
    });
    expect(resolveCodexStreamNotice({
      ...warning,
      dismissedWarningIds: [localId],
    }, [])).toMatchObject({ notice: { warningSuppressionId: remoteId } });
    expect(resolveCodexStreamNotice({
      ...warning,
      dismissedWarningIds: [remoteId],
    }, [])).toBeUndefined();
  });

  it("never suppresses or offers to suppress a Codex error", () => {
    const result = resolveCodexStreamNotice({
      threadLabel: "Package lookup",
      dismissedWarningIds: [codexWarningSuppressionId({ summary: REQUIREMENT_WARNING })],
      notification: {
        method: "error",
        params: { threadId: "thread-1", error: { message: REQUIREMENT_WARNING } },
      },
    }, []);
    expect(result).toMatchObject({ notice: { title: "Codex error" } });
    expect(result && "notice" in result && result.notice.warningSuppressionId)
      .toBeFalsy();
  });
});
