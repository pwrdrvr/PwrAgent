import { useState, type ReactElement } from "react";
import type {
  MessagingChannelKind,
  MessagingPlatformHealth,
  MessagingPlatformStatus,
} from "@pwragent/shared";
import { DiscordIcon, TelegramIcon, type IconProps } from "../../icons";
import { useMessagingPlatformStatuses } from "./useMessagingPlatformStatuses";
import type { DesktopApi } from "../../lib/desktop-api";

type MessagingEnablementState = {
  /** True when the runtime is currently allowed to run. */
  userEnabled: boolean;
  /** True when a startup override (CLI/env) is forcing messaging off. */
  overridden: boolean;
  overrideReason?: string;
};

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
 * The bar also hosts the global on/off toggle. When `--disable-messaging`
 * fired at startup, the toggle is locked off with an explanatory tooltip.
 *
 * Renders nothing when no platforms are configured AND the user has
 * never toggled messaging — keeps the header tight for users who don't
 * use messaging.
 */
export function MessagingStatusBar(props: {
  desktopApi?: DesktopApi;
  enablement?: MessagingEnablementState;
}) {
  const { statuses, activeAtByPlatform } = useMessagingPlatformStatuses(
    props.desktopApi,
  );
  const [enablement, setEnablement] = useState<MessagingEnablementState | undefined>(
    props.enablement,
  );

  // Adopt the latest prop value on each render but keep local state for
  // optimistic updates after the user clicks the toggle.
  const effectiveEnablement = enablement ?? props.enablement;

  // Show nothing when there's nothing to show and no toggle to surface.
  if (statuses.length === 0 && !effectiveEnablement) {
    return null;
  }

  const onToggle = async (): Promise<void> => {
    if (!effectiveEnablement || effectiveEnablement.overridden) return;
    if (!props.desktopApi?.setMessagingEnabled) return;
    const next = !effectiveEnablement.userEnabled;
    setEnablement({ ...effectiveEnablement, userEnabled: next });
    try {
      const result = await props.desktopApi.setMessagingEnabled({ enabled: next });
      setEnablement({
        userEnabled: result.enabled,
        overridden: result.overridden,
        overrideReason: result.overrideReason,
      });
    } catch {
      // Roll back the optimistic flip on failure.
      setEnablement(effectiveEnablement);
    }
  };

  return (
    <div className="messaging-status-bar" role="group" aria-label="Messaging platform status">
      {statuses.map((status) => (
        <PlatformChip
          key={status.platform}
          status={status}
          active={hasRecentActivity(status, activeAtByPlatform[status.platform])}
        />
      ))}
      {effectiveEnablement ? (
        <ToggleButton enablement={effectiveEnablement} onToggle={onToggle} />
      ) : null}
    </div>
  );
}

function ToggleButton(props: {
  enablement: MessagingEnablementState;
  onToggle: () => Promise<void>;
}) {
  const { enablement, onToggle } = props;
  const overrideTooltip = enablement.overrideReason
    ? `Messaging is locked off: ${enablement.overrideReason}`
    : "Messaging is locked off by startup override";
  const tooltip = enablement.overridden
    ? overrideTooltip
    : enablement.userEnabled
      ? "Messaging is on. Click to pause."
      : "Messaging is off. Click to resume.";
  return (
    <button
      type="button"
      className={`messaging-toggle${
        enablement.userEnabled ? " is-on" : ""
      }${enablement.overridden ? " is-locked" : ""}`}
      title={tooltip}
      aria-label={tooltip}
      aria-pressed={enablement.userEnabled}
      disabled={enablement.overridden}
      onClick={() => {
        void onToggle();
      }}
    >
      <span className="messaging-toggle__track" aria-hidden="true">
        <span className="messaging-toggle__thumb" />
      </span>
      <span className="messaging-toggle__label">
        {enablement.overridden ? "Off" : enablement.userEnabled ? "On" : "Off"}
      </span>
    </button>
  );
}

function PlatformChip(props: {
  status: MessagingPlatformStatus;
  active: boolean;
}) {
  const { status, active } = props;
  const Icon = ICONS[status.platform];
  const label = `${formatPlatformName(status.platform)}: ${HEALTH_LABEL[status.health]}${
    status.reason ? ` (${status.reason})` : ""
  }`;
  return (
    <span
      className={`messaging-status-chip messaging-status-chip--${status.health}${
        active ? " is-active" : ""
      }`}
      title={label}
      aria-label={label}
    >
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
    </span>
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
