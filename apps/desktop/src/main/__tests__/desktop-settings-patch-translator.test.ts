import { describe, expect, it } from "vitest";
import { desktopSettingsPatchToEdits } from "../settings/desktop-config";
import { parseTomlTables } from "../settings/toml-editor";

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
        op: "deleteTableArray",
        path: ["messaging", "mattermost", "authorized_user_ids"],
      },
      {
        op: "setTableArray",
        path: ["messaging", "mattermost", "authorized_user_ids"],
        value: [
          { id: "abc", display_name: "Alice" },
          { id: "def", display_name: "Dev Team" },
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
        path: ["messaging", "mattermost", "authorized_users"],
      },
      {
        op: "deleteTableArray",
        path: ["messaging", "mattermost", "authorized_users"],
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
        op: "deleteTableArray",
        path: ["messaging", "mattermost", "authorized_user_ids_list"],
      },
      {
        op: "setTableArray",
        path: ["messaging", "mattermost", "authorized_user_ids_list"],
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
