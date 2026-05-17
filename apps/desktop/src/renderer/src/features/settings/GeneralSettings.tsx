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
import {
  SettingsField,
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
} from "./SettingsLayout";
import { sourceBadge } from "./settings-fields";
import { SettingsSwitch } from "./SettingsSwitch";

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

  return (
    <SettingsSectionStack paneId="general" aria-label="General settings">
      <SettingsPanelHead
        eyebrow="General"
        title="General settings"
        help="Defaults that apply across PwrAgent surfaces."
      />

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
