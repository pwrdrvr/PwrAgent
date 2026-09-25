import { describe, expect, it } from "vitest";
import {
  buildSlackAppMessagesUrl,
  buildSlackAppSettingsUrl,
  slackAppIdFromAppToken,
} from "../slack-create-app-url.ts";
import { readSlackTeamId } from "../validate-credentials.ts";

// Shape-correct fakes: prefix, version, app ID, a numeric id, and hex.
const FAKE_APP_TOKEN = "xapp-1-A0FAKEAPP01-1234567890123-0123456789abcdef";

describe("Slack app settings URL", () => {
  it("reads the app ID an app-level token carries", () => {
    expect(slackAppIdFromAppToken(FAKE_APP_TOKEN)).toBe("A0FAKEAPP01");
    expect(slackAppIdFromAppToken(`  ${FAKE_APP_TOKEN}\n`)).toBe("A0FAKEAPP01");
  });

  it("finds no app ID in anything but an app-level token", () => {
    expect(slackAppIdFromAppToken(undefined)).toBeUndefined();
    expect(slackAppIdFromAppToken("")).toBeUndefined();
    expect(slackAppIdFromAppToken("xoxb-0000-fake")).toBeUndefined();
    expect(slackAppIdFromAppToken("xapp-1-not-an-app")).toBeUndefined();
    // Nothing that could leave api.slack.com/apps/ reaches the path.
    expect(slackAppIdFromAppToken("xapp-1-A0FAKE/../x-1-a")).toBeUndefined();
  });

  it("opens the app's Basic Information page, or the app list without one", () => {
    expect(buildSlackAppSettingsUrl(FAKE_APP_TOKEN)).toEqual({
      url: "https://api.slack.com/apps/A0FAKEAPP01/general",
      appSpecific: true,
    });
    expect(buildSlackAppSettingsUrl(undefined)).toEqual({
      url: "https://api.slack.com/apps",
      appSpecific: false,
    });
  });

  it("opens a direct message with the app, in its workspace when known", () => {
    expect(buildSlackAppMessagesUrl({ appId: "A0FAKEAPP01", teamId: "T0FAKETEAM1" }))
      .toBe("https://slack.com/app_redirect?app=A0FAKEAPP01&team=T0FAKETEAM1");
    expect(buildSlackAppMessagesUrl({ appId: "A0FAKEAPP01" }))
      .toBe("https://slack.com/app_redirect?app=A0FAKEAPP01");
    // Only something shaped like a workspace ID becomes one.
    expect(buildSlackAppMessagesUrl({ appId: "A0FAKEAPP01", teamId: "T0&x=1" }))
      .toBe("https://slack.com/app_redirect?app=A0FAKEAPP01");
  });

  it("reads the bot token's workspace ID, and nothing when Slack fails", async () => {
    await expect(
      readSlackTeamId("xoxb-fake", {
        authTest: async () => ({ team: "Fixture Workspace", team_id: "T0FAKETEAM1" }),
      }),
    ).resolves.toBe("T0FAKETEAM1");
    await expect(
      readSlackTeamId("xoxb-fake", { authTest: async () => ({ team: "No ID" }) }),
    ).resolves.toBeUndefined();
    await expect(
      readSlackTeamId("xoxb-fake", {
        authTest: async () => {
          throw new Error("invalid_auth");
        },
      }),
    ).resolves.toBeUndefined();
  });
});
