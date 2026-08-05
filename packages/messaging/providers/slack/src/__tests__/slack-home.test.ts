import { describe, expect, it } from "vitest";
import { buildSlackHomeView } from "../slack-home.ts";
import type { SlackMessagingConfig } from "../slack-config.ts";

const lockedDownConfig: SlackMessagingConfig = {
  channel: "slack",
  botToken: "xoxb-test",
  appToken: "xapp-test",
  authorizedActorIds: [
    { id: "U012ABCDEF0", displayName: "Alice" },
    { id: "U012ABCDEF1", displayName: "Bob" },
  ],
  authorizedTeamIds: [
    { id: "T012ABCDEF0", displayName: "PwrDrvr" },
  ],
  authorizedConversationIds: [
    { id: "C012ABCDEF0", displayName: "engineering" },
    { id: "C012ABCDEF1", displayName: "product" },
  ],
};

describe("buildSlackHomeView", () => {
  it("builds a branded, useful Home tab without exposing allowlisted IDs", () => {
    const view = buildSlackHomeView({
      config: lockedDownConfig,
      userId: "U012ABCDEF0",
    });
    const payload = JSON.stringify(view);

    expect(view.type).toBe("home");
    expect(view.blocks).toHaveLength(14);
    expect(payload).toContain("https://pwragent.ai/assets/logo.png");
    expect(payload).toContain("Welcome, <@U012ABCDEF0>");
    expect(payload).toContain("Permission controls, by design");
    expect(payload).toContain("1 approved workspace");
    expect(payload).toContain("2 approved conversations");
    expect(payload).toContain("2 configured users");
    expect(payload).not.toContain("T012ABCDEF0");
    expect(payload).not.toContain("C012ABCDEF0");
    expect(payload).not.toContain("engineering");
  });

  it("describes open Slack gates without implying an allowlist", () => {
    const view = buildSlackHomeView({
      config: {
        ...lockedDownConfig,
        teamAuthorizationMode: "allow_all",
        channelAuthorizationMode: "allow_all",
        channelUserAccessMode: "any_channel_user",
        dmAccessMode: "any_workspace_user",
        groupDmAccessMode: "authorized_users",
      },
      userId: "U012ABCDEF0",
    });
    const payload = JSON.stringify(view);

    expect(payload).toContain("Any workspace reaching this installation");
    expect(payload).toContain("Any channel the bot can access");
    expect(payload).toContain("Any member of an approved channel");
    expect(payload).toContain("Any workspace user");
    expect(payload).toContain("Authorized users, when they mention the bot");
  });
});
