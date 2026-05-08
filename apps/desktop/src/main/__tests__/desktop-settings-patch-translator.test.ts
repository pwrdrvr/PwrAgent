import { describe, expect, it } from "vitest";
import { desktopSettingsPatchToEdits } from "../settings/desktop-config";

describe("desktopSettingsPatchToEdits — Mattermost", () => {
  it("emits one set op per defined Mattermost field with the correct snake_case key", () => {
    const edits = desktopSettingsPatchToEdits({
      messaging: {
        mattermost: {
          enabled: true,
          streamingResponses: false,
          serverUrl: "https://chat.example.com",
          callbackBaseUrl: "https://callbacks.example.com",
          slashCommandPrefix: "pwragent_",
          registerSlashCommands: true,
          authorizedUserIds: [
            { id: "abc", displayName: "Alice" },
            { id: "def", displayName: "Dev Team" },
          ],
        },
      },
    });

    expect(edits).toEqual([
      {
        op: "set",
        path: ["messaging", "mattermost", "enabled"],
        value: true,
      },
      {
        op: "set",
        path: ["messaging", "mattermost", "streaming_responses"],
        value: false,
      },
      {
        op: "set",
        path: ["messaging", "mattermost", "server_url"],
        value: "https://chat.example.com",
      },
      {
        op: "set",
        path: ["messaging", "mattermost", "callback_base_url"],
        value: "https://callbacks.example.com",
      },
      {
        op: "set",
        path: ["messaging", "mattermost", "slash_command_prefix"],
        value: "pwragent_",
      },
      {
        op: "set",
        path: ["messaging", "mattermost", "register_slash_commands"],
        value: true,
      },
      {
        op: "delete",
        path: ["messaging", "mattermost", "authorized_user_ids"],
      },
      {
        op: "delete",
        path: ["messaging", "mattermost", "authorized_users"],
      },
      {
        op: "deleteTableArray",
        path: ["messaging", "mattermost", "authorized_users"],
      },
      {
        op: "setTableArray",
        path: ["messaging", "mattermost", "authorized_users"],
        value: [
          { id: "abc", display_name: "Alice" },
          { id: "def", display_name: "Dev Team" },
        ],
      },
    ]);
  });

  it("emits no ops when the Mattermost patch is empty", () => {
    expect(
      desktopSettingsPatchToEdits({ messaging: { mattermost: {} } }),
    ).toEqual([]);
  });

  it("emits ops only for the fields that are defined", () => {
    const edits = desktopSettingsPatchToEdits({
      messaging: {
        mattermost: {
          serverUrl: "https://chat.example.com",
        },
      },
    });
    expect(edits).toEqual([
      {
        op: "set",
        path: ["messaging", "mattermost", "server_url"],
        value: "https://chat.example.com",
      },
    ]);
  });
});
