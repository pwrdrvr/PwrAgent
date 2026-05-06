import { describe, expect, it } from "vitest";
import { MattermostAdapter } from "../mattermost-adapter.ts";
import type { MessagingCallbackHandleStore } from "@pwragent/messaging-interface";

const fakeStore: MessagingCallbackHandleStore = {
  resolveCallbackHandle: async () => undefined,
  upsertCallbackHandle: async (record) => record,
};

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe("MattermostAdapter", () => {
  it("declares a Mattermost capability profile with documented limits", () => {
    const adapter = new MattermostAdapter({
      callbackHandleStore: fakeStore,
      config: {
        channel: "mattermost",
        botToken: "test-token",
        serverUrl: "https://chat.example.com",
        callbackBaseUrl: "https://callback.example.com/cb",
        callbackPort: 47899,
        callbackHmacSecret: "test-secret",
        authorizedActorIds: ["user-1"],
      },
      logger: silentLogger,
    });

    const profile = adapter.capabilityProfile;
    expect(profile.actions).toBeDefined();
    expect(profile.actions?.maxActions).toBe(25);
    expect(profile.actions?.supportsLayoutHints).toBe(false);
    expect(profile.actions?.supportsDisabled).toBe(false);
    expect(profile.actions?.supportsStyles).toBe(true);
    expect(profile.text.maxLength).toBe(16_383);
    expect(profile.text.encoding).toBe("characters");
    expect(profile.text.markdownDialect).toBe("markdown");
    expect(profile.outboundAttachments?.supportsFileUpload).toBe(true);
    expect(profile.outboundAttachments?.maxUploadBytes).toBe(100 * 1024 * 1024);
    expect(profile.inboundAttachments?.maxAttachmentCount).toBe(10);
  });

  it("exposes the configured authorized actor IDs", () => {
    const adapter = new MattermostAdapter({
      callbackHandleStore: fakeStore,
      config: {
        channel: "mattermost",
        botToken: "test-token",
        serverUrl: "https://chat.example.com",
        callbackBaseUrl: "https://callback.example.com/cb",
        callbackHmacSecret: "test-secret",
        authorizedActorIds: ["alice", "bob"],
      },
      logger: silentLogger,
    });
    expect(adapter.authorizedActorIds).toEqual(["alice", "bob"]);
  });

  it("declares the channel kind 'mattermost'", () => {
    const adapter = new MattermostAdapter({
      callbackHandleStore: fakeStore,
      config: {
        channel: "mattermost",
        botToken: "test-token",
        serverUrl: "https://chat.example.com",
        callbackBaseUrl: "https://callback.example.com/cb",
        callbackHmacSecret: "test-secret",
        authorizedActorIds: ["user-1"],
      },
      logger: silentLogger,
    });
    expect(adapter.channel).toBe("mattermost");
  });
});
