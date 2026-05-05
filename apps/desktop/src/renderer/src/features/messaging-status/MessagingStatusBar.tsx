import type { ReactElement } from "react";
import type {
  MessagingChannelKind,
  MessagingPlatformHealth,
  MessagingPlatformStatus,
} from "@pwragent/shared";
import { DiscordIcon, TelegramIcon, type IconProps } from "../../icons";
import { useMessagingPlatformStatuses } from "./useMessagingPlatformStatuses";
import type { DesktopApi } from "../../lib/desktop-api";

const ICONS: Partial<
  Record<MessagingChannelKind, (props: IconProps) => ReactElement>
> = {
  telegram: TelegramIcon,
  discord: DiscordIcon,
};

const HEALTH_LABEL: Record<MessagingPlatformHealth, string> = {
  enabled: "Enabled",
  suspended: "Suspended",
  errored: "Errored",
  unknown: "Unknown",
};

/**
 * Right-of-header status indicators for each *configured* messaging
 * platform. Health controls the dot color (green/gray/red); a recent
 * activity timestamp adds the slow-blink animation. Platforms without a
 * dedicated icon (custom adapters, future channels) get a small text
 * pill instead so we never silently drop a configured platform.
 *
 * Renders nothing when no platforms are configured — keeps the header
 * tight for users who don't use messaging.
 */
export function MessagingStatusBar(props: {
  desktopApi?: DesktopApi;
  /**
   * Called when the user clicks a platform chip. Parent navigates to
   * the Messaging Activity screen so the user can audit traffic for
   * that platform. Receives the chosen platform so the parent could
   * scope the screen to it in the future.
   */
  onOpenActivity?: (platform: MessagingChannelKind) => void;
}) {
  const { statuses, activeAtByPlatform } = useMessagingPlatformStatuses(
    props.desktopApi,
  );

  if (statuses.length === 0) {
    return null;
  }

  return (
    <div className="messaging-status-bar" role="group" aria-label="Messaging platform status">
      {statuses.map((status) => (
        <PlatformChip
          key={status.platform}
          status={status}
          active={hasRecentActivity(status, activeAtByPlatform[status.platform])}
          onClick={
            props.onOpenActivity
              ? () => props.onOpenActivity!(status.platform)
              : undefined
          }
        />
      ))}
    </div>
  );
}

function PlatformChip(props: {
  status: MessagingPlatformStatus;
  active: boolean;
  onClick?: () => void;
}) {
  const { status, active, onClick } = props;
  const Icon = ICONS[status.platform];
  const baseLabel = `${formatPlatformName(status.platform)}: ${HEALTH_LABEL[status.health]}${
    status.reason ? ` (${status.reason})` : ""
  }`;
  const label = onClick
    ? `${baseLabel} — click to view messaging activity`
    : baseLabel;
  const className = `messaging-status-chip messaging-status-chip--${status.health}${
    active ? " is-active" : ""
  }`;
  const content = (
    <>
      {Icon ? (
        <Icon size={14} />
      ) : (
        <span className="messaging-status-chip__fallback">
          {status.platform.slice(0, 2)}
        </span>
      )}
      <span
        className={`status-dot status-dot--${dotTone(status.health)}${
          active ? " status-dot--blink" : ""
        }`}
        aria-hidden="true"
      />
    </>
  );
  if (!onClick) {
    return (
      <span className={className} title={label} aria-label={label}>
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`${className} messaging-status-chip--clickable`}
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      {content}
    </button>
  );
}

function hasRecentActivity(
  status: MessagingPlatformStatus,
  observedAt: number | undefined,
): boolean {
  // Suspended/errored platforms shouldn't blink even if a stale activity
  // timestamp is hanging around — the dot is a status indicator first.
  if (status.health !== "enabled") return false;
  return Boolean(observedAt);
}

function dotTone(
  health: MessagingPlatformHealth,
): "ok" | "warning" | "error" | "suspended" {
  switch (health) {
    case "enabled":
      return "ok";
    case "suspended":
      return "suspended";
    case "errored":
      return "error";
    case "unknown":
      return "warning";
  }
}

function formatPlatformName(platform: MessagingChannelKind): string {
  if (platform.length === 0) return platform;
  return platform.charAt(0).toUpperCase() + platform.slice(1);
}
