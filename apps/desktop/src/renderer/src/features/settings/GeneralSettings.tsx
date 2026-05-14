import type { DesktopSettingsSnapshot } from "@pwragent/shared";
import {
  SettingsField,
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
} from "./SettingsLayout";
import { sourceBadge } from "./settings-fields";

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

export function GeneralSettings(props: {
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  onPastedImageMaxPatchesChange: (value: number) => Promise<void>;
}) {
  const pastedImageMaxPatches =
    props.snapshot.imageUploads.pastedImageMaxPatches;
  const activeOption = PASTED_IMAGE_PATCH_OPTIONS.find(
    (option) => option.value === pastedImageMaxPatches.value,
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
