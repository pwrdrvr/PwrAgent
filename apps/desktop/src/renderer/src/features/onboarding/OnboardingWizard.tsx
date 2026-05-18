import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type {
  DesktopAppearanceDensity,
  DesktopCodexProfileModel,
  DesktopSettingsConfigPatch,
} from "@pwragent/shared";
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
  | "messaging-safety"
  | "messaging-providers"
  | "done";

const STEP_ORDER: WizardStep[] = [
  "welcome",
  "thread-presentation",
  "codex-profile",
  "messaging-safety",
  "messaging-providers",
  "done",
];

const RAIL_STEPS: ReadonlyArray<{
  step: WizardStep;
  label: string;
}> = [
  { step: "thread-presentation", label: "Thread presentation" },
  { step: "codex-profile", label: "Codex profile" },
  { step: "messaging-safety", label: "Messaging" },
  { step: "done", label: "Review" },
];

export type OnboardingWizardProps = {
  initialDensity: DesktopAppearanceDensity;
  initialCodexProfileModel: DesktopCodexProfileModel;
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
};

export function OnboardingWizard(props: OnboardingWizardProps) {
  const [step, setStep] = useState<WizardStep>("welcome");
  const [density, setDensity] = useState<DesktopAppearanceDensity>(
    props.initialDensity,
  );
  const [codexProfileModel, setCodexProfileModel] =
    useState<DesktopCodexProfileModel>(props.initialCodexProfileModel);
  const [acknowledged, setAcknowledged] = useState(false);
  const [selectedProviders, setSelectedProviders] = useState<
    ReadonlySet<OnboardingProvider>
  >(new Set(["telegram"]));
  const [submitting, setSubmitting] = useState(false);

  const isReplay = props.isReplay;

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

  const goPrev = useCallback(() => {
    const i = STEP_ORDER.indexOf(step);
    if (i > 0) setStep(STEP_ORDER[i - 1]);
  }, [step]);
  const goNext = useCallback(() => {
    const i = STEP_ORDER.indexOf(step);
    if (i >= 0 && i < STEP_ORDER.length - 1) setStep(STEP_ORDER[i + 1]);
  }, [step]);

  const persistAndComplete = useCallback(
    async (extra?: DesktopSettingsConfigPatch): Promise<void> => {
      if (submitting) return;
      setSubmitting(true);
      try {
        const providers = [...selectedProviders];
        const patch: DesktopSettingsConfigPatch = {
          general: {
            appearance: { density },
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
          ...(isReplay ? {} : { onboarding: { completed: true } }),
          ...(extra ?? {}),
        };
        await props.onComplete(patch);
      } finally {
        setSubmitting(false);
      }
    },
    [
      acknowledged,
      codexProfileModel,
      density,
      isReplay,
      props,
      selectedProviders,
      submitting,
    ],
  );

  const handleSkip = useCallback((): void => {
    // Skip mirrors Finish from a persistence standpoint when the
    // operator was already on first-run — we still mark completed so
    // they don't see the wizard auto-launch again. Replays skip persist.
    props.onDismiss(!isReplay);
  }, [isReplay, props]);

  const handleFinishMessaging = useCallback(async (): Promise<void> => {
    await persistAndComplete();
    if (selectedProviders.size > 0 && props.onOpenMessagingSettings) {
      props.onOpenMessagingSettings();
    }
  }, [persistAndComplete, props, selectedProviders]);

  const currentRailIndex = (() => {
    if (step === "welcome") return -1;
    if (step === "thread-presentation") return 0;
    if (step === "codex-profile") return 1;
    if (step === "messaging-safety" || step === "messaging-providers") return 2;
    if (step === "done") return 3;
    return -1;
  })();

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
          onClose={() => props.onDismiss(!isReplay)}
        />
        {step !== "welcome" ? (
          <WizardRail
            currentIndex={currentRailIndex}
            chosenDensity={density}
            chosenCodexProfileModel={codexProfileModel}
            messagingDone={step === "done"}
          />
        ) : null}
        <div className="onboarding-wizard__body">
          {step === "welcome" ? <WelcomeStep /> : null}
          {step === "thread-presentation" ? (
            <ThreadPresentationStep value={density} onChange={setDensity} />
          ) : null}
          {step === "codex-profile" ? (
            <CodexProfileStep
              value={codexProfileModel}
              onChange={setCodexProfileModel}
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
          {step === "done" ? (
            <DoneStep
              density={density}
              codexProfileModel={codexProfileModel}
              messagingProviders={[...selectedProviders]}
              acknowledged={acknowledged}
            />
          ) : null}
        </div>
        <WizardFooter
          step={step}
          submitting={submitting}
          acknowledged={acknowledged}
          providerCount={selectedProviders.size}
          density={density}
          codexProfileModel={codexProfileModel}
          onBack={goPrev}
          onSkip={handleSkip}
          onNext={goNext}
          onAdvanceToProviders={goNext}
          onFinishMessaging={() => void handleFinishMessaging()}
          onFinish={() => void persistAndComplete()}
        />
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------
   Chrome — titlebar, step rail, footer
   ---------------------------------------------------------------- */

function WizardTitlebar(props: {
  step: WizardStep;
  isReplay: boolean;
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
      case "messaging-safety":
        return "Step 3 — Messaging — Before you connect";
      case "messaging-providers":
        return "Step 3 — Messaging — Pick providers";
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
  messagingDone: boolean;
}) {
  const labelOverrides: Record<number, string> = {
    0: props.currentIndex > 0 ? densityLabel(props.chosenDensity) : "Thread presentation",
    1:
      props.currentIndex > 1
        ? codexProfileLabel(props.chosenCodexProfileModel)
        : "Codex profile",
    2: props.messagingDone ? "Messaging" : "Messaging",
  };
  return (
    <nav className="onboarding-wizard__rail" aria-label="Setup progress">
      {RAIL_STEPS.map(({ step, label }, idx) => {
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
            key={step}
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
  density: DesktopAppearanceDensity;
  codexProfileModel: DesktopCodexProfileModel;
  onBack: () => void;
  onSkip: () => void;
  onNext: () => void;
  onAdvanceToProviders: () => void;
  onFinishMessaging: () => void;
  onFinish: () => void;
}) {
  const showBack =
    props.step !== "welcome" && props.step !== "done" && !props.submitting;
  const showSkip = props.step !== "done";
  const skipLabel =
    props.step === "messaging-safety" || props.step === "messaging-providers"
      ? "Skip messaging setup"
      : "Skip setup";

  let hint: string | undefined;
  if (props.step === "thread-presentation") {
    hint = `${densityLabel(props.density)} selected · 1 of 3`;
  } else if (props.step === "codex-profile") {
    hint = `${codexProfileLabel(props.codexProfileModel)} selected · 2 of 3`;
  } else if (props.step === "messaging-safety") {
    hint = props.acknowledged ? "Acknowledgement recorded" : undefined;
  } else if (props.step === "messaging-providers") {
    hint =
      props.providerCount > 0
        ? `${props.providerCount} provider${props.providerCount === 1 ? "" : "s"} selected`
        : "No providers selected";
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
  } else if (props.step === "thread-presentation" || props.step === "codex-profile") {
    primary = (
      <button
        type="button"
        className="onboarding-wizard__btn onboarding-wizard__btn--primary"
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
        onClick={props.onAdvanceToProviders}
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
        onClick={props.onFinishMessaging}
      >
        {props.providerCount > 0 ? "Save & set up →" : "Save & finish →"}
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
  value: DesktopAppearanceDensity;
  onChange: (value: DesktopAppearanceDensity) => void;
}) {
  return (
    <div>
      <header className="onboarding-wizard__head">
        <h1 className="onboarding-wizard__title">
          How densely do you want your thread list?
        </h1>
        <p className="onboarding-wizard__sub">
          You can switch between these any time from Settings → General →
          Thread presentation. This choice only affects how thread rows render
          in the sidebar.
        </p>
      </header>
      <div className="onboarding-wizard__choices onboarding-wizard__choices--2">
        <ChoiceCard
          eyebrow="Compact"
          title="Titles only · maximum density"
          desc="Title fills the row. No status chips. User-added emoji still render. The orange cookie marker still shows unread state."
          hint="Best for: power users with many open threads."
          badge={props.value === "compact" ? "Selected" : undefined}
          selected={props.value === "compact"}
          onSelect={() => props.onChange("compact")}
          preview={<DensityCompactPreview />}
        />
        <ChoiceCard
          eyebrow="Mission control"
          title="Full chips · maximum context"
          desc="Every row carries status, branch, and messaging-platform chips. More to scan, more context at a glance."
          hint="Best for: many concurrent threads with different states."
          badge={props.value === "mission-control" ? "Selected" : undefined}
          selected={props.value === "mission-control"}
          onSelect={() => props.onChange("mission-control")}
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
    return props.messagingProviders.map(providerLabel).join(", ");
  }, [props.acknowledged, props.messagingProviders]);
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
          <dd>{codexProfileLabel(props.codexProfileModel)}</dd>
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

function DensityCompactPreview() {
  return (
    <div className="onboarding-wizard__mini">
      <div className="onboarding-wizard__mini-section">Pinned</div>
      <div className="onboarding-wizard__mini-row is-active">
        <span className="onboarding-wizard__mini-cookie" />
        <span className="onboarding-wizard__mini-title">
          Migrate auth middleware to v2 contract
        </span>
      </div>
      <div className="onboarding-wizard__mini-row">
        <span className="onboarding-wizard__mini-cookie onboarding-wizard__mini-cookie--off" />
        <span className="onboarding-wizard__mini-title">
          Ship Phase 2 distribution channel cutover
        </span>
      </div>
      <div className="onboarding-wizard__mini-section">Recents</div>
      <div className="onboarding-wizard__mini-row">
        <span className="onboarding-wizard__mini-cookie" />
        <span className="onboarding-wizard__mini-title">
          Investigate sqlite WAL lock under concurrent profiles
        </span>
      </div>
      <div className="onboarding-wizard__mini-row">
        <span className="onboarding-wizard__mini-cookie onboarding-wizard__mini-cookie--off" />
        <span className="onboarding-wizard__mini-title">
          Document branch-drift dialog fixture seed flow
        </span>
      </div>
      <div className="onboarding-wizard__mini-row">
        <span className="onboarding-wizard__mini-cookie onboarding-wizard__mini-cookie--off" />
        <span className="onboarding-wizard__mini-title">
          Tighten messaging adapter contract: capability flags
        </span>
      </div>
    </div>
  );
}

function DensityMissionControlPreview() {
  return (
    <div className="onboarding-wizard__mini">
      <div className="onboarding-wizard__mini-section">Pinned</div>
      <div className="onboarding-wizard__mini-row is-active">
        <span className="onboarding-wizard__mini-cookie" />
        <span className="onboarding-wizard__mini-title">
          Migrate auth middleware
        </span>
        <span className="onboarding-wizard__mini-chip onboarding-wizard__mini-chip--accent">
          Running
        </span>
      </div>
      <div className="onboarding-wizard__mini-row">
        <span className="onboarding-wizard__mini-cookie onboarding-wizard__mini-cookie--off" />
        <span className="onboarding-wizard__mini-title">
          Phase 2 distribution
        </span>
        <span className="onboarding-wizard__mini-chip onboarding-wizard__mini-chip--ok">
          Ready
        </span>
      </div>
      <div className="onboarding-wizard__mini-section">Recents</div>
      <div className="onboarding-wizard__mini-row">
        <span className="onboarding-wizard__mini-cookie" />
        <span className="onboarding-wizard__mini-title">
          sqlite WAL lock investigation
        </span>
        <span className="onboarding-wizard__mini-chip">Blocked</span>
      </div>
      <div className="onboarding-wizard__mini-row">
        <span className="onboarding-wizard__mini-cookie onboarding-wizard__mini-cookie--off" />
        <span className="onboarding-wizard__mini-title">
          Branch-drift fixture docs
        </span>
        <span className="onboarding-wizard__mini-chip">Draft</span>
      </div>
      <div className="onboarding-wizard__mini-row">
        <span className="onboarding-wizard__mini-cookie onboarding-wizard__mini-cookie--off" />
        <span className="onboarding-wizard__mini-title">
          Messaging adapter contract
        </span>
        <span className="onboarding-wizard__mini-chip">Idle</span>
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

function providerLabel(id: OnboardingProvider): string {
  const row = PROVIDER_ROWS.find((p) => p.id === id);
  return row?.name ?? id;
}
