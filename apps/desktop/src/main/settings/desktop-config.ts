import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  DesktopAppearanceDensity,
  DesktopAppearanceTheme,
  DesktopChatReplyComposer,
  DesktopAuthorizedContact,
  DesktopMessagingFullAccessWarningGlobalPolicy,
  DesktopMessagingFullAccessWarningUserPolicy,
  DesktopMessagingImageProfile,
  DesktopOnboardingCompletedSource,
  DesktopSettingsConfigPatch,
  DesktopUpdateChannel,
  DesktopWorktreeStorageLocation,
  MessagingToolUpdateMode,
} from "@pwragent/shared";
import {
  DESKTOP_APPEARANCE_DENSITY_DEFAULT,
  DESKTOP_APPEARANCE_THEME_DEFAULT,
  DESKTOP_UPDATE_CHANNEL_DEFAULT,
  isDesktopAppearanceDensity,
  isDesktopAppearanceTheme,
  isDesktopOnboardingCompletedSource,
  isDesktopWorktreeStorageLocation,
  isDesktopUpdateChannel,
  sanitizeMessagingContactLabel,
} from "@pwragent/shared";
import { DEFAULT_PASTED_IMAGE_MAX_PATCHES } from "../../shared/image-normalization";
import { resolveActiveProfilePath } from "../profile";
import {
  applyTomlEdits,
  parseTomlTables,
  type TomlEdit,
  type TomlTables,
  type TomlValue,
} from "./toml-editor";

type DesktopConfigPathOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  xdgConfigHome?: string;
  cliProfile?: string;
  argv?: readonly string[];
};

type AuthorizedContactConfig = DesktopAuthorizedContact;
type LegacyChatReplyComposer =
  | "textarea"
  | "tiptap-chips"
  | "custom-widget-chips";
type StoredChatReplyComposer =
  | DesktopChatReplyComposer
  | LegacyChatReplyComposer;

export type DesktopSettingsConfig = {
  general?: {
    developerMode?: boolean;
    appearance?: {
      theme?: DesktopAppearanceTheme;
      density?: DesktopAppearanceDensity;
    };
  };
  onboarding?: {
    completed?: boolean;
    completedSource?: DesktopOnboardingCompletedSource;
  };
  experimental?: {
    chatReplyComposer?: StoredChatReplyComposer;
    fullAccessRiskWarningDismissed?: boolean;
    diffCondensation?: {
      enabled?: boolean;
      model?: string;
    };
  };
  imageUploads?: {
    pastedImageMaxPatches?: number;
  };
  updates?: {
    channel?: DesktopUpdateChannel;
  };
  messaging?: {
    enabled?: boolean;
    allowFullAccessEscalation?: boolean;
    allowFullAccessThreadResume?: boolean;
    fullAccessWarning?: DesktopMessagingFullAccessWarningGlobalPolicy;
    inputDebounceMs?: number;
    toolUpdateMode?: MessagingToolUpdateMode;
    attachments?: {
      imageProfile?: DesktopMessagingImageProfile;
      maxAttachmentBytes?: number;
      maxAttachmentCount?: number;
    };
    telegram?: {
      enabled?: boolean;
      streamingResponses?: boolean;
      authorizedUserIds?: AuthorizedContactConfig[];
      authorizedSupergroups?: AuthorizedContactConfig[];
    };
    discord?: {
      enabled?: boolean;
      streamingResponses?: boolean;
      applicationId?: string;
      authorizedUserIds?: AuthorizedContactConfig[];
      authorizedGuilds?: AuthorizedContactConfig[];
    };
    mattermost?: {
      enabled?: boolean;
      streamingResponses?: boolean;
      serverUrl?: string;
      callbackBaseUrl?: string;
      slashCommandPrefix?: string;
      registerSlashCommands?: boolean;
      authorizedUserIds?: AuthorizedContactConfig[];
      authorizedTeams?: AuthorizedContactConfig[];
      authorizedConversations?: AuthorizedContactConfig[];
    };
    slack?: {
      enabled?: boolean;
      streamingResponses?: boolean;
      workspaceUrl?: string;
      inboundMode?: "socket" | "events";
      slashCommandPrefix?: string;
      registerSlashCommands?: boolean;
      authorizedUserIds?: AuthorizedContactConfig[];
      authorizedWorkspaces?: AuthorizedContactConfig[];
    };
    feishu?: {
      enabled?: boolean;
      streamingResponses?: boolean;
      inboundMode?: "persistent" | "webhook";
      tenantRegion?: "feishu" | "lark";
      tenantUrl?: string;
      callbackBaseUrl?: string;
      slashCommandPrefix?: string;
      registerSlashCommands?: boolean;
      authorizedUserIds?: AuthorizedContactConfig[];
      authorizedChats?: AuthorizedContactConfig[];
      authorizedTenants?: AuthorizedContactConfig[];
    };
    line?: {
      enabled?: boolean;
      streamingResponses?: boolean;
      webhookUrl?: string;
      callbackBaseUrl?: string;
      botUserId?: string;
      authorizedUserIds?: AuthorizedContactConfig[];
      authorizedGroups?: AuthorizedContactConfig[];
      authorizedRooms?: AuthorizedContactConfig[];
    };
  };
  models?: {
    codex?: {
      path?: string;
      profile?: string;
    };
  };
  applications?: {
    editor?: {
      preferredId?: string;
    };
    terminal?: {
      preferredId?: string;
    };
    gh?: {
      path?: string;
    };
  };
  worktrees?: {
    storage?: DesktopWorktreeStorageLocation;
  };
};

type TomlScalar = TomlValue;

const LEGACY_AUTHORIZED_CONTACT_LAST_VERSION = "1.0.0-alpha.9";
const LEGACY_AUTHORIZED_CONTACT_MARKER = "pwragent-legacy-settings";
const LEGACY_CHAT_REPLY_COMPOSER_LAST_VERSION = "1.0.0-alpha.8";

export function defaultDesktopConfigDir(
  options?: DesktopConfigPathOptions,
): string {
  const env = options?.env ?? process.env;
  const homeDir = options?.homeDir ?? os.homedir();
  const xdgConfigHome =
    options?.xdgConfigHome?.trim() || env.XDG_CONFIG_HOME?.trim();

  return path.join(xdgConfigHome || path.join(homeDir, ".config"), "pwragent");
}

export function userHomeWorktreesRoot(homeDir?: string): string {
  return path.join(homeDir ?? os.homedir(), ".pwragent", "worktrees");
}

export function resolveDesktopConfigPath(
  options?: DesktopConfigPathOptions,
): string {
  return resolveActiveProfilePath("config.toml", options);
}

export function readDesktopSettingsConfig(
  configPath: string,
): DesktopSettingsConfig {
  if (!fs.existsSync(configPath)) {
    return {};
  }

  return parseDesktopSettingsToml(fs.readFileSync(configPath, "utf8"), configPath);
}

/**
 * Apply a settings patch to the on-disk config by editing only the keys named
 * in the patch. Sections, comments, blank lines, and unknown keys outside the
 * patch are preserved byte-for-byte. The file is never round-tripped through
 * a typed config, so unknown sections written by other builds survive a save.
 */
export function applyDesktopSettingsPatch(
  configPath: string,
  patch: DesktopSettingsConfigPatch,
): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const source = fs.existsSync(configPath)
    ? fs.readFileSync(configPath, "utf8")
    : "";
  const edits = desktopSettingsPatchToEdits(
    patch,
    parseTomlTables(source, configPath),
  );
  if (edits.length === 0) {
    return;
  }
  const next = applyTomlEdits(source, edits);
  if (next === source) {
    return;
  }
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, next, "utf8");
  fs.renameSync(temporaryPath, configPath);
}

export function desktopSettingsPatchToEdits(
  patch: DesktopSettingsConfigPatch,
  currentTables: TomlTables = {},
): TomlEdit[] {
  const edits: TomlEdit[] = [];

  const set = (
    pathSegments: readonly string[],
    value: string | number | boolean | readonly string[] | undefined,
  ): void => {
    if (value === undefined) return;
    edits.push({ op: "set", path: pathSegments, value });
  };
  if (currentTables.experimental?.chat_reply_composer !== undefined) {
    edits.push({
      op: "ensureCommentBefore",
      path: ["experimental", "chat_reply_composer"],
      marker: LEGACY_AUTHORIZED_CONTACT_MARKER,
      comment: legacyChatReplyComposerComment(),
    });
  }
  const setAuthorizedContacts = (
    tablePath: readonly string[],
    legacyKey: string,
    canonicalKey: string,
    value: readonly DesktopAuthorizedContact[] | undefined,
    oldTableArrayKeys: readonly string[] = [],
  ): void => {
    if (value === undefined) return;
    const tableName = tablePath.join(".");
    const listKey = `${canonicalKey}_list`;
    const table = currentTables[tableName];
    const hasLegacyScalar = readStringArray(table?.[legacyKey]) !== undefined;
    const hasListTable = readAuthorizedContactArray(table?.[listKey]) !== undefined;
    const tableArrayKey =
      (hasLegacyScalar && canonicalKey === legacyKey) || hasListTable
        ? listKey
        : canonicalKey;
    const tableArrayPath = [...tablePath, tableArrayKey];
    const normalizedContacts = normalizeAuthorizedContacts(value);

    for (const staleKey of [legacyKey, listKey, ...oldTableArrayKeys]) {
      if (staleKey === tableArrayKey) continue;
      if (staleKey === legacyKey && hasLegacyScalar) continue;
      edits.push({ op: "delete", path: [...tablePath, staleKey] });
      edits.push({ op: "deleteTableArray", path: [...tablePath, staleKey] });
    }

    if (hasLegacyScalar) {
      edits.push({
        op: "ensureCommentBefore",
        path: [...tablePath, legacyKey],
        marker: LEGACY_AUTHORIZED_CONTACT_MARKER,
        comment: legacyAuthorizedContactComment(legacyKey),
      });
      edits.push({
        op: "set",
        path: [...tablePath, legacyKey],
        value: normalizedContacts.map((contact) => contact.id),
      });
    }

    edits.push({ op: "delete", path: tableArrayPath });
    edits.push({ op: "deleteTableArray", path: tableArrayPath });
    if (normalizedContacts.length === 0) {
      return;
    }
    edits.push({
      op: "setTableArray",
      path: tableArrayPath,
      value: normalizedContacts.map((contact) => ({
        id: contact.id,
        display_name: contact.displayName,
        ...(contact.fullAccessWarningOverride
          ? { full_access_warning: contact.fullAccessWarningOverride }
          : {}),
        ...(contact.fullAccessWarningDismissed === true
          ? { full_access_warning_dismissed: true }
          : {}),
      })),
    });
  };

  // `chat_reply_composer` is obsolete and intentionally ignored by current
  // clients. Preserve existing values for downgrade compatibility, but do not
  // write new values.
  if (patch.general?.developerMode !== undefined) {
    set(["general", "developer_mode"], patch.general.developerMode);
  }

  if (patch.experimental?.diffCondensation?.enabled !== undefined) {
    set(
      ["experimental", "diff_condensation", "enabled"],
      patch.experimental.diffCondensation.enabled,
    );
  }
  if (patch.experimental?.fullAccessRiskWarningDismissed !== undefined) {
    set(
      ["experimental", "full_access_risk_warning_dismissed"],
      patch.experimental.fullAccessRiskWarningDismissed,
    );
  }
  if (patch.experimental?.diffCondensation?.model !== undefined) {
    set(
      ["experimental", "diff_condensation", "model"],
      patch.experimental.diffCondensation.model,
    );
  }

  if (patch.general?.appearance?.theme !== undefined) {
    if (patch.general.appearance.theme === DESKTOP_APPEARANCE_THEME_DEFAULT) {
      edits.push({ op: "delete", path: ["general", "appearance", "theme"] });
    } else {
      set(["general", "appearance", "theme"], patch.general.appearance.theme);
    }
  }
  if (patch.onboarding?.completed !== undefined) {
    set(["onboarding", "completed"], patch.onboarding.completed);
  }
  if (patch.onboarding?.completedSource !== undefined) {
    set(["onboarding", "completed_source"], patch.onboarding.completedSource);
  }

  if (patch.general?.appearance?.density !== undefined) {
    if (
      patch.general.appearance.density === DESKTOP_APPEARANCE_DENSITY_DEFAULT
    ) {
      edits.push({ op: "delete", path: ["general", "appearance", "density"] });
    } else {
      set(
        ["general", "appearance", "density"],
        patch.general.appearance.density,
      );
    }
  }

  if (patch.imageUploads?.pastedImageMaxPatches !== undefined) {
    const pastedImageMaxPatches = patch.imageUploads.pastedImageMaxPatches;
    if (pastedImageMaxPatches === DEFAULT_PASTED_IMAGE_MAX_PATCHES) {
      edits.push({
        op: "delete",
        path: ["image_uploads", "pasted_image_max_patches"],
      });
    } else {
      set(
        ["image_uploads", "pasted_image_max_patches"],
        pastedImageMaxPatches,
      );
    }
  }

  if (patch.updates?.channel !== undefined) {
    if (patch.updates.channel === DESKTOP_UPDATE_CHANNEL_DEFAULT) {
      edits.push({
        op: "delete",
        path: ["updates", "channel"],
      });
    } else {
      set(["updates", "channel"], patch.updates.channel);
    }
  }

  if (patch.messaging?.inputDebounceMs !== undefined) {
    set(["messaging", "input_debounce_ms"], patch.messaging.inputDebounceMs);
  }
  if (patch.messaging?.enabled !== undefined) {
    set(["messaging", "enabled"], patch.messaging.enabled);
  }
  if (patch.messaging?.allowFullAccessThreadResume !== undefined) {
    set(
      ["messaging", "allow_full_access_thread_resume"],
      patch.messaging.allowFullAccessThreadResume,
    );
  }
  if (patch.messaging?.allowFullAccessEscalation !== undefined) {
    set(
      ["messaging", "allow_full_access_escalation"],
      patch.messaging.allowFullAccessEscalation,
    );
  }
  if (patch.messaging?.fullAccessWarning !== undefined) {
    set(["messaging", "full_access_warning"], patch.messaging.fullAccessWarning);
  }
  if (patch.messaging?.toolUpdateMode !== undefined) {
    set(["messaging", "tool_update_mode"], patch.messaging.toolUpdateMode);
  }

  const attachments = patch.messaging?.attachments;
  if (attachments?.imageProfile !== undefined) {
    if (attachments.imageProfile === "medium") {
      edits.push({
        op: "delete",
        path: ["messaging", "attachments", "image_profile"],
      });
    } else {
      set(["messaging", "attachments", "image_profile"], attachments.imageProfile);
    }
  }
  if (attachments?.maxAttachmentBytes !== undefined) {
    set(["messaging", "attachments", "max_attachment_bytes"], attachments.maxAttachmentBytes);
  }
  if (attachments?.maxAttachmentCount !== undefined) {
    set(["messaging", "attachments", "max_attachment_count"], attachments.maxAttachmentCount);
  }

  const telegram = patch.messaging?.telegram;
  if (telegram?.enabled !== undefined) {
    set(["messaging", "telegram", "enabled"], telegram.enabled);
  }
  if (telegram?.streamingResponses !== undefined) {
    set(["messaging", "telegram", "streaming_responses"], telegram.streamingResponses);
  }
  if (telegram?.authorizedUserIds !== undefined) {
    setAuthorizedContacts(
      ["messaging", "telegram"],
      "authorized_user_ids",
      "authorized_users",
      telegram.authorizedUserIds,
      ["authorized_user_ids_list"],
    );
  }
  if (telegram?.authorizedSupergroups !== undefined) {
    setAuthorizedContacts(
      ["messaging", "telegram"],
      "authorized_supergroups",
      "authorized_supergroups",
      telegram.authorizedSupergroups,
    );
  }

  const discord = patch.messaging?.discord;
  if (discord?.enabled !== undefined) {
    set(["messaging", "discord", "enabled"], discord.enabled);
  }
  if (discord?.streamingResponses !== undefined) {
    set(["messaging", "discord", "streaming_responses"], discord.streamingResponses);
  }
  if (discord?.applicationId !== undefined) {
    set(["messaging", "discord", "application_id"], discord.applicationId);
  }
  if (discord?.authorizedUserIds !== undefined) {
    setAuthorizedContacts(
      ["messaging", "discord"],
      "authorized_user_ids",
      "authorized_users",
      discord.authorizedUserIds,
      ["authorized_user_ids_list"],
    );
  }
  if (discord?.authorizedGuilds !== undefined) {
    setAuthorizedContacts(
      ["messaging", "discord"],
      "authorized_guilds",
      "authorized_guilds",
      discord.authorizedGuilds,
    );
  }

  const mattermost = patch.messaging?.mattermost;
  if (mattermost?.enabled !== undefined) {
    set(["messaging", "mattermost", "enabled"], mattermost.enabled);
  }
  if (mattermost?.streamingResponses !== undefined) {
    set(
      ["messaging", "mattermost", "streaming_responses"],
      mattermost.streamingResponses,
    );
  }
  if (mattermost?.serverUrl !== undefined) {
    set(["messaging", "mattermost", "server_url"], mattermost.serverUrl);
  }
  if (mattermost?.callbackBaseUrl !== undefined) {
    set(
      ["messaging", "mattermost", "callback_base_url"],
      mattermost.callbackBaseUrl,
    );
  }
  if (mattermost?.slashCommandPrefix !== undefined) {
    set(
      ["messaging", "mattermost", "slash_command_prefix"],
      mattermost.slashCommandPrefix,
    );
  }
  if (mattermost?.registerSlashCommands !== undefined) {
    set(
      ["messaging", "mattermost", "register_slash_commands"],
      mattermost.registerSlashCommands,
    );
  }
  if (mattermost?.authorizedUserIds !== undefined) {
    setAuthorizedContacts(
      ["messaging", "mattermost"],
      "authorized_user_ids",
      "authorized_users",
      mattermost.authorizedUserIds,
      ["authorized_user_ids_list"],
    );
  }
  if (mattermost?.authorizedTeams !== undefined) {
    setAuthorizedContacts(
      ["messaging", "mattermost"],
      "authorized_team_ids",
      "authorized_teams",
      mattermost.authorizedTeams,
      ["authorized_team_ids_list"],
    );
  }
  if (mattermost?.authorizedConversations !== undefined) {
    setAuthorizedContacts(
      ["messaging", "mattermost"],
      "authorized_conversation_ids",
      "authorized_conversations",
      mattermost.authorizedConversations,
      ["authorized_conversation_ids_list"],
    );
  }

  const slack = patch.messaging?.slack;
  if (slack?.enabled !== undefined) {
    set(["messaging", "slack", "enabled"], slack.enabled);
  }
  if (slack?.streamingResponses !== undefined) {
    set(["messaging", "slack", "streaming_responses"], slack.streamingResponses);
  }
  if (slack?.workspaceUrl !== undefined) {
    set(["messaging", "slack", "workspace_url"], slack.workspaceUrl);
  }
  if (slack?.inboundMode !== undefined) {
    set(["messaging", "slack", "inbound_mode"], slack.inboundMode);
  }
  if (slack?.slashCommandPrefix !== undefined) {
    set(["messaging", "slack", "slash_command_prefix"], slack.slashCommandPrefix);
  }
  if (slack?.registerSlashCommands !== undefined) {
    set(
      ["messaging", "slack", "register_slash_commands"],
      slack.registerSlashCommands,
    );
  }
  if (slack?.authorizedUserIds !== undefined) {
    setAuthorizedContacts(
      ["messaging", "slack"],
      "authorized_user_ids",
      "authorized_users",
      slack.authorizedUserIds,
      ["authorized_user_ids_list"],
    );
  }
  if (slack?.authorizedWorkspaces !== undefined) {
    setAuthorizedContacts(
      ["messaging", "slack"],
      "authorized_workspaces",
      "authorized_workspaces",
      slack.authorizedWorkspaces,
    );
  }

  const feishu = patch.messaging?.feishu;
  if (feishu?.enabled !== undefined) {
    set(["messaging", "feishu", "enabled"], feishu.enabled);
  }
  if (feishu?.streamingResponses !== undefined) {
    set(["messaging", "feishu", "streaming_responses"], feishu.streamingResponses);
  }
  if (feishu?.inboundMode !== undefined) {
    set(["messaging", "feishu", "inbound_mode"], feishu.inboundMode);
  }
  if (feishu?.tenantRegion !== undefined) {
    set(["messaging", "feishu", "tenant_region"], feishu.tenantRegion);
  }
  if (feishu?.tenantUrl !== undefined) {
    set(["messaging", "feishu", "tenant_url"], feishu.tenantUrl);
  }
  if (feishu?.callbackBaseUrl !== undefined) {
    set(["messaging", "feishu", "callback_base_url"], feishu.callbackBaseUrl);
  }
  if (feishu?.slashCommandPrefix !== undefined) {
    set(["messaging", "feishu", "slash_command_prefix"], feishu.slashCommandPrefix);
  }
  if (feishu?.registerSlashCommands !== undefined) {
    set(
      ["messaging", "feishu", "register_slash_commands"],
      feishu.registerSlashCommands,
    );
  }
  if (feishu?.authorizedUserIds !== undefined) {
    setAuthorizedContacts(
      ["messaging", "feishu"],
      "authorized_user_ids",
      "authorized_users",
      feishu.authorizedUserIds,
      ["authorized_user_ids_list"],
    );
  }
  if (feishu?.authorizedChats !== undefined) {
    setAuthorizedContacts(
      ["messaging", "feishu"],
      "authorized_chats",
      "authorized_chats",
      feishu.authorizedChats,
    );
  }
  if (feishu?.authorizedTenants !== undefined) {
    setAuthorizedContacts(
      ["messaging", "feishu"],
      "authorized_tenants",
      "authorized_tenants",
      feishu.authorizedTenants,
    );
  }

  const line = patch.messaging?.line;
  if (line?.enabled !== undefined) {
    set(["messaging", "line", "enabled"], line.enabled);
  }
  if (line?.streamingResponses !== undefined) {
    set(["messaging", "line", "streaming_responses"], line.streamingResponses);
  }
  if (line?.webhookUrl !== undefined) {
    set(["messaging", "line", "webhook_url"], line.webhookUrl);
  }
  if (line?.callbackBaseUrl !== undefined) {
    set(["messaging", "line", "callback_base_url"], line.callbackBaseUrl);
  }
  if (line?.botUserId !== undefined) {
    set(["messaging", "line", "bot_user_id"], line.botUserId);
  }
  if (line?.authorizedUserIds !== undefined) {
    setAuthorizedContacts(
      ["messaging", "line"],
      "authorized_user_ids",
      "authorized_users",
      line.authorizedUserIds,
      ["authorized_user_ids_list"],
    );
  }
  if (line?.authorizedGroups !== undefined) {
    setAuthorizedContacts(
      ["messaging", "line"],
      "authorized_groups",
      "authorized_groups",
      line.authorizedGroups,
    );
  }
  if (line?.authorizedRooms !== undefined) {
    setAuthorizedContacts(
      ["messaging", "line"],
      "authorized_rooms",
      "authorized_rooms",
      line.authorizedRooms,
    );
  }

  if (patch.models?.codex?.path !== undefined) {
    set(["models", "codex", "path"], patch.models.codex.path);
  }
  if (patch.models?.codex?.profile !== undefined) {
    set(["models", "codex", "profile"], patch.models.codex.profile);
  }

  if (patch.applications?.editor?.preferredId !== undefined) {
    set(["applications", "editor", "preferred_id"], patch.applications.editor.preferredId);
  }
  if (patch.applications?.terminal?.preferredId !== undefined) {
    set(["applications", "terminal", "preferred_id"], patch.applications.terminal.preferredId);
  }
  if (patch.applications?.gh?.path !== undefined) {
    set(["applications", "gh", "path"], patch.applications.gh.path);
  }

  if (patch.worktrees?.storage !== undefined) {
    set(["worktrees", "storage"], patch.worktrees.storage);
  }

  return edits;
}

export function parseDesktopSettingsToml(
  contents: string,
  filePath: string,
): DesktopSettingsConfig {
  return normalizeDesktopConfig(parseTomlTables(contents, filePath));
}

function normalizeDesktopConfig(
  tables: Record<string, Record<string, TomlScalar>>,
): DesktopSettingsConfig {
  const general = tables["general"];
  const generalAppearance = tables["general.appearance"];
  const onboarding = tables["onboarding"];
  const experimental = tables["experimental"];
  const diffCondensation = tables["experimental.diff_condensation"];
  const imageUploads = tables["image_uploads"];
  const updates = tables["updates"];
  const messaging = tables["messaging"];
  const attachments = tables["messaging.attachments"];
  const telegram = tables["messaging.telegram"];
  const discord = tables["messaging.discord"];
  const mattermost = tables["messaging.mattermost"];
  const slack = tables["messaging.slack"];
  const feishu = tables["messaging.feishu"];
  const line = tables["messaging.line"];
  const codex = tables["models.codex"];
  const editor = tables["applications.editor"];
  const terminal = tables["applications.terminal"];
  const gh = tables["applications.gh"];
  const worktrees = tables["worktrees"];

  return pruneEmptyConfig({
    general: {
      developerMode: readBoolean(general?.developer_mode),
      appearance: {
        theme: readAppearanceTheme(generalAppearance?.theme),
        density: readAppearanceDensity(generalAppearance?.density),
      },
    },
    onboarding: {
      completed: readBoolean(onboarding?.completed),
      completedSource: readOnboardingCompletedSource(
        onboarding?.completed_source,
      ),
    },
    experimental: {
      chatReplyComposer: readComposer(experimental?.chat_reply_composer),
      fullAccessRiskWarningDismissed: readBoolean(
        experimental?.full_access_risk_warning_dismissed,
      ),
      diffCondensation: {
        enabled: readBoolean(diffCondensation?.enabled),
        model: readString(diffCondensation?.model),
      },
    },
    imageUploads: {
      pastedImageMaxPatches: readNumber(
        imageUploads?.pasted_image_max_patches,
      ),
    },
    updates: {
      channel: readUpdateChannel(updates?.channel),
    },
    messaging: {
      enabled: readBoolean(messaging?.enabled),
      allowFullAccessEscalation: readBoolean(
        messaging?.allow_full_access_escalation,
      ),
      allowFullAccessThreadResume: readBoolean(
        messaging?.allow_full_access_thread_resume,
      ),
      fullAccessWarning: readFullAccessWarningGlobalPolicy(
        messaging?.full_access_warning,
      ),
      inputDebounceMs: readNumber(messaging?.input_debounce_ms),
      toolUpdateMode: readToolUpdateMode(messaging?.tool_update_mode),
      attachments: {
        imageProfile: readImageProfile(attachments?.image_profile),
        maxAttachmentBytes: readNumber(attachments?.max_attachment_bytes),
        maxAttachmentCount: readNumber(attachments?.max_attachment_count),
      },
      telegram: {
        enabled: readBoolean(telegram?.enabled),
        streamingResponses: readBoolean(telegram?.streaming_responses),
        authorizedUserIds: readAuthorizedContacts(
          telegram?.authorized_users,
          telegram?.authorized_user_ids_list,
          telegram?.authorized_user_ids,
        ),
        authorizedSupergroups: readAuthorizedContacts(
          telegram?.authorized_supergroups_list,
          telegram?.authorized_supergroups,
        ),
      },
      discord: {
        enabled: readBoolean(discord?.enabled),
        streamingResponses: readBoolean(discord?.streaming_responses),
        applicationId: readString(discord?.application_id),
        authorizedUserIds: readAuthorizedContacts(
          discord?.authorized_users,
          discord?.authorized_user_ids_list,
          discord?.authorized_user_ids,
        ),
        authorizedGuilds: readAuthorizedContacts(
          discord?.authorized_guilds_list,
          discord?.authorized_guilds,
        ),
      },
      mattermost: {
        enabled: readBoolean(mattermost?.enabled),
        streamingResponses: readBoolean(mattermost?.streaming_responses),
        serverUrl: readString(mattermost?.server_url),
        callbackBaseUrl: readString(mattermost?.callback_base_url),
        slashCommandPrefix: readString(mattermost?.slash_command_prefix),
        registerSlashCommands: readBoolean(mattermost?.register_slash_commands),
        authorizedUserIds: readAuthorizedContacts(
          mattermost?.authorized_users,
          mattermost?.authorized_user_ids_list,
          mattermost?.authorized_user_ids,
        ),
        authorizedTeams: readAuthorizedContacts(
          mattermost?.authorized_teams,
          mattermost?.authorized_teams_list,
          mattermost?.authorized_team_ids_list,
          mattermost?.authorized_team_ids,
        ),
        authorizedConversations: readAuthorizedContacts(
          mattermost?.authorized_conversations,
          mattermost?.authorized_conversations_list,
          mattermost?.authorized_conversation_ids_list,
          mattermost?.authorized_conversation_ids,
        ),
      },
      slack: {
        enabled: readBoolean(slack?.enabled),
        streamingResponses: readBoolean(slack?.streaming_responses),
        workspaceUrl: readString(slack?.workspace_url),
        inboundMode: readSlackInboundMode(slack?.inbound_mode),
        slashCommandPrefix: readString(slack?.slash_command_prefix),
        registerSlashCommands: readBoolean(slack?.register_slash_commands),
        authorizedUserIds: readAuthorizedContacts(
          slack?.authorized_users,
          slack?.authorized_user_ids_list,
          slack?.authorized_user_ids,
        ),
        authorizedWorkspaces: readAuthorizedContacts(
          slack?.authorized_workspaces_list,
          slack?.authorized_workspaces,
        ),
      },
      feishu: {
        enabled: readBoolean(feishu?.enabled),
        streamingResponses: readBoolean(feishu?.streaming_responses),
        inboundMode: readFeishuInboundMode(feishu?.inbound_mode),
        tenantRegion: readFeishuTenantRegion(feishu?.tenant_region),
        tenantUrl: readString(feishu?.tenant_url),
        callbackBaseUrl: readString(feishu?.callback_base_url),
        slashCommandPrefix: readString(feishu?.slash_command_prefix),
        registerSlashCommands: readBoolean(feishu?.register_slash_commands),
        authorizedUserIds: readAuthorizedContacts(
          feishu?.authorized_users,
          feishu?.authorized_user_ids_list,
          feishu?.authorized_user_ids,
        ),
        authorizedChats: readAuthorizedContacts(
          feishu?.authorized_chats,
          feishu?.authorized_chats_list,
        ),
        authorizedTenants: readAuthorizedContacts(
          feishu?.authorized_tenants,
          feishu?.authorized_tenants_list,
        ),
      },
      line: {
        enabled: readBoolean(line?.enabled),
        streamingResponses: readBoolean(line?.streaming_responses),
        webhookUrl: readString(line?.webhook_url),
        callbackBaseUrl: readString(line?.callback_base_url),
        botUserId: readString(line?.bot_user_id),
        authorizedUserIds: readAuthorizedContacts(
          line?.authorized_users,
          line?.authorized_user_ids_list,
          line?.authorized_user_ids,
        ),
        authorizedGroups: readAuthorizedContacts(
          line?.authorized_groups_list,
          line?.authorized_groups,
        ),
        authorizedRooms: readAuthorizedContacts(
          line?.authorized_rooms_list,
          line?.authorized_rooms,
        ),
      },
    },
    models: {
      codex: {
        path: readString(codex?.path),
        profile: readString(codex?.profile),
      },
    },
    applications: {
      editor: {
        preferredId: readString(editor?.preferred_id),
      },
      terminal: {
        preferredId: readString(terminal?.preferred_id),
      },
      gh: {
        path: readString(gh?.path),
      },
    },
    worktrees: {
      storage: readWorktreeStorage(worktrees?.storage),
    },
  });
}

function pruneEmptyConfig(config: DesktopSettingsConfig): DesktopSettingsConfig {
  const pruned: DesktopSettingsConfig = {};

  const developerMode = config.general?.developerMode;
  const appearance = config.general?.appearance;
  const appearanceDefined = appearance && hasDefinedValue(appearance);
  if (developerMode !== undefined || appearanceDefined) {
    pruned.general = {};
    if (developerMode !== undefined) {
      pruned.general.developerMode = developerMode;
    }
    if (appearanceDefined) {
      pruned.general.appearance = appearance;
    }
  }

  const onboarding = config.onboarding;
  if (onboarding && hasDefinedValue(onboarding)) {
    pruned.onboarding = {};
    if (onboarding.completed !== undefined) {
      pruned.onboarding.completed = onboarding.completed;
    }
    if (onboarding.completedSource !== undefined) {
      pruned.onboarding.completedSource = onboarding.completedSource;
    }
  }

  if (config.experimental && hasDefinedValue(config.experimental)) {
    pruned.experimental = config.experimental;
  }

  if (config.imageUploads && hasDefinedValue(config.imageUploads)) {
    pruned.imageUploads = config.imageUploads;
  }

  if (config.updates && hasDefinedValue(config.updates)) {
    pruned.updates = config.updates;
  }

  const attachments = config.messaging?.attachments;
  const telegram = config.messaging?.telegram;
  const discord = config.messaging?.discord;
  const mattermost = config.messaging?.mattermost;
  const slack = config.messaging?.slack;
  const feishu = config.messaging?.feishu;
  const line = config.messaging?.line;
  const inputDebounceMs = config.messaging?.inputDebounceMs;
  const enabled = config.messaging?.enabled;
  const allowFullAccessEscalation = config.messaging?.allowFullAccessEscalation;
  const allowFullAccessThreadResume = config.messaging?.allowFullAccessThreadResume;
  const fullAccessWarning = config.messaging?.fullAccessWarning;
  const toolUpdateMode = config.messaging?.toolUpdateMode;
  if (
    enabled !== undefined ||
    allowFullAccessEscalation !== undefined ||
    allowFullAccessThreadResume !== undefined ||
    fullAccessWarning !== undefined ||
    inputDebounceMs !== undefined ||
    toolUpdateMode !== undefined ||
    (attachments && hasDefinedValue(attachments))
    || (telegram && hasDefinedValue(telegram))
    || (discord && hasDefinedValue(discord))
    || (mattermost && hasDefinedValue(mattermost))
    || (slack && hasDefinedValue(slack))
    || (feishu && hasDefinedValue(feishu))
    || (line && hasDefinedValue(line))
  ) {
    pruned.messaging = {};
    if (enabled !== undefined) {
      pruned.messaging.enabled = enabled;
    }
    if (allowFullAccessEscalation !== undefined) {
      pruned.messaging.allowFullAccessEscalation = allowFullAccessEscalation;
    }
    if (allowFullAccessThreadResume !== undefined) {
      pruned.messaging.allowFullAccessThreadResume = allowFullAccessThreadResume;
    }
    if (fullAccessWarning !== undefined) {
      pruned.messaging.fullAccessWarning = fullAccessWarning;
    }
    if (inputDebounceMs !== undefined) {
      pruned.messaging.inputDebounceMs = inputDebounceMs;
    }
    if (toolUpdateMode !== undefined) {
      pruned.messaging.toolUpdateMode = toolUpdateMode;
    }
    if (attachments && hasDefinedValue(attachments)) {
      pruned.messaging.attachments = attachments;
    }
    if (telegram && hasDefinedValue(telegram)) {
      pruned.messaging.telegram = telegram;
    }
    if (discord && hasDefinedValue(discord)) {
      pruned.messaging.discord = discord;
    }
    if (mattermost && hasDefinedValue(mattermost)) {
      pruned.messaging.mattermost = mattermost;
    }
    if (slack && hasDefinedValue(slack)) {
      pruned.messaging.slack = slack;
    }
    if (feishu && hasDefinedValue(feishu)) {
      pruned.messaging.feishu = feishu;
    }
    if (line && hasDefinedValue(line)) {
      pruned.messaging.line = line;
    }
  }

  const codex = config.models?.codex;
  if (codex && hasDefinedValue(codex)) {
    pruned.models = { codex };
  }

  const editor = config.applications?.editor;
  const terminal = config.applications?.terminal;
  const gh = config.applications?.gh;
  if (
    (editor && hasDefinedValue(editor))
    || (terminal && hasDefinedValue(terminal))
    || (gh && hasDefinedValue(gh))
  ) {
    pruned.applications = {};
    if (editor && hasDefinedValue(editor)) {
      pruned.applications.editor = editor;
    }
    if (terminal && hasDefinedValue(terminal)) {
      pruned.applications.terminal = terminal;
    }
    if (gh && hasDefinedValue(gh)) {
      pruned.applications.gh = gh;
    }
  }

  const worktrees = config.worktrees;
  if (worktrees && hasDefinedValue(worktrees)) {
    pruned.worktrees = worktrees;
  }

  return pruned;
}

function hasDefinedValue(values: object): boolean {
  return Object.values(values).some((value) => value !== undefined);
}

function readComposer(value: TomlScalar | undefined): StoredChatReplyComposer | undefined {
  return typeof value === "string" && isDesktopChatReplyComposer(value)
    ? value
    : undefined;
}

function isDesktopChatReplyComposer(
  value: string,
): value is StoredChatReplyComposer {
  return (
    value === "textarea"
    || value === "tiptap-chips"
    || value === "tiptap-wysiwyg-markdown-chips"
    || value === "custom-widget-chips"
  );
}

function readToolUpdateMode(
  value: TomlScalar | undefined,
): MessagingToolUpdateMode | undefined {
  return typeof value === "string" && isMessagingToolUpdateMode(value)
    ? value
    : undefined;
}

function readUpdateChannel(
  value: TomlScalar | undefined,
): DesktopUpdateChannel | undefined {
  return typeof value === "string" && isDesktopUpdateChannel(value)
    ? value
    : undefined;
}

function readAppearanceTheme(
  value: TomlScalar | undefined,
): DesktopAppearanceTheme | undefined {
  return typeof value === "string" && isDesktopAppearanceTheme(value)
    ? value
    : undefined;
}

function readAppearanceDensity(
  value: TomlScalar | undefined,
): DesktopAppearanceDensity | undefined {
  return typeof value === "string" && isDesktopAppearanceDensity(value)
    ? value
    : undefined;
}

function readOnboardingCompletedSource(
  value: TomlScalar | undefined,
): DesktopOnboardingCompletedSource | undefined {
  return typeof value === "string" && isDesktopOnboardingCompletedSource(value)
    ? value
    : undefined;
}

function isMessagingToolUpdateMode(
  value: string,
): value is MessagingToolUpdateMode {
  return (
    value === "show_none"
    || value === "show_less"
    || value === "show_some"
    || value === "show_more"
    || value === "show_all"
  );
}

function readSlackInboundMode(
  value: TomlScalar | undefined,
): "socket" | "events" | undefined {
  return value === "socket" || value === "events" ? value : undefined;
}

function readFeishuInboundMode(
  value: TomlScalar | undefined,
): "persistent" | "webhook" | undefined {
  return value === "persistent" || value === "webhook" ? value : undefined;
}

function readFeishuTenantRegion(
  value: TomlScalar | undefined,
): "feishu" | "lark" | undefined {
  return value === "feishu" || value === "lark" ? value : undefined;
}

function readFullAccessWarningGlobalPolicy(
  value: TomlScalar | undefined,
): DesktopMessagingFullAccessWarningGlobalPolicy | undefined {
  return value === "always" || value === "dismissable" || value === "never"
    ? value
    : undefined;
}

function isFullAccessWarningUserPolicy(
  value: unknown,
): value is DesktopMessagingFullAccessWarningUserPolicy {
  return (
    value === "default" ||
    value === "always" ||
    value === "dismissable" ||
    value === "never"
  );
}

function readBoolean(value: TomlScalar | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readString(value: TomlScalar | undefined): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function readStringArray(value: TomlScalar | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((item): item is string => typeof item === "string")) {
    return undefined;
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function readAuthorizedContacts(
  ...values: Array<TomlScalar | undefined>
): DesktopAuthorizedContact[] | undefined {
  for (const value of values) {
    const contacts = readAuthorizedContactArray(value);
    if (contacts !== undefined) {
      return contacts;
    }
  }
  for (const value of values) {
    const legacy = readStringArray(value);
    if (legacy !== undefined) {
      return legacy.map((id) => ({ id, displayName: "" }));
    }
  }
  return undefined;
}

function readAuthorizedContactArray(
  value: TomlScalar | undefined,
): DesktopAuthorizedContact[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length === 0) return [];
  if (
    !value.every(
      (item): item is Record<string, string | number | boolean> =>
        typeof item === "object" && item !== null && !Array.isArray(item),
    )
  ) {
    return undefined;
  }
  return normalizeAuthorizedContacts(
    value.map((entry) => ({
      id: typeof entry.id === "string" ? entry.id : "",
      displayName:
        typeof entry.display_name === "string"
          ? entry.display_name
          : typeof entry.displayName === "string"
            ? entry.displayName
            : "",
      fullAccessWarningOverride: isFullAccessWarningUserPolicy(
        entry.full_access_warning,
      )
        ? entry.full_access_warning
        : isFullAccessWarningUserPolicy(entry.fullAccessWarningOverride)
          ? entry.fullAccessWarningOverride
          : undefined,
      fullAccessWarningDismissed:
        entry.full_access_warning_dismissed === true ||
        entry.fullAccessWarningDismissed === true,
    })),
  );
}

function normalizeAuthorizedContacts(
  contacts: readonly DesktopAuthorizedContact[],
): DesktopAuthorizedContact[] {
  return contacts
    .map((contact) => ({
      id: contact.id.trim(),
      displayName: sanitizeMessagingContactLabel(contact.displayName),
      ...(isFullAccessWarningUserPolicy(contact.fullAccessWarningOverride) &&
      contact.fullAccessWarningOverride !== "default"
        ? { fullAccessWarningOverride: contact.fullAccessWarningOverride }
        : {}),
      ...(contact.fullAccessWarningDismissed === true
        ? { fullAccessWarningDismissed: true }
        : {}),
    }))
    .filter((contact) => contact.id.length > 0);
}

function legacyAuthorizedContactComment(key: string): string {
  return [
    "#",
    LEGACY_AUTHORIZED_CONTACT_MARKER,
    `key=${key}`,
    "shape=string-array",
    `used_through=${LEGACY_AUTHORIZED_CONTACT_LAST_VERSION}`,
    "kept_for_older_clients",
  ].join(" ");
}

function legacyChatReplyComposerComment(): string {
  return [
    "#",
    LEGACY_AUTHORIZED_CONTACT_MARKER,
    "key=chat_reply_composer",
    "shape=string-enum",
    `used_through=${LEGACY_CHAT_REPLY_COMPOSER_LAST_VERSION}`,
    "kept_for_older_clients",
    "obsolete_no_replacement",
    "ignored_by_current_clients",
    "remove_when_convenient",
  ].join(" ");
}

function readNumber(value: TomlScalar | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readImageProfile(
  value: TomlScalar | undefined,
): DesktopMessagingImageProfile | undefined {
  return typeof value === "string" && isDesktopMessagingImageProfile(value)
    ? value
    : undefined;
}

function isDesktopMessagingImageProfile(
  value: string,
): value is DesktopMessagingImageProfile {
  return value === "low" || value === "medium" || value === "high" || value === "actual";
}

function readWorktreeStorage(
  value: TomlScalar | undefined,
): DesktopWorktreeStorageLocation | undefined {
  return typeof value === "string" && isDesktopWorktreeStorageLocation(value)
    ? value
    : undefined;
}
