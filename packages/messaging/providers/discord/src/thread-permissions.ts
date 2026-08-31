import { PermissionFlagsBits, REST, Routes } from "discord.js";
import { clipMessagingValidationError } from "@pwragent/messaging-interface";
import { validateDiscordSnowflake } from "./validate-ids.ts";

export const DISCORD_THREAD_REPLY_PERMISSIONS = [
  {
    bit: PermissionFlagsBits.ViewChannel,
    id: "view_channel",
    label: "View Channel",
  },
  {
    bit: PermissionFlagsBits.SendMessages,
    id: "send_messages",
    label: "Send Messages",
  },
  {
    bit: PermissionFlagsBits.EmbedLinks,
    id: "embed_links",
    label: "Embed Links",
  },
  {
    bit: PermissionFlagsBits.AttachFiles,
    id: "attach_files",
    label: "Attach Files",
  },
  {
    bit: PermissionFlagsBits.ReadMessageHistory,
    id: "read_message_history",
    label: "Read Message History",
  },
  {
    bit: PermissionFlagsBits.CreatePublicThreads,
    id: "create_public_threads",
    label: "Create Public Threads",
  },
  {
    bit: PermissionFlagsBits.SendMessagesInThreads,
    id: "send_messages_in_threads",
    label: "Send Messages in Threads",
  },
] as const;

export type DiscordThreadReplyPermissionId =
  (typeof DISCORD_THREAD_REPLY_PERMISSIONS)[number]["id"];

export type DiscordThreadPermissionInspection = {
  botId?: string;
  channelId: string;
  checkedAt: number;
  durationMs: number;
  errorMessage?: string;
  guildId: string;
  permissions: Array<{
    granted: boolean;
    id: DiscordThreadReplyPermissionId;
    label: string;
  }>;
  status: "ok" | "failed" | "unset";
};

export type DiscordPermissionRest = {
  get(route: string): Promise<unknown>;
};

type DiscordUserPayload = {
  id?: string;
};

type DiscordGuildPayload = {
  owner_id?: string;
};

type DiscordGuildMemberPayload = {
  roles?: string[];
};

type DiscordRolePayload = {
  id?: string;
  permissions?: string;
};

type DiscordPermissionOverwritePayload = {
  allow?: string;
  deny?: string;
  id?: string;
  type?: number;
};

type DiscordChannelPayload = {
  guild_id?: string;
  permission_overwrites?: DiscordPermissionOverwritePayload[];
};

const DISCORD_ADMINISTRATOR = PermissionFlagsBits.Administrator;
const DISCORD_THREAD_REPLY_PERMISSION_BITS = DISCORD_THREAD_REPLY_PERMISSIONS
  .reduce((bits, permission) => bits | permission.bit, 0n);

/**
 * Inspect the bot's effective permissions in one guild text channel. Discord
 * applies @everyone, roles, and channel overwrites in that order; this mirrors
 * that precedence for the permissions PwrAgent exposes in Settings.
 */
export async function inspectDiscordThreadPermissions(
  request: {
    botToken: string;
    channelId: string;
    guildId: string;
  },
): Promise<DiscordThreadPermissionInspection> {
  const startedAt = Date.now();
  if (!request.botToken) {
    return {
      channelId: request.channelId,
      checkedAt: startedAt,
      durationMs: 0,
      guildId: request.guildId,
      permissions: [],
      status: "unset",
    };
  }
  const rest = new REST({ version: "10" }).setToken(request.botToken);
  return inspectDiscordThreadPermissionsWithRest({
    channelId: request.channelId,
    guildId: request.guildId,
    rest,
    startedAt,
  });
}

export async function inspectDiscordThreadPermissionsWithRest(
  request: {
    channelId: string;
    guildId: string;
    rest: DiscordPermissionRest;
    startedAt?: number;
  },
): Promise<DiscordThreadPermissionInspection> {
  const startedAt = request.startedAt ?? Date.now();
  const invalidIdentifier = invalidThreadPermissionIdentifier(request);
  if (invalidIdentifier) {
    return {
      channelId: request.channelId,
      checkedAt: startedAt,
      durationMs: 0,
      errorMessage: invalidIdentifier,
      guildId: request.guildId,
      permissions: [],
      status: "failed",
    };
  }

  try {
    const me = (await request.rest.get(Routes.user("@me"))) as DiscordUserPayload;
    if (!me.id || !validateDiscordSnowflake(me.id).ok) {
      throw new Error("Discord did not return a valid bot identity.");
    }
    const [guild, channel, member, roles] = await Promise.all([
      request.rest.get(Routes.guild(request.guildId)) as Promise<DiscordGuildPayload>,
      request.rest.get(Routes.channel(request.channelId)) as Promise<DiscordChannelPayload>,
      request.rest.get(
        `/guilds/${request.guildId}/members/${me.id}`,
      ) as Promise<DiscordGuildMemberPayload>,
      request.rest.get(`/guilds/${request.guildId}/roles`) as Promise<DiscordRolePayload[]>,
    ]);
    if (channel.guild_id && channel.guild_id !== request.guildId) {
      throw new Error("The selected Discord channel is not in the selected server.");
    }

    const effectivePermissions = calculateDiscordChannelPermissions({
      botId: me.id,
      channel,
      guild,
      guildId: request.guildId,
      member,
      roles,
    });
    return {
      botId: me.id,
      channelId: request.channelId,
      checkedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      guildId: request.guildId,
      permissions: DISCORD_THREAD_REPLY_PERMISSIONS.map((permission) => ({
        granted: hasDiscordPermission(effectivePermissions, permission.bit),
        id: permission.id,
        label: permission.label,
      })),
      status: "ok",
    };
  } catch (error) {
    return {
      channelId: request.channelId,
      checkedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      errorMessage: clipMessagingValidationError(
        error instanceof Error ? error.message : String(error),
      ),
      guildId: request.guildId,
      permissions: [],
      status: "failed",
    };
  }
}

export function buildDiscordThreadPermissionRequestUrl(request: {
  applicationId: string;
  guildId?: string;
}): string {
  if (!validateDiscordSnowflake(request.applicationId).ok) {
    throw new Error("A valid Discord application ID is required.");
  }
  if (request.guildId && !validateDiscordSnowflake(request.guildId).ok) {
    throw new Error("The Discord server ID is invalid.");
  }

  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", request.applicationId);
  url.searchParams.set("scope", "bot applications.commands");
  url.searchParams.set(
    "permissions",
    DISCORD_THREAD_REPLY_PERMISSION_BITS.toString(),
  );
  if (request.guildId) {
    url.searchParams.set("guild_id", request.guildId);
    url.searchParams.set("disable_guild_select", "true");
  }
  return url.toString();
}

function calculateDiscordChannelPermissions(input: {
  botId: string;
  channel: DiscordChannelPayload;
  guild: DiscordGuildPayload;
  guildId: string;
  member: DiscordGuildMemberPayload;
  roles: DiscordRolePayload[];
}): bigint {
  if (input.guild.owner_id === input.botId) {
    return DISCORD_THREAD_REPLY_PERMISSION_BITS;
  }

  const roleIds = new Set([input.guildId, ...(input.member.roles ?? [])]);
  let permissions = input.roles
    .filter((role) => role.id && roleIds.has(role.id))
    .reduce((bits, role) => bits | permissionBits(role.permissions), 0n);
  if ((permissions & DISCORD_ADMINISTRATOR) === DISCORD_ADMINISTRATOR) {
    return permissions;
  }
  const overwrites = input.channel.permission_overwrites ?? [];
  const everyoneOverwrite = overwrites.find(
    (overwrite) => overwrite.type === 0 && overwrite.id === input.guildId,
  );
  permissions = applyDiscordPermissionOverwrite(permissions, everyoneOverwrite);

  let roleAllow = 0n;
  let roleDeny = 0n;
  for (const overwrite of overwrites) {
    if (
      overwrite.type === 0
      && overwrite.id
      && overwrite.id !== input.guildId
      && roleIds.has(overwrite.id)
    ) {
      roleAllow |= permissionBits(overwrite.allow);
      roleDeny |= permissionBits(overwrite.deny);
    }
  }
  permissions = (permissions & ~roleDeny) | roleAllow;

  const memberOverwrite = overwrites.find(
    (overwrite) => overwrite.type === 1 && overwrite.id === input.botId,
  );
  return applyDiscordPermissionOverwrite(permissions, memberOverwrite);
}

function applyDiscordPermissionOverwrite(
  permissions: bigint,
  overwrite: DiscordPermissionOverwritePayload | undefined,
): bigint {
  if (!overwrite) {
    return permissions;
  }
  return (permissions & ~permissionBits(overwrite.deny)) | permissionBits(overwrite.allow);
}

function hasDiscordPermission(permissions: bigint, permission: bigint): boolean {
  return (
    (permissions & DISCORD_ADMINISTRATOR) === DISCORD_ADMINISTRATOR
    || (permissions & permission) === permission
  );
}

function invalidThreadPermissionIdentifier(request: {
  channelId: string;
  guildId: string;
}): string | undefined {
  if (!validateDiscordSnowflake(request.channelId).ok) {
    return "The Discord channel ID is invalid.";
  }
  if (!validateDiscordSnowflake(request.guildId).ok) {
    return "The Discord server ID is invalid.";
  }
  return undefined;
}

function permissionBits(value: string | undefined): bigint {
  if (!value || !/^[0-9]+$/.test(value)) {
    return 0n;
  }
  return BigInt(value);
}
