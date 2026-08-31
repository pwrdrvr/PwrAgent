import { PermissionFlagsBits, REST, Routes } from "discord.js";
import {
  clipMessagingValidationError,
  sanitizeMessagingContactLabel,
} from "@pwragent/messaging-interface";
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

export type DiscordThreadPermissionChannelListing = {
  channels: Array<{
    categoryName?: string;
    id: string;
    kind: "announcement" | "text";
    name: string;
  }>;
  errorMessage?: string;
  guildId: string;
  guildName?: string;
  status: "ok" | "failed" | "unset";
};

export type DiscordPermissionRest = {
  get(route: string): Promise<unknown>;
};

type DiscordUserPayload = {
  id?: string;
};

type DiscordGuildPayload = {
  id?: unknown;
  name?: unknown;
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

type DiscordListedChannelPayload = {
  guild_id?: unknown;
  id?: unknown;
  name?: unknown;
  parent_id?: unknown;
  position?: unknown;
  type?: unknown;
};

const DISCORD_GUILD_TEXT_CHANNEL = 0;
const DISCORD_GUILD_CATEGORY_CHANNEL = 4;
const DISCORD_GUILD_ANNOUNCEMENT_CHANNEL = 5;

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

/**
 * List the named guild channels where Discord can create a thread from an
 * existing message. This keeps platform snowflakes out of the Settings UI.
 */
export async function listDiscordThreadPermissionChannels(
  request: {
    botToken: string;
    guildId: string;
  },
): Promise<DiscordThreadPermissionChannelListing> {
  if (!request.botToken) {
    return {
      channels: [],
      guildId: request.guildId,
      status: "unset",
    };
  }
  const rest = new REST({ version: "10" }).setToken(request.botToken);
  return listDiscordThreadPermissionChannelsWithRest({
    guildId: request.guildId,
    rest,
  });
}

export async function listDiscordThreadPermissionChannelsWithRest(
  request: {
    guildId: string;
    rest: DiscordPermissionRest;
  },
): Promise<DiscordThreadPermissionChannelListing> {
  if (!validateDiscordSnowflake(request.guildId).ok) {
    return {
      channels: [],
      errorMessage: "The Discord server ID is invalid.",
      guildId: request.guildId,
      status: "failed",
    };
  }

  try {
    const [guild, rawChannels] = await Promise.all([
      request.rest.get(Routes.guild(request.guildId)) as Promise<DiscordGuildPayload>,
      request.rest.get(`/guilds/${request.guildId}/channels`) as Promise<unknown>,
    ]);
    if (guild.id !== request.guildId) {
      throw new Error("Discord returned an unexpected server.");
    }
    if (!Array.isArray(rawChannels)) {
      throw new Error("Discord did not return a channel list.");
    }

    const listedChannels = rawChannels as DiscordListedChannelPayload[];
    const categories = new Map<string, { name: string; position: number }>();
    for (const channel of listedChannels) {
      const name = sanitizeMessagingContactLabel(channel.name);
      if (
        channel.type === DISCORD_GUILD_CATEGORY_CHANNEL
        && channel.guild_id === request.guildId
        && typeof channel.id === "string"
        && validateDiscordSnowflake(channel.id).ok
        && name
      ) {
        categories.set(channel.id, {
          name,
          position: validDiscordChannelPosition(channel.position),
        });
      }
    }

    const channels = listedChannels.flatMap((channel) => {
      const name = sanitizeMessagingContactLabel(channel.name);
      const validKind =
        channel.type === DISCORD_GUILD_TEXT_CHANNEL
        || channel.type === DISCORD_GUILD_ANNOUNCEMENT_CHANNEL;
      if (
        !validKind
        || channel.guild_id !== request.guildId
        || typeof channel.id !== "string"
        || !validateDiscordSnowflake(channel.id).ok
        || !name
      ) {
        return [];
      }
      const category =
        typeof channel.parent_id === "string"
        && validateDiscordSnowflake(channel.parent_id).ok
          ? categories.get(channel.parent_id)
          : undefined;
      return [{
        categoryName: category?.name,
        categoryPosition: category?.position ?? -1,
        id: channel.id,
        kind: channel.type === DISCORD_GUILD_ANNOUNCEMENT_CHANNEL
          ? "announcement" as const
          : "text" as const,
        name,
        position: validDiscordChannelPosition(channel.position),
      }];
    });
    channels.sort((left, right) =>
      left.categoryPosition - right.categoryPosition
      || left.position - right.position
      || left.name.localeCompare(right.name)
      || left.id.localeCompare(right.id),
    );

    const guildName = sanitizeMessagingContactLabel(guild.name);
    return {
      channels: channels.map(({
        categoryPosition: _categoryPosition,
        position: _position,
        ...channel
      }) => channel),
      guildId: request.guildId,
      guildName: guildName || undefined,
      status: "ok",
    };
  } catch (error) {
    return {
      channels: [],
      errorMessage: clipMessagingValidationError(
        error instanceof Error ? error.message : String(error),
      ),
      guildId: request.guildId,
      status: "failed",
    };
  }
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
    if (channel.guild_id !== request.guildId) {
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

function validDiscordChannelPosition(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  return Number.MAX_SAFE_INTEGER;
}

function permissionBits(value: string | undefined): bigint {
  if (!value || !/^[0-9]+$/.test(value)) {
    return 0n;
  }
  return BigInt(value);
}
