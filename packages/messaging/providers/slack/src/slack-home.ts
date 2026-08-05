import {
  SLACK_CHANNEL_AUTHORIZATION_MODE_DEFAULT,
  SLACK_CHANNEL_USER_ACCESS_MODE_DEFAULT,
  SLACK_DM_ACCESS_MODE_DEFAULT,
  SLACK_GROUP_DM_ACCESS_MODE_DEFAULT,
  SLACK_TEAM_AUTHORIZATION_MODE_DEFAULT,
} from "@pwragent/messaging-interface";
import type { SlackMessagingConfig } from "./slack-config.ts";

const PWRAGENT_LOGO_URL = "https://pwragent.ai/assets/logo.png";

type SlackHomeTextObject = {
  type: "mrkdwn" | "plain_text";
  text: string;
  emoji?: boolean;
};

type SlackHomeImageElement = {
  type: "image";
  image_url: string;
  alt_text: string;
};

type SlackHomeBlock =
  | {
      type: "header";
      text: SlackHomeTextObject & { type: "plain_text" };
    }
  | { type: "divider" }
  | {
      type: "section";
      text?: SlackHomeTextObject;
      fields?: SlackHomeTextObject[];
      accessory?: SlackHomeImageElement;
    }
  | {
      type: "context";
      elements: SlackHomeTextObject[];
    };

export type SlackHomeView = {
  type: "home";
  blocks: SlackHomeBlock[];
};

/**
 * Build the private, per-user landing page Slack renders in the app's Home tab.
 * The copy is intentionally useful without exposing allowlisted Slack IDs or
 * desktop-only state across the provider boundary.
 */
export function buildSlackHomeView(params: {
  config: SlackMessagingConfig;
  userId: string;
}): SlackHomeView {
  const config = params.config;
  const slashCommand = (command: string) =>
    `/${config.slashCommandPrefix?.trim() ?? ""}${command}`;
  return {
    type: "home",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            `*Welcome, <@${params.userId}>*`,
            "*Your coding agent runs on your computer. You drive it from Slack.*",
            "Start work, resume a thread, steer the agent, answer questions, and approve protected actions without returning to your desk.",
          ].join("\n"),
        },
        accessory: {
          type: "image",
          image_url: PWRAGENT_LOGO_URL,
          alt_text: "PwrAgent logo",
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "PwrAgent is open source, MIT-licensed, and local-first.",
          },
        ],
      },
      { type: "divider" },
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "What you can do",
          emoji: true,
        },
      },
      {
        type: "section",
        fields: [
          homeField(
            ":rocket: Start or resume",
            `Use \`${slashCommand("new")}\` for fresh work or \`${slashCommand("resume")}\` to pick up an existing thread.`,
          ),
          homeField(
            ":control_knobs: Steer from Slack",
            "Send prompts, queue follow-ups, stop work, or continue the same thread from desktop.",
          ),
          homeField(
            ":mag: Review and decide",
            "Read results, inspect tool activity, answer questions, and approve protected commands.",
          ),
          homeField(
            ":card_file_box: Keep context attached",
            "Share files and images, choose projects and worktrees, and keep each Slack thread bound to the right coding thread.",
          ),
          homeField(
            ":satellite_antenna: Monitor and schedule",
            "Watch active work, schedule a future prompt, and get the result back in the conversation where it belongs.",
          ),
          homeField(
            ":information_source: See every command",
            `Send \`${slashCommand("help")}\` or mention the bot with \`help\` for the live command menu.`,
          ),
        ],
      },
      { type: "divider" },
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "Permission controls, by design",
          emoji: true,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            "*Slack access gates run before a message reaches the agent.* The operator controls which workspaces, channels, direct messages, group DMs, and people may invoke PwrAgent.",
            "",
            "*Execution access is separate and per thread.* Default Access asks before protected actions. Full Access can be disabled for messaging entirely and, when enabled, is an explicit operator-controlled escalation.",
            "",
            `Use \`${slashCommand("status")}\` in a bound conversation to inspect and control that thread's model, reasoning, speed, and access mode.`,
          ].join("\n"),
        },
      },
      {
        type: "section",
        fields: slackAccessFields(config),
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "This access snapshot comes from *PwrAgent → Settings → Messaging → Slack*. Allowlisted IDs stay private.",
          },
        ],
      },
      { type: "divider" },
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "Local-first, without a PwrAgent cloud relay",
          emoji: true,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "PwrAgent runs on your computer and connects directly to Slack. PwrAgent adds no hosted account, relay, or telemetry service between this workspace and your local agent. Slack and your configured model provider still handle the data sent to their services.",
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "<https://docs.pwragent.ai/using-codex/|Usage guide>  •  <https://docs.pwragent.ai/providers/slack/|Slack setup>  •  <https://github.com/pwrdrvr/PwrAgent|Source on GitHub>",
          },
        ],
      },
    ],
  };
}

function slackAccessFields(config: SlackMessagingConfig): SlackHomeTextObject[] {
  const teamMode =
    config.teamAuthorizationMode ?? SLACK_TEAM_AUTHORIZATION_MODE_DEFAULT;
  const channelMode =
    config.channelAuthorizationMode ?? SLACK_CHANNEL_AUTHORIZATION_MODE_DEFAULT;
  const channelUserMode =
    config.channelUserAccessMode ?? SLACK_CHANNEL_USER_ACCESS_MODE_DEFAULT;
  const dmMode = config.dmAccessMode ?? SLACK_DM_ACCESS_MODE_DEFAULT;
  const groupDmMode =
    config.groupDmAccessMode ?? SLACK_GROUP_DM_ACCESS_MODE_DEFAULT;

  return [
    homeField(
      ":office: Workspaces",
      teamMode === "allow_all"
        ? "Any workspace reaching this installation"
        : countLabel(config.authorizedTeamIds?.length ?? 0, "approved workspace"),
    ),
    homeField(
      ":speech_balloon: Channels",
      channelMode === "allow_all"
        ? "Any channel the bot can access"
        : countLabel(
            config.authorizedConversationIds?.length ?? 0,
            "approved conversation",
          ),
    ),
    homeField(
      ":busts_in_silhouette: Channel senders",
      channelUserMode === "any_channel_user"
        ? "Any member of an approved channel"
        : channelUserMode === "authorized_users"
          ? "Authorized users only"
          : "Channel messages disabled",
    ),
    homeField(
      ":incoming_envelope: Direct messages",
      dmMode === "any_workspace_user"
        ? "Any workspace user"
        : dmMode === "authorized_users"
          ? "Authorized users only"
          : "Direct messages disabled",
    ),
    homeField(
      ":people_holding_hands: Group DMs",
      groupDmMode === "authorized_users"
        ? "Authorized users, when they mention the bot"
        : "Closed",
    ),
    homeField(
      ":key: Authorized users",
      countLabel(config.authorizedActorIds.length, "configured user"),
    ),
  ];
}

function homeField(title: string, body: string): SlackHomeTextObject {
  return {
    type: "mrkdwn",
    text: `*${title}*\n${body}`,
  };
}

function countLabel(count: number, singular: string): string {
  if (count === 0) return `No ${singular}s configured`;
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}
