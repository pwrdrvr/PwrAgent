import { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  DesktopSettingsConfigPatch,
  DesktopSettingsSnapshot,
  MessagingChannelKind,
  MessagingDegradationReason,
  MessagingPlatformActivitySummary,
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

type ConfigurableMessagingPlatform = Extract<
  MessagingChannelKind,
  "discord" | "feishu" | "line" | "mattermost" | "slack" | "telegram"
>;

const CONFIGURABLE_MESSAGING_PLATFORMS = [
  "telegram",
  "discord",
  "mattermost",
  "slack",
  "feishu",
  "line",
] as const satisfies readonly ConfigurableMessagingPlatform[];

type PlatformActivitySummary = {
  lastRequestAt?: number;
  lastResponseAt?: number;
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
  onOpenActivity?: (platform?: MessagingChannelKind) => void;
}) {
  const { statuses, activeAtByPlatform } = useMessagingPlatformStatuses(
    props.desktopApi,
  );
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [togglePending, setTogglePending] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [platformTogglePending, setPlatformTogglePending] = useState<
    Partial<Record<ConfigurableMessagingPlatform, boolean>>
  >({});
  const [platformToggleError, setPlatformToggleError] = useState<string | null>(
    null,
  );
  const [sessionOverride, setSessionOverride] = useState<boolean | null>(null);
  const [settingsSnapshot, setSettingsSnapshot] =
    useState<DesktopSettingsSnapshot | null>(null);
  const [activityByPlatform, setActivityByPlatform] = useState<
    Partial<Record<MessagingChannelKind, PlatformActivitySummary>>
  >({});
  const rootRef = useRef<HTMLDivElement | null>(null);
  const popoverId = useId();

  const runtimeMessagingEnabled =
    settingsSnapshot?.runtime?.messaging?.disabled !== undefined
      ? !settingsSnapshot.runtime.messaging.disabled
      : null;
  const displayStatuses = useMemo(
    () => withConfiguredSettingsStatuses(statuses, settingsSnapshot),
    [settingsSnapshot, statuses],
  );
  const messagingOn = sessionOverride
    ?? runtimeMessagingEnabled
    ?? inferMessagingEnabled(displayStatuses);
  const activePlatforms = displayStatuses.filter((status) =>
    hasRecentActivity(status, activeAtByPlatform[status.platform])
  );
  const hasDegradation = displayStatuses.some(
    (status) => (status.degradationReasons ?? []).length > 0,
  );
  const summary = buildStatusSummary(
    displayStatuses,
    messagingOn,
    activePlatforms.length,
  );
  const controllerLabel = displayStatuses
    .map(
      (status) =>
        `${formatMessagingPlatformName(status.platform)}: ${HEALTH_LABEL[status.health]}`,
    )
    .join("; ");

  useEffect(() => {
    if (!open) return;
    const intervalId = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, [open]);

  useEffect(() => {
    if (
      !props.desktopApi?.getMessagingPlatformStatuses
      || !props.desktopApi?.readSettings
    ) {
      return;
    }
    let cancelled = false;
    void props.desktopApi.readSettings({}).then((response) => {
      if (!cancelled) setSettingsSnapshot(response.snapshot);
    }).catch(() => {
      // Settings screen owns user-facing errors; keep this controller quiet.
    });
    return () => {
      cancelled = true;
    };
  }, [props.desktopApi, statuses.length]);

  useEffect(() => {
    if (
      !open
      || !props.desktopApi?.getMessagingPlatformStatuses
      || !props.desktopApi?.readSettings
    ) {
      return;
    }
    let cancelled = false;
    void props.desktopApi.readSettings({}).then((response) => {
      if (!cancelled) setSettingsSnapshot(response.snapshot);
    }).catch(() => {
      // Settings screen owns user-facing errors; keep this controller quiet.
    });
    return () => {
      cancelled = true;
    };
  }, [open, props.desktopApi]);

  useEffect(() => {
    if (!open || !props.desktopApi?.getMessagingActivitySummary) return;
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      try {
        const response = await props.desktopApi!.getMessagingActivitySummary!();
        if (!cancelled) {
          setActivityByPlatform(summarizeActivityByPlatform(response.summaries));
        }
      } catch {
        // Activity is best-effort; the full Activity window surfaces errors.
      }
    };
    void refresh();
    const intervalId = window.setInterval(() => {
      void refresh();
    }, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [open, props.desktopApi]);

  useEffect(() => {
    const observed =
      runtimeMessagingEnabled ?? inferMessagingEnabled(displayStatuses);
    setSessionOverride((current) => (current === observed ? null : current));
  }, [displayStatuses, runtimeMessagingEnabled]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
      setPinned(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      setPinned(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const handleToggleMessaging = async (): Promise<void> => {
    if (!props.desktopApi?.setMessagingEnabled) {
      setToggleError("Messaging can only be toggled from the desktop app.");
      return;
    }
    const nextEnabled = !messagingOn;
    setTogglePending(true);
    setToggleError(null);
    setSessionOverride(nextEnabled);
    try {
      const result = await props.desktopApi.setMessagingEnabled({
        enabled: nextEnabled,
      });
      setSessionOverride(result.enabled);
      if (nextEnabled && !result.enabled) {
        setToggleError(
          result.disabledReason
            ?? result.overrideReason
            ?? "Messaging could not be started.",
        );
      }
    } catch (error) {
      setSessionOverride(null);
      setToggleError(
        error instanceof Error ? error.message : "Messaging toggle failed.",
      );
    } finally {
      setTogglePending(false);
    }
  };

  const handleTogglePlatform = async (
    platform: ConfigurableMessagingPlatform,
    enabled: boolean,
  ): Promise<void> => {
    if (!messagingOn) {
      setPlatformToggleError("Turn messaging on before changing a platform.");
      return;
    }
    if (!props.desktopApi?.writeSettingsConfig) {
      setPlatformToggleError("Settings are unavailable.");
      return;
    }
    setPlatformToggleError(null);
    setPlatformTogglePending((current) => ({
      ...current,
      [platform]: true,
    }));
    try {
      const response = await props.desktopApi.writeSettingsConfig({
        patch: platformEnabledPatch(platform, enabled),
      });
      setSettingsSnapshot(response.snapshot);
    } catch (error) {
      setPlatformToggleError(
        error instanceof Error
          ? error.message
          : `Could not update ${formatMessagingPlatformName(platform)}.`,
      );
    } finally {
      setPlatformTogglePending((current) => {
        const next = { ...current };
        delete next[platform];
        return next;
      });
    }
  };

  if (displayStatuses.length === 0) {
    return null;
  }

  return (
    <div
      ref={rootRef}
      className="messaging-status-bar"
      role="group"
      aria-label="Messaging platform status"
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => {
        if (!pinned) setOpen(false);
      }}
    >
      <button
        type="button"
        className={`messaging-status-controller${
          messagingOn ? "" : " is-off"
        }${hasDegradation ? " has-warning" : ""}`}
        aria-controls={open ? popoverId : undefined}
        aria-expanded={open}
        aria-label={`${controllerLabel}. ${summary}. Click to ${
          pinned ? "close" : "pin"
        } messaging status.`}
        onClick={() => {
          if (pinned) {
            setOpen(false);
            setPinned(false);
            return;
          }
          setOpen(true);
          setPinned(true);
        }}
      >
        <span className="messaging-status-controller__label">
          {messagingOn ? "Msg" : "Off"}
        </span>
        <span className="messaging-status-controller__platforms">
          {displayStatuses.map((status) => (
            <PlatformGlyph
              key={status.platform}
              status={status}
              active={hasRecentActivity(status, activeAtByPlatform[status.platform])}
              forcedOff={!messagingOn}
            />
          ))}
        </span>
      </button>
      {open ? (
        <div
          id={popoverId}
          className="messaging-status-popover"
          role="dialog"
          aria-label="Messaging platforms"
        >
          <div className="messaging-status-popover__head">
            <div>
              <div className="messaging-status-popover__title">
                Messaging platforms
              </div>
              <div className="messaging-status-popover__summary">
                {summary}
              </div>
            </div>
            <button
              type="button"
              className={`settings-switch messaging-status-popover__switch${
                messagingOn ? " is-on" : ""
              }`}
              aria-pressed={messagingOn}
              disabled={togglePending}
              onClick={() => {
                void handleToggleMessaging();
              }}
            >
              <span aria-hidden="true" className="settings-switch__track">
                <span className="settings-switch__thumb" />
              </span>
              <span>{togglePending ? "..." : messagingOn ? "On" : "Off"}</span>
            </button>
          </div>
          <div className="messaging-status-popover__rows">
            {displayStatuses.map((status) => (
              <PlatformStatusRow
                key={status.platform}
                status={status}
                active={hasRecentActivity(status, activeAtByPlatform[status.platform])}
                activity={activityByPlatform[status.platform]}
                forcedOff={!messagingOn}
                platformEnabled={platformEnabledFromSnapshot(
                  settingsSnapshot,
                  status.platform,
                )}
                platformTogglePending={
                  configurablePlatform(status.platform)
                    ? platformTogglePending[status.platform] === true
                    : false
                }
                platformToggleDisabled={!messagingOn}
                now={now}
                onTogglePlatform={handleTogglePlatform}
              />
            ))}
          </div>
          {toggleError || platformToggleError ? (
            <p className="messaging-status-popover__error" role="alert">
              {toggleError ?? platformToggleError}
            </p>
          ) : null}
          {props.onOpenActivity ? (
            <button
              type="button"
              className="messaging-status-popover__activity"
              onClick={() => {
                setOpen(false);
                setPinned(false);
                props.onOpenActivity?.();
              }}
            >
              Open Messaging Activity
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PlatformGlyph(props: {
  status: MessagingPlatformStatus;
  active: boolean;
  forcedOff?: boolean;
}) {
  const { status, active, forcedOff = false } = props;
  const Icon = MESSAGING_PLATFORM_ICONS[status.platform];
  const effectiveHealth = forcedOff ? "suspended" : status.health;
  const blink = !forcedOff && (active || status.health === "unknown");
  return (
    <span
      className={`messaging-status-chip messaging-status-chip--${effectiveHealth}${
        active && !forcedOff ? " is-active" : ""
      }`}
      title={formatMessagingPlatformName(status.platform)}
      aria-hidden="true"
    >
      {Icon ? (
        <Icon size={14} />
      ) : (
        <span className="messaging-status-chip__fallback">
          {status.platform.slice(0, 2)}
        </span>
      )}
      <span
        className={`status-dot status-dot--${dotTone(effectiveHealth)}${
          blink ? " status-dot--blink" : ""
        }`}
        aria-hidden="true"
      />
    </span>
  );
}

function PlatformStatusRow(props: {
  status: MessagingPlatformStatus;
  active: boolean;
  activity?: PlatformActivitySummary;
  forcedOff: boolean;
  platformEnabled?: boolean;
  platformToggleDisabled: boolean;
  platformTogglePending: boolean;
  now: number;
  onTogglePlatform: (
    platform: ConfigurableMessagingPlatform,
    enabled: boolean,
  ) => void | Promise<void>;
}) {
  const { status, active, forcedOff, now } = props;
  const configurable = configurablePlatform(status.platform)
    ? status.platform
    : undefined;
  const platformEnabled = props.platformEnabled ?? status.health !== "suspended";
  const statusLabel = forcedOff || platformEnabled === false
    ? "Off"
    : HEALTH_LABEL[status.health];
  const stateHealth = forcedOff || platformEnabled === false
    ? "suspended"
    : status.health;
  const subline = forcedOff
    ? "Globally disabled"
    : formatPlatformSubline(status, now);
  const labelLines = [
    `${formatMessagingPlatformName(status.platform)}: ${HEALTH_LABEL[status.health]}`,
    status.account && status.account !== subline
      ? `Bot: ${status.account}`
      : undefined,
    status.detail && status.detail !== subline
      ? `Account detail: ${status.detail}`
      : undefined,
    ...formatPlatformActivity(props.activity, now),
    status.reason,
    ...formatDegradationReasons(status.degradationReasons ?? [], now),
  ]
    .filter((line): line is string => Boolean(line));

  return (
    <div className="messaging-status-popover__row">
      <PlatformGlyph status={status} active={active} forcedOff={forcedOff} />
      <div className="messaging-status-popover__row-main">
        <div className="messaging-status-popover__row-title">
          {formatMessagingPlatformName(status.platform)}
        </div>
        <div className="messaging-status-popover__row-sub">{subline}</div>
        {labelLines.length > 1 ? (
          <div className="messaging-status-popover__details">
            {labelLines.slice(1).map((line) => (
              <span key={line}>{line}</span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="messaging-status-popover__row-actions">
        <span
          className={`messaging-status-popover__state messaging-status-popover__state--${stateHealth}`}
        >
          {statusLabel}
        </span>
        {configurable ? (
          <button
            type="button"
            className={`settings-switch messaging-status-popover__platform-switch${
              platformEnabled ? " is-on" : ""
            }`}
            aria-label={`${platformEnabled ? "Disable" : "Enable"} ${formatMessagingPlatformName(status.platform)}`}
            aria-pressed={platformEnabled}
            disabled={props.platformTogglePending || props.platformToggleDisabled}
            onClick={() => {
              void props.onTogglePlatform(configurable, !platformEnabled);
            }}
          >
            <span aria-hidden="true" className="settings-switch__track">
              <span className="settings-switch__thumb" />
            </span>
            <span>
              {props.platformTogglePending
                ? "..."
                : platformEnabled
                  ? "On"
                  : "Off"}
            </span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

function withConfiguredSettingsStatuses(
  runtimeStatuses: readonly MessagingPlatformStatus[],
  snapshot: DesktopSettingsSnapshot | null,
): MessagingPlatformStatus[] {
  if (!snapshot) return [...runtimeStatuses];
  const seen = new Set(runtimeStatuses.map((status) => status.platform));
  const configuredFromSettings = CONFIGURABLE_MESSAGING_PLATFORMS
    .filter((platform) => !seen.has(platform))
    .filter((platform) => platformConfiguredFromSnapshot(snapshot, platform))
    .map((platform): MessagingPlatformStatus => ({
      platform,
      health: platformEnabledFromSnapshot(snapshot, platform)
        ? "unknown"
        : "suspended",
      changedAt: snapshot.fetchedAt ?? Date.now(),
      ...platformIdentityFromSnapshot(snapshot, platform),
    }));
  return [...runtimeStatuses, ...configuredFromSettings];
}

function platformConfiguredFromSnapshot(
  snapshot: DesktopSettingsSnapshot,
  platform: ConfigurableMessagingPlatform,
): boolean {
  switch (platform) {
    case "telegram":
      return snapshot.messaging?.telegram?.botToken?.configured === true;
    case "discord":
      return snapshot.messaging?.discord?.botToken?.configured === true;
    case "mattermost":
      return snapshot.messaging?.mattermost?.botToken?.configured === true;
    case "slack":
      return snapshot.messaging?.slack?.botToken?.configured === true;
    case "feishu":
      return snapshot.messaging?.feishu?.appSecret?.configured === true;
    case "line":
      return snapshot.messaging?.line?.channelAccessToken?.configured === true;
  }
}

function platformIdentityFromSnapshot(
  snapshot: DesktopSettingsSnapshot,
  platform: ConfigurableMessagingPlatform,
): Pick<MessagingPlatformStatus, "account" | "detail"> {
  switch (platform) {
    case "line":
      return snapshot.messaging?.line?.botUserId?.value
        ? { account: snapshot.messaging.line.botUserId.value }
        : {};
    case "feishu":
      return snapshot.messaging?.feishu?.tenantUrl?.value
        ? { detail: snapshot.messaging.feishu.tenantUrl.value }
        : {};
    default:
      return {};
  }
}

function configurablePlatform(
  platform: MessagingChannelKind,
): platform is ConfigurableMessagingPlatform {
  return CONFIGURABLE_MESSAGING_PLATFORMS.some((entry) => entry === platform);
}

function platformEnabledFromSnapshot(
  snapshot: DesktopSettingsSnapshot | null,
  platform: MessagingChannelKind,
): boolean | undefined {
  if (!snapshot || !configurablePlatform(platform)) return undefined;
  return snapshot.messaging?.[platform]?.enabled?.value;
}

function platformEnabledPatch(
  platform: ConfigurableMessagingPlatform,
  enabled: boolean,
): DesktopSettingsConfigPatch {
  return { messaging: { [platform]: { enabled } } };
}

function summarizeActivityByPlatform(
  summaries: readonly MessagingPlatformActivitySummary[],
): Partial<Record<MessagingChannelKind, PlatformActivitySummary>> {
  const next: Partial<Record<MessagingChannelKind, PlatformActivitySummary>> = {};
  for (const summary of summaries) {
    next[summary.platform] = {
      lastRequestAt: summary.lastRequestAt,
      lastResponseAt: summary.lastResponseAt,
    };
  }
  return next;
}

function formatPlatformActivity(
  activity: PlatformActivitySummary | undefined,
  now: number,
): string[] {
  if (!activity) return [];
  return [
    `Last request: ${
      activity.lastRequestAt !== undefined
        ? formatRelativeTime(activity.lastRequestAt, now)
        : "none yet"
    }`,
    `Last response: ${
      activity.lastResponseAt !== undefined
        ? formatRelativeTime(activity.lastResponseAt, now)
        : "none yet"
    }`,
  ];
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

function inferMessagingEnabled(
  statuses: readonly MessagingPlatformStatus[],
): boolean {
  return statuses.some((status) => status.health !== "suspended");
}

function buildStatusSummary(
  statuses: readonly MessagingPlatformStatus[],
  messagingOn: boolean,
  activeCount: number,
): string {
  const counts = statuses.reduce<Record<MessagingPlatformHealth, number>>(
    (acc, status) => {
      acc[status.health] += 1;
      return acc;
    },
    { degraded: 0, enabled: 0, errored: 0, suspended: 0, unknown: 0 },
  );
  if (!messagingOn) {
    return `${statuses.length} configured platform${statuses.length === 1 ? "" : "s"} off`;
  }
  const parts = [
    counts.enabled > 0 ? `${counts.enabled} online` : undefined,
    counts.degraded > 0 ? `${counts.degraded} degraded` : undefined,
    counts.errored > 0 ? `${counts.errored} errored` : undefined,
    counts.suspended > 0 ? `${counts.suspended} suspended` : undefined,
    activeCount > 0 ? `${activeCount} active` : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(", ") : "Messaging starting";
}

function formatPlatformSubline(
  status: MessagingPlatformStatus,
  now: number,
): string {
  if (status.health === "enabled") {
    return status.lastActivityAt
      ? `Last activity ${formatRelativeTime(status.lastActivityAt, now)}`
      : status.detail ?? status.account ?? "Listening";
  }
  if (status.health === "degraded") {
    const firstReason = status.degradationReasons?.[0];
    return firstReason
      ? formatDegradationReason(firstReason, now)
      : status.reason ?? "Temporarily constrained";
  }
  if (status.health === "errored") {
    return status.reason ?? "Connection error";
  }
  if (status.health === "suspended") {
    return "Configured, currently suspended";
  }
  return "Starting";
}

function formatDegradationReasons(
  reasons: readonly MessagingDegradationReason[],
  now = Date.now(),
): string[] {
  return reasons.map((reason) => formatDegradationReason(reason, now));
}

function formatDegradationReason(
  reason: MessagingDegradationReason,
  now: number,
): string {
  const scopeLabel = reason.scope?.label ? ` (${reason.scope.label})` : "";
  const started = `since ${formatClockTime(reason.startedAt)}`;
  const remaining = "expiresAt" in reason && reason.expiresAt
    ? `, ${formatRemaining(reason.expiresAt, now)} remaining`
    : "";
  switch (reason.kind) {
    case "rate-limited":
      return `Rate limited${scopeLabel}; ${started}${remaining}${formatRetry(reason.retryAfterMs)}`;
    case "reconnecting":
      return `Reconnecting${formatAttempt(reason.attemptCount)}; ${started}${reason.lastFailureReason ? `: ${reason.lastFailureReason}` : ""}`;
    case "missing-permission":
      return `Missing permission${reason.permission ? `: ${reason.permission}` : ""}; ${started}`;
    case "warning":
      return `${reason.message ?? `Warning${scopeLabel}`}; ${started}${remaining}`;
  }
}

function formatRetry(retryAfterMs: number | undefined): string {
  if (retryAfterMs === undefined) return "";
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return `; retrying in ${seconds}s`;
}

function formatAttempt(attemptCount: number | undefined): string {
  return attemptCount === undefined ? "" : ` (attempt ${attemptCount})`;
}

function formatClockTime(at: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(at));
}

function formatRelativeTime(at: number, now: number): string {
  const seconds = Math.max(1, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function formatRemaining(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes}m`;
}
