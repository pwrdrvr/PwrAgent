import { PermissionFlagsBits } from "discord.js";
import { describe, expect, it } from "vitest";
import {
  buildDiscordThreadPermissionRequestUrl,
  inspectDiscordThreadPermissionsWithRest,
  listDiscordThreadPermissionChannelsWithRest,
} from "../thread-permissions.ts";

const BOT_ID = "1480556454498009351";
const CHANNEL_ID = "1480556454498009352";
const GUILD_ID = "1480556454498009353";
const BOT_ROLE_ID = "1480556454498009354";
const ANNOUNCEMENT_CHANNEL_ID = "1480556454498009355";
const CATEGORY_ID = "1480556454498009356";

describe("Discord thread permissions", () => {
  it("applies role and member channel overwrites before reporting effective permissions", async () => {
    const permissions = await inspectDiscordThreadPermissionsWithRest({
      channelId: CHANNEL_ID,
      guildId: GUILD_ID,
      rest: {
        get: async (route) => {
          if (route === "/users/%40me") return { id: BOT_ID };
          if (route === `/guilds/${GUILD_ID}`) return {};
          if (route === `/channels/${CHANNEL_ID}`) {
            return {
              guild_id: GUILD_ID,
              permission_overwrites: [
                {
                  allow: "0",
                  deny: PermissionFlagsBits.SendMessages.toString(),
                  id: BOT_ROLE_ID,
                  type: 0,
                },
                {
                  allow: PermissionFlagsBits.EmbedLinks.toString(),
                  deny: PermissionFlagsBits.CreatePublicThreads.toString(),
                  id: BOT_ID,
                  type: 1,
                },
              ],
            };
          }
          if (route === `/guilds/${GUILD_ID}/members/${BOT_ID}`) {
            return { roles: [BOT_ROLE_ID] };
          }
          if (route === `/guilds/${GUILD_ID}/roles`) {
            return [
              {
                id: GUILD_ID,
                permissions: (
                  PermissionFlagsBits.ViewChannel
                  | PermissionFlagsBits.SendMessages
                ).toString(),
              },
              {
                id: BOT_ROLE_ID,
                permissions: (
                  PermissionFlagsBits.AttachFiles
                  | PermissionFlagsBits.CreatePublicThreads
                  | PermissionFlagsBits.ReadMessageHistory
                  | PermissionFlagsBits.SendMessagesInThreads
                ).toString(),
              },
            ];
          }
          throw new Error(`unexpected route: ${route}`);
        },
      },
    });

    expect(permissions.status).toBe("ok");
    expect(permissions.permissions).toEqual([
      { granted: true, id: "view_channel", label: "View Channel" },
      { granted: false, id: "send_messages", label: "Send Messages" },
      { granted: true, id: "embed_links", label: "Embed Links" },
      { granted: true, id: "attach_files", label: "Attach Files" },
      {
        granted: true,
        id: "read_message_history",
        label: "Read Message History",
      },
      {
        granted: false,
        id: "create_public_threads",
        label: "Create Public Threads",
      },
      {
        granted: true,
        id: "send_messages_in_threads",
        label: "Send Messages in Threads",
      },
    ]);
  });

  it("builds a guild-targeted least-privilege Discord authorization request", () => {
    const url = new URL(buildDiscordThreadPermissionRequestUrl({
      applicationId: BOT_ID,
      guildId: GUILD_ID,
    }));

    expect(url.origin).toBe("https://discord.com");
    expect(url.pathname).toBe("/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe(BOT_ID);
    expect(url.searchParams.get("scope")).toBe("bot applications.commands");
    expect(url.searchParams.get("permissions")).toBe("309237763072");
    expect(url.searchParams.get("guild_id")).toBe(GUILD_ID);
    expect(url.searchParams.get("disable_guild_select")).toBe("true");
  });

  it("rejects a DM channel that has no selected guild", async () => {
    const permissions = await inspectDiscordThreadPermissionsWithRest({
      channelId: CHANNEL_ID,
      guildId: GUILD_ID,
      rest: {
        get: async (route) => {
          if (route === "/users/%40me") return { id: BOT_ID };
          if (route === `/guilds/${GUILD_ID}`) return {};
          if (route === `/channels/${CHANNEL_ID}`) return {};
          if (route === `/guilds/${GUILD_ID}/members/${BOT_ID}`) {
            return { roles: [] };
          }
          if (route === `/guilds/${GUILD_ID}/roles`) return [];
          throw new Error(`unexpected route: ${route}`);
        },
      },
    });

    expect(permissions).toMatchObject({
      errorMessage: "The selected Discord channel is not in the selected server.",
      status: "failed",
    });
  });

  it("lists named text channels and their categories for the selected server", async () => {
    const listing = await listDiscordThreadPermissionChannelsWithRest({
      guildId: GUILD_ID,
      rest: {
        get: async (route) => {
          if (route === `/guilds/${GUILD_ID}`) {
            return { id: GUILD_ID, name: "huntharo-claw" };
          }
          if (route === `/guilds/${GUILD_ID}/channels`) {
            return [
              {
                guild_id: GUILD_ID,
                id: CATEGORY_ID,
                name: "Chat",
                position: 1,
                type: 4,
              },
              {
                guild_id: GUILD_ID,
                id: CHANNEL_ID,
                name: "general",
                parent_id: CATEGORY_ID,
                position: 2,
                type: 0,
              },
              {
                guild_id: GUILD_ID,
                id: ANNOUNCEMENT_CHANNEL_ID,
                name: "announcements",
                parent_id: CATEGORY_ID,
                position: 3,
                type: 5,
              },
              {
                guild_id: GUILD_ID,
                id: "1480556454498009357",
                name: "Voice",
                position: 4,
                type: 2,
              },
              {
                guild_id: "1480556454498009358",
                id: "1480556454498009359",
                name: "wrong-server",
                position: 5,
                type: 0,
              },
              {
                guild_id: GUILD_ID,
                id: "not-a-snowflake",
                name: "invalid",
                position: 6,
                type: 0,
              },
            ];
          }
          throw new Error(`unexpected route: ${route}`);
        },
      },
    });

    expect(listing).toEqual({
      channels: [
        {
          categoryName: "Chat",
          id: CHANNEL_ID,
          kind: "text",
          name: "general",
        },
        {
          categoryName: "Chat",
          id: ANNOUNCEMENT_CHANNEL_ID,
          kind: "announcement",
          name: "announcements",
        },
      ],
      guildId: GUILD_ID,
      guildName: "huntharo-claw",
      status: "ok",
    });
  });

  it("rejects a malformed server response when listing channels", async () => {
    const listing = await listDiscordThreadPermissionChannelsWithRest({
      guildId: GUILD_ID,
      rest: {
        get: async (route) => {
          if (route === `/guilds/${GUILD_ID}`) {
            return { id: "1480556454498009358", name: "Another server" };
          }
          if (route === `/guilds/${GUILD_ID}/channels`) return [];
          throw new Error(`unexpected route: ${route}`);
        },
      },
    });

    expect(listing).toMatchObject({
      channels: [],
      errorMessage: "Discord returned an unexpected server.",
      guildId: GUILD_ID,
      status: "failed",
    });
  });
});
