import { useId } from "react";
import type {
  MessagingChannelKind,
  MessagingDegradationReason,
  MessagingPlatformHealth,
  MessagingPlatformStatus,
} from "@pwragent/shared";
import {
  formatMessagingPlatformName,
  MESSAGING_PLATFORM_ICONS,
} from "../../lib/messaging-platform-branding";
import { useMessagingPlatformStatuses } from "./useMessagingPlatformStatuses";
import type { DesktopApi } from "../../lib/desktop-api";

const HEALTH_LABEL: Record<MessagingPlatformHealth, string> = {
  enabled: "Enabled",
  degraded: "Degraded",
  suspended: "Suspended",
  errored: "Errored",
  unknown: "Loading",
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
  const tooltipId = useId();
  const Icon = MESSAGING_PLATFORM_ICONS[status.platform];
  const labelLines = [
    `${formatMessagingPlatformName(status.platform)}: ${HEALTH_LABEL[status.health]}`,
    status.account ? `Bot: ${status.account}` : undefined,
    status.detail ? `Account detail: ${status.detail}` : undefined,
    status.reason,
    ...formatDegradationReasons(status.degradationReasons ?? []),
  ]
    .filter((line): line is string => Boolean(line));
  const baseLabel = labelLines.join("\n");
  const label = onClick
    ? `${baseLabel} — click to view messaging activity`
    : baseLabel;
  const className = `messaging-status-chip messaging-status-chip--${status.health}${
    active ? " is-active" : ""
  }`;
  const blink = active || status.health === "unknown";
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
          blink ? " status-dot--blink" : ""
        }`}
        aria-hidden="true"
      />
      <span className="messaging-status-chip__tooltip" id={tooltipId} role="tooltip">
        {labelLines.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </span>
    </>
  );
  if (!onClick) {
    return (
      <span className={className} aria-describedby={tooltipId} aria-label={label}>
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`${className} messaging-status-chip--clickable`}
      aria-describedby={tooltipId}
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
  if (status.health !== "enabled" && status.health !== "degraded") return false;
  return Boolean(observedAt);
}

function dotTone(
  health: MessagingPlatformHealth,
): "ok" | "warning" | "error" | "suspended" {
  switch (health) {
    case "enabled":
      return "ok";
    case "degraded":
      return "warning";
    case "suspended":
      return "suspended";
    case "errored":
      return "error";
    case "unknown":
      return "suspended";
  }
}

function formatDegradationReasons(
  reasons: readonly MessagingDegradationReason[],
): string[] {
  return reasons.map((reason) => {
    const scopeLabel = reason.scope?.label ? ` (${reason.scope.label})` : "";
    switch (reason.kind) {
      case "rate-limited":
        return `Rate limited${scopeLabel}${formatRetry(reason.retryAfterMs)}`;
      case "reconnecting":
        return `Reconnecting${formatAttempt(reason.attemptCount)}${reason.lastFailureReason ? `: ${reason.lastFailureReason}` : ""}`;
      case "missing-permission":
        return `Missing permission${reason.permission ? `: ${reason.permission}` : ""}`;
      case "warning":
        return reason.message ?? `Warning${scopeLabel}`;
    }
  });
}

function formatRetry(retryAfterMs: number | undefined): string {
  if (retryAfterMs === undefined) return "";
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return `; retrying in ${seconds}s`;
}

function formatAttempt(attemptCount: number | undefined): string {
  return attemptCount === undefined ? "" : ` (attempt ${attemptCount})`;
}
