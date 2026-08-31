import { PermissionFlagsBits } from "discord.js";
import { describe, expect, it } from "vitest";
import {
  buildDiscordThreadPermissionRequestUrl,
  inspectDiscordThreadPermissionsWithRest,
} from "../thread-permissions.ts";

const BOT_ID = "1480556454498009351";
const CHANNEL_ID = "1480556454498009352";
const GUILD_ID = "1480556454498009353";
const BOT_ROLE_ID = "1480556454498009354";

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
});
