import { MESSAGING_COMMAND_CATALOG } from "@pwragent/messaging-interface";

/**
 * PwrAgent-maintained Slack app manifest (customer-owned apps).
 *
 * This is the official Phase 1 install artifact: operators create an
 * unpublished internal Slack app from this document. PwrAgent does not
 * ship a shared Slack app, client secret, or Marketplace listing.
 *
 * Bump {@link SLACK_APP_MANIFEST_VERSION} when scopes, events, slash
 * commands, or settings flags change in a way that existing customer
 * apps should reinstall.
 */
export const SLACK_APP_MANIFEST_VERSION = 1;

export const DEFAULT_SLACK_SLASH_COMMAND_PREFIX = "pwragent_";

export const SLACK_APP_MANIFEST_BOT_SCOPES = [
  "app_mentions:read",
  "assistant:write",
  "channels:history",
  "channels:read",
  "chat:write",
  "commands",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "mpim:history",
  "mpim:read",
  "users:read",
] as const;

export const SLACK_APP_MANIFEST_BOT_EVENTS = [
  "app_home_opened",
  "app_mention",
  "app_uninstalled",
  "message.channels",
  "message.groups",
  "message.im",
  "message.mpim",
  "tokens_revoked",
] as const;

export type SlackAppManifestSlashCommand = {
  command: string;
  description: string;
  should_escape: false;
  usage_hint: string;
};

export type SlackAppManifest = {
  _metadata: {
    major_version: 1;
    minor_version: 1;
  };
  display_information: {
    name: string;
    description: string;
    background_color: string;
  };
  features: {
    app_home: {
      home_tab_enabled: true;
      messages_tab_enabled: true;
      messages_tab_read_only_enabled: false;
    };
    bot_user: {
      display_name: string;
      always_online: true;
    };
    slash_commands: SlackAppManifestSlashCommand[];
  };
  oauth_config: {
    pkce_enabled: false;
    scopes: {
      bot: string[];
    };
  };
  settings: {
    event_subscriptions: {
      bot_events: string[];
    };
    interactivity: {
      is_enabled: true;
    };
    org_deploy_enabled: false;
    socket_mode_enabled: true;
    token_rotation_enabled: false;
  };
};

export type BuildOfficialSlackAppManifestOptions = {
  slashCommandPrefix?: string;
};

export function buildOfficialSlackAppManifest(
  options: BuildOfficialSlackAppManifestOptions = {},
): SlackAppManifest {
  const prefix = options.slashCommandPrefix ?? DEFAULT_SLACK_SLASH_COMMAND_PREFIX;
  return {
    _metadata: {
      major_version: 1,
      minor_version: 1,
    },
    display_information: {
      name: "PwrAgent",
      description: "Your coding agent, running on your computer.",
      background_color: "#000000",
    },
    features: {
      app_home: {
        home_tab_enabled: true,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: {
        display_name: "PwrAgent",
        always_online: true,
      },
      slash_commands: MESSAGING_COMMAND_CATALOG.map((command) => ({
        command: `/${prefix}${command.verb}`,
        description: command.description,
        usage_hint: "",
        should_escape: false,
      })),
    },
    oauth_config: {
      pkce_enabled: false,
      scopes: {
        bot: [...SLACK_APP_MANIFEST_BOT_SCOPES],
      },
    },
    settings: {
      event_subscriptions: {
        bot_events: [...SLACK_APP_MANIFEST_BOT_EVENTS],
      },
      interactivity: {
        is_enabled: true,
      },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}

export function slackAppManifestJson(
  manifest: SlackAppManifest = buildOfficialSlackAppManifest(),
): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function slackAppManifestYaml(
  manifest: SlackAppManifest = buildOfficialSlackAppManifest(),
): string {
  return `${renderYaml(manifest)}\n`;
}

function renderYaml(value: unknown): string {
  return renderYamlLines(value, 0).join("\n");
}

function renderYamlLines(value: unknown, indent: number): string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return ["[]"];
    }
    return value.flatMap((item) => {
      if (isPlainObject(item)) {
        const objectLines = renderYamlObjectLines(item, indent + 2);
        const first = objectLines[0]?.trimStart() ?? "";
        return [
          `${" ".repeat(indent)}- ${first}`,
          ...objectLines.slice(1),
        ];
      }
      return [`${" ".repeat(indent)}- ${yamlScalar(item)}`];
    });
  }
  if (isPlainObject(value)) {
    return renderYamlObjectLines(value, indent);
  }
  return [yamlScalar(value)];
}

function renderYamlObjectLines(
  value: Record<string, unknown>,
  indent: number,
): string[] {
  const pad = " ".repeat(indent);
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return ["{}"];
  }
  return entries.flatMap(([key, child]) => {
    if (isPlainObject(child) || Array.isArray(child)) {
      const childLines = renderYamlLines(child, indent + 2);
      if (childLines.length === 1 && (childLines[0] === "{}" || childLines[0] === "[]")) {
        return [`${pad}${key}: ${childLines[0]}`];
      }
      return [`${pad}${key}:`, ...childLines];
    }
    return [`${pad}${key}: ${yamlScalar(child)}`];
  });
}

function yamlScalar(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string") {
    return quoteYamlString(value);
  }
  return quoteYamlString(String(value));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function quoteYamlString(value: string): string {
  if (
    value.length === 0
    || /[#{}[\],&*?|<>=!%@`'"\\]/.test(value)
    || value.includes(": ")
    || value.endsWith(":")
    || /^\s|\s$/.test(value)
    || value.includes("\n")
    || /^(true|false|null|~|[-+]?[0-9]+(?:\.[0-9]+)?)$/i.test(value)
  ) {
    return JSON.stringify(value);
  }
  return value;
}
