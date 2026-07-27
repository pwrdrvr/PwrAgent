import { useEffect, useState } from "react";
import type {
  DesktopHotCpuProfileStartDelayMs,
  DesktopHotCpuProfileTriggerMode,
  DesktopSettingsSnapshot,
  DesktopUpdateChannel,
} from "@pwragent/shared";
import type {
  AppMetadata,
  AppUpdateCheckResult,
  AppUpdateReleaseInfo,
  AppUpdateReleaseVersions,
  AppUpdateStatus,
} from "../../../../shared/app-metadata";
import { HEAP_SNAPSHOT_SECRET_WARNING } from "../../../../shared/heap-snapshot";
import type { DesktopApi } from "../../lib/desktop-api";
import type {
  AppearanceController,
  DensityPreference,
  ThemePreference,
} from "../../lib/useAppearance";
import {
  SettingsField,
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
} from "./SettingsLayout";
import { SettingsCopyValue } from "./SettingsCopyValue";
import { formatProcessIds, sourceBadge } from "./settings-fields";
import { SettingsSwitch } from "./SettingsSwitch";

const THEME_OPTIONS: Array<{
  label: string;
  meta: string;
  value: ThemePreference;
}> = [
  { label: "System", meta: "Follow OS", value: "system" },
  { label: "Dark", meta: "Always dark", value: "dark" },
  { label: "Light", meta: "Always light", value: "light" },
];

const DENSITY_OPTIONS: Array<{
  label: string;
  meta: string;
  value: DensityPreference;
}> = [
  {
    label: "Mission control",
    meta: "Full thread chips",
    value: "mission-control",
  },
  { label: "Compact", meta: "Chips hidden", value: "compact" },
];

const PASTED_IMAGE_PATCH_OPTIONS: Array<{
  description: string;
  label: string;
  value: number;
}> = [
  {
    description:
      "Caps square images at about 1024 32px patches before model-specific multipliers.",
    label: "1024 patches",
    value: 1024,
  },
  {
    description:
      "Default. Limits large pasted images to roughly 1536 image patches before model-specific multipliers.",
    label: "1536 patches",
    value: 1536,
  },
  {
    description:
      "Allows roughly a 2048 x 2048 square image before model-specific multipliers.",
    label: "4096 patches",
    value: 4096,
  },
  {
    description: "Preserves pasted image dimensions before upload.",
    label: "Actual size",
    value: 0,
  },
];

const UPDATE_CHANNEL_OPTIONS: Array<{
  label: string;
  value: DesktopUpdateChannel;
}> = [
  { label: "Latest", value: "latest" },
  { label: "Prerelease", value: "prerelease" },
];

const HOT_CPU_HEAP_SNAPSHOT_LIMIT_OPTIONS: Array<{
  label: string;
  meta: string;
  value: number;
}> = [
  { label: "2 snapshots", meta: "Start + stop", value: 2 },
  { label: "3 snapshots", meta: "Extra sample", value: 3 },
];

const HOT_CPU_START_DELAY_OPTIONS: Array<{
  label: string;
  meta: string;
  value: DesktopHotCpuProfileStartDelayMs;
}> = [
  { label: "Immediate", meta: "Arm now", value: 0 },
  { label: "5 seconds", meta: "Short setup", value: 5_000 },
  { label: "10 seconds", meta: "Long setup", value: 10_000 },
];

const HOT_CPU_TRIGGER_MODE_OPTIONS: Array<{
  label: string;
  meta: string;
  value: DesktopHotCpuProfileTriggerMode;
}> = [
  { label: "Spike", meta: "> 50%", value: "spike" },
  { label: "Sustained", meta: "2x > 50%", value: "sustained" },
  { label: "Slowburn", meta: "2x > 15%", value: "slowburn" },
];

/** Session-local, not persisted: it is a one-shot capture, not a preference. */
const HEAP_SNAPSHOT_DELAY_OPTIONS: Array<{
  label: string;
  meta: string;
  value: number;
}> = [
  { label: "Immediate", meta: "Capture now", value: 0 },
  { label: "5 seconds", meta: "Short setup", value: 5_000 },
  { label: "10 seconds", meta: "Long setup", value: 10_000 },
];

function releaseVersionText(release: AppUpdateReleaseInfo | undefined): string {
  return release?.version ?? "Unavailable";
}

function releaseHelpText(
  releases: AppUpdateReleaseVersions | undefined,
): string {
  if (!releases) {
    return "Release versions are loading.";
  }
  return `Latest: ${releaseVersionText(releases.latest)}. Prerelease: ${releaseVersionText(releases.prerelease)}.`;
}

function updateResultText(result: AppUpdateCheckResult): string {
  if (result.status === "skipped") {
    return result.reason;
  }
  if (result.status === "error") {
    return `Update check failed: ${result.message}`;
  }
  if (result.status === "checking") {
    return "Checking for updates...";
  }
  if (result.status === "no-update") {
    return `You're up to date (v${result.version}).`;
  }
  if (result.status === "downloaded") {
    return `Update ready: v${result.version}. Restart to install.`;
  }
  return `Update available: v${result.version}. Downloading in the background.`;
}

function formatHotCpuStartDelay(delayMs: DesktopHotCpuProfileStartDelayMs): string {
  return delayMs === 0 ? "Immediate" : `Delay ${Math.round(delayMs / 1_000)}s`;
}

export function GeneralSettings(props: {
  appearanceController?: AppearanceController;
  desktopApi?: DesktopApi;
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  onDeveloperModeChange: (value: boolean) => Promise<void>;
  onHotCpuProfilingEnabledChange: (value: boolean) => Promise<void>;
  onHotCpuProfilingStartDelayMsChange: (
    value: DesktopHotCpuProfileStartDelayMs,
  ) => Promise<void>;
  onHotCpuProfilingTriggerModeChange: (
    value: DesktopHotCpuProfileTriggerMode,
  ) => Promise<void>;
  onHotCpuProfilingCaptureHeapSnapshotChange: (value: boolean) => Promise<void>;
  onHotCpuProfilingHeapSnapshotLimitChange: (value: number) => Promise<void>;
  onConfirmQuitWithInProgressThreadsChange: (value: boolean) => Promise<void>;
  onPastedImageMaxPatchesChange: (value: number) => Promise<void>;
  onUpdateChannelChange: (value: DesktopUpdateChannel) => Promise<void>;
  onNotificationsEnabledChange: (value: boolean) => Promise<void>;
  onClearMessagingAcknowledgment: () => Promise<void>;
}) {
  const [releaseVersions, setReleaseVersions] = useState<
    AppUpdateReleaseVersions | undefined
  >();
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateResult, setUpdateResult] = useState<
    AppUpdateCheckResult | undefined
  >();
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus>({
    status: "idle",
  });
  const [updateRestarting, setUpdateRestarting] = useState(false);
  const [updateRestartError, setUpdateRestartError] = useState<
    string | undefined
  >();
  const [hotCpuCountdownEndsAt, setHotCpuCountdownEndsAt] = useState<
    number | null
  >(null);
  const [hotCpuCountdownRemainingMs, setHotCpuCountdownRemainingMs] =
    useState(0);
  const [heapSnapshotDelayMs, setHeapSnapshotDelayMs] = useState(0);
  const [heapSnapshotCountdownEndsAt, setHeapSnapshotCountdownEndsAt] =
    useState<number | null>(null);
  const [heapSnapshotCountdownRemainingMs, setHeapSnapshotCountdownRemainingMs] =
    useState(0);
  const [appMetadata, setAppMetadata] = useState<AppMetadata>();
  const pastedImageMaxPatches =
    props.snapshot.imageUploads.pastedImageMaxPatches;
  const confirmQuitWithInProgressThreads =
    props.snapshot.general.confirmQuitWithInProgressThreads;
  const developerMode = props.snapshot.general.developerMode;
  const hotCpuProfilingEnabled =
    props.snapshot.general.hotCpuProfilingEnabled;
  const hotCpuProfilingStartDelayMs =
    props.snapshot.general.hotCpuProfilingStartDelayMs;
  const hotCpuProfilingTriggerMode =
    props.snapshot.general.hotCpuProfilingTriggerMode;
  const hotCpuProfilingSlowburnThresholdPercent =
    props.snapshot.general.hotCpuProfilingSlowburnThresholdPercent;
  const hotCpuProfilingCaptureHeapSnapshot =
    props.snapshot.general.hotCpuProfilingCaptureHeapSnapshot;
  const hotCpuProfilingHeapSnapshotLimit =
    props.snapshot.general.hotCpuProfilingHeapSnapshotLimit;
  const notificationsEnabled = props.snapshot.general.notificationsEnabled;
  const updateChannel = props.snapshot.updates.channel;
  const messagingAcknowledgment =
    props.snapshot.general.messagingAcknowledgment;
  const activeOption = PASTED_IMAGE_PATCH_OPTIONS.find(
    (option) => option.value === pastedImageMaxPatches.value,
  );
  const hotCpuCountdownActive = hotCpuCountdownRemainingMs > 0;
  const hotCpuCountdownSeconds = Math.ceil(hotCpuCountdownRemainingMs / 1_000);
  const hotCpuStartDelayText = formatHotCpuStartDelay(
    hotCpuProfilingStartDelayMs.value,
  );

  useEffect(() => {
    if (hotCpuCountdownEndsAt === null) {
      return;
    }

    const updateCountdown = () => {
      const remainingMs = Math.max(0, hotCpuCountdownEndsAt - Date.now());
      setHotCpuCountdownRemainingMs(remainingMs);
      if (remainingMs === 0) {
        setHotCpuCountdownEndsAt(null);
      }
    };

    updateCountdown();
    const interval = window.setInterval(updateCountdown, 250);
    return () => {
      window.clearInterval(interval);
    };
  }, [hotCpuCountdownEndsAt]);

  const startHotCpuCapture = async () => {
    await props.onHotCpuProfilingEnabledChange(true);
    if (hotCpuProfilingStartDelayMs.value > 0) {
      const endsAt = Date.now() + hotCpuProfilingStartDelayMs.value;
      setHotCpuCountdownEndsAt(endsAt);
      setHotCpuCountdownRemainingMs(hotCpuProfilingStartDelayMs.value);
    } else {
      setHotCpuCountdownEndsAt(null);
      setHotCpuCountdownRemainingMs(0);
    }
  };

  const stopHotCpuCapture = async () => {
    setHotCpuCountdownEndsAt(null);
    setHotCpuCountdownRemainingMs(0);
    await props.onHotCpuProfilingEnabledChange(false);
  };

  const heapSnapshotCountdownActive = heapSnapshotCountdownRemainingMs > 0;
  const heapSnapshotCountdownSeconds = Math.ceil(
    heapSnapshotCountdownRemainingMs / 1_000,
  );
  const heapSnapshotDelayText =
    HEAP_SNAPSHOT_DELAY_OPTIONS.find(
      (option) => option.value === heapSnapshotDelayMs,
    )?.label ?? "Immediate";

  // Mirrors the countdown the main process is already running, purely so the
  // row can say how long is left. If Settings closes, main still captures.
  useEffect(() => {
    if (heapSnapshotCountdownEndsAt === null) {
      return;
    }

    const updateCountdown = () => {
      const remainingMs = Math.max(0, heapSnapshotCountdownEndsAt - Date.now());
      setHeapSnapshotCountdownRemainingMs(remainingMs);
      if (remainingMs === 0) {
        setHeapSnapshotCountdownEndsAt(null);
      }
    };

    updateCountdown();
    const interval = window.setInterval(updateCountdown, 250);
    return () => {
      window.clearInterval(interval);
    };
  }, [heapSnapshotCountdownEndsAt]);

  const startHeapSnapshotCapture = async () => {
    const scheduled = await props.desktopApi?.captureHeapSnapshot?.({
      delayMs: heapSnapshotDelayMs,
      target: "both",
    });
    const delayMs = scheduled?.delayMs ?? heapSnapshotDelayMs;
    if (delayMs > 0) {
      setHeapSnapshotCountdownEndsAt(Date.now() + delayMs);
      setHeapSnapshotCountdownRemainingMs(delayMs);
    }
  };

  const processIds = appMetadata ? formatProcessIds(appMetadata) : undefined;

  useEffect(() => {
    let canceled = false;
    void props.desktopApi?.readAppMetadata?.().then((metadata) => {
      if (!canceled) {
        setAppMetadata(metadata);
      }
    });
    return () => {
      canceled = true;
    };
  }, [props.desktopApi]);

  useEffect(() => {
    let canceled = false;
    void props.desktopApi?.readAppUpdateReleaseVersions?.().then((versions) => {
      if (!canceled) {
        setReleaseVersions(versions);
      }
    });
    return () => {
      canceled = true;
    };
  }, [props.desktopApi]);

  useEffect(() => {
    let canceled = false;
    let receivedEvent = false;
    const unsubscribe = props.desktopApi?.onAppUpdateStatus?.((status) => {
      receivedEvent = true;
      setUpdateStatus(status);
      if (status.status === "downloaded") {
        setUpdateRestartError(undefined);
        setUpdateRestarting(false);
      }
    });
    void props.desktopApi?.readAppUpdateStatus?.().then((status) => {
      if (!canceled && !receivedEvent) {
        setUpdateStatus(status);
      }
    });
    return () => {
      canceled = true;
      unsubscribe?.();
    };
  }, [props.desktopApi]);

  const checkForUpdates = props.desktopApi?.checkForAppUpdates;
  const downloadedVersion =
    updateStatus.status === "downloaded" ? updateStatus.version : undefined;
  const handleCheckForUpdate = async () => {
    if (!checkForUpdates) {
      return;
    }
    setUpdateChecking(true);
    setUpdateResult(undefined);
    try {
      const result = await checkForUpdates();
      setUpdateResult(result);
      setUpdateStatus(result);
    } catch (err) {
      setUpdateResult({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setUpdateChecking(false);
    }
  };
  const handleRestartUpdate = async () => {
    if (!props.desktopApi?.installAppUpdate) {
      setUpdateRestartError("Restart is not available in this build.");
      return;
    }
    setUpdateRestarting(true);
    setUpdateRestartError(undefined);
    const result = await props.desktopApi.installAppUpdate();
    if (result.status === "error") {
      setUpdateRestartError(result.message);
      setUpdateRestarting(false);
    }
  };

  const appearance = props.appearanceController?.appearance;

  return (
    <SettingsSectionStack paneId="general" aria-label="General settings">
      <SettingsPanelHead
        eyebrow="General"
        title="General settings"
        help="Defaults that apply across PwrAgent surfaces."
      />

      {props.appearanceController && appearance ? (
        <SettingsSection eyebrow="General" title="Appearance">
          <div className="settings-fields">
            <SettingsField
              label="Theme"
              sub="System follows your OS appearance and flips live when you change it."
              help={
                appearance.theme === "system"
                  ? `Currently following the OS (${appearance.resolvedTheme}).`
                  : `Locked to ${appearance.theme}.`
              }
              control={
                <div
                  className="settings-segmented"
                  role="radiogroup"
                  aria-label="Theme"
                >
                  {THEME_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      aria-checked={appearance.theme === option.value}
                      className={`settings-segmented__button settings-segmented__button--stacked${
                        appearance.theme === option.value ? " is-active" : ""
                      }`}
                      role="radio"
                      type="button"
                      onClick={() => {
                        props.appearanceController?.setTheme(option.value);
                      }}
                    >
                      <span>{option.label}</span>
                      <span className="settings-segmented__meta">
                        {option.meta}
                      </span>
                    </button>
                  ))}
                </div>
              }
            />
            <SettingsField
              label="Density"
              sub="Compact hides the directory and PR chips in thread rows so more threads fit on screen. Reaction and pin markers stay visible."
              control={
                <div
                  className="settings-segmented"
                  role="radiogroup"
                  aria-label="Density"
                >
                  {DENSITY_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      aria-checked={appearance.density === option.value}
                      className={`settings-segmented__button settings-segmented__button--stacked${
                        appearance.density === option.value ? " is-active" : ""
                      }`}
                      role="radio"
                      type="button"
                      onClick={() => {
                        props.appearanceController?.setDensity(option.value);
                      }}
                    >
                      <span>{option.label}</span>
                      <span className="settings-segmented__meta">
                        {option.meta}
                      </span>
                    </button>
                  ))}
                </div>
              }
            />
          </div>
        </SettingsSection>
      ) : null}

      <SettingsSection
        eyebrow="General"
        title="Quit confirmation"
        chip={sourceBadge(confirmQuitWithInProgressThreads)}
      >
        <div className="settings-fields">
          <SettingsField
            label="Confirm quit when threads or terminals are active"
            sub="Warn before quitting while agent turns, integrated terminal commands, or environment actions are running. On macOS and Linux, idle terminal prompts do not block quit. The prompt auto-quits after a short countdown so shutdown can continue."
            source={sourceBadge(confirmQuitWithInProgressThreads)}
            control={
              <SettingsSwitch
                checked={confirmQuitWithInProgressThreads.value}
                disabled={props.saving}
                label="Confirm quit when threads or terminals are active"
                onChange={(next) => {
                  void props.onConfirmQuitWithInProgressThreadsChange(next);
                }}
              />
            }
          />
        </div>
      </SettingsSection>

      <SettingsSection
        eyebrow="General"
        title="Notifications"
        chip={sourceBadge(notificationsEnabled)}
      >
        <div className="settings-fields">
          <SettingsField
            label="Desktop notifications"
            sub="Native alerts for approval/questions and turn completion while PwrAgent is unfocused or minimized."
            source={sourceBadge(notificationsEnabled)}
            help="If you don't see notifications, allow them for PwrAgent in your OS notification settings."
            control={
              <SettingsSwitch
                checked={notificationsEnabled.value}
                disabled={props.saving}
                label="Desktop notifications"
                onChange={(next) => {
                  void props.onNotificationsEnabledChange(next);
                }}
              />
            }
          />
        </div>
      </SettingsSection>

      <SettingsSection
        eyebrow="General"
        title="Updates"
        chip={sourceBadge(updateChannel)}
      >
        <div className="settings-fields">
          <SettingsField
            label="Update channel"
            sub="Choose which GitHub release stream the updater follows."
            help={
              <>
                {releaseHelpText(releaseVersions)}
                {updateResult ? (
                  <>
                    {" "}
                    <span
                      className={
                        updateResult.status === "error"
                          ? "settings-update-channel__result settings-update-channel__result--error"
                          : "settings-update-channel__result"
                      }
                      role={
                        updateResult.status === "error" ? "alert" : undefined
                      }
                    >
                      {updateResultText(updateResult)}
                    </span>
                  </>
                ) : null}
              </>
            }
            error={updateChannel.error}
            source={sourceBadge(updateChannel)}
            control={
              <div className="settings-update-channel">
                <div
                  className="settings-segmented"
                  role="radiogroup"
                  aria-label="Update channel"
                >
                  {UPDATE_CHANNEL_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      aria-checked={updateChannel.value === option.value}
                      className={`settings-segmented__button settings-segmented__button--stacked${
                        updateChannel.value === option.value ? " is-active" : ""
                      }`}
                      disabled={props.saving}
                      role="radio"
                      type="button"
                      onClick={() => {
                        void props.onUpdateChannelChange(option.value);
                      }}
                    >
                      <span>{option.label}</span>
                      <span className="settings-segmented__meta">
                        {releaseVersionText(releaseVersions?.[option.value])}
                      </span>
                    </button>
                  ))}
                </div>
                {downloadedVersion ? (
                  <div className="settings-update-channel__restart">
                    <button
                      aria-label={`Restart to Update (${downloadedVersion})`}
                      className="button button--primary settings-update-channel__restart-button"
                      type="button"
                      disabled={
                        updateRestarting || !props.desktopApi?.installAppUpdate
                      }
                      onClick={() => {
                        void handleRestartUpdate();
                      }}
                    >
                      <span>Restart to Update</span>
                      <span className="settings-update-channel__restart-version">
                        ({downloadedVersion})
                      </span>
                    </button>
                    <span className="settings-update-channel__downloaded">
                      Downloaded version: {downloadedVersion}
                    </span>
                    {updateRestartError ? (
                      <span
                        className="settings-update-channel__result settings-update-channel__result--error"
                        role="alert"
                      >
                        {updateRestartError}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                <button
                  className="button button--secondary settings-update-channel__button"
                  type="button"
                  disabled={!checkForUpdates || props.saving || updateChecking}
                  onClick={() => {
                    void handleCheckForUpdate();
                  }}
                >
                  {updateChecking ? "Checking..." : "Check for Update"}
                </button>
              </div>
            }
          />
        </div>
      </SettingsSection>

      <SettingsSection
        eyebrow="General"
        title="Pasted images"
        chip={sourceBadge(pastedImageMaxPatches)}
      >
        <div className="settings-fields">
          <SettingsField
            label="Image patch budget"
            sub="Resize pasted desktop images before upload to control image-token usage."
            help={
              <>
                {activeOption?.description ??
                  "Custom patch budget for pasted images."}{" "}
                Patch-based models count 32 x 32 pixel blocks before
                model-specific multipliers. Images within 20% of the selected
                patch budget are left unchanged to avoid marginal re-encodes.
                Tile-based models use their own image resizing rules.
              </>
            }
            error={pastedImageMaxPatches.error}
            source={sourceBadge(pastedImageMaxPatches)}
            control={
              <div
                className="settings-segmented"
                role="radiogroup"
                aria-label="Pasted image patch budget"
              >
                {PASTED_IMAGE_PATCH_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    aria-checked={pastedImageMaxPatches.value === option.value}
                    className={`settings-segmented__button${
                      pastedImageMaxPatches.value === option.value
                        ? " is-active"
                        : ""
                    }`}
                    disabled={props.saving}
                    role="radio"
                    type="button"
                    onClick={() => {
                      void props.onPastedImageMaxPatchesChange(option.value);
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            }
          />
        </div>
      </SettingsSection>

      <SettingsSection eyebrow="General" title="Messaging acknowledgment">
        <div className="settings-fields">
          <SettingsField
            label="First-run acknowledgment"
            sub="Your record of when you acknowledged the messaging-safety preamble in the first-run wizard."
            help={
              messagingAcknowledgment.value ? (
                <>
                  Acknowledged{" "}
                  <strong>
                    {new Date(
                      messagingAcknowledgment.value.acknowledgedAt,
                    ).toLocaleString()}
                  </strong>
                  {messagingAcknowledgment.value.providers.length > 0 ? (
                    <>
                      {" · providers configured: "}
                      <strong>
                        {messagingAcknowledgment.value.providers.join(", ")}
                      </strong>
                    </>
                  ) : null}
                </>
              ) : (
                <>
                  Not yet acknowledged. Run Help → Replay Onboarding to set up
                  messaging.
                </>
              )
            }
            control={
              <button
                type="button"
                className="button button--secondary"
                disabled={
                  props.saving || messagingAcknowledgment.value === null
                }
                onClick={() => {
                  void props.onClearMessagingAcknowledgment();
                }}
              >
                Clear acknowledgment
              </button>
            }
          />
        </div>
      </SettingsSection>

      <SettingsSection
        eyebrow="General"
        title="Developer mode"
        chip={sourceBadge(developerMode)}
      >
        <div className="settings-fields">
          <SettingsField
            label="Developer Mode"
            sub="Expose Reload, Force Reload, and Developer Tools menu shortcuts."
            source={sourceBadge(developerMode)}
            control={
              <SettingsSwitch
                checked={developerMode.value}
                disabled={props.saving}
                label="Developer Mode"
                onChange={(next) => {
                  void props.onDeveloperModeChange(next);
                }}
              />
            }
          />
          <SettingsField
            label="Hot renderer CPU profiling"
            sub="Start an armed capture only after the presets below are ready."
            source={sourceBadge(hotCpuProfilingEnabled)}
            control={
              <div className="settings-hot-cpu-capture">
                {hotCpuProfilingEnabled.value || hotCpuCountdownActive ? (
                  <button
                    type="button"
                    className="button button--secondary"
                    disabled={props.saving}
                    onClick={() => {
                      void stopHotCpuCapture();
                    }}
                  >
                    Stop Capture
                  </button>
                ) : (
                  <button
                    type="button"
                    className="button button--primary"
                    disabled={props.saving}
                    onClick={() => {
                      void startHotCpuCapture();
                    }}
                  >
                    Start Capture ({hotCpuStartDelayText})
                  </button>
                )}
                <span className="settings-hot-cpu-capture__status" aria-live="polite">
                  {hotCpuCountdownActive
                    ? `Starting in ${hotCpuCountdownSeconds}s`
                    : hotCpuProfilingEnabled.value
                      ? "Monitoring"
                      : "Not armed"}
                </span>
              </div>
            }
          />
          <SettingsField
            label="Profiling start delay"
            sub="Wait before the monitor starts sampling so you can trigger the scenario."
            source={sourceBadge(hotCpuProfilingStartDelayMs)}
            control={
              <div
                className="settings-segmented"
                role="radiogroup"
                aria-label="Profiling start delay"
              >
                {HOT_CPU_START_DELAY_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    aria-checked={
                      hotCpuProfilingStartDelayMs.value === option.value
                    }
                    className={`settings-segmented__button settings-segmented__button--stacked${
                      hotCpuProfilingStartDelayMs.value === option.value
                        ? " is-active"
                        : ""
                    }`}
                    disabled={props.saving}
                    role="radio"
                    type="button"
                    onClick={() => {
                      void props.onHotCpuProfilingStartDelayMsChange(
                        option.value,
                      );
                    }}
                  >
                    <span>{option.label}</span>
                    <span className="settings-segmented__meta">
                      {option.meta}
                    </span>
                  </button>
                ))}
              </div>
            }
          />
          <SettingsField
            label="CPU profile trigger"
            sub="Choose whether one spike, two hot samples, or a lower slowburn starts the capture."
            help={`Slowburn currently uses ${hotCpuProfilingSlowburnThresholdPercent.value}% across the same consecutive-sample window.`}
            source={sourceBadge(hotCpuProfilingTriggerMode)}
            control={
              <div
                className="settings-segmented"
                role="radiogroup"
                aria-label="CPU profile trigger"
              >
                {HOT_CPU_TRIGGER_MODE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    aria-checked={
                      hotCpuProfilingTriggerMode.value === option.value
                    }
                    className={`settings-segmented__button settings-segmented__button--stacked${
                      hotCpuProfilingTriggerMode.value === option.value
                        ? " is-active"
                        : ""
                    }`}
                    disabled={props.saving}
                    role="radio"
                    type="button"
                    onClick={() => {
                      void props.onHotCpuProfilingTriggerModeChange(
                        option.value,
                      );
                    }}
                  >
                    <span>{option.label}</span>
                    <span className="settings-segmented__meta">
                      {option.meta}
                    </span>
                  </button>
                ))}
              </div>
            }
          />
          <SettingsField
            label="Smart heap snapshots"
            sub="Capture bounded heap snapshots around the next hot CPU trigger, then turn this option back off."
            help="Arms heap snapshots for the next explicit CPU capture start."
            source={sourceBadge(hotCpuProfilingCaptureHeapSnapshot)}
            control={
              <SettingsSwitch
                checked={hotCpuProfilingCaptureHeapSnapshot.value}
                disabled={props.saving}
                label="Smart heap snapshots"
                onChange={(next) => {
                  void props.onHotCpuProfilingCaptureHeapSnapshotChange(next);
                }}
              />
            }
          />
          <SettingsField
            label="Heap snapshot limit"
            sub="Keep emergency heap capture small enough to avoid filling disk or stalling the app repeatedly."
            source={sourceBadge(hotCpuProfilingHeapSnapshotLimit)}
            control={
              <div
                className="settings-segmented"
                role="radiogroup"
                aria-label="Heap snapshot limit"
              >
                {HOT_CPU_HEAP_SNAPSHOT_LIMIT_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    aria-checked={
                      hotCpuProfilingHeapSnapshotLimit.value === option.value
                    }
                    className={`settings-segmented__button settings-segmented__button--stacked${
                      hotCpuProfilingHeapSnapshotLimit.value === option.value
                        ? " is-active"
                        : ""
                    }`}
                    disabled={
                      props.saving || !hotCpuProfilingCaptureHeapSnapshot.value
                    }
                    role="radio"
                    type="button"
                    onClick={() => {
                      void props.onHotCpuProfilingHeapSnapshotLimitChange(
                        option.value,
                      );
                    }}
                  >
                    <span>{option.label}</span>
                    <span className="settings-segmented__meta">
                      {option.meta}
                    </span>
                  </button>
                ))}
              </div>
            }
          />
          <SettingsField
            label="Capture heap snapshot"
            sub="Snapshot both processes right now, without waiting for a CPU spike. Use the delay to stage the scenario first."
            control={
              <div className="settings-hot-cpu-capture">
                <button
                  type="button"
                  className="button button--primary"
                  disabled={!developerMode.value || heapSnapshotCountdownActive}
                  onClick={() => {
                    void startHeapSnapshotCapture();
                  }}
                >
                  Capture ({heapSnapshotDelayText})
                </button>
                <span
                  className="settings-hot-cpu-capture__status"
                  aria-live="polite"
                >
                  {!developerMode.value
                    ? "Requires Developer Mode"
                    : heapSnapshotCountdownActive
                      ? `Capturing in ${heapSnapshotCountdownSeconds}s`
                      : "Idle"}
                </span>
              </div>
            }
            help={`Capture runs in the main process, so you can close Settings while the countdown finishes. ${HEAP_SNAPSHOT_SECRET_WARNING}`}
          />
          <SettingsField
            label="Heap snapshot delay"
            sub="Wait before capturing so you can reproduce the state you want to inspect."
            control={
              <div
                className="settings-segmented"
                role="radiogroup"
                aria-label="Heap snapshot delay"
              >
                {HEAP_SNAPSHOT_DELAY_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    aria-checked={heapSnapshotDelayMs === option.value}
                    className={`settings-segmented__button settings-segmented__button--stacked${
                      heapSnapshotDelayMs === option.value ? " is-active" : ""
                    }`}
                    disabled={
                      !developerMode.value || heapSnapshotCountdownActive
                    }
                    role="radio"
                    type="button"
                    onClick={() => {
                      setHeapSnapshotDelayMs(option.value);
                    }}
                  >
                    <span>{option.label}</span>
                    <span className="settings-segmented__meta">
                      {option.meta}
                    </span>
                  </button>
                ))}
              </div>
            }
          />
          <SettingsField
            label="Process IDs"
            sub="Attach a debugger or profiler to the right process when several Electron apps are running."
            control={
              processIds ? (
                <SettingsCopyValue
                  desktopApi={props.desktopApi}
                  label="process IDs"
                  value={processIds}
                />
              ) : (
                <span className="settings-hot-cpu-capture__status">
                  Unavailable
                </span>
              )
            }
          />
        </div>
      </SettingsSection>
    </SettingsSectionStack>
  );
}
