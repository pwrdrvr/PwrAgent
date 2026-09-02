import { describe, expect, it, vi } from "vitest";
import { MESSAGING_RBAC_READ_SUBJECTS_CHANNEL } from "../../shared/ipc";

const handlers = vi.hoisted(() => new Map<string, (...args: never[]) => unknown>());
const readConfigDomain = vi.hoisted(() => vi.fn(() => ({
  discord: {
    authorizedUserIds: [{ id: "discord-user", displayName: "Ada" }],
  },
  slack: {
    authorizedUserIds: [{ id: "slack-user", displayName: "Grace" }],
    channelUserAccessMode: "any_channel_user",
    dmAccessMode: "any_workspace_user",
  },
})));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: never[]) => unknown) => {
      handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  },
}));

vi.mock("../settings/desktop-settings-singleton", () => ({
  getDesktopConfigStore: () => ({ read: readConfigDomain }),
}));

vi.mock("../messaging/rbac-policy-service", () => ({
  getRbacPolicyService: () => ({}),
}));

import { registerMessagingRbacIpcHandlers } from "../ipc/messaging-rbac";

describe("messaging RBAC IPC", () => {
  it("reads known subjects from the messaging domain snapshot", async () => {
    registerMessagingRbacIpcHandlers();

    const response = await handlers.get(MESSAGING_RBAC_READ_SUBJECTS_CHANNEL)?.();

    expect(readConfigDomain).toHaveBeenCalledWith("messaging");
    expect(response).toEqual({
      subjects: [
        {
          subject: {
            kind: "actor",
            platform: "discord",
            actorId: "discord-user",
          },
          displayName: "Ada",
        },
        {
          subject: {
            kind: "actor",
            platform: "slack",
            actorId: "slack-user",
          },
          displayName: "Grace",
        },
        {
          subject: {
            kind: "bucket",
            platform: "slack",
            bucket: "channel_any_user",
          },
          displayName: "Any user in an authorized Slack channel",
          bucket: true,
        },
        {
          subject: {
            kind: "bucket",
            platform: "slack",
            bucket: "dm_any_workspace_user",
          },
          displayName: "Any Slack workspace user (DM)",
          bucket: true,
        },
      ],
    });
  });
});
