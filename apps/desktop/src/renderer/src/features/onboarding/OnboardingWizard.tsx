import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import type {
  DesktopAppearanceDensity,
  DesktopAppearanceTheme,
  DesktopCodexProfileModel,
  DesktopSettingsConfigPatch,
  DesktopSettingsSecretName,
  DesktopSettingsSecretState,
  DesktopSettingsSnapshot,
  MessagingChannelKind,
  MessagingPairingScope,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import type { AppearanceController } from "../../lib/useAppearance";
import type { DesktopSettingsState } from "../settings/useDesktopSettings";
import {
  DiscordIcon,
  FeishuIcon,
  LineIcon,
  MattermostIcon,
  SlackIcon,
  TelegramIcon,
} from "../../icons";

export type OnboardingProvider =
  | "telegram"
  | "discord"
  | "mattermost"
  | "feishu"
  | "slack"
  | "line";

type WizardStep =
  | "welcome"
  | "thread-presentation"
  | "codex-profile"
  | "name-codex-profiles"
  | "messaging-safety"
  | "messaging-providers"
  | "provider-setup"
  | "done";

type RailIndex = 0 | 1 | 2 | 3;

const RAIL_STEPS: ReadonlyArray<{ label: string }> = [
  { label: "Thread presentation" },
  { label: "Codex profile" },
  { label: "Messaging" },
  { label: "Review" },
];

function railIndexForStep(step: WizardStep): RailIndex | -1 {
  if (step === "welcome") return -1;
  if (step === "thread-presentation") return 0;
  if (step === "codex-profile" || step === "name-codex-profiles") return 1;
  if (
    step === "messaging-safety" ||
    step === "messaging-providers" ||
    step === "provider-setup"
  )
    return 2;
  if (step === "done") return 3;
  return -1;
}

export type OnboardingWizardProps = {
  initialDensity: DesktopAppearanceDensity;
  initialTheme: DesktopAppearanceTheme;
  initialCodexProfileModel: DesktopCodexProfileModel;
  /** Live theme + density controller. The wizard calls setTheme / setDensity
   *  as the operator picks so the app flips in real time. */
  appearanceController: AppearanceController;
  /** Called once on Finish or Skip with the assembled config patch. */
  onComplete: (patch: DesktopSettingsConfigPatch) => Promise<void> | void;
  /**
   * Called when the operator dismisses the wizard via close button or
   * Skip. Implementation should clear the overlay; if `persistCompleted`
   * is true, the caller also persists `onboarding.completed = true`.
   */
  onDismiss: (persistCompleted: boolean) => void;
  /** When true, this is a Help-menu replay — do NOT persist `completed`. */
  isReplay: boolean;
  /** Deep-link target into Settings → Messaging when the operator
   *  picks providers and clicks Set up. */
  onOpenMessagingSettings?: () => void;
  /** Live settings state — used by per-provider setup steps to write
   *  secrets + config directly without leaving the wizard. */
  settings: DesktopSettingsState;
  /** Used for pairing-token + codex-auth-profile IPCs invoked inline
   *  by Steps 3c (per-provider setup) and the Multiple-profile loop. */
  desktopApi?: DesktopApi;
};

export function OnboardingWizard(props: OnboardingWizardProps) {
  const [step, setStep] = useState<WizardStep>("welcome");
  const [density, setDensity] = useState<DesktopAppearanceDensity>(
    props.initialDensity,
  );
  const [theme, setTheme] = useState<DesktopAppearanceTheme>(props.initialTheme);
  const [codexProfileModel, setCodexProfileModel] =
    useState<DesktopCodexProfileModel>(props.initialCodexProfileModel);
  const [codexProfileNames, setCodexProfileNames] = useState<string[]>([
    "personal",
    "work",
  ]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [selectedProviders, setSelectedProviders] = useState<
    ReadonlySet<OnboardingProvider>
  >(new Set(["telegram"]));
  const [providerSetupIndex, setProviderSetupIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  const isReplay = props.isReplay;
  const orderedProviders = useMemo(
    () =>
      PROVIDER_ORDER.filter((id) =>
        selectedProviders.has(id as OnboardingProvider),
      ) as OnboardingProvider[],
    [selectedProviders],
  );
  const currentProvider = orderedProviders[providerSetupIndex];

  // ESC = dismiss (same as Skip — see onDismiss contract)
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !submitting) {
        event.preventDefault();
        props.onDismiss(!isReplay);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isReplay, props, submitting]);

  // Conditional step graph — codexProfileModel="multiple" inserts the
  // name-codex-profiles step between codex-profile and messaging-safety;
  // empty selectedProviders skips provider-setup; etc. Centralizing the
  // transitions here so goNext/goPrev stay one-liners at the callsite.
  const nextStep = useCallback(
    (current: WizardStep): WizardStep | null => {
      switch (current) {
        case "welcome":
          return "thread-presentation";
        case "thread-presentation":
          return "codex-profile";
        case "codex-profile":
          return codexProfileModel === "multiple"
            ? "name-codex-profiles"
            : "messaging-safety";
        case "name-codex-profiles":
          return "messaging-safety";
        case "messaging-safety":
          return "messaging-providers";
        case "messaging-providers":
          return orderedProviders.length > 0 ? "provider-setup" : "done";
        case "provider-setup":
          return providerSetupIndex + 1 < orderedProviders.length
            ? "provider-setup"
            : "done";
        case "done":
          return null;
      }
    },
    [codexProfileModel, orderedProviders.length, providerSetupIndex],
  );
  const prevStep = useCallback(
    (current: WizardStep): WizardStep | null => {
      switch (current) {
        case "welcome":
          return null;
        case "thread-presentation":
          return "welcome";
        case "codex-profile":
          return "thread-presentation";
        case "name-codex-profiles":
          return "codex-profile";
        case "messaging-safety":
          return codexProfileModel === "multiple"
            ? "name-codex-profiles"
            : "codex-profile";
        case "messaging-providers":
          return "messaging-safety";
        case "provider-setup":
          return providerSetupIndex > 0
            ? "provider-setup"
            : "messaging-providers";
        case "done":
          return orderedProviders.length > 0
            ? "provider-setup"
            : "messaging-providers";
      }
    },
    [codexProfileModel, orderedProviders.length, providerSetupIndex],
  );

  const goPrev = useCallback(() => {
    if (step === "provider-setup" && providerSetupIndex > 0) {
      setProviderSetupIndex((i) => i - 1);
      return;
    }
    if (step === "done" && orderedProviders.length > 0) {
      setProviderSetupIndex(orderedProviders.length - 1);
      setStep("provider-setup");
      return;
    }
    const next = prevStep(step);
    if (next !== null) setStep(next);
  }, [orderedProviders.length, prevStep, providerSetupIndex, step]);
  const goNext = useCallback(() => {
    if (
      step === "provider-setup" &&
      providerSetupIndex + 1 < orderedProviders.length
    ) {
      setProviderSetupIndex((i) => i + 1);
      return;
    }
    if (step === "messaging-providers" && orderedProviders.length > 0) {
      setProviderSetupIndex(0);
    }
    const next = nextStep(step);
    if (next !== null) setStep(next);
  }, [nextStep, orderedProviders.length, providerSetupIndex, step]);

  const persistAndComplete = useCallback(
    async (extra?: DesktopSettingsConfigPatch): Promise<void> => {
      if (submitting) return;
      setSubmitting(true);
      try {
        const providers = [...selectedProviders];
        const patch: DesktopSettingsConfigPatch = {
          general: {
            appearance: { density, theme },
            codexProfileModel,
            ...(acknowledged
              ? {
                  messagingAcknowledgment: {
                    acknowledgedAt: new Date().toISOString(),
                    providers,
                  },
                }
              : {}),
          },
          // `onboarding.completed` is intentionally NOT in this patch
          // anymore. App.tsx's onComplete handler invokes the dedicated
          // `completeOnboardingCodexBootstrap` IPC instead, which both
          // persists `completed = true` AND fires the Codex `listThreads`
          // prefetch the read-side gate has been blocking while the
          // wizard was open. Going through writeConfig would persist the
          // flag but skip the prefetch, leaving the sidebar empty until
          // a manual refresh.
          ...(extra ?? {}),
        };
        await props.onComplete(patch);

        // Multi-profile path: actually create the named Codex auth
        // profiles on disk so the operator can pick them up in Settings →
        // Profiles. Login is left for the user to trigger from Settings —
        // we don't want to fire N SSO browser windows here.
        if (
          codexProfileModel === "multiple" &&
          props.desktopApi?.createCodexAuthProfile
        ) {
          const validNames = codexProfileNames
            .map((n) => n.trim())
            .filter((n) => isValidProfileName(n));
          for (const name of validNames) {
            try {
              await props.desktopApi.createCodexAuthProfile({ profile: name });
            } catch (caught) {
              // Best-effort: a single failed profile shouldn't sink the
              // whole flow. The user can retry from Settings → Profiles
              // (the existing #256 surface owns the actual provisioning).
              // eslint-disable-next-line no-console
              console.warn(
                `Onboarding: failed to create Codex profile "${name}"`,
                caught,
              );
            }
          }
        }
      } finally {
        setSubmitting(false);
      }
    },
    [
      acknowledged,
      codexProfileModel,
      codexProfileNames,
      density,
      isReplay,
      props,
      selectedProviders,
      submitting,
      theme,
    ],
  );

  const handleSkip = useCallback((): void => {
    // Skip mirrors Finish from a persistence standpoint when the
    // operator was already on first-run — we still mark completed so
    // they don't see the wizard auto-launch again. Replays skip persist.
    props.onDismiss(!isReplay);
  }, [isReplay, props]);

  const currentRailIndex = railIndexForStep(step);

  return (
    <div
      className="onboarding-wizard-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="First-run setup"
    >
      <div className="onboarding-wizard-overlay__scrim" />
      <div
        className={`onboarding-wizard${step === "welcome" || step === "done" ? " onboarding-wizard--narrow" : ""}`}
      >
        <WizardTitlebar
          step={step}
          isReplay={isReplay}
          providerName={
            step === "provider-setup" && currentProvider
              ? providerName(currentProvider)
              : undefined
          }
          providerPosition={
            step === "provider-setup"
              ? `${providerSetupIndex + 1} of ${orderedProviders.length}`
              : undefined
          }
          onClose={() => props.onDismiss(!isReplay)}
        />
        {step !== "welcome" ? (
          <WizardRail
            currentIndex={currentRailIndex}
            chosenDensity={density}
            chosenCodexProfileModel={codexProfileModel}
          />
        ) : null}
        <div className="onboarding-wizard__body">
          {step === "welcome" ? <WelcomeStep /> : null}
          {step === "thread-presentation" ? (
            <ThreadPresentationStep
              theme={theme}
              density={density}
              onThemeChange={(next) => {
                setTheme(next);
                props.appearanceController.setTheme(next);
              }}
              onDensityChange={(next) => {
                setDensity(next);
                props.appearanceController.setDensity(next);
              }}
            />
          ) : null}
          {step === "codex-profile" ? (
            <CodexProfileStep
              value={codexProfileModel}
              onChange={setCodexProfileModel}
            />
          ) : null}
          {step === "name-codex-profiles" ? (
            <NameCodexProfilesStep
              names={codexProfileNames}
              onChange={setCodexProfileNames}
            />
          ) : null}
          {step === "messaging-safety" ? (
            <MessagingSafetyStep
              acknowledged={acknowledged}
              onAcknowledgedChange={setAcknowledged}
            />
          ) : null}
          {step === "messaging-providers" ? (
            <MessagingProvidersStep
              selected={selectedProviders}
              onChange={setSelectedProviders}
            />
          ) : null}
          {step === "provider-setup" && currentProvider ? (
            <ProviderSetupStep
              key={currentProvider}
              provider={currentProvider}
              settings={props.settings}
              desktopApi={props.desktopApi}
            />
          ) : null}
          {step === "done" ? (
            <DoneStep
              density={density}
              codexProfileModel={codexProfileModel}
              codexProfileNames={
                codexProfileModel === "multiple" ? codexProfileNames : undefined
              }
              messagingProviders={orderedProviders}
              acknowledged={acknowledged}
            />
          ) : null}
        </div>
        <WizardFooter
          step={step}
          submitting={submitting}
          acknowledged={acknowledged}
          providerCount={selectedProviders.size}
          providerSetupIndex={providerSetupIndex}
          providerSetupTotal={orderedProviders.length}
          currentProviderName={
            currentProvider ? providerName(currentProvider) : undefined
          }
          codexProfileNamesValid={validateProfileNames(codexProfileNames)}
          density={density}
          codexProfileModel={codexProfileModel}
          onBack={goPrev}
          onSkip={handleSkip}
          onNext={goNext}
          onFinish={() => void persistAndComplete()}
        />
      </div>
    </div>
  );
}

function validateProfileNames(names: readonly string[]): boolean {
  const trimmed = names.map((n) => n.trim()).filter((n) => n.length > 0);
  if (trimmed.length < 1 || trimmed.length > 5) return false;
  const set = new Set(trimmed);
  return set.size === trimmed.length && trimmed.every(isValidProfileName);
}

function isValidProfileName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,30}$/.test(name);
}

/* ----------------------------------------------------------------
   Chrome — titlebar, step rail, footer
   ---------------------------------------------------------------- */

function WizardTitlebar(props: {
  step: WizardStep;
  isReplay: boolean;
  providerName?: string;
  providerPosition?: string;
  onClose: () => void;
}) {
  const eyebrow = props.isReplay ? "Replay" : "Welcome";
  const crumb = (() => {
    switch (props.step) {
      case "welcome":
        return "First-run setup";
      case "thread-presentation":
        return "Step 1 — Thread presentation";
      case "codex-profile":
        return "Step 2 — Codex profile";
      case "name-codex-profiles":
        return "Step 2 — Name your profiles";
      case "messaging-safety":
        return "Step 3 — Messaging — Before you connect";
      case "messaging-providers":
        return "Step 3 — Messaging — Pick providers";
      case "provider-setup":
        return props.providerName
          ? `Step 3 — ${props.providerName}${props.providerPosition ? ` (${props.providerPosition})` : ""}`
          : "Step 3 — Provider setup";
      case "done":
        return "Done";
    }
  })();
  return (
    <header className="onboarding-wizard__titlebar">
      <span className="onboarding-wizard__eyebrow">{eyebrow}</span>
      <span className="onboarding-wizard__sep">/</span>
      <span className="onboarding-wizard__crumb">{crumb}</span>
      <span className="onboarding-wizard__spacer" />
      <button
        type="button"
        className="onboarding-wizard__close"
        aria-label="Close onboarding"
        onClick={props.onClose}
      >
        <CloseIcon />
      </button>
    </header>
  );
}

function WizardRail(props: {
  currentIndex: number;
  chosenDensity: DesktopAppearanceDensity;
  chosenCodexProfileModel: DesktopCodexProfileModel;
}) {
  const labelOverrides: Record<number, string> = {
    0: props.currentIndex > 0 ? densityLabel(props.chosenDensity) : "Thread presentation",
    1:
      props.currentIndex > 1
        ? codexProfileLabel(props.chosenCodexProfileModel)
        : "Codex profile",
    2: "Messaging",
  };
  return (
    <nav className="onboarding-wizard__rail" aria-label="Setup progress">
      {RAIL_STEPS.map(({ label }, idx) => {
        const state =
          idx < props.currentIndex
            ? "done"
            : idx === props.currentIndex
              ? "current"
              : "pending";
        const numLabel =
          state === "done" ? `Step ${idx + 1} ✓` : idx === 3 ? "Done" : `Step ${idx + 1}`;
        return (
          <div
            key={idx}
            className={`onboarding-wizard__rail-step is-${state}`}
            aria-current={state === "current" ? "step" : undefined}
          >
            <div className="onboarding-wizard__rail-num">{numLabel}</div>
            <div className="onboarding-wizard__rail-label">
              {labelOverrides[idx] ?? label}
            </div>
          </div>
        );
      })}
    </nav>
  );
}

function WizardFooter(props: {
  step: WizardStep;
  submitting: boolean;
  acknowledged: boolean;
  providerCount: number;
  providerSetupIndex: number;
  providerSetupTotal: number;
  currentProviderName?: string;
  codexProfileNamesValid: boolean;
  density: DesktopAppearanceDensity;
  codexProfileModel: DesktopCodexProfileModel;
  onBack: () => void;
  onSkip: () => void;
  onNext: () => void;
  onFinish: () => void;
}) {
  const showBack =
    props.step !== "welcome" && props.step !== "done" && !props.submitting;
  const showSkip = props.step !== "done";
  const skipLabel = (() => {
    if (
      props.step === "messaging-safety" ||
      props.step === "messaging-providers"
    )
      return "Skip messaging setup";
    if (props.step === "provider-setup") return `Skip ${props.currentProviderName}`;
    return "Skip setup";
  })();

  let hint: string | undefined;
  if (props.step === "thread-presentation") {
    hint = `${densityLabel(props.density)} selected · 1 of 3`;
  } else if (props.step === "codex-profile") {
    hint = `${codexProfileLabel(props.codexProfileModel)} selected · 2 of 3`;
  } else if (props.step === "name-codex-profiles") {
    hint = props.codexProfileNamesValid
      ? "Names look good"
      : "1–5 unique lowercase names (letters, digits, _ , -)";
  } else if (props.step === "messaging-safety") {
    hint = props.acknowledged ? "Acknowledgement recorded" : undefined;
  } else if (props.step === "messaging-providers") {
    hint =
      props.providerCount > 0
        ? `${props.providerCount} provider${props.providerCount === 1 ? "" : "s"} selected`
        : "No providers selected";
  } else if (props.step === "provider-setup") {
    hint = `Provider ${props.providerSetupIndex + 1} of ${props.providerSetupTotal}`;
  }

  let primary: ReactNode = null;
  if (props.step === "welcome") {
    primary = (
      <button
        type="button"
        className="onboarding-wizard__btn onboarding-wizard__btn--primary"
        onClick={props.onNext}
      >
        Get started →
      </button>
    );
  } else if (
    props.step === "thread-presentation" ||
    props.step === "codex-profile"
  ) {
    primary = (
      <button
        type="button"
        className="onboarding-wizard__btn onboarding-wizard__btn--primary"
        onClick={props.onNext}
      >
        Continue →
      </button>
    );
  } else if (props.step === "name-codex-profiles") {
    primary = (
      <button
        type="button"
        className="onboarding-wizard__btn onboarding-wizard__btn--primary"
        disabled={!props.codexProfileNamesValid || props.submitting}
        onClick={props.onNext}
      >
        Continue →
      </button>
    );
  } else if (props.step === "messaging-safety") {
    primary = (
      <button
        type="button"
        className="onboarding-wizard__btn onboarding-wizard__btn--primary"
        disabled={!props.acknowledged || props.submitting}
        onClick={props.onNext}
      >
        Continue →
      </button>
    );
  } else if (props.step === "messaging-providers") {
    primary = (
      <button
        type="button"
        className="onboarding-wizard__btn onboarding-wizard__btn--primary"
        disabled={props.submitting}
        onClick={props.onNext}
      >
        {props.providerCount > 0 ? "Set up →" : "Finish →"}
      </button>
    );
  } else if (props.step === "provider-setup") {
    const isLast =
      props.providerSetupIndex + 1 >= props.providerSetupTotal;
    primary = (
      <button
        type="button"
        className="onboarding-wizard__btn onboarding-wizard__btn--primary"
        disabled={props.submitting}
        onClick={props.onNext}
      >
        {isLast ? "Finish →" : "Next provider →"}
      </button>
    );
  } else if (props.step === "done") {
    primary = (
      <button
        type="button"
        className="onboarding-wizard__btn onboarding-wizard__btn--primary"
        disabled={props.submitting}
        onClick={props.onFinish}
      >
        Open my workspace →
      </button>
    );
  }

  return (
    <footer className="onboarding-wizard__footer">
      {showBack ? (
        <button
          type="button"
          className="onboarding-wizard__btn onboarding-wizard__btn--ghost"
          onClick={props.onBack}
        >
          ← Back
        </button>
      ) : null}
      {showSkip ? (
        <button
          type="button"
          className="onboarding-wizard__btn onboarding-wizard__btn--link"
          onClick={props.onSkip}
        >
          {skipLabel}
        </button>
      ) : null}
      <span className="onboarding-wizard__spacer" />
      {hint ? <span className="onboarding-wizard__hint">{hint}</span> : null}
      {primary}
    </footer>
  );
}

/* ----------------------------------------------------------------
   Step bodies
   ---------------------------------------------------------------- */

function WelcomeStep() {
  return (
    <div className="onboarding-wizard__welcome">
      <div className="onboarding-wizard__brand">
        Pwr<span>Agent</span>
      </div>
      <h1 className="onboarding-wizard__title">
        Three short choices, then you&rsquo;re operating.
      </h1>
      <p className="onboarding-wizard__sub">
        Pick how your thread list looks, how PwrAgent relates to your Codex
        install, and which messaging platform you want — if any. Every choice
        persists in Settings → General and is reversible at any time.
      </p>
      <ol className="onboarding-wizard__welcome-list">
        <li>
          <span className="onboarding-wizard__welcome-num is-current">1</span>
          <div>
            <div className="onboarding-wizard__welcome-row-title">
              Thread presentation
            </div>
            <div className="onboarding-wizard__welcome-row-sub">
              Compact rows or Mission Control chips.
            </div>
          </div>
        </li>
        <li>
          <span className="onboarding-wizard__welcome-num">2</span>
          <div>
            <div className="onboarding-wizard__welcome-row-title">
              Codex profile
            </div>
            <div className="onboarding-wizard__welcome-row-sub">
              Share, isolate, or run multiple identities.
            </div>
          </div>
        </li>
        <li>
          <span className="onboarding-wizard__welcome-num">3</span>
          <div>
            <div className="onboarding-wizard__welcome-row-title">
              Messaging
            </div>
            <div className="onboarding-wizard__welcome-row-sub">
              Optional. Telegram-first; others available.
            </div>
          </div>
        </li>
      </ol>
    </div>
  );
}

function ThreadPresentationStep(props: {
  theme: DesktopAppearanceTheme;
  density: DesktopAppearanceDensity;
  onThemeChange: (value: DesktopAppearanceTheme) => void;
  onDensityChange: (value: DesktopAppearanceDensity) => void;
}) {
  return (
    <div>
      <header className="onboarding-wizard__head">
        <h1 className="onboarding-wizard__title">
          Pick your appearance and thread density
        </h1>
        <p className="onboarding-wizard__sub">
          Theme follows the OS by default. Density controls how much metadata
          rides on each thread row. Both flip live as you click, and both
          persist in Settings → General → Appearance.
        </p>
      </header>

      <div className="onboarding-wizard__theme-row">
        <span className="onboarding-wizard__theme-label">Theme</span>
        <div
          className="onboarding-wizard__segmented onboarding-wizard__segmented--inline"
          role="radiogroup"
          aria-label="Theme"
        >
          {(
            [
              { value: "system" as const, label: "Follow System", meta: "Match OS" },
              { value: "light" as const, label: "Light", meta: "Always light" },
              { value: "dark" as const, label: "Dark", meta: "Always dark" },
            ]
          ).map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={props.theme === option.value}
              className={`onboarding-wizard__segmented-btn onboarding-wizard__segmented-btn--stacked${props.theme === option.value ? " is-active" : ""}`}
              onClick={() => props.onThemeChange(option.value)}
            >
              <span>{option.label}</span>
              <span className="onboarding-wizard__segmented-meta">{option.meta}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="onboarding-wizard__choices onboarding-wizard__choices--2">
        <ChoiceCard
          eyebrow="Compact"
          title="Just the title — you know what it is"
          desc="You can remember that this thread is for PR #123 on branch feat/fix-feature-foo and that it's bound to topic SledgeHammer in the Hunters group on Telegram. You don't want all that clutter reminding you of it."
          hint="Best for: muscle memory, density, many open threads."
          badge={props.density === "compact" ? "Selected" : undefined}
          selected={props.density === "compact"}
          onSelect={() => props.onDensityChange("compact")}
          preview={<DensityCompactPreview />}
        />
        <ChoiceCard
          eyebrow="Mission control"
          title="Every row, every signal, all visible"
          desc="It's the 60s and you're at a beautiful console with a custom indicator for every system you're monitoring. All the info you need is right there — without having to remember the temperature at which a rocket engine burns itself as fuel."
          hint="Best for: at-a-glance scanning across many parallel states."
          badge={props.density === "mission-control" ? "Selected" : undefined}
          selected={props.density === "mission-control"}
          onSelect={() => props.onDensityChange("mission-control")}
          preview={<DensityMissionControlPreview />}
        />
      </div>
    </div>
  );
}

function CodexProfileStep(props: {
  value: DesktopCodexProfileModel;
  onChange: (value: DesktopCodexProfileModel) => void;
}) {
  return (
    <div>
      <header className="onboarding-wizard__head">
        <h1 className="onboarding-wizard__title">
          How should PwrAgent relate to your Codex install?
        </h1>
        <p className="onboarding-wizard__sub">
          PwrAgent runs on top of the same Codex backend you may already use.
          Pick whether you share that identity, isolate a fresh one, or set up
          several at once. You can change this later in Settings → General.
        </p>
      </header>
      <div className="onboarding-wizard__choices onboarding-wizard__choices--3">
        <ChoiceCard
          eyebrow="Shared"
          title="Reuse your existing Codex login"
          desc="Zero new logins. Threads created in PwrAgent show up in Codex Desktop and the codex CLI, and vice versa."
          hint="Best for: trying PwrAgent without disturbing anything."
          badge={props.value === "shared" ? "Default" : undefined}
          selected={props.value === "shared"}
          onSelect={() => props.onChange("shared")}
          preview={<CodexDiagramShared />}
        />
        <ChoiceCard
          eyebrow="Isolated"
          title="Create a fresh Codex profile for PwrAgent"
          desc="One login click. PwrAgent threads stay separate from your other Codex account(s). Still reachable via CODEX_HOME."
          hint="Best for: kicking the tires without touching work's Codex session."
          badge={props.value === "isolated" ? "Selected" : undefined}
          selected={props.value === "isolated"}
          onSelect={() => props.onChange("isolated")}
          preview={<CodexDiagramIsolated />}
        />
        <ChoiceCard
          eyebrow="Multiple · power user"
          title="Set up several profiles at once"
          desc="Name up to 5 paired profiles. Each gets its own login and identity. Configure additional profiles later in Settings → Profiles."
          hint="Best for: operators with multiple distinct identities."
          badge={props.value === "multiple" ? "Selected" : undefined}
          selected={props.value === "multiple"}
          onSelect={() => props.onChange("multiple")}
          preview={<CodexDiagramMultiple />}
        />
      </div>
    </div>
  );
}

function MessagingSafetyStep(props: {
  acknowledged: boolean;
  onAcknowledgedChange: (next: boolean) => void;
}) {
  return (
    <div className="onboarding-wizard__safety">
      <div className="onboarding-wizard__safety-icon">
        <ShieldIcon />
      </div>
      <h1 className="onboarding-wizard__title onboarding-wizard__title--center">
        Before you connect a messaging platform
      </h1>
      <p className="onboarding-wizard__sub onboarding-wizard__sub--center">
        A short pause to think this through. Three principles, then one
        acknowledgement.
      </p>
      <ul className="onboarding-wizard__safety-list">
        <li>
          <strong>Try personal first.</strong> Use a personal computer and
          personal accounts before connecting any work device or work account.
        </li>
        <li>
          <strong>If you do connect a work device,</strong> connect only the
          work messaging platform — never personal messaging platforms — on
          that device.
        </li>
        <li>
          <strong>Talk to your security team</strong> before connecting a work
          device to anything. Sadly, we know what the answer often will be.
          Act responsibly.
        </li>
      </ul>
      <label
        className={`onboarding-wizard__safety-ack${props.acknowledged ? " is-checked" : ""}`}
      >
        <input
          type="checkbox"
          checked={props.acknowledged}
          onChange={(event) => props.onAcknowledgedChange(event.target.checked)}
          className="onboarding-wizard__visually-hidden"
        />
        <span
          className={`onboarding-wizard__safety-check${props.acknowledged ? " is-on" : ""}`}
          aria-hidden
        />
        <span className="onboarding-wizard__safety-ack-text">
          <strong>I understand.</strong> I have carefully evaluated whether
          and how to proceed with connecting an agent to messaging platforms.
          All risk — including risk to my employment — is my own. I agree to
          hold PwrDrvr LLC and all PwrAgent contributors harmless for the
          outcomes of any actions I take here.
        </span>
      </label>
    </div>
  );
}

type ProviderRow = {
  id: OnboardingProvider;
  name: string;
  icon: ReactNode;
  recommended?: boolean;
  notes: string;
  setupTime: string;
  risk: "low" | "med" | "high";
  riskLabel: string;
};

const PROVIDER_ROWS: readonly ProviderRow[] = [
  {
    id: "telegram",
    name: "Telegram",
    icon: <TelegramIcon size={20} aria-hidden />,
    recommended: true,
    notes:
      "Sign up on mobile · BotFather /newbot · paste token · pairing code · go. No ports, no tunnels.",
    setupTime: "~2 min",
    risk: "low",
    riskLabel: "Lowest",
  },
  {
    id: "discord",
    name: "Discord",
    icon: <DiscordIcon size={20} aria-hidden />,
    notes:
      "Developer Portal app · bot token · OAuth invite to a guild. No ports or tunnels needed.",
    setupTime: "~10 min",
    risk: "low",
    riskLabel: "Low",
  },
  {
    id: "mattermost",
    name: "Mattermost",
    icon: <MattermostIcon size={20} aria-hidden />,
    notes:
      "Self-hosted: easy. Callback URL needed — private network low, public higher.",
    setupTime: "~15 min",
    risk: "med",
    riskLabel: "Medium",
  },
  {
    id: "feishu",
    name: "Feishu / Lark",
    icon: <FeishuIcon size={20} aria-hidden />,
    notes:
      "Open Platform app · app secret · webhook may apply depending on region.",
    setupTime: "~20 min",
    risk: "med",
    riskLabel: "Low–medium",
  },
  {
    id: "slack",
    name: "Slack",
    icon: <SlackIcon size={20} aria-hidden />,
    notes:
      "Multi-step app config · OAuth scopes · Socket Mode vs Events API. Most fiddly.",
    setupTime: "~30 min",
    risk: "med",
    riskLabel: "Low–medium",
  },
  {
    id: "line",
    name: "LINE",
    icon: <LineIcon size={20} aria-hidden />,
    notes:
      "Webhook-only inbound. Requires public HTTPS URL (tunnel needed for self-hosted).",
    setupTime: "~25 min + tunnel",
    risk: "high",
    riskLabel: "Medium-high",
  },
];

function MessagingProvidersStep(props: {
  selected: ReadonlySet<OnboardingProvider>;
  onChange: (next: ReadonlySet<OnboardingProvider>) => void;
}) {
  const toggle = (id: OnboardingProvider): void => {
    const next = new Set(props.selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    props.onChange(next);
  };
  return (
    <div>
      <header className="onboarding-wizard__head">
        <h1 className="onboarding-wizard__title">
          Pick the messaging platforms you want to connect
        </h1>
        <p className="onboarding-wizard__sub">
          Ranked by setup time and risk profile. Telegram is preselected —
          it&rsquo;s the lowest-friction path. You&rsquo;ll land in Settings →
          Messaging to finish each provider; add more later from there.
        </p>
      </header>
      <div className="onboarding-wizard__provider-table" role="grid">
        <div className="onboarding-wizard__provider-row is-head" role="row">
          <span />
          <span>Provider</span>
          <span>Notes</span>
          <span>Setup time</span>
          <span>Risk profile</span>
        </div>
        {PROVIDER_ROWS.map((row) => {
          const checked = props.selected.has(row.id);
          return (
            <label
              key={row.id}
              className={`onboarding-wizard__provider-row${checked ? " is-checked" : ""}`}
              role="row"
            >
              <span className="onboarding-wizard__provider-check-cell">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(row.id)}
                  className="onboarding-wizard__visually-hidden"
                />
                <span
                  className={`onboarding-wizard__provider-check${checked ? " is-on" : ""}`}
                  aria-hidden
                />
              </span>
              <span className="onboarding-wizard__provider-name">
                <span className="onboarding-wizard__provider-icon">{row.icon}</span>
                {row.name}
                {row.recommended ? (
                  <span className="onboarding-wizard__provider-rec">
                    Recommended
                  </span>
                ) : null}
              </span>
              <span className="onboarding-wizard__provider-notes">
                {row.notes}
              </span>
              <span className="onboarding-wizard__provider-meta">
                {row.setupTime}
              </span>
              <span
                className={`onboarding-wizard__provider-risk onboarding-wizard__provider-risk--${row.risk}`}
              >
                <span className="onboarding-wizard__provider-risk-dot" />
                {row.riskLabel}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function DoneStep(props: {
  density: DesktopAppearanceDensity;
  codexProfileModel: DesktopCodexProfileModel;
  codexProfileNames?: string[];
  messagingProviders: readonly OnboardingProvider[];
  acknowledged: boolean;
}) {
  const messagingSummary = useMemo(() => {
    if (!props.acknowledged) {
      return "Skipped — set up later in Settings → Messaging.";
    }
    if (props.messagingProviders.length === 0) {
      return "Acknowledged, no providers selected.";
    }
    return props.messagingProviders.map(providerName).join(", ");
  }, [props.acknowledged, props.messagingProviders]);
  const codexSummary = useMemo(() => {
    if (
      props.codexProfileModel === "multiple" &&
      props.codexProfileNames?.length
    ) {
      return `Multiple — ${props.codexProfileNames
        .map((n) => n.trim())
        .filter((n) => n.length > 0)
        .join(", ")}`;
    }
    return codexProfileLabel(props.codexProfileModel);
  }, [props.codexProfileModel, props.codexProfileNames]);
  return (
    <div className="onboarding-wizard__done">
      <div className="onboarding-wizard__done-check">
        <CheckIcon />
      </div>
      <h1 className="onboarding-wizard__title onboarding-wizard__title--center">
        You&rsquo;re operating.
      </h1>
      <p className="onboarding-wizard__sub onboarding-wizard__sub--center">
        Every choice persists in Settings → General and Settings → Messaging.
        Change your mind anytime — Help → Replay Onboarding brings this back.
      </p>
      <dl className="onboarding-wizard__done-summary">
        <div>
          <dt>Thread presentation</dt>
          <dd>{densityLabel(props.density)}</dd>
        </div>
        <div>
          <dt>Codex profile</dt>
          <dd>{codexSummary}</dd>
        </div>
        <div>
          <dt>Messaging</dt>
          <dd>{messagingSummary}</dd>
        </div>
      </dl>
    </div>
  );
}

/* ----------------------------------------------------------------
   Reusable choice card
   ---------------------------------------------------------------- */

function ChoiceCard(props: {
  eyebrow: string;
  title: string;
  desc: string;
  hint: string;
  badge?: string;
  selected: boolean;
  preview: ReactNode;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`onboarding-wizard__choice${props.selected ? " is-selected" : ""}`}
      onClick={props.onSelect}
      aria-pressed={props.selected}
    >
      {props.badge ? (
        <span className="onboarding-wizard__choice-badge">{props.badge}</span>
      ) : null}
      <span className="onboarding-wizard__choice-eyebrow">{props.eyebrow}</span>
      <span className="onboarding-wizard__choice-title">{props.title}</span>
      <div className="onboarding-wizard__choice-preview">{props.preview}</div>
      <p className="onboarding-wizard__choice-desc">{props.desc}</p>
      <p className="onboarding-wizard__choice-hint">{props.hint}</p>
    </button>
  );
}

/* ----------------------------------------------------------------
   Embedded mini-previews for Step 1
   ---------------------------------------------------------------- */

/* Mini ThreadRow chips — composed to mirror the live ThreadRow primitive:
   - .mini-chip-pin renders the "Pinned" pill (accent-bordered, accent text)
   - .mini-chip-pr renders the "#123" PR pill (dot + number)
   - .mini-chip-meta renders the gray-fill chips (OpenAI / PwrAgnt / branch)
   Compact mode keeps Pin + PR + emoji; Mission Control adds the meta row. */
function MiniPinChip() {
  return (
    <span className="onboarding-wizard__mini-chip onboarding-wizard__mini-chip--pin">
      Pinned
    </span>
  );
}
function MiniPrChip(props: { num: string; status: "ok" | "draft" | "merged" }) {
  return (
    <span className="onboarding-wizard__mini-chip onboarding-wizard__mini-chip--pr">
      <span
        className={`onboarding-wizard__mini-pr-dot is-${props.status}`}
        aria-hidden
      />
      #{props.num}
    </span>
  );
}
function MiniMetaChip(props: { children: ReactNode }) {
  return (
    <span className="onboarding-wizard__mini-chip onboarding-wizard__mini-chip--meta">
      {props.children}
    </span>
  );
}

function DensityCompactPreview() {
  return (
    <div className="onboarding-wizard__mini">
      <div className="onboarding-wizard__mini-row is-active">
        <span className="onboarding-wizard__mini-title">PwrAgent - Release</span>
        <MiniPinChip />
        <span className="onboarding-wizard__mini-time">2h</span>
      </div>
      <div className="onboarding-wizard__mini-row">
        <span className="onboarding-wizard__mini-title">PwrSnap - Release</span>
        <MiniPinChip />
        <span className="onboarding-wizard__mini-time">May 7</span>
      </div>
      <div className="onboarding-wizard__mini-row">
        <span className="onboarding-wizard__mini-title">Text Mode for Button Platforms</span>
        <MiniPinChip />
        <MiniPrChip num="352" status="ok" />
        <span className="onboarding-wizard__mini-emoji">👀</span>
        <span className="onboarding-wizard__mini-time">2d</span>
      </div>
      <div className="onboarding-wizard__mini-row">
        <span className="onboarding-wizard__mini-cookie" />
        <span className="onboarding-wizard__mini-title">Automation scheduling system</span>
        <MiniPinChip />
        <MiniPrChip num="376" status="ok" />
        <span className="onboarding-wizard__mini-emoji">🏃</span>
        <span className="onboarding-wizard__mini-time">2d</span>
      </div>
      <div className="onboarding-wizard__mini-row">
        <span className="onboarding-wizard__mini-cookie" />
        <span className="onboarding-wizard__mini-title">OCR image tags and descriptions</span>
        <MiniPinChip />
        <MiniPrChip num="30" status="merged" />
        <span className="onboarding-wizard__mini-emoji">🙏</span>
        <span className="onboarding-wizard__mini-time">3h</span>
      </div>
      <div className="onboarding-wizard__mini-row">
        <span className="onboarding-wizard__mini-title">App image cache disk usage</span>
        <MiniPinChip />
        <MiniPrChip num="46" status="draft" />
        <span className="onboarding-wizard__mini-emoji">👀</span>
        <span className="onboarding-wizard__mini-time">4h</span>
      </div>
      <div className="onboarding-wizard__mini-row">
        <span className="onboarding-wizard__mini-cookie" />
        <span className="onboarding-wizard__mini-title">Pass PDFs through directly</span>
        <MiniPinChip />
        <MiniPrChip num="386" status="ok" />
        <span className="onboarding-wizard__mini-time">2d</span>
      </div>
      <div className="onboarding-wizard__mini-row">
        <span className="onboarding-wizard__mini-title">Knock Knock Rock</span>
        <MiniPinChip />
        <MiniPrChip num="173" status="draft" />
        <span className="onboarding-wizard__mini-time">May 10</span>
      </div>
    </div>
  );
}

function DensityMissionControlPreview() {
  return (
    <div className="onboarding-wizard__mini">
      <div className="onboarding-wizard__mini-row onboarding-wizard__mini-row--mc is-active">
        <span className="onboarding-wizard__mini-title">PwrAgent - Release</span>
        <span className="onboarding-wizard__mini-time">2h</span>
        <div className="onboarding-wizard__mini-meta">
          <MiniMetaChip>OpenAI</MiniMetaChip>
          <MiniMetaChip>📁 PwrAgnt</MiniMetaChip>
          <MiniMetaChip>⌥ main</MiniMetaChip>
          <MiniPinChip />
        </div>
      </div>
      <div className="onboarding-wizard__mini-row onboarding-wizard__mini-row--mc">
        <span className="onboarding-wizard__mini-title">PwrSnap - Release</span>
        <span className="onboarding-wizard__mini-time">May 7</span>
        <div className="onboarding-wizard__mini-meta">
          <MiniMetaChip>OpenAI</MiniMetaChip>
          <MiniMetaChip>📁 PwrSnap</MiniMetaChip>
          <MiniMetaChip>⌥ main</MiniMetaChip>
          <MiniPinChip />
        </div>
      </div>
      <div className="onboarding-wizard__mini-row onboarding-wizard__mini-row--mc">
        <span className="onboarding-wizard__mini-title">Text Mode for Button Platforms</span>
        <span className="onboarding-wizard__mini-time">2d</span>
        <div className="onboarding-wizard__mini-meta">
          <MiniMetaChip>OpenAI</MiniMetaChip>
          <MiniMetaChip>⌥ PwrAgnt</MiniMetaChip>
          <MiniMetaChip>⌥ feat/messaging-text-mode</MiniMetaChip>
          <MiniPinChip />
          <MiniPrChip num="352" status="ok" />
          <span className="onboarding-wizard__mini-emoji">👀</span>
        </div>
      </div>
      <div className="onboarding-wizard__mini-row onboarding-wizard__mini-row--mc">
        <span className="onboarding-wizard__mini-cookie" />
        <span className="onboarding-wizard__mini-title">Automation scheduling system</span>
        <span className="onboarding-wizard__mini-time">2d</span>
        <div className="onboarding-wizard__mini-meta">
          <MiniMetaChip>OpenAI</MiniMetaChip>
          <MiniMetaChip>⌥ PwrAgnt</MiniMetaChip>
          <MiniMetaChip>⌥ feat/automation</MiniMetaChip>
          <MiniPinChip />
          <MiniPrChip num="376" status="ok" />
          <span className="onboarding-wizard__mini-emoji">🏃</span>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------
   Embedded schematic diagrams for Step 2
   ---------------------------------------------------------------- */

function CodexDiagramShared() {
  return (
    <div className="onboarding-wizard__codex">
      <CodexNode label="PwrAgent" avatar="PA" accent />
      <span className="onboarding-wizard__codex-link onboarding-wizard__codex-link--accent">
        ↔
      </span>
      <CodexNode label="Codex Desktop" meta="same threads" avatar="CX" />
    </div>
  );
}

function CodexDiagramIsolated() {
  return (
    <div className="onboarding-wizard__codex">
      <CodexNode label="PwrAgent" meta="personal" avatar="PA" accent />
      <span className="onboarding-wizard__codex-link">||</span>
      <CodexNode
        label="Codex Desktop"
        meta="work — untouched"
        avatar="CX"
      />
    </div>
  );
}

function CodexDiagramMultiple() {
  return (
    <div className="onboarding-wizard__codex onboarding-wizard__codex--stack">
      <div className="onboarding-wizard__codex-col">
        <CodexNode label="personal" avatar="P" accent compact />
        <CodexNode label="work" avatar="W" compact />
        <CodexNode label="side-project" avatar="S" compact />
      </div>
      <span className="onboarding-wizard__codex-link">↔</span>
      <div className="onboarding-wizard__codex-col">
        <CodexNode label="3 logins" avatar="CX" accent compact />
      </div>
    </div>
  );
}

function CodexNode(props: {
  label: string;
  avatar: string;
  meta?: string;
  accent?: boolean;
  compact?: boolean;
}) {
  return (
    <div
      className={`onboarding-wizard__codex-node${props.accent ? " is-accent" : ""}${props.compact ? " is-compact" : ""}`}
    >
      <span className="onboarding-wizard__codex-avatar">{props.avatar}</span>
      <div>
        <div className="onboarding-wizard__codex-label">{props.label}</div>
        {props.meta ? (
          <div className="onboarding-wizard__codex-meta">{props.meta}</div>
        ) : null}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------
   Step: Name your Codex profiles (Step 2b — only when "Multiple")
   ---------------------------------------------------------------- */

function NameCodexProfilesStep(props: {
  names: string[];
  onChange: (next: string[]) => void;
}) {
  const setAt = (idx: number, value: string): void => {
    const next = [...props.names];
    next[idx] = value;
    props.onChange(next);
  };
  const removeAt = (idx: number): void => {
    const next = [...props.names];
    next.splice(idx, 1);
    props.onChange(next);
  };
  const addOne = (): void => {
    if (props.names.length >= 5) return;
    props.onChange([...props.names, ""]);
  };
  return (
    <div>
      <header className="onboarding-wizard__head">
        <h1 className="onboarding-wizard__title">
          Name your Codex profiles
        </h1>
        <p className="onboarding-wizard__sub">
          Up to 5. Names become both the Codex profile name and the paired
          PwrAgent profile name. Lowercase letters, digits, underscores, and
          hyphens — 1 to 31 characters. Codex login for each happens after the
          wizard from Settings → Profiles.
        </p>
      </header>
      <div className="onboarding-wizard__profile-list">
        {props.names.map((name, idx) => {
          const trimmed = name.trim();
          const valid = trimmed === "" || isValidProfileName(trimmed);
          return (
            <div key={idx} className="onboarding-wizard__profile-row">
              <span className="onboarding-wizard__profile-num">{idx + 1}</span>
              <input
                type="text"
                className={`onboarding-wizard__profile-input${valid ? "" : " is-invalid"}`}
                placeholder="profile-name"
                value={name}
                onChange={(e) => setAt(idx, e.target.value)}
                aria-invalid={!valid}
              />
              {props.names.length > 1 ? (
                <button
                  type="button"
                  className="onboarding-wizard__btn onboarding-wizard__btn--link"
                  onClick={() => removeAt(idx)}
                  aria-label={`Remove profile ${idx + 1}`}
                >
                  Remove
                </button>
              ) : null}
            </div>
          );
        })}
        {props.names.length < 5 ? (
          <button
            type="button"
            className="onboarding-wizard__btn onboarding-wizard__btn--ghost onboarding-wizard__profile-add"
            onClick={addOne}
          >
            + Add another profile
          </button>
        ) : null}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------
   Step: Per-provider inline setup (Step 3c — one per selected provider)
   ---------------------------------------------------------------- */

type ProviderField =
  | {
      kind: "secret";
      name: DesktopSettingsSecretName;
      label: string;
      sub?: string;
      placeholder?: string;
    }
  | {
      kind: "text";
      key: string;
      label: string;
      sub?: string;
      placeholder?: string;
    }
  | {
      kind: "segmented";
      key: string;
      label: string;
      sub?: string;
      options: ReadonlyArray<{ label: string; value: string }>;
    };

type ProviderPairingOption = {
  scope: MessagingPairingScope;
  label: string;
  help?: ReactNode;
};

type ProviderSetupConfig = {
  id: OnboardingProvider;
  intro: ReactNode;
  fields: readonly ProviderField[];
  /** Section title shown above the pairing block. Frame it from the
   *  operator's perspective ("Pair your DMs"), not the app's ("Pair
   *  this device") — PwrAgent isn't the device the operator pairs FROM. */
  pairingTitle?: string;
  pairingOptions?: readonly ProviderPairingOption[];
};

const PROVIDER_SETUP_CONFIGS: Record<OnboardingProvider, ProviderSetupConfig> = {
  telegram: {
    id: "telegram",
    intro: (
      <>
        Message <strong>@BotFather</strong> on Telegram, send <code>/newbot</code>,
        pick a name. BotFather replies with a bot token — paste it below.
      </>
    ),
    fields: [
      {
        kind: "secret",
        name: "telegramBotToken",
        label: "Bot token",
        sub: "Stored in your system keychain.",
        placeholder: "0000000000:AAEx………",
      },
    ],
    pairingTitle: "Pair a Telegram conversation",
    pairingOptions: [
      {
        scope: "user_dm",
        label: "Pair your DMs",
        help: (
          <>
            From <strong>your</strong> Telegram account, open the chat with
            your new bot and send the pairing message below. PwrAgent sees the
            message land and finishes pairing automatically — you can use
            Telegram on any device, the pairing is between your account and
            the bot.
          </>
        ),
      },
      {
        scope: "bucket",
        label: "Pair a Supergroup / Forum (just you + the bot)",
        help: (
          <>
            Add the bot to a supergroup or forum that contains only you and
            it, then send the pairing message inside any topic. Threads will
            land in that topic. Best for keeping the bot conversation in its
            own room separate from your DMs.
          </>
        ),
      },
    ],
  },
  discord: {
    id: "discord",
    intro: (
      <>
        Discord Developer Portal → create an Application → Bot tab → reset
        token. Paste it below along with the Application ID (General
        Information tab).
      </>
    ),
    fields: [
      {
        kind: "secret",
        name: "discordBotToken",
        label: "Bot token",
        placeholder: "Paste from Bot → Reset Token",
      },
      {
        kind: "text",
        key: "applicationId",
        label: "Application ID",
        sub: "Found under General Information → Application ID.",
        placeholder: "1480556454498009352",
      },
    ],
    pairingTitle: "Pair a Discord conversation",
    pairingOptions: [
      {
        scope: "user_dm",
        label: "Pair your DMs with the bot",
        help: (
          <>
            Invite the bot to a guild (Developer Portal → OAuth2 URL
            Generator, scopes <code>bot</code> + <code>applications.commands</code>),
            then DM the bot the pairing message below from your Discord
            account.
          </>
        ),
      },
    ],
  },
  mattermost: {
    id: "mattermost",
    intro: (
      <>
        In your Mattermost server: System Console → Integrations → Bot
        Accounts → create a bot, copy the token. Also set the server URL and
        a callback base URL reachable from the Mattermost host.
      </>
    ),
    fields: [
      {
        kind: "text",
        key: "serverUrl",
        label: "Server URL",
        placeholder: "https://chat.example.com",
      },
      {
        kind: "secret",
        name: "mattermostBotToken",
        label: "Bot token",
      },
      {
        kind: "secret",
        name: "mattermostHmacSecret",
        label: "HMAC signing secret",
        sub: "Verifies incoming webhook callbacks. Generate any high-entropy string.",
      },
      {
        kind: "text",
        key: "callbackBaseUrl",
        label: "Callback base URL",
        sub: "Public URL Mattermost will POST events to (tunnel or LAN).",
        placeholder: "https://pwragent.tail.example.ts.net",
      },
    ],
    pairingTitle: "Pair a Mattermost conversation",
    pairingOptions: [
      {
        scope: "user_dm",
        label: "Pair your DMs with the bot",
        help: (
          <>
            From your Mattermost account, open a direct message with the bot
            and post the pairing message below.
          </>
        ),
      },
    ],
  },
  feishu: {
    id: "feishu",
    intro: (
      <>
        Feishu / Lark Open Platform → create a custom app → copy App ID,
        App Secret, Encrypt Key, and Verification Token. Pick which tenant
        region to use and the inbound mode.
      </>
    ),
    fields: [
      {
        kind: "segmented",
        key: "tenantRegion",
        label: "Tenant region",
        options: [
          { label: "Lark (international)", value: "lark" },
          { label: "Feishu (China)", value: "feishu" },
        ],
      },
      {
        kind: "segmented",
        key: "inboundMode",
        label: "Inbound mode",
        sub: "Persistent uses long-polling; Webhook needs a public callback URL.",
        options: [
          { label: "Persistent", value: "persistent" },
          { label: "Webhook", value: "webhook" },
        ],
      },
      { kind: "secret", name: "feishuAppId", label: "App ID" },
      { kind: "secret", name: "feishuAppSecret", label: "App secret" },
      { kind: "secret", name: "feishuEncryptKey", label: "Encrypt key" },
      {
        kind: "secret",
        name: "feishuVerificationToken",
        label: "Verification token",
      },
    ],
    pairingTitle: "Pair a Feishu / Lark conversation",
    pairingOptions: [
      {
        scope: "user_dm",
        label: "Pair your DMs with the bot",
        help: (
          <>
            Open a 1:1 chat with the bot inside Feishu / Lark and post the
            pairing message below.
          </>
        ),
      },
    ],
  },
  slack: {
    id: "slack",
    intro: (
      <>
        Slack app config → Install App → grab the Bot User OAuth Token. Pick
        Socket Mode (easiest, requires App-Level Token) or Events API
        (requires a public signing secret + callback URL).
      </>
    ),
    fields: [
      {
        kind: "segmented",
        key: "inboundMode",
        label: "Inbound mode",
        sub: "Socket Mode is recommended — no public URL needed.",
        options: [
          { label: "Socket Mode", value: "socket" },
          { label: "Events API", value: "events" },
        ],
      },
      { kind: "secret", name: "slackBotToken", label: "Bot token (xoxb-…)" },
      {
        kind: "secret",
        name: "slackAppToken",
        label: "App-level token (xapp-…)",
        sub: "Required for Socket Mode. Generate under Basic Information → App-Level Tokens.",
      },
      {
        kind: "secret",
        name: "slackSigningSecret",
        label: "Signing secret",
        sub: "Required for Events API. Found under Basic Information → App Credentials.",
      },
      {
        kind: "text",
        key: "workspaceUrl",
        label: "Workspace URL",
        placeholder: "https://your-team.slack.com",
      },
    ],
    pairingTitle: "Pair a Slack conversation",
    pairingOptions: [
      {
        scope: "user_dm",
        label: "Pair your DMs with the bot",
        help: (
          <>
            Open a DM with the bot in Slack and post the pairing message
            below.
          </>
        ),
      },
    ],
  },
  line: {
    id: "line",
    intro: (
      <>
        LINE Developers → Messaging API channel → copy the Channel Access
        Token and Channel Secret. LINE is webhook-only inbound, so you need a
        public HTTPS URL pointing at this machine (Cloudflare Tunnel, Tailscale
        Funnel, ngrok, etc.).
      </>
    ),
    fields: [
      {
        kind: "secret",
        name: "lineChannelAccessToken",
        label: "Channel access token",
      },
      { kind: "secret", name: "lineChannelSecret", label: "Channel secret" },
      {
        kind: "text",
        key: "botUserId",
        label: "Bot user ID",
        sub: "Found under Messaging API tab — starts with U.",
        placeholder: "U1234567890abcdef…",
      },
      {
        kind: "text",
        key: "callbackBaseUrl",
        label: "Public callback URL",
        sub: "Must be reachable over HTTPS from LINE's servers.",
        placeholder: "https://pwragent.tail.example.ts.net",
      },
    ],
    pairingTitle: "Pair a LINE conversation",
    pairingOptions: [
      {
        scope: "user_dm",
        label: "Pair your DMs with the bot",
        help: (
          <>
            From your LINE account, add the bot as a friend and post the
            pairing message in the 1:1 chat.
          </>
        ),
      },
    ],
  },
};

function ProviderSetupStep(props: {
  provider: OnboardingProvider;
  settings: DesktopSettingsState;
  desktopApi?: DesktopApi;
}) {
  const config = PROVIDER_SETUP_CONFIGS[props.provider];
  const snapshot = props.settings.snapshot;
  const platformSnapshot = snapshot?.messaging?.[props.provider];

  // Auto-enable the platform when the step opens so pairing / probe work.
  useEffect(() => {
    if (!platformSnapshot) return;
    if (platformSnapshot.enabled.value) return;
    void props.settings.writeConfig({
      messaging: { [props.provider]: { enabled: true } } as never,
    });
    // intentionally only run when provider changes — repeated writes would
    // race with the snapshot refresh fired by writeConfig itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.provider]);

  return (
    <div className="onboarding-wizard__provider-setup">
      <header className="onboarding-wizard__head">
        <h1 className="onboarding-wizard__title">
          <span className="onboarding-wizard__provider-setup-icon">
            {providerIcon(props.provider, 22)}
          </span>
          Connect {providerName(props.provider)}
        </h1>
        <p className="onboarding-wizard__sub">{config.intro}</p>
      </header>
      <div className="onboarding-wizard__provider-fields">
        {config.fields.map((field) => (
          <ProviderFieldRow
            key={field.kind === "secret" ? `secret:${field.name}` : `text:${field.key}`}
            field={field}
            provider={props.provider}
            snapshot={snapshot}
            saving={props.settings.saving}
            replaceSecret={props.settings.replaceSecret}
            writeConfig={props.settings.writeConfig}
          />
        ))}
      </div>
      {config.pairingOptions && config.pairingOptions.length > 0 ? (
        <PairingBlock
          platform={props.provider}
          title={config.pairingTitle ?? "Pair a conversation"}
          options={config.pairingOptions}
          desktopApi={props.desktopApi}
        />
      ) : null}
    </div>
  );
}

function ProviderFieldRow(props: {
  field: ProviderField;
  provider: OnboardingProvider;
  snapshot?: DesktopSettingsSnapshot;
  saving: boolean;
  replaceSecret: (
    name: DesktopSettingsSecretName,
    value: string,
  ) => Promise<boolean>;
  writeConfig: (patch: DesktopSettingsConfigPatch) => Promise<boolean>;
}) {
  if (props.field.kind === "secret") {
    return (
      <SecretFieldRow
        field={props.field}
        snapshot={props.snapshot}
        saving={props.saving}
        replaceSecret={props.replaceSecret}
      />
    );
  }
  if (props.field.kind === "text") {
    return (
      <TextFieldRow
        field={props.field}
        provider={props.provider}
        snapshot={props.snapshot}
        saving={props.saving}
        writeConfig={props.writeConfig}
      />
    );
  }
  return (
    <SegmentedFieldRow
      field={props.field}
      provider={props.provider}
      snapshot={props.snapshot}
      saving={props.saving}
      writeConfig={props.writeConfig}
    />
  );
}

function SecretFieldRow(props: {
  field: Extract<ProviderField, { kind: "secret" }>;
  snapshot?: DesktopSettingsSnapshot;
  saving: boolean;
  replaceSecret: (
    name: DesktopSettingsSecretName,
    value: string,
  ) => Promise<boolean>;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const state = readSecretState(props.snapshot, props.field.name);
  const configured = state?.configured ?? false;

  const save = async (): Promise<void> => {
    if (!value || busy) return;
    setBusy(true);
    setError(undefined);
    const ok = await props.replaceSecret(props.field.name, value);
    if (ok) {
      setValue("");
    } else {
      setError("Could not save the secret.");
    }
    setBusy(false);
  };
  return (
    <div className="onboarding-wizard__field">
      <div className="onboarding-wizard__field-head">
        <span className="onboarding-wizard__field-label">{props.field.label}</span>
        <span className="onboarding-wizard__field-status">
          {configured ? (
            <span className="onboarding-wizard__field-pill is-ok">✓ saved</span>
          ) : (
            <span className="onboarding-wizard__field-pill">not set</span>
          )}
        </span>
      </div>
      {props.field.sub ? (
        <span className="onboarding-wizard__field-sub">{props.field.sub}</span>
      ) : null}
      <div className="onboarding-wizard__field-row">
        <input
          type="password"
          className="onboarding-wizard__input"
          placeholder={configured ? "Replace stored value" : props.field.placeholder}
          value={value}
          disabled={props.saving || busy}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save();
            }
          }}
        />
        <button
          type="button"
          className="onboarding-wizard__btn onboarding-wizard__btn--ghost"
          disabled={!value || busy || props.saving}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : configured ? "Replace" : "Save"}
        </button>
      </div>
      {error ? (
        <span className="onboarding-wizard__field-error">{error}</span>
      ) : null}
    </div>
  );
}

function TextFieldRow(props: {
  field: Extract<ProviderField, { kind: "text" }>;
  provider: OnboardingProvider;
  snapshot?: DesktopSettingsSnapshot;
  saving: boolean;
  writeConfig: (patch: DesktopSettingsConfigPatch) => Promise<boolean>;
}) {
  const stored =
    (readPlatformValue(props.snapshot, props.provider, props.field.key) as
      | string
      | undefined) ?? "";
  const [value, setValue] = useState(stored);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const dirty = value !== stored;
  // Resync when stored value changes (e.g. snapshot refresh).
  useEffect(() => {
    setValue(stored);
  }, [stored]);
  const save = async (): Promise<void> => {
    if (!dirty || busy) return;
    setBusy(true);
    setError(undefined);
    const patch = buildPlatformPatch(props.provider, props.field.key, value);
    const ok = await props.writeConfig(patch);
    if (!ok) setError("Could not save.");
    setBusy(false);
  };
  return (
    <div className="onboarding-wizard__field">
      <div className="onboarding-wizard__field-head">
        <span className="onboarding-wizard__field-label">{props.field.label}</span>
        <span className="onboarding-wizard__field-status">
          {stored ? (
            <span className="onboarding-wizard__field-pill is-ok">✓ saved</span>
          ) : (
            <span className="onboarding-wizard__field-pill">not set</span>
          )}
        </span>
      </div>
      {props.field.sub ? (
        <span className="onboarding-wizard__field-sub">{props.field.sub}</span>
      ) : null}
      <div className="onboarding-wizard__field-row">
        <input
          type="text"
          className="onboarding-wizard__input"
          placeholder={props.field.placeholder}
          value={value}
          disabled={props.saving || busy}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setValue(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save();
            }
          }}
        />
        {dirty ? (
          <button
            type="button"
            className="onboarding-wizard__btn onboarding-wizard__btn--ghost"
            disabled={busy || props.saving}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        ) : null}
      </div>
      {error ? (
        <span className="onboarding-wizard__field-error">{error}</span>
      ) : null}
    </div>
  );
}

function SegmentedFieldRow(props: {
  field: Extract<ProviderField, { kind: "segmented" }>;
  provider: OnboardingProvider;
  snapshot?: DesktopSettingsSnapshot;
  saving: boolean;
  writeConfig: (patch: DesktopSettingsConfigPatch) => Promise<boolean>;
}) {
  const stored =
    (readPlatformValue(props.snapshot, props.provider, props.field.key) as
      | string
      | undefined) ?? props.field.options[0]?.value;
  const select = async (value: string): Promise<void> => {
    if (value === stored) return;
    const patch = buildPlatformPatch(props.provider, props.field.key, value);
    await props.writeConfig(patch);
  };
  return (
    <div className="onboarding-wizard__field">
      <div className="onboarding-wizard__field-head">
        <span className="onboarding-wizard__field-label">{props.field.label}</span>
      </div>
      {props.field.sub ? (
        <span className="onboarding-wizard__field-sub">{props.field.sub}</span>
      ) : null}
      <div className="onboarding-wizard__segmented">
        {props.field.options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`onboarding-wizard__segmented-btn${stored === option.value ? " is-active" : ""}`}
            disabled={props.saving}
            onClick={() => void select(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------
   Pairing-token block — reuses generateMessagingPairingToken IPC
   and watches onMessagingPairingChanged for live status updates
   ---------------------------------------------------------------- */

function PairingBlock(props: {
  platform: MessagingChannelKind;
  title: string;
  options: readonly ProviderPairingOption[];
  desktopApi?: DesktopApi;
}) {
  const [scope, setScope] = useState<MessagingPairingScope>(
    props.options[0]?.scope ?? "user_dm",
  );
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [entryId, setEntryId] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [resolution, setResolution] = useState<"observed" | "approved" | undefined>(
    undefined,
  );
  const entryIdRef = useRef<string | undefined>(undefined);
  entryIdRef.current = entryId;

  const activeOption = props.options.find((o) => o.scope === scope) ?? props.options[0];

  useEffect(() => {
    if (!props.desktopApi?.onMessagingPairingChanged) return;
    return props.desktopApi.onMessagingPairingChanged((event) => {
      if (event.entry.platform !== props.platform) return;
      if (event.entry.id !== entryIdRef.current) return;
      if (event.entry.status === "observed" || event.entry.status === "approved") {
        setResolution(event.entry.status);
      }
    });
  }, [props.desktopApi, props.platform]);

  const generate = async (): Promise<void> => {
    if (!props.desktopApi?.generateMessagingPairingToken || busy) return;
    setBusy(true);
    setError(undefined);
    setResolution(undefined);
    try {
      const result = await props.desktopApi.generateMessagingPairingToken({
        platform: props.platform,
        scope,
      });
      setMessage(result.message);
      setEntryId(result.entry.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (): Promise<void> => {
    if (!message) return;
    try {
      await navigator.clipboard.writeText(message);
    } catch {
      // best effort — user can still select the text in the input
    }
  };

  const switchScope = (next: MessagingPairingScope): void => {
    if (next === scope) return;
    setScope(next);
    // Switching scope invalidates the in-flight pairing — the previous
    // token was scoped to the old kind. Clear it; the operator can
    // generate a new one for the freshly-selected scope.
    setMessage(undefined);
    setEntryId(undefined);
    setResolution(undefined);
    setError(undefined);
  };

  return (
    <div className="onboarding-wizard__pairing">
      <div className="onboarding-wizard__pairing-head">
        <span className="onboarding-wizard__field-label">{props.title}</span>
        <span className="onboarding-wizard__field-status">
          {resolution === "approved" ? (
            <span className="onboarding-wizard__field-pill is-ok">✓ paired</span>
          ) : resolution === "observed" ? (
            <span className="onboarding-wizard__field-pill is-ok">✓ message seen</span>
          ) : entryId ? (
            <span className="onboarding-wizard__field-pill is-warn">
              waiting for message…
            </span>
          ) : null}
        </span>
      </div>
      {props.options.length > 1 ? (
        <div className="onboarding-wizard__segmented" role="radiogroup" aria-label="Pairing target">
          {props.options.map((option) => (
            <button
              key={option.scope}
              type="button"
              role="radio"
              aria-checked={scope === option.scope}
              className={`onboarding-wizard__segmented-btn${scope === option.scope ? " is-active" : ""}`}
              onClick={() => switchScope(option.scope)}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
      {activeOption?.help ? (
        <p className="onboarding-wizard__field-sub">{activeOption.help}</p>
      ) : null}
      {message ? (
        <div className="onboarding-wizard__pairing-token">
          <code>{message}</code>
          <button
            type="button"
            className="onboarding-wizard__btn onboarding-wizard__btn--ghost"
            onClick={() => void copy()}
          >
            Copy
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="onboarding-wizard__btn onboarding-wizard__btn--ghost"
          disabled={busy || !props.desktopApi?.generateMessagingPairingToken}
          onClick={() => void generate()}
        >
          {busy ? "Generating…" : "Generate pairing code"}
        </button>
      )}
      {error ? (
        <span className="onboarding-wizard__field-error">{error}</span>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------------
   Snapshot lookup helpers — read current platform values + secret state
   ---------------------------------------------------------------- */

function readSecretState(
  snapshot: DesktopSettingsSnapshot | undefined,
  name: DesktopSettingsSecretName,
): DesktopSettingsSecretState | undefined {
  if (!snapshot) return undefined;
  // Walk the messaging snapshot and find the matching secret by name. The
  // type-level mapping from secret-name to snapshot path is awkward to
  // express, so we lean on a small lookup table maintained inline.
  const map: Partial<Record<DesktopSettingsSecretName, DesktopSettingsSecretState>> = {
    telegramBotToken: snapshot.messaging.telegram.botToken,
    discordBotToken: snapshot.messaging.discord.botToken,
    mattermostBotToken: snapshot.messaging.mattermost.botToken,
    mattermostHmacSecret: snapshot.messaging.mattermost.hmacSecret,
    slackBotToken: snapshot.messaging.slack.botToken,
    slackAppToken: snapshot.messaging.slack.appToken,
    slackSigningSecret: snapshot.messaging.slack.signingSecret,
    feishuAppId: snapshot.messaging.feishu.appId,
    feishuAppSecret: snapshot.messaging.feishu.appSecret,
    feishuEncryptKey: snapshot.messaging.feishu.encryptKey,
    feishuVerificationToken: snapshot.messaging.feishu.verificationToken,
    lineChannelAccessToken: snapshot.messaging.line.channelAccessToken,
    lineChannelSecret: snapshot.messaging.line.channelSecret,
  };
  return map[name];
}

function readPlatformValue(
  snapshot: DesktopSettingsSnapshot | undefined,
  provider: OnboardingProvider,
  key: string,
): unknown {
  if (!snapshot) return undefined;
  // The per-platform snapshot mixes `{ value }` fields with raw secret-state
  // objects; the secret entries get filtered out by the caller (text/segmented
  // rows never reference secret keys). Cast through `unknown` so TS lets us
  // do the lookup without enumerating every field type per platform.
  const platform = snapshot.messaging[provider] as unknown as Record<
    string,
    { value: unknown } | undefined
  >;
  const field = platform?.[key];
  return field?.value;
}

function buildPlatformPatch(
  provider: OnboardingProvider,
  key: string,
  value: unknown,
): DesktopSettingsConfigPatch {
  return {
    messaging: {
      [provider]: { [key]: value },
    } as never,
  };
}

function providerIcon(id: OnboardingProvider, size: number) {
  switch (id) {
    case "telegram":
      return <TelegramIcon size={size} aria-hidden />;
    case "discord":
      return <DiscordIcon size={size} aria-hidden />;
    case "mattermost":
      return <MattermostIcon size={size} aria-hidden />;
    case "feishu":
      return <FeishuIcon size={size} aria-hidden />;
    case "slack":
      return <SlackIcon size={size} aria-hidden />;
    case "line":
      return <LineIcon size={size} aria-hidden />;
  }
}

/* ----------------------------------------------------------------
   Inline SVG icons (one-offs not in the shared icon library)
   ---------------------------------------------------------------- */

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

/* ----------------------------------------------------------------
   Label helpers
   ---------------------------------------------------------------- */

function densityLabel(value: DesktopAppearanceDensity): string {
  return value === "compact" ? "Compact" : "Mission control";
}

function codexProfileLabel(value: DesktopCodexProfileModel): string {
  switch (value) {
    case "shared":
      return "Shared";
    case "isolated":
      return "Isolated";
    case "multiple":
      return "Multiple";
  }
}

function providerName(id: OnboardingProvider): string {
  const row = PROVIDER_ROWS.find((p) => p.id === id);
  return row?.name ?? id;
}

const PROVIDER_ORDER: readonly OnboardingProvider[] = [
  "telegram",
  "discord",
  "mattermost",
  "feishu",
  "slack",
  "line",
];
