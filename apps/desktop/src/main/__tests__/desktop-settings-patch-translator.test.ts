import { describe, expect, it } from "vitest";
import { desktopSettingsPatchToEdits } from "../settings/desktop-config";
import { parseTomlTables } from "../settings/toml-editor";

describe("desktopSettingsPatchToEdits — experimental", () => {
  it("writes the Full Access risk warning dismissal flag", () => {
    const edits = desktopSettingsPatchToEdits({
      experimental: {
        fullAccessRiskWarningDismissed: true,
      },
    });

    expect(edits).toEqual([
      {
        op: "set",
        path: ["experimental", "full_access_risk_warning_dismissed"],
        value: true,
      },
    ]);
  });
});

describe("desktopSettingsPatchToEdits — image uploads", () => {
  it("writes non-default pasted image patch budgets", () => {
    expect(
      desktopSettingsPatchToEdits({
        imageUploads: {
          pastedImageMaxPatches: 4096,
        },
      }),
    ).toEqual([
      {
        op: "set",
        path: ["image_uploads", "pasted_image_max_patches"],
        value: 4096,
      },
    ]);
  });

  it("removes the pasted image patch budget when saving the default", () => {
    expect(
      desktopSettingsPatchToEdits({
        imageUploads: {
          pastedImageMaxPatches: 1536,
        },
      }),
    ).toEqual([
      {
        op: "delete",
        path: ["image_uploads", "pasted_image_max_patches"],
      },
    ]);
  });
});

describe("desktopSettingsPatchToEdits — updates", () => {
  it("writes the prerelease update channel", () => {
    expect(
      desktopSettingsPatchToEdits({
        updates: {
          channel: "prerelease",
        },
      }),
    ).toEqual([
      {
        op: "set",
        path: ["updates", "channel"],
        value: "prerelease",
      },
    ]);
  });

  it("removes the update channel when saving the default", () => {
    expect(
      desktopSettingsPatchToEdits({
        updates: {
          channel: "latest",
        },
      }),
    ).toEqual([
      {
        op: "delete",
        path: ["updates", "channel"],
      },
    ]);
  });
});

describe("desktopSettingsPatchToEdits — messaging attachments", () => {
  it("writes non-default image upload profiles", () => {
    expect(
      desktopSettingsPatchToEdits({
        messaging: {
          attachments: { imageProfile: "high" },
        },
      }),
    ).toEqual([
      {
        op: "set",
        path: ["messaging", "attachments", "image_profile"],
        value: "high",
      },
    ]);
  });

  it("removes the image upload profile when saving the default", () => {
    expect(
      desktopSettingsPatchToEdits({
        messaging: {
          attachments: { imageProfile: "medium" },
        },
      }),
    ).toEqual([
      {
        op: "delete",
        path: ["messaging", "attachments", "image_profile"],
      },
    ]);
  });
});

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
          authorizedTeams: [
            { id: "teamabcdefghijklmnopqrstu1", displayName: "Dev Team" },
          ],
          authorizedConversations: [
            { id: "channelabcdefghijklmn12345", displayName: "Town Square" },
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
        op: "deleteTableArray",
        path: ["messaging", "mattermost", "authorized_user_ids"],
      },
      {
        op: "delete",
        path: ["messaging", "mattermost", "authorized_users_list"],
      },
      {
        op: "deleteTableArray",
        path: ["messaging", "mattermost", "authorized_users_list"],
      },
      {
        op: "delete",
        path: ["messaging", "mattermost", "authorized_user_ids_list"],
      },
      {
        op: "deleteTableArray",
        path: ["messaging", "mattermost", "authorized_user_ids_list"],
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
      {
        op: "delete",
        path: ["messaging", "mattermost", "authorized_team_ids"],
      },
      {
        op: "deleteTableArray",
        path: ["messaging", "mattermost", "authorized_team_ids"],
      },
      {
        op: "delete",
        path: ["messaging", "mattermost", "authorized_teams_list"],
      },
      {
        op: "deleteTableArray",
        path: ["messaging", "mattermost", "authorized_teams_list"],
      },
      {
        op: "delete",
        path: ["messaging", "mattermost", "authorized_team_ids_list"],
      },
      {
        op: "deleteTableArray",
        path: ["messaging", "mattermost", "authorized_team_ids_list"],
      },
      {
        op: "delete",
        path: ["messaging", "mattermost", "authorized_teams"],
      },
      {
        op: "deleteTableArray",
        path: ["messaging", "mattermost", "authorized_teams"],
      },
      {
        op: "setTableArray",
        path: ["messaging", "mattermost", "authorized_teams"],
        value: [
          { id: "teamabcdefghijklmnopqrstu1", display_name: "Dev Team" },
        ],
      },
      {
        op: "delete",
        path: ["messaging", "mattermost", "authorized_conversation_ids"],
      },
      {
        op: "deleteTableArray",
        path: ["messaging", "mattermost", "authorized_conversation_ids"],
      },
      {
        op: "delete",
        path: ["messaging", "mattermost", "authorized_conversations_list"],
      },
      {
        op: "deleteTableArray",
        path: ["messaging", "mattermost", "authorized_conversations_list"],
      },
      {
        op: "delete",
        path: ["messaging", "mattermost", "authorized_conversation_ids_list"],
      },
      {
        op: "deleteTableArray",
        path: ["messaging", "mattermost", "authorized_conversation_ids_list"],
      },
      {
        op: "delete",
        path: ["messaging", "mattermost", "authorized_conversations"],
      },
      {
        op: "deleteTableArray",
        path: ["messaging", "mattermost", "authorized_conversations"],
      },
      {
        op: "setTableArray",
        path: ["messaging", "mattermost", "authorized_conversations"],
        value: [
          { id: "channelabcdefghijklmn12345", display_name: "Town Square" },
        ],
      },
    ]);
  });

  it("keeps a legacy scalar mirror when the current config already has one", () => {
    const tables = parseTomlTables(
      "[messaging.mattermost]\nauthorized_user_ids = [\"old\"]\n",
      "/tmp/config.toml",
    );

    const edits = desktopSettingsPatchToEdits(
      {
        messaging: {
          mattermost: {
            authorizedUserIds: [{ id: "abc", displayName: "Alice" }],
          },
        },
      },
      tables,
    );

    expect(edits).toEqual([
      {
        op: "delete",
        path: ["messaging", "mattermost", "authorized_users_list"],
      },
      {
        op: "deleteTableArray",
        path: ["messaging", "mattermost", "authorized_users_list"],
      },
      {
        op: "delete",
        path: ["messaging", "mattermost", "authorized_user_ids_list"],
      },
      {
        op: "deleteTableArray",
        path: ["messaging", "mattermost", "authorized_user_ids_list"],
      },
      {
        op: "ensureCommentBefore",
        path: ["messaging", "mattermost", "authorized_user_ids"],
        marker: "pwragent-legacy-settings",
        comment:
          "# pwragent-legacy-settings key=authorized_user_ids shape=string-array used_through=1.0.0-alpha.9 kept_for_older_clients",
      },
      {
        op: "set",
        path: ["messaging", "mattermost", "authorized_user_ids"],
        value: ["abc"],
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
        value: [{ id: "abc", display_name: "Alice" }],
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
