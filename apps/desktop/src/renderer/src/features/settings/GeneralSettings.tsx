import { useState } from "react";
import type {
  DesktopColorTheme,
  DesktopSettingsSnapshot,
} from "@pwragent/shared";
import { Select, type SelectOption } from "../../components/Select";
import type { DesktopApi } from "../../lib/desktop-api";
import type {
  AppearanceController,
  DarkThemePreference,
  DensityPreference,
  LightThemePreference,
  TextSizePreference,
  ThemePreference,
} from "../../lib/useAppearance";
import {
  SegmentedControl,
  SegmentedField,
  SettingsField,
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
  ToggleField,
} from "./SettingsLayout";
import { sourceBadge } from "./settings-fields";

const THEME_OPTIONS: Array<{
  label: string;
  meta: string;
  value: ThemePreference;
}> = [
  { label: "System", meta: "Follow OS", value: "system" },
  { label: "Dark", meta: "Always dark", value: "dark" },
  { label: "Light", meta: "Always light", value: "light" },
];

/** A theme's canvas, sidebar, accent, and primary text, from the
 *  `--theme-swatch-*` tokens on `:root`, so it shows true while any other
 *  theme renders. */
function ThemeSwatch(props: { theme: DesktopColorTheme }) {
  return (
    <span className="theme-swatch">
      {(["app", "sidebar", "accent", "text"] as const).map((part) => (
        <i
          key={part}
          style={{ background: `var(--theme-swatch-${props.theme}-${part})` }}
        />
      ))}
    </span>
  );
}

const PWRAGENT_THEMES = "PwrAgent";
const COMMUNITY_THEMES = "Community palettes";

/* The theme each scheme renders in. Picked independently, so "System"
   above flips between the two choices with the OS. PwrAgent's own pairs
   come first; the community group is what explains the borrowed names. */
function themeOption<T extends DesktopColorTheme>(
  value: T,
  label: string,
  group: string,
  description?: string,
): SelectOption<T> {
  return {
    value,
    label,
    group,
    description,
    leading: <ThemeSwatch theme={value} />,
  };
}

const DARK_THEME_OPTIONS: readonly SelectOption<DarkThemePreference>[] = [
  themeOption("tangerine-dark", "Tangerine", PWRAGENT_THEMES, "PwrAgent default"),
  themeOption("gray-dark", "Gray", PWRAGENT_THEMES, "Charcoal surfaces"),
  themeOption("blue-dark", "Blue", PWRAGENT_THEMES, "Navy surfaces"),
  themeOption("matrix-dark", "Matrix", PWRAGENT_THEMES, "Phosphor green on black"),
  themeOption("catppuccin-mocha", "Catppuccin Mocha", COMMUNITY_THEMES),
  themeOption("solarized-dark", "Solarized Dark", COMMUNITY_THEMES),
];

const LIGHT_THEME_OPTIONS: readonly SelectOption<LightThemePreference>[] = [
  themeOption("tangerine-light", "Tangerine", PWRAGENT_THEMES, "PwrAgent default"),
  themeOption("gray-light", "Gray", PWRAGENT_THEMES, "Light gray surfaces"),
  themeOption("blue-light", "Blue", PWRAGENT_THEMES, "Pale blue surfaces"),
  themeOption("catppuccin-latte", "Catppuccin Latte", COMMUNITY_THEMES),
  themeOption("solarized-light", "Solarized Light", COMMUNITY_THEMES),
];

/** Each theme's other half: picking one offers it for the other scheme. A
 *  dark-only theme (Matrix) has no light half, so picking it offers none. */
const LIGHT_PAIR: Partial<Record<DarkThemePreference, LightThemePreference>> = {
  "tangerine-dark": "tangerine-light",
  "gray-dark": "gray-light",
  "blue-dark": "blue-light",
  "catppuccin-mocha": "catppuccin-latte",
  "solarized-dark": "solarized-light",
};
const DARK_PAIR = Object.fromEntries(
  Object.entries(LIGHT_PAIR).map(([dark, light]) => [light, dark]),
) as Record<LightThemePreference, DarkThemePreference>;

/** Credit for a community palette, linked from its field. Their licenses
 *  are in THIRD_PARTY_LICENSES. */
const PALETTE_CREDITS: Partial<
  Record<DesktopColorTheme, { name: string; url: string }>
> = {
  "catppuccin-mocha": { name: "Catppuccin", url: "https://catppuccin.com/licensing/" },
  "catppuccin-latte": { name: "Catppuccin", url: "https://catppuccin.com/licensing/" },
  "solarized-dark": { name: "Ethan Schoonover", url: "https://ethanschoonover.com/solarized/" },
  "solarized-light": { name: "Ethan Schoonover", url: "https://ethanschoonover.com/solarized/" },
};

type ThemePairOffer =
  | { scheme: "dark"; theme: DarkThemePreference; pairedWith: string }
  | { scheme: "light"; theme: LightThemePreference; pairedWith: string };

function themeLabel(theme: DesktopColorTheme): string {
  return (
    [...DARK_THEME_OPTIONS, ...LIGHT_THEME_OPTIONS].find(
      (option) => option.value === theme,
    )?.label ?? theme
  );
}

/** The scheme row's sub-line: what it is for, whether Theme can reach it,
 *  and the palette credit. */
function themeFieldSub(
  scheme: "dark" | "light",
  themePreference: ThemePreference,
  colorTheme: DesktopColorTheme,
) {
  const credit = PALETTE_CREDITS[colorTheme];
  const unreachable =
    themePreference !== "system" && themePreference !== scheme;
  return (
    <>
      Colors used whenever the app is {scheme}.
      {unreachable
        ? ` Not used while Theme is ${themePreference === "dark" ? "Dark" : "Light"}.`
        : null}
      {credit ? (
        <>
          {" "}Palette by{" "}
          <a href={credit.url} target="_blank" rel="noreferrer">
            {credit.name}
          </a>
          {" "}(MIT).
        </>
      ) : null}
    </>
  );
}

const THEME_PICKER_CLASS = "settings-select settings-select--chip";

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
        // No pending tracker: the appearance controller applies the axis
        // optimistically, so the sidebar or transcript resizes on the click
        // and the persist is fire-and-forget behind it.
        <SegmentedControl
          label={props.label}
          options={TEXT_SIZE_OPTIONS}
          value={props.value}
          onChange={props.onChange}
        />
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

function ThemePairOfferPrompt(props: {
  offer: ThemePairOffer;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const label = themeLabel(props.offer.theme);
  return (
    <div aria-live="polite" className="settings-action-confirmation">
      <div className="settings-action-confirmation__copy">
        <strong>Use {label} for the {props.offer.scheme} theme too?</strong>
        <span>It is {props.offer.pairedWith}&apos;s {props.offer.scheme} pair.</span>
      </div>
      <div className="settings-inline-actions">
        <button className="button button--primary" type="button" onClick={props.onAccept}>
          Use {label}
        </button>
        <button className="button button--ghost" type="button" onClick={props.onDismiss}>
          Not now
        </button>
      </div>
    </div>
  );
}

export function GeneralSettings(props: {
  appearanceController?: AppearanceController;
  desktopApi?: DesktopApi;
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  onConfirmQuitWithInProgressThreadsChange: (value: boolean) => Promise<void>;
  onAttentionPromoteOnTurnEndChange: (value: boolean) => Promise<void>;
  onInteractiveSvgChange: (patch: {
    interactiveSvgSkipNotice?: boolean;
    interactiveSvgAutoOpen?: boolean;
  }) => Promise<void>;
  onPdfAnalysisEnabledChange: (value: boolean) => Promise<void>;
  onPastedImageMaxPatchesChange: (value: number) => Promise<void>;
  onNotificationsEnabledChange: (value: boolean) => Promise<void>;
  onThemedDockIconChange: (value: boolean) => Promise<void>;
  onClearMessagingAcknowledgment: () => Promise<void>;
}) {
  const pastedImageMaxPatches =
    props.snapshot.imageUploads.pastedImageMaxPatches;
  const confirmQuitWithInProgressThreads =
    props.snapshot.general.confirmQuitWithInProgressThreads;
  const attentionPromoteOnTurnEnd =
    props.snapshot.general.attentionPromoteOnTurnEnd;
  const interactiveSvgSkipNotice =
    props.snapshot.general.interactiveSvgSkipNotice;
  const interactiveSvgAutoOpen = props.snapshot.general.interactiveSvgAutoOpen;
  // An older profile can hold auto-open without skip-notice; auto-open has
  // always implied it, as the lightbox reads it.
  const trustsSvgScripts =
    interactiveSvgSkipNotice.value || interactiveSvgAutoOpen.value;
  // The badge names whichever key turned trust on.
  const svgTrustSource =
    interactiveSvgSkipNotice.value || !interactiveSvgAutoOpen.value
      ? interactiveSvgSkipNotice
      : interactiveSvgAutoOpen;
  const pdfAnalysisEnabled = props.snapshot.general.pdfAnalysisEnabled;
  const notificationsEnabled = props.snapshot.general.notificationsEnabled;
  const themedDockIcon = props.snapshot.general.appearance.themedDockIcon;
  const messagingAcknowledgment =
    props.snapshot.general.messagingAcknowledgment;
  const activeOption = PASTED_IMAGE_PATCH_OPTIONS.find(
    (option) => option.value === pastedImageMaxPatches.value,
  );

  const appearance = props.appearanceController?.appearance;
  // Offered once, right after a pick, when the other scheme's theme is not
  // the picked theme's pair. Never applied without a click: choosing the
  // two independently is the point of the two rows.
  const [pairOffer, setPairOffer] = useState<ThemePairOffer | null>(null);

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
                // No pending tracker: the whole window re-themes on the click,
                // which is louder feedback than a spinner could be.
                <SegmentedControl
                  label="Theme"
                  options={THEME_OPTIONS}
                  value={appearance.theme}
                  onChange={(value) => {
                    props.appearanceController?.setTheme(value);
                  }}
                />
              }
            />
            <SettingsField
              label="Dark theme"
              sub={themeFieldSub("dark", appearance.theme, appearance.darkTheme)}
              source={appearance.resolvedTheme === "dark" ? "Showing" : undefined}
              control={
                <Select
                  aria-label="Dark theme"
                  className={THEME_PICKER_CLASS}
                  options={DARK_THEME_OPTIONS}
                  value={appearance.darkTheme}
                  onChange={(value) => {
                    props.appearanceController?.setDarkTheme(value);
                    const pair = LIGHT_PAIR[value];
                    setPairOffer(
                      pair === undefined || appearance.lightTheme === pair
                        ? null
                        : { scheme: "light", theme: pair, pairedWith: themeLabel(value) },
                    );
                  }}
                />
              }
              actions={
                pairOffer?.scheme === "light" ? (
                  <ThemePairOfferPrompt
                    offer={pairOffer}
                    onAccept={() => {
                      props.appearanceController?.setLightTheme(pairOffer.theme);
                      setPairOffer(null);
                    }}
                    onDismiss={() => setPairOffer(null)}
                  />
                ) : null
              }
            />
            <SettingsField
              label="Light theme"
              sub={themeFieldSub("light", appearance.theme, appearance.lightTheme)}
              source={appearance.resolvedTheme === "light" ? "Showing" : undefined}
              control={
                <Select
                  aria-label="Light theme"
                  className={THEME_PICKER_CLASS}
                  options={LIGHT_THEME_OPTIONS}
                  value={appearance.lightTheme}
                  onChange={(value) => {
                    props.appearanceController?.setLightTheme(value);
                    const pair = DARK_PAIR[value];
                    setPairOffer(
                      appearance.darkTheme === pair
                        ? null
                        : { scheme: "dark", theme: pair, pairedWith: themeLabel(value) },
                    );
                  }}
                />
              }
              actions={
                pairOffer?.scheme === "dark" ? (
                  <ThemePairOfferPrompt
                    offer={pairOffer}
                    onAccept={() => {
                      props.appearanceController?.setDarkTheme(pairOffer.theme);
                      setPairOffer(null);
                    }}
                    onDismiss={() => setPairOffer(null)}
                  />
                ) : null
              }
            />
            {props.desktopApi?.platform === "darwin" ? (
              <ToggleField
                checked={themedDockIcon.value}
                disabled={props.saving}
                label="Match Dock icon to theme"
                sub="While PwrAgent runs, its Dock icon wears the dark theme, so instances on different profiles are easy to tell apart."
                source={sourceBadge(themedDockIcon)}
                onChange={(next) => {
                  return props.onThemedDockIconChange(next);
                }}
              />
            ) : null}
            <SettingsField
              label="Info density"
              sub="Compact hides the provider, directory, and branch chips in thread rows so more threads fit on screen. PR chips, reactions, and pin markers stay visible."
              control={
                // No pending tracker: the thread rows recompose on the click.
                <SegmentedControl
                  label="Info density"
                  options={DENSITY_OPTIONS}
                  value={appearance.density}
                  onChange={(value) => {
                    props.appearanceController?.setDensity(value);
                  }}
                />
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
          <ToggleField
            checked={attentionPromoteOnTurnEnd.value}
            disabled={props.saving}
            label="Move a thread to the top when its turn finishes"
            sub="Attention ranks threads by when their current turn started, so streaming output, sub-agents, and tool results never re-sort the queue mid-turn. Turn this off to keep a thread parked where its turn started until the next one begins."
            source={sourceBadge(attentionPromoteOnTurnEnd)}
            onChange={(next) => {
              return props.onAttentionPromoteOnTurnEndChange(next);
            }}
          />
        </div>
      </SettingsSection>

      <SettingsSection
        eyebrow="General"
        title="Interactive SVGs"
        chip={sourceBadge(interactiveSvgAutoOpen.source === "default"
          ? interactiveSvgSkipNotice
          : interactiveSvgAutoOpen)}
      >
        <div className="settings-fields">
          <ToggleField
            checked={trustsSvgScripts}
            disabled={props.saving}
            label="Run SVG scripts without asking"
            sub="Clicking an SVG runs its scripts in an isolated frame, with no notice first."
            source={sourceBadge(svgTrustSource)}
            onChange={(next) => {
              // Opening interactive runs scripts too, so it goes off with trust.
              return props.onInteractiveSvgChange(next
                ? { interactiveSvgSkipNotice: true }
                : { interactiveSvgSkipNotice: false, interactiveSvgAutoOpen: false });
            }}
          />
          <ToggleField
            checked={interactiveSvgAutoOpen.value}
            disabled={props.saving}
            label="Open SVGs interactive"
            sub="Skip the static preview when an SVG has scripts."
            lockedReason={trustsSvgScripts
              ? undefined
              : "Needs \u201cRun SVG scripts without asking\u201d: opening an SVG runs its scripts."}
            source={sourceBadge(interactiveSvgAutoOpen)}
            onChange={(next) => {
              return props.onInteractiveSvgChange({ interactiveSvgAutoOpen: next });
            }}
          />
        </div>
      </SettingsSection>

      <SettingsSection
        eyebrow="General"
        title="Quit confirmation"
        chip={sourceBadge(confirmQuitWithInProgressThreads)}
      >
        <div className="settings-fields">
          <ToggleField
            checked={confirmQuitWithInProgressThreads.value}
            disabled={props.saving}
            label="Confirm quit when threads or terminals are active"
            sub="Warn before quitting while agent turns, integrated terminal commands, or environment actions are running. On macOS and Linux, idle terminal prompts do not block quit. The prompt auto-quits after a short countdown so shutdown can continue."
            source={sourceBadge(confirmQuitWithInProgressThreads)}
            onChange={(next) => {
              return props.onConfirmQuitWithInProgressThreadsChange(next);
            }}
          />
        </div>
      </SettingsSection>

      <SettingsSection
        eyebrow="General"
        title="Notifications"
        chip={sourceBadge(notificationsEnabled)}
      >
        <div className="settings-fields">
          <ToggleField
            checked={notificationsEnabled.value}
            disabled={props.saving}
            label="Desktop notifications"
            sub="Native alerts for approval/questions and turn completion while PwrAgent is unfocused or minimized."
            help="If you don't see notifications, allow them for PwrAgent in your OS notification settings."
            source={sourceBadge(notificationsEnabled)}
            onChange={(next) => {
              return props.onNotificationsEnabledChange(next);
            }}
          />
        </div>
      </SettingsSection>

      <SettingsSection
        eyebrow="General"
        title="Pasted images"
        chip={sourceBadge(pastedImageMaxPatches)}
      >
        <div className="settings-fields">
          <SegmentedField
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
            disabled={props.saving}
            options={PASTED_IMAGE_PATCH_OPTIONS}
            value={pastedImageMaxPatches.value}
            onChange={(value) => {
              return props.onPastedImageMaxPatchesChange(value);
            }}
          />
        </div>
      </SettingsSection>

      <SettingsSection
        eyebrow="General"
        title="PDF analysis"
        chip={sourceBadge(pdfAnalysisEnabled)}
      >
        <div className="settings-fields">
          <ToggleField
            checked={pdfAnalysisEnabled.value}
            disabled={props.saving}
            label="Use PwrAgent PDF analysis"
            sub="Use local PDF tools to select pages on supported Codex threads, or render a bounded page set when a backend requires image input. This preserves visual layout while avoiding raw PDF input overhead."
            help="Turn this off to leave PDFs as normal local-file references for model-directed code or manual inspection."
            source={sourceBadge(pdfAnalysisEnabled)}
            onChange={(value) => {
              return props.onPdfAnalysisEnabledChange(value);
            }}
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
