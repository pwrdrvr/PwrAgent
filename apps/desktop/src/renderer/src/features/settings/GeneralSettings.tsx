import { useEffect, useState } from "react";
import type {
  DesktopSettingsSnapshot,
  DesktopUpdateChannel,
} from "@pwragent/shared";
import type {
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

export function GeneralSettings(props: {
  appearanceController?: AppearanceController;
  desktopApi?: DesktopApi;
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  onDeveloperModeChange: (value: boolean) => Promise<void>;
  onPastedImageMaxPatchesChange: (value: number) => Promise<void>;
  onUpdateChannelChange: (value: DesktopUpdateChannel) => Promise<void>;
}) {
  const [releaseVersions, setReleaseVersions] = useState<
    AppUpdateReleaseVersions | undefined
  >();
  const pastedImageMaxPatches =
    props.snapshot.imageUploads.pastedImageMaxPatches;
  const developerMode = props.snapshot.general.developerMode;
  const updateChannel = props.snapshot.updates.channel;
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
            help={releaseHelpText(releaseVersions)}
            error={updateChannel.error}
            source={sourceBadge(updateChannel)}
            control={
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
    </SettingsSectionStack>
  );
}
