import { useEffect, useState } from "react";
import type {
  DesktopSettingsSnapshot,
  DesktopUpdateChannel,
  DesktopUpdateTrain,
} from "@pwragent/shared";
import type {
  AppUpdateCheckResult,
  AppUpdateReleaseInfo,
  AppUpdateReleaseVersions,
  AppUpdateStatus,
} from "../../../../shared/app-metadata";
import type { DesktopApi } from "../../lib/desktop-api";
import type {
  AppearanceController,
  DensityPreference,
  TextSizePreference,
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
  { label: "Compact", meta: "Metadata chips hidden", value: "compact" },
];

/* One notch scale serves both text-size axes (sidebar titles,
   transcript body). */
const TEXT_SIZE_OPTIONS: Array<{
  label: string;
  value: TextSizePreference;
}> = [
  { label: "XS", value: "xs" },
  { label: "S", value: "sm" },
  { label: "M", value: "md" },
  { label: "L", value: "lg" },
  { label: "XL", value: "xl" },
];

/* One field per text-size axis — a shared control so a radiogroup fix
   (keyboard handling, aria, styling) lands once for every axis. */
function TextSizeField(props: {
  label: string;
  sub: string;
  value: TextSizePreference;
  onChange: (value: TextSizePreference) => void;
}) {
  return (
    <SettingsField
      label={props.label}
      sub={props.sub}
      control={
        <div
          className="settings-segmented"
          role="radiogroup"
          aria-label={props.label}
        >
          {TEXT_SIZE_OPTIONS.map((option) => (
            <button
              key={option.value}
              aria-checked={props.value === option.value}
              className={`settings-segmented__button${
                props.value === option.value ? " is-active" : ""
              }`}
              role="radio"
              type="button"
              onClick={() => {
                props.onChange(option.value);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      }
    />
  );
}

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

const UPDATE_TRAIN_OPTIONS: Array<{
  label: string;
  value: DesktopUpdateTrain;
}> = [
  { label: "Stable", value: "stable" },
  { label: "Beta", value: "beta" },
];

const UPDATE_CHANNEL_OPTIONS: Array<{
  label: string;
  value: DesktopUpdateChannel;
}> = [
  { label: "Latest", value: "latest" },
  { label: "Prerelease", value: "prerelease" },
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
  return [
    `Stable latest: ${releaseVersionText(releases.stable.latest)}`,
    `Stable prerelease: ${releaseVersionText(releases.stable.prerelease)}`,
    `Beta latest: ${releaseVersionText(releases.beta.latest)}`,
    `Beta prerelease: ${releaseVersionText(releases.beta.prerelease)}`,
  ].join(". ");
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
    return result.direction === "downgrade"
      ? `Switch ready: v${result.version}. Restart to switch.`
      : `Update ready: v${result.version}. Restart to install.`;
  }
  return result.direction === "downgrade"
    ? `Switch to v${result.version}. Downloading in the background.`
    : `Update available: v${result.version}. Downloading in the background.`;
}

export function GeneralSettings(props: {
  appearanceController?: AppearanceController;
  desktopApi?: DesktopApi;
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  onConfirmQuitWithInProgressThreadsChange: (value: boolean) => Promise<void>;
  onAttentionPromoteOnTurnEndChange: (value: boolean) => Promise<void>;
  onPdfAnalysisEnabledChange: (value: boolean) => Promise<void>;
  onPastedImageMaxPatchesChange: (value: number) => Promise<void>;
  onUpdateChannelChange: (value: DesktopUpdateChannel) => Promise<void>;
  onUpdateTrainChange: (value: DesktopUpdateTrain) => Promise<void>;
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
  const pastedImageMaxPatches =
    props.snapshot.imageUploads.pastedImageMaxPatches;
  const confirmQuitWithInProgressThreads =
    props.snapshot.general.confirmQuitWithInProgressThreads;
  const attentionPromoteOnTurnEnd =
    props.snapshot.general.attentionPromoteOnTurnEnd;
  const pdfAnalysisEnabled = props.snapshot.general.pdfAnalysisEnabled;
  const notificationsEnabled = props.snapshot.general.notificationsEnabled;
  const updateChannel = props.snapshot.updates.channel;
  const updateTrain = props.snapshot.updates.train;
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
  // A resolved selection that is older than the running build is a switch back
  // onto the operator's own channel, not an update.
  const downloadedIsSwitchBack =
    updateStatus.status === "downloaded"
    && updateStatus.direction === "downgrade";
  const restartActionLabel = downloadedIsSwitchBack
    ? "Restart to Switch"
    : "Restart to Update";
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
      // The check refreshed the main-process release cache, so this read is
      // served from memory and clears any stale Unavailable slot labels. It is
      // cosmetic: failing it must not overwrite the check result above.
      try {
        const versions =
          await props.desktopApi?.readAppUpdateReleaseVersions?.();
        if (versions) {
          setReleaseVersions(versions);
        }
      } catch {
        // Keep the check result the operator just asked for.
      }
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
              label="Info density"
              sub="Compact hides the provider, directory, and branch chips in thread rows so more threads fit on screen. PR chips, reactions, and pin markers stay visible."
              control={
                <div
                  className="settings-segmented"
                  role="radiogroup"
                  aria-label="Info density"
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
            <TextSizeField
              label="Sidebar text size"
              sub="Scales the thread and directory titles in the left sidebar. M is the tuned default; each notch moves the titles one pixel."
              value={appearance.sidebarTextSize}
              onChange={(value) => {
                props.appearanceController?.setSidebarTextSize(value);
              }}
            />
            <TextSizeField
              label="Transcript text size"
              sub="Scales body text in the thread transcript — messages, plans, reviews, and prompts. M is the tuned default; each notch moves the text one pixel."
              value={appearance.transcriptTextSize}
              onChange={(value) => {
                props.appearanceController?.setTranscriptTextSize(value);
              }}
            />
          </div>
        </SettingsSection>
      ) : null}

      <SettingsSection
        eyebrow="General"
        title="Attention lens"
        chip={sourceBadge(attentionPromoteOnTurnEnd)}
      >
        <div className="settings-fields">
          <SettingsField
            label="Move a thread to the top when its turn finishes"
            sub="Attention ranks threads by when their current turn started, so streaming output, sub-agents, and tool results never re-sort the queue mid-turn. Turn this off to keep a thread parked where its turn started until the next one begins."
            source={sourceBadge(attentionPromoteOnTurnEnd)}
            control={
              <SettingsSwitch
                checked={attentionPromoteOnTurnEnd.value}
                disabled={props.saving}
                label="Move a thread to the top when its turn finishes"
                onChange={(next) => {
                  void props.onAttentionPromoteOnTurnEndChange(next);
                }}
              />
            }
          />
        </div>
      </SettingsSection>

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
        chip={
          updateTrain.source === "config"
            ? sourceBadge(updateTrain)
            : sourceBadge(updateChannel)
        }
      >
        <div className="settings-fields">
          <SettingsField
            label="Release channel"
            sub="Stable is the smoke-checked train. Beta follows main and stays selectable even when its versions are still Unavailable."
            help={releaseHelpText(releaseVersions)}
            error={updateTrain.error}
            source={sourceBadge(updateTrain)}
            control={
              <div
                className="settings-segmented"
                role="radiogroup"
                aria-label="Release channel"
              >
                {UPDATE_TRAIN_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    aria-checked={updateTrain.value === option.value}
                    className={`settings-segmented__button settings-segmented__button--stacked${
                      updateTrain.value === option.value ? " is-active" : ""
                    }`}
                    disabled={props.saving}
                    role="radio"
                    type="button"
                    onClick={() => {
                      void props.onUpdateTrainChange(option.value);
                    }}
                  >
                    <span>{option.label}</span>
                    <span className="settings-segmented__meta">
                      {releaseVersionText(
                        releaseVersions?.[option.value]?.latest,
                      )}
                    </span>
                  </button>
                ))}
              </div>
            }
          />
          <SettingsField
            label="Update track"
            sub="Latest is smoke-checked. Prerelease is newer and may not install."
            help={
              updateResult ? (
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
              ) : undefined
            }
            error={updateChannel.error}
            source={sourceBadge(updateChannel)}
            control={
              <div className="settings-update-channel">
                <div
                  className="settings-segmented"
                  role="radiogroup"
                  aria-label="Update track"
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
                        {releaseVersionText(
                          releaseVersions?.[updateTrain.value]?.[option.value],
                        )}
                      </span>
                    </button>
                  ))}
                </div>
                {downloadedVersion ? (
                  <div className="settings-update-channel__restart">
                    <button
                      aria-label={`${restartActionLabel} (${downloadedVersion})`}
                      className="button button--primary settings-update-channel__restart-button"
                      type="button"
                      disabled={
                        updateRestarting || !props.desktopApi?.installAppUpdate
                      }
                      onClick={() => {
                        void handleRestartUpdate();
                      }}
                    >
                      <span>{restartActionLabel}</span>
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

      <SettingsSection
        eyebrow="General"
        title="PDF analysis"
        chip={sourceBadge(pdfAnalysisEnabled)}
      >
        <div className="settings-fields">
          <SettingsField
            label="Use PwrAgent PDF analysis"
            sub="Use local PDF tools to select pages on supported Codex threads, or render a bounded page set when a backend requires image input. This preserves visual layout while avoiding raw PDF input overhead."
            help="Turn this off to leave PDFs as normal local-file references for model-directed code or manual inspection."
            source={sourceBadge(pdfAnalysisEnabled)}
            control={
              <SettingsSwitch
                checked={pdfAnalysisEnabled.value}
                disabled={props.saving}
                label="Use PwrAgent PDF analysis"
                onChange={(value) => {
                  void props.onPdfAnalysisEnabledChange(value);
                }}
              />
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
