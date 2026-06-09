import { useEffect, useState } from "react";
import type {
  DesktopSettingsSnapshot,
  DesktopUpdateChannel,
} from "@pwragent/shared";
import type {
  AppUpdateCheckResult,
  AppUpdateReleaseInfo,
  AppUpdateReleaseVersions,
} from "../../../../shared/app-metadata";
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
import { sourceBadge } from "./settings-fields";
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

export function GeneralSettings(props: {
  appearanceController?: AppearanceController;
  desktopApi?: DesktopApi;
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  onDeveloperModeChange: (value: boolean) => Promise<void>;
  onHotCpuProfilingEnabledChange: (value: boolean) => Promise<void>;
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
  const pastedImageMaxPatches =
    props.snapshot.imageUploads.pastedImageMaxPatches;
  const confirmQuitWithInProgressThreads =
    props.snapshot.general.confirmQuitWithInProgressThreads;
  const developerMode = props.snapshot.general.developerMode;
  const hotCpuProfilingEnabled =
    props.snapshot.general.hotCpuProfilingEnabled;
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

  const checkForUpdates = props.desktopApi?.checkForAppUpdates;
  const handleUpdateNow = async () => {
    if (!checkForUpdates) {
      return;
    }
    setUpdateChecking(true);
    setUpdateResult(undefined);
    try {
      setUpdateResult(await checkForUpdates());
    } catch (err) {
      setUpdateResult({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setUpdateChecking(false);
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
            label="Confirm quit when threads are in progress"
            sub="Warn before quitting while agent turns are running. The prompt auto-quits after a short countdown so shutdown can continue."
            source={sourceBadge(confirmQuitWithInProgressThreads)}
            control={
              <SettingsSwitch
                checked={confirmQuitWithInProgressThreads.value}
                disabled={props.saving}
                label="Confirm quit when threads are in progress"
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
            sub="Capture a short Chrome CPU profile when the renderer stays hot."
            source={sourceBadge(hotCpuProfilingEnabled)}
            control={
              <SettingsSwitch
                checked={hotCpuProfilingEnabled.value}
                disabled={props.saving}
                label="Hot renderer CPU profiling"
                onChange={(next) => {
                  void props.onHotCpuProfilingEnabledChange(next);
                }}
              />
            }
          />
          <SettingsField
            label="Smart heap snapshots"
            sub="Capture bounded heap snapshots around the next hot CPU trigger, then turn this option back off."
            help="This also enables hot renderer CPU profiling so it can arm immediately while the current instance keeps running."
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
                <button
                  className="button button--secondary settings-update-channel__button"
                  type="button"
                  disabled={!checkForUpdates || props.saving || updateChecking}
                  onClick={() => {
                    void handleUpdateNow();
                  }}
                >
                  {updateChecking ? "Checking..." : "Update"}
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
    </SettingsSectionStack>
  );
}
