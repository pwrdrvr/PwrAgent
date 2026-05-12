import type { ReactElement } from "react";
import type { MessagingChannelKind } from "@pwragent/shared";
import {
  DiscordIcon,
  FeishuIcon,
  LineIcon,
  MattermostIcon,
  SlackIcon,
  TelegramIcon,
  type IconProps,
} from "../icons";

export const MESSAGING_PLATFORM_ICONS: Partial<
  Record<MessagingChannelKind, (props: IconProps) => ReactElement>
> = {
  telegram: ({ size }) => <TelegramIcon size={size} variant="color" />,
  discord: ({ size }) => <DiscordIcon size={size} variant="white" />,
  mattermost: ({ size }) => <MattermostIcon size={size} />,
  slack: ({ size }) => <SlackIcon size={size} />,
  feishu: ({ size }) => <FeishuIcon size={size} />,
  line: ({ size }) => <LineIcon size={size} />,
};

const MESSAGING_PLATFORM_LABELS: Partial<Record<MessagingChannelKind, string>> = {
  discord: "Discord",
  feishu: "Feishu / Lark",
  line: "LINE",
  mattermost: "Mattermost",
  slack: "Slack",
  telegram: "Telegram",
};

export function formatMessagingPlatformName(platform: MessagingChannelKind): string {
  return MESSAGING_PLATFORM_LABELS[platform] ?? fallbackPlatformName(platform);
}

function fallbackPlatformName(platform: string): string {
  if (platform.length === 0) return platform;
  return platform.charAt(0).toUpperCase() + platform.slice(1);
}
