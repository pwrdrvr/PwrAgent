import type {
  DesktopMessagingImageProfile,
  DesktopSettingsSnapshot,
} from "@pwragent/shared";
import {
  SettingsField,
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
} from "./SettingsLayout";
import { sourceBadge } from "./settings-fields";

const IMAGE_PROFILE_OPTIONS: Array<{
  description: string;
  label: string;
  value: DesktopMessagingImageProfile;
}> = [
  {
    description: "Lowest bandwidth. Images are downscaled aggressively.",
    label: "Low",
    value: "low",
  },
  {
    description: "Default. Matches desktop paste behavior.",
    label: "Medium",
    value: "medium",
  },
  {
    description: "Higher fidelity with larger uploads.",
    label: "High",
    value: "high",
  },
  {
    description: "Preserve the inbound image dimensions.",
    label: "Actual",
    value: "actual",
  },
];

export function GeneralSettings(props: {
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  onImageProfileChange: (value: DesktopMessagingImageProfile) => Promise<void>;
}) {
  const imageProfile = props.snapshot.messaging.attachments.imageProfile;
  const overridden = imageProfile.source === "env";
  const activeOption = IMAGE_PROFILE_OPTIONS.find(
    (option) => option.value === imageProfile.value,
  );

  return (
    <SettingsSectionStack paneId="general" aria-label="General settings">
      <SettingsPanelHead
        eyebrow="General"
        title="General settings"
        help="Defaults that apply across PwrAgent surfaces."
      />

      <SettingsSection
        eyebrow="General"
        title="Image uploads"
        chip={sourceBadge(imageProfile)}
        chipKind={overridden ? "warn" : "default"}
      >
        <div className="settings-fields">
          <SettingsField
            label="Image upload profile"
            sub="Normalize inbound messaging images before forwarding them to the model."
            help={
              overridden
                ? "Overridden by PWRAGENT_MESSAGING_ATTACHMENT_IMAGE_PROFILE; clear the environment variable to edit this from settings."
                : activeOption?.description
            }
            error={imageProfile.error}
            source={sourceBadge(imageProfile)}
            control={
              <div
                className="settings-segmented"
                role="radiogroup"
                aria-label="Image upload profile"
              >
                {IMAGE_PROFILE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    aria-checked={imageProfile.value === option.value}
                    className={`settings-segmented__button${
                      imageProfile.value === option.value ? " is-active" : ""
                    }`}
                    disabled={props.saving || overridden}
                    role="radio"
                    type="button"
                    onClick={() => {
                      void props.onImageProfileChange(option.value);
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
