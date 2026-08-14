import { describe, expect, it } from "vitest";
import {
  SLACK_CREDENTIAL_ERROR,
  validateCredentials,
} from "../validate-credentials.ts";

describe("Slack credential validation", () => {
  it("returns unset without a bot token", async () => {
    await expect(validateCredentials({ botToken: "" })).resolves.toMatchObject({
      status: "unset",
      errorMessage: SLACK_CREDENTIAL_ERROR.missingBotToken,
    });
  });

  it("reports a distinct bot-token failure without probing Socket Mode", async () => {
    let openedSocket = false;
    await expect(
      validateCredentials(
        { botToken: "xoxb-bad", appToken: "xapp-test" },
        {
          authTest: async () => {
            throw new Error("invalid_auth");
          },
          openSocketConnection: async () => {
            openedSocket = true;
          },
        },
      ),
    ).resolves.toMatchObject({
      status: "failed",
      errorMessage: SLACK_CREDENTIAL_ERROR.invalidBotToken,
    });
    expect(openedSocket).toBe(false);
  });

  it("reports a distinct Socket Mode failure after a valid bot token", async () => {
    await expect(
      validateCredentials(
        { botToken: "xoxb-test", appToken: "xapp-bad" },
        {
          authTest: async () => ({
            user: "pwragent",
            team: "PwrDrvr",
            url: "https://example.slack.com/",
          }),
          openSocketConnection: async () => {
            throw new Error("not_allowed_token_type");
          },
        },
      ),
    ).resolves.toMatchObject({
      status: "failed",
      account: "pwragent",
      detail: "PwrDrvr",
      errorMessage: SLACK_CREDENTIAL_ERROR.socketFailed,
    });
  });

  it("fails with a Socket Mode message when the app token is missing", async () => {
    await expect(
      validateCredentials(
        { botToken: "xoxb-test" },
        {
          authTest: async () => ({
            user: "pwragent",
            team: "PwrDrvr",
          }),
        },
      ),
    ).resolves.toMatchObject({
      status: "failed",
      account: "pwragent",
      detail: "PwrDrvr",
      errorMessage: SLACK_CREDENTIAL_ERROR.missingAppToken,
    });
  });

  it("reports bot identity and Socket Mode connectivity separately on success", async () => {
    await expect(
      validateCredentials(
        { botToken: "xoxb-test", appToken: "xapp-test" },
        {
          authTest: async () => ({
            user: "pwragent",
            team: "PwrDrvr",
            url: "https://example.slack.com/",
          }),
          openSocketConnection: async () => ({ ok: true }),
        },
      ),
    ).resolves.toMatchObject({
      status: "ok",
      account: "pwragent",
      detail: "PwrDrvr · Socket Mode ok",
    });
  });
});
