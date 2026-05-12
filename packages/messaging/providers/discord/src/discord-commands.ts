import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ApplicationIntegrationType,
  InteractionContextType,
} from "discord.js";

export type DiscordApplicationCommandOption = {
  description: string;
  name: string;
  required?: boolean;
  type: number;
};

export type DiscordApplicationCommandBody = {
  contexts?: number[];
  description: string;
  integration_types?: number[];
  name: string;
  options?: DiscordApplicationCommandOption[];
  type: number;
};

export type DiscordApplicationCommand = DiscordApplicationCommandBody & {
  application_id?: string;
  description_localized?: string;
  dm_permission?: boolean;
  guild_id?: string;
  id: string;
  name_localized?: string;
  nsfw?: boolean;
  version?: string;
};

export type DiscordApplicationCommandApi = {
  createApplicationCommand(
    applicationId: string,
    command: DiscordApplicationCommandBody,
  ): Promise<DiscordApplicationCommand>;
  deleteApplicationCommand(applicationId: string, commandId: string): Promise<void>;
  listApplicationCommands(applicationId: string): Promise<DiscordApplicationCommand[]>;
  updateApplicationCommand(
    applicationId: string,
    commandId: string,
    command: DiscordApplicationCommandBody,
  ): Promise<DiscordApplicationCommand>;
};

const COMMAND_CONTEXTS = [
  InteractionContextType.Guild,
  InteractionContextType.BotDM,
  InteractionContextType.PrivateChannel,
];
const COMMAND_INTEGRATION_TYPES = [
  ApplicationIntegrationType.GuildInstall,
  ApplicationIntegrationType.UserInstall,
];

export const DISCORD_APPLICATION_COMMANDS: DiscordApplicationCommandBody[] = [
  {
    contexts: COMMAND_CONTEXTS,
    description: "Choose a PwrAgent thread to control from this conversation.",
    integration_types: COMMAND_INTEGRATION_TYPES,
    name: "resume",
    options: [
      {
        description: "Optional resume flags, such as --projects or --new.",
        name: "args",
        required: false,
        type: ApplicationCommandOptionType.String,
      },
    ],
    type: ApplicationCommandType.ChatInput,
  },
  {
    contexts: COMMAND_CONTEXTS,
    description: "Show the current PwrAgent thread binding and controls.",
    integration_types: COMMAND_INTEGRATION_TYPES,
    name: "status",
    type: ApplicationCommandType.ChatInput,
  },
  {
    contexts: COMMAND_CONTEXTS,
    description: "Detach this conversation from its current PwrAgent thread.",
    integration_types: COMMAND_INTEGRATION_TYPES,
    name: "detach",
    type: ApplicationCommandType.ChatInput,
  },
  {
    contexts: COMMAND_CONTEXTS,
    description: "Monitor recent PwrAgent threads once per minute.",
    integration_types: COMMAND_INTEGRATION_TYPES,
    name: "monitor",
    type: ApplicationCommandType.ChatInput,
  },
];

export async function reconcileDiscordApplicationCommands(params: {
  api: DiscordApplicationCommandApi;
  applicationId: string;
  commands?: DiscordApplicationCommandBody[];
  log?: (message: string, extra?: Record<string, unknown>) => void;
}): Promise<{
  created: number;
  deleted: number;
  desiredCount: number;
  liveCount: number;
  updated: number;
}> {
  const log = params.log ?? (() => {});
  const desiredBodies = params.commands ?? DISCORD_APPLICATION_COMMANDS;
  const liveCommands = await params.api.listApplicationCommands(params.applicationId);
  const liveByKey = new Map(
    liveCommands.map((command) => [commandKey(command), command]),
  );
  const desiredCommands = desiredBodies.map((command) => ({
    body: command,
    key: commandKey(command),
  }));
  const desiredKeys = new Set(desiredCommands.map((command) => command.key));
  let created = 0;
  let deleted = 0;
  let updated = 0;

  for (const live of liveCommands) {
    const key = commandKey(live);
    if (desiredKeys.has(key)) {
      continue;
    }

    log("deleting stale command", { key, id: live.id });
    await params.api.deleteApplicationCommand(params.applicationId, live.id);
    liveByKey.delete(key);
    deleted += 1;
  }

  for (const desired of desiredCommands) {
    const existing = liveByKey.get(desired.key);
    if (!existing) {
      continue;
    }
    if (commandsEqual(existing, desired.body)) {
      continue;
    }

    const normalizedLive = normalizeLiveCommand(existing);
    const normalizedDesired = normalizeCommand(desired.body);
    log("command drift detected — updating", {
      key: desired.key,
      live: normalizedLive,
      desired: normalizedDesired,
      rawLiveKeys: Object.keys(existing).sort(),
    });

    const patched = await params.api.updateApplicationCommand(
      params.applicationId,
      existing.id,
      desired.body,
    );
    liveByKey.set(desired.key, patched);
    updated += 1;
  }

  for (const desired of desiredCommands) {
    if (liveByKey.has(desired.key)) {
      continue;
    }

    const posted = await params.api.createApplicationCommand(
      params.applicationId,
      desired.body,
    );
    liveByKey.set(desired.key, posted);
    created += 1;
  }

  return {
    created,
    deleted,
    desiredCount: desiredCommands.length,
    liveCount: liveCommands.length,
    updated,
  };
}

function commandKey(command: Pick<DiscordApplicationCommandBody, "name" | "type">): string {
  return `${command.type}:${command.name}`;
}

function commandsEqual(
  live: DiscordApplicationCommand,
  desired: DiscordApplicationCommandBody,
): boolean {
  return JSON.stringify(normalizeLiveCommand(live)) === JSON.stringify(normalizeCommand(desired));
}

function normalizeLiveCommand(command: DiscordApplicationCommand): unknown {
  const responseOnlyFields = new Set([
    "application_id",
    "default_member_permissions",
    "description_localized",
    "dm_permission",
    "guild_id",
    "id",
    "name_localized",
    "nsfw",
    "version",
  ]);
  return normalizeCommand(
    Object.fromEntries(
      Object.entries(command).filter(([key]) => !responseOnlyFields.has(key)),
    ),
  );
}

function normalizeCommand(value: unknown, path: string[] = []): unknown {
  if (Array.isArray(value)) {
    const normalized = value.map((entry) => normalizeCommand(entry, path));
    const key = path.at(-1);
    if (
      key
      && ["channel_types", "contexts", "integration_types"].includes(key)
      && normalized.every(
        (entry) =>
          typeof entry === "string"
          || typeof entry === "number"
          || typeof entry === "boolean",
      )
    ) {
      return [...normalized].sort();
    }
    return normalized;
  }

  if (value && typeof value === "object") {
    const subcommandOnlyFields = new Set([
      "contexts",
      "default_member_permissions",
      "description_localizations",
      "integration_types",
      "name_localizations",
    ]);
    const normalizedEntries = Object.entries(value as Record<string, unknown>).flatMap(
      ([key, entry]) => {
        if (path.includes("options") && subcommandOnlyFields.has(key)) {
          return [];
        }
        if ((key === "required" || key === "autocomplete") && entry === false) {
          return [];
        }

        const normalized = normalizeCommand(entry, [...path, key]);
        if (normalized === undefined) {
          return [];
        }

        return [[key, normalized] as const];
      },
    );

    return Object.fromEntries(
      normalizedEntries.sort(([left], [right]) => left.localeCompare(right)),
    );
  }

  return value;
}
