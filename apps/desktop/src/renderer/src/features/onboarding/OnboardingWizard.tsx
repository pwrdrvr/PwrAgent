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
  DesktopBootInfo,
  DesktopCodexProfileModel,
  DesktopSettingsConfigPatch,
  DesktopSettingsSecretName,
  DesktopSettingsSecretState,
  DesktopSettingsSnapshot,
  MessagingChannelKind,
  MessagingPairingScope,
  SettingsCredentialTestKind,
  SettingsCredentialTestResult,
} from "@pwragent/shared";
import { isMessagingRuntimeSecret } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import type { AppearanceController } from "../../lib/useAppearance";
import type { DesktopSettingsState } from "../settings/useDesktopSettings";
import { filterBufferedSecrets } from "./filterBufferedSecrets";
import {
  isValidProfileName,
  provisionPairedProfiles,
} from "./provisionPairedProfiles";
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
  | "bootstrap-confirm"
  | "welcome"
  | "thread-presentation"
  | "models-providers"
  | "codex-profile"
  | "name-codex-profiles"
  | "shared-codex-login"
  | "messaging-safety"
  | "messaging-providers"
  | "provider-setup"
  | "done";

type RailIndex = 0 | 1 | 2 | 3 | 4;

const RAIL_STEPS: ReadonlyArray<{ label: string }> = [
  { label: "Thread presentation" },
  { label: "Models / Providers" },
  { label: "Profiles" },
  { label: "Messaging" },
  { label: "Review" },
];

function railIndexForStep(step: WizardStep): RailIndex | -1 {
  // `bootstrap-confirm` and `welcome` are pre-rail intro screens —
  // shown before the five numbered steps the rail tracks.
  if (step === "bootstrap-confirm") return -1;
  if (step === "welcome") return -1;
  if (step === "thread-presentation") return 0;
  if (step === "models-providers") return 1;
  if (
    step === "codex-profile" ||
    step === "name-codex-profiles" ||
    step === "shared-codex-login"
  )
    return 2;
  if (
    step === "messaging-safety" ||
    step === "messaging-providers" ||
    step === "provider-setup"
  )
    return 3;
  if (step === "done") return 4;
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
  /** Boot info from `getBootInfo` IPC. When `decisionKind ===
   *  "missing-named-profile"` the wizard renders a slim
   *  confirmation step first (pre-populating the requested name)
   *  instead of going straight to the Welcome screen. `null` while
   *  fetching, or when the renderer is running outside of a real
   *  desktop session (e.g. in unit-test harnesses). */
  bootInfo: DesktopBootInfo | null;
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
  // Initial step:
  //   - bootstrap with a CLI/env-named missing profile →
  //     `bootstrap-confirm` ("PwrAgent doesn't know `foo` yet — set
  //     it up, or quit?"). Pre-populates the name.
  //   - everything else (first-run, replay, missing-default-profile,
  //     bootstrap with no name supplied) → Welcome.
  // The flow from Welcome onward is:
  //   Welcome → Thread presentation → Models / Providers (the backend
  //   gate) → Codex profile → optional Name profiles → Messaging
  //   warning → optional Messaging providers / Provider setup → Done.
  // Replay just doesn't persist `onboarding.completed` at Finish.
  const initialStep: WizardStep =
    props.bootInfo?.decisionKind === "missing-named-profile" && !props.isReplay
      ? "bootstrap-confirm"
      : "welcome";
  const [step, setStep] = useState<WizardStep>(initialStep);
  const [density, setDensity] = useState<DesktopAppearanceDensity>(
    props.initialDensity,
  );
  const [theme, setTheme] = useState<DesktopAppearanceTheme>(props.initialTheme);
  // When the operator launched with a missing-named profile, default
  // to Isolated mode: the requested name becomes the single profile
  // we're setting up, paired with a Codex auth profile of the same
  // name. They can still flip to Shared or Multiple in the wizard
  // if they change their mind.
  const [codexProfileModel, setCodexProfileModel] =
    useState<DesktopCodexProfileModel>(
      props.bootInfo?.decisionKind === "missing-named-profile" && !props.isReplay
        ? "isolated"
        : props.initialCodexProfileModel,
    );
  // Names for the per-profile naming step. Isolated mode shows one
  // input (default "pwragent"); Multiple shows 1–5 inputs (defaults
  // "personal" + "work"). When the user changes Step 2's selection,
  // a useEffect resets these defaults — see below.
  //
  // Special-case: missing-named-profile bootstrap pre-populates the
  // requested name (from `--profile=foo` / `PWRAGENT_PROFILE=foo`)
  // as the Isolated default. This lets the operator confirm "yes,
  // create `foo`" without retyping the name in the Profiles step.
  const [codexProfileNames, setCodexProfileNames] = useState<string[]>(() => {
    const requested =
      props.bootInfo?.decisionKind === "missing-named-profile"
        ? props.bootInfo.requestedProfileName?.trim()
        : undefined;
    if (requested && isValidProfileName(requested)) {
      return [requested];
    }
    return props.initialCodexProfileModel === "isolated"
      ? ["pwragent"]
      : ["personal", "work"];
  });
  const [acknowledged, setAcknowledged] = useState(false);
  // Buffered secrets (xAI API key + messaging tokens). The wizard
  // collects values in renderer memory rather than writing them
  // through `replaceSecret` on input change. At Finish, the
  // `persistAndComplete` callback writes them to the operator's
  // chosen target profile(s) via `writeSecretsToProfile`. This
  // avoids stranding secrets in `.bootstrap/state.db` in bootstrap
  // mode and supports per-profile xAI keys in Multiple mode (each
  // profile row can override the global value below; see
  // `bufferedSecretsPerProfile`).
  const [bufferedSecrets, setBufferedSecrets] = useState<
    Record<string, string>
  >({});
  const setBufferedSecret = useCallback((name: string, value: string): void => {
    setBufferedSecrets((prev) => ({ ...prev, [name]: value }));
  }, []);
  const bufferedGrokKey = bufferedSecrets.grokApiKey ?? "";
  // Per-profile xAI key overrides keyed by the profile's committed
  // name in the naming step. In Multiple mode the operator can keep
  // some profiles on the global key (from Models / Providers) and
  // override others — e.g. "personal profile uses my personal xAI
  // key, work profile uses the work xAI key." A row without an
  // entry here inherits the global `bufferedGrokKey` at graduation.
  const [xaiKeyByProfile, setXaiKeyByProfile] = useState<Record<string, string>>(
    {},
  );
  const setXaiKeyForProfile = useCallback(
    (profileName: string, value: string): void => {
      setXaiKeyByProfile((prev) => ({ ...prev, [profileName]: value }));
    },
    [],
  );
  // Snapshot reported by the name-codex-profiles step: are all named
  // rows authenticated? Drives the footer Continue button's enabled
  // state. `codexLoginDeferred` is the operator's escape hatch — a
  // subtle "I'll log in later" link lifts the gate without finishing
  // the logins. We intentionally don't persist `codexLoginDeferred`
  // anywhere; backing out and re-entering the step recomputes the
  // gate from the on-disk auth state.
  const [codexAuthSnapshot, setCodexAuthSnapshot] = useState<{
    allAuthed: boolean;
    namedRows: number;
  }>({ allAuthed: false, namedRows: 0 });
  const [codexLoginDeferred, setCodexLoginDeferred] = useState(false);
  // Shared-mode Codex login state. Mirrors the per-row state in
  // `name-codex-profiles` but for the system default Codex profile —
  // the wizard only routes here when the operator's existing Codex
  // install isn't already authenticated AND they picked Shared mode.
  const [sharedAuthed, setSharedAuthed] = useState(false);
  const [sharedLoginDeferred, setSharedLoginDeferred] = useState(false);
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

  // ESC = dismiss without persisting onboarding.completed. Previous
  // behavior wrote completed=true on ESC during first-run, which left
  // the operator with a profile that *says* it finished onboarding but
  // has no working backend configured. The user's #467 follow-up
  // explicitly called this out: "don't write anything to the config
  // saying we succeeded with the wizard until we really truly did."
  //
  // Now:
  //   - In active-profile mode (Replay): ESC dismisses immediately.
  //   - In bootstrap mode: ESC opens the dismiss-confirmation modal
  //     so the operator gets the explicit fork (Cancel / Skip and
  //     use default / Exit) instead of silently bailing into a
  //     half-state. If the modal is already open, ESC closes it.
  //
  // `bootInfoModeRef` lets the keydown handler read the current mode
  // without re-binding on every render — the handler closes over it
  // by ref so we don't churn `addEventListener` calls.
  const bootInfoModeRef = useRef(props.bootInfo?.mode);
  bootInfoModeRef.current = props.bootInfo?.mode;
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || submitting) return;
      event.preventDefault();
      if (bootInfoModeRef.current === "bootstrap") {
        setDismissModalOpen((prev) => !prev ? true : prev);
      } else {
        props.onDismiss(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [props, submitting]);

  // Reset the naming step's defaults when the operator changes Step 2's
  // selection. Isolated → single canonical default "pwragent" (unless
  // they're already in the isolated single-name shape with real text,
  // in which case keep their edits). Multiple → restore the two-name
  // default, lifting any custom singular name they typed first so a
  // "customname → switch to Multiple" round-trip doesn't lose it.
  // Shared doesn't use the step.
  useEffect(() => {
    if (codexProfileModel === "isolated") {
      setCodexProfileNames((prev) => {
        // Already in the singular shape with real text? Keep it — the
        // operator may have already typed a custom name.
        if (prev.length === 1 && prev[0]?.trim()) return prev;
        // Coming in from Multiple's defaults (`["personal", "work"]`)
        // or some other shape — reset to the canonical default.
        return ["pwragent"];
      });
    } else if (codexProfileModel === "multiple") {
      setCodexProfileNames((prev) => {
        if (prev.length >= 2) return prev;
        const first = prev[0]?.trim();
        if (first && first !== "pwragent") return [first, "work"];
        return ["personal", "work"];
      });
    }
  }, [codexProfileModel]);

  // Does the Codex system default need a login before we can ship the
  // operator into Shared mode? `auth.json` missing means the operator
  // has never logged into Codex Desktop on this machine — picking
  // Shared without addressing that gives them a non-working profile.
  // The wizard routes them through `shared-codex-login` first; if
  // they're already logged in, that step is skipped.
  const codexDefaultProfile = props.settings.snapshot?.models.codex.profiles.profiles.find(
    (entry) => entry.name === "",
  );
  const sharedNeedsLogin =
    codexProfileModel === "shared" && !codexDefaultProfile?.hasAuthFile;

  // Conditional step graph — codexProfileModel="multiple" inserts the
  // name-codex-profiles step between codex-profile and messaging-safety;
  // empty selectedProviders skips provider-setup; etc. Centralizing the
  // transitions here so goNext/goPrev stay one-liners at the callsite.
  const nextStep = useCallback(
    (current: WizardStep): WizardStep | null => {
      switch (current) {
        case "bootstrap-confirm":
          // Confirmation accepted → join the standard flow at Welcome.
          // The pre-populated name + isolated default mean the rest
          // of the wizard naturally lands on the operator's chosen
          // profile without extra prompting.
          return "welcome";
        case "welcome":
          return "thread-presentation";
        case "thread-presentation":
          return "models-providers";
        case "models-providers":
          return "codex-profile";
        case "codex-profile":
          // Both Isolated (single new profile) and Multiple (1–5)
          // route through the naming step — they both need paired
          // PwrAgent + Codex profile names to create after Finish.
          // Shared mode only inserts `shared-codex-login` when the
          // operator's existing Codex install ISN'T already logged
          // in; otherwise it goes straight to messaging-safety.
          if (codexProfileModel === "shared") {
            return sharedNeedsLogin ? "shared-codex-login" : "messaging-safety";
          }
          return "name-codex-profiles";
        case "name-codex-profiles":
          return "messaging-safety";
        case "shared-codex-login":
          return "messaging-safety";
        case "messaging-safety":
          // The body of `messaging-safety` renders an explicit
          // Skip-messaging vs. Continue choice. `goNext` only fires
          // for Continue, which always advances to the provider
          // picker. The Skip path uses `skipMessaging` to jump to
          // Done with `selectedProviders` cleared.
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
    [codexProfileModel, orderedProviders.length, providerSetupIndex, sharedNeedsLogin],
  );
  // Did this wizard session start at the bootstrap-confirm step?
  // Only true when the boot decision named a missing profile —
  // determines whether Back from Welcome surfaces the confirmation
  // again (vs. being a no-op for first-run / replay entries).
  const entryWasBootstrapConfirm =
    props.bootInfo?.decisionKind === "missing-named-profile" && !props.isReplay;
  const prevStep = useCallback(
    (current: WizardStep): WizardStep | null => {
      switch (current) {
        case "bootstrap-confirm":
          return null;
        case "welcome":
          return entryWasBootstrapConfirm ? "bootstrap-confirm" : null;
        case "thread-presentation":
          return "welcome";
        case "models-providers":
          return "thread-presentation";
        case "codex-profile":
          return "models-providers";
        case "name-codex-profiles":
          return "codex-profile";
        case "shared-codex-login":
          return "codex-profile";
        case "messaging-safety":
          // Back-out symmetry with `nextStep`: Shared bypasses the
          // naming step, anything else routes through it. Within
          // Shared, the login step only sits in the back chain when
          // the operator actually saw it (i.e. needed the login).
          if (codexProfileModel === "shared") {
            return sharedNeedsLogin ? "shared-codex-login" : "codex-profile";
          }
          return "name-codex-profiles";
        case "messaging-providers":
          return "messaging-safety";
        case "provider-setup":
          return providerSetupIndex > 0
            ? "provider-setup"
            : "messaging-providers";
        case "done":
          return orderedProviders.length > 0
            ? "provider-setup"
            : "messaging-safety";
      }
    },
    [
      codexProfileModel,
      entryWasBootstrapConfirm,
      orderedProviders.length,
      providerSetupIndex,
      sharedNeedsLogin,
    ],
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

  // Inline "Skip messaging setup" button on the messaging-safety step.
  // Different from the footer skip link (which exits the wizard entirely
  // without persisting completion). This one CLEARS provider selection,
  // marks the operator as having decided to skip, and jumps to the Done
  // step so they can land their other choices.
  const skipMessaging = useCallback(() => {
    setSelectedProviders(new Set());
    setStep("done");
  }, []);

  /**
   * Write buffered secrets to a target profile's keychain, but only
   * if there's actually something to encrypt. Skipping the IPC when
   * the payload is empty avoids unnecessary `safeStorage` access,
   * which on macOS can pop a keychain-access dialog the operator
   * didn't expect (especially the "Keychain Not Found" variant
   * surfaced by misconfigured login keychains). Replay-style empty
   * deletions (set a key to "") still go through — the caller
   * filters intentional clears in.
   */
  const writeBufferedSecretsIfAny = useCallback(
    async (
      targetProfile: string,
      secrets: Record<string, string>,
    ): Promise<void> => {
      const api = props.desktopApi;
      if (!api?.writeSecretsToProfile) return;
      // Trim + drop empties via the pure filter — see
      // `filterBufferedSecrets` for the rationale (clipboard newlines,
      // half-typed input, etc).
      const nonEmpty = filterBufferedSecrets(secrets);
      if (Object.keys(nonEmpty).length === 0) return;
      try {
        await api.writeSecretsToProfile({ profile: targetProfile, secrets: nonEmpty });
      } catch (caught) {
        // eslint-disable-next-line no-console
        console.warn(
          `Onboarding: writeSecretsToProfile failed for "${targetProfile}"`,
          caught,
        );
      }
    },
    [props.desktopApi],
  );

  // After graduation in bootstrap mode, the wizard spawns a new
  // Electron instance pointed at the operator's chosen profile (via
  // `openPwrAgentProfile`, which `spawn()`s a detached child process)
  // and then quits the current (bootstrap) instance so the operator
  // isn't left with two windows.
  //
  // The dev-server gotcha: in dev mode, the parent `electron-vite`
  // process owns the Vite dev server. When the bootstrap Electron
  // exits, the dev server dies with it. If we quit before the
  // spawned process has loaded its renderer assets from Vite, the
  // new window ends up at `chrome-error://chromewebdata/`. So we
  // wait for the spawned process's runtime heartbeat marker to
  // appear (proving its app state initialized and renderer mounted)
  // before issuing the quit. By that point the new process has its
  // renderer cached in memory; Vite's lifecycle no longer matters.
  //
  // In active-profile mode (Replay), we don't quit — the operator
  // is still in their real profile and that window IS their session.
  const openTargetAndQuitBootstrapIfNeeded = useCallback(
    async (targetProfile: string): Promise<void> => {
      const api = props.desktopApi;
      if (!api?.openPwrAgentProfile) return;
      // Release any messaging adapters this process is holding before
      // we spawn the operator's chosen profile in a new Electron.
      // Adapters like Telegram long-poll and Discord gateway hold
      // exclusive resources upstream; without this release the child
      // process's runtime collides with ours and the upstream returns
      // 409 / "another shard already connected" / similar — leaving
      // the operator with a *visually* online runtime in the new
      // window's titlebar but broken inbound delivery.
      //
      // We only need this in bootstrap mode (where we're about to
      // quit anyway), but calling it unconditionally is safe — the
      // IPC is idempotent and the active-profile path will restart
      // the runtime on the same process on the next config write.
      if (api.shutdownMessagingRuntime) {
        try {
          await api.shutdownMessagingRuntime();
        } catch (caught) {
          // eslint-disable-next-line no-console
          console.warn(
            "Onboarding: shutdownMessagingRuntime failed before spawn — "
              + "child process may collide with stale adapters",
            caught,
          );
        }
      }
      try {
        await api.openPwrAgentProfile({ profile: targetProfile });
      } catch (caught) {
        // eslint-disable-next-line no-console
        console.warn(
          `Onboarding: failed to auto-switch into "${targetProfile}"`,
          caught,
        );
        return;
      }
      if (props.bootInfo?.mode !== "bootstrap") return;
      if (api.waitForProfileAlive) {
        try {
          const result = await api.waitForProfileAlive({
            profile: targetProfile,
            timeoutMs: 10_000,
          });
          if (!result.alive) {
            // Don't quit the bootstrap on timeout — leaving it
            // alive gives the operator a fallback window if the
            // spawn never came up. Bad outcome, but better than
            // both windows gone.
            // eslint-disable-next-line no-console
            console.warn(
              `Onboarding: spawned "${targetProfile}" didn't report alive within timeout; keeping bootstrap window open`,
            );
            return;
          }
        } catch (caught) {
          // eslint-disable-next-line no-console
          console.warn(
            "Onboarding: waitForProfileAlive failed; skipping quit",
            caught,
          );
          return;
        }
      }
      // Extra grace after the heartbeat marker appears. The marker
      // gets written during the spawned process's
      // `initializeAppState` (main process side), but the renderer
      // still needs to download + parse + paint after that. In dev
      // the renderer fetches from Vite — if we quit the bootstrap
      // and electron-vite kills the dev server WHILE the new
      // renderer is mid-fetch, the new window ends up at
      // chrome-error://chromewebdata/. A small fixed wait here
      // covers the gap. Production builds load instantly from
      // `file://`, so the delay is harmless overhead there.
      const POST_ALIVE_GRACE_MS = 2_000;
      await new Promise((resolve) => setTimeout(resolve, POST_ALIVE_GRACE_MS));
      if (api.quitApp) {
        try {
          await api.quitApp();
        } catch (caught) {
          // eslint-disable-next-line no-console
          console.warn("Onboarding: quitApp after graduation failed", caught);
        }
      }
    },
    [props.bootInfo?.mode, props.desktopApi],
  );

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

        // Isolated + Multiple paths: provision paired PwrAgent + Codex
        // profiles with the same names on both sides. The user's
        // existing `default` PwrAgent profile and `default` Codex
        // profile both stay untouched. Codex login per pair is deferred
        // to Settings → Profiles — we don't fire N SSO browser windows
        // mid-wizard. See `provisionPairedProfiles` for the IPC sequence
        // and best-effort error handling.
        //
        // After the provisioning loop, auto-switch the operator INTO the
        // newly-created profile (the first one for Multiple). The wizard
        // was running on the operator's *original* session profile
        // (typically `default`), but the whole point of Isolated/Multiple
        // is "I want to work in a different profile" — landing the
        // operator there at Finish closes that loop. The created
        // profiles have `onboarding.completed = true` already seeded
        // (see `provisionPairedProfiles`), so the wizard does NOT
        // re-fire when the new window opens. Best-effort: a missing
        // `openPwrAgentProfile` IPC just leaves the operator in the
        // original session — they can switch later from the Profiles
        // menu.
        if (codexProfileModel !== "shared") {
          const created = await provisionPairedProfiles(
            props.desktopApi,
            codexProfileNames,
          );
          // Per-profile secret graduation: each created profile gets
          // its own xAI key + messaging tokens written into ITS
          // state.db keychain (not the bootstrap/active profile's).
          // xAI key resolution per profile: a per-row override beats
          // the global buffer. Messaging tokens stay global across
          // profiles (the operator usually has one bot per platform).
          for (const target of created) {
            const override = xaiKeyByProfile[target]?.trim();
            const resolvedGrokKey =
              override !== undefined && override.length > 0
                ? override
                : bufferedSecrets.grokApiKey ?? "";
            await writeBufferedSecretsIfAny(target, {
              ...bufferedSecrets,
              grokApiKey: resolvedGrokKey,
            });
          }
          const switchTo = created[0];
          if (switchTo) {
            // Graduate the bootstrap profile's settings (theme,
            // density, messaging acknowledgment, etc.) onto the
            // operator's chosen real profile. The IPC is a no-op
            // when the main process isn't actually in bootstrap
            // mode (e.g. Help → Replay Onboarding, where the
            // wizard runs against an existing real profile), so
            // the wizard calls it unconditionally.
            if (props.desktopApi?.graduateBootstrapConfigToProfile) {
              try {
                await props.desktopApi.graduateBootstrapConfigToProfile({
                  targetProfile: switchTo,
                });
              } catch (caught) {
                // eslint-disable-next-line no-console
                console.warn(
                  `Onboarding: graduateBootstrapConfigToProfile failed for "${switchTo}"`,
                  caught,
                );
              }
            }
            await openTargetAndQuitBootstrapIfNeeded(switchTo);
          }
        } else {
          // Shared mode. Two sub-paths depending on whether the
          // wizard is running in active-profile or bootstrap mode:
          //
          //   - Active-profile (Replay / Help → Replay Onboarding):
          //     the operator is already in a real profile. Buffered
          //     secrets graduate to that profile, full stop.
          //
          //   - Bootstrap: there's no real profile yet. "Shared"
          //     means "create a default profile that reuses my
          //     existing Codex install at `~/.codex/`." We create
          //     a PwrAgent profile named `default` (or pick a
          //     unique name if `default/` is somehow already
          //     occupied), leave its Codex pairing empty (= system
          //     default), graduate the bootstrap config onto it,
          //     and open the main window for it.
          const activeProfile = props.bootInfo?.activeProfileName;
          if (activeProfile) {
            await writeBufferedSecretsIfAny(activeProfile, bufferedSecrets);
          } else if (props.desktopApi?.createPwrAgentProfile) {
            // Bootstrap + Shared. Provision the default profile
            // with the system-default Codex pairing implied (we
            // skip `setPwrAgentProfileCodexProfile`; an unset
            // codex.profile in the new profile's config.toml means
            // "use ~/.codex/" — i.e. Shared).
            const defaultName = "default";
            try {
              await props.desktopApi.createPwrAgentProfile({
                profile: defaultName,
                seedOnboardingCompleted: true,
              });
              await writeBufferedSecretsIfAny(defaultName, bufferedSecrets);
              if (props.desktopApi?.graduateBootstrapConfigToProfile) {
                await props.desktopApi.graduateBootstrapConfigToProfile({
                  targetProfile: defaultName,
                });
              }
              await openTargetAndQuitBootstrapIfNeeded(defaultName);
            } catch (caught) {
              // eslint-disable-next-line no-console
              console.warn(
                "Onboarding: shared-default provisioning failed",
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
      bufferedSecrets,
      codexProfileModel,
      codexProfileNames,
      density,
      isReplay,
      openTargetAndQuitBootstrapIfNeeded,
      props,
      selectedProviders,
      submitting,
      theme,
      writeBufferedSecretsIfAny,
      xaiKeyByProfile,
    ],
  );

  // Dismiss-confirmation modal state. The wizard shows the modal
  // instead of dismissing immediately when running in bootstrap mode,
  // because dismissing-from-bootstrap is irreversible-ish: either we
  // create a `default` profile mapped to the operator's Codex system
  // session (and they see all their existing Codex Desktop threads),
  // or we quit the app entirely. The modal makes that fork explicit.
  // In active-profile mode (Replay), dismiss is benign — wizard just
  // closes — so we skip the modal there.
  const [dismissModalOpen, setDismissModalOpen] = useState(false);
  const inBootstrapMode = props.bootInfo?.mode === "bootstrap";

  const handleSkip = useCallback((): void => {
    if (inBootstrapMode) {
      setDismissModalOpen(true);
      return;
    }
    // Active-profile (Replay) skip: close the wizard, no profile
    // mutation. Skip never persists `onboarding.completed = true`.
    props.onDismiss(false);
  }, [inBootstrapMode, props]);

  // "Skip and use default" path from the dismiss modal: reuses the
  // same Shared-mode bootstrap provisioning logic as
  // `persistAndComplete` — create a `default` profile mapped to
  // Codex system default, graduate bootstrap, open main window.
  // Settings + secrets get applied even though the operator skipped
  // the rest of the wizard, so the operator's theme/density choices
  // (if any) aren't lost just because they bailed early.
  const skipAndUseDefault = useCallback(async (): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const defaultName = "default";
      if (!props.desktopApi?.createPwrAgentProfile) {
        props.onDismiss(false);
        return;
      }
      await props.desktopApi.createPwrAgentProfile({
        profile: defaultName,
        seedOnboardingCompleted: true,
      });
      await writeBufferedSecretsIfAny(defaultName, bufferedSecrets);
      if (props.desktopApi.graduateBootstrapConfigToProfile) {
        await props.desktopApi.graduateBootstrapConfigToProfile({
          targetProfile: defaultName,
        });
      }
      await openTargetAndQuitBootstrapIfNeeded(defaultName);
    } catch (caught) {
      // eslint-disable-next-line no-console
      console.warn("Onboarding: skipAndUseDefault failed", caught);
    } finally {
      setSubmitting(false);
      setDismissModalOpen(false);
    }
  }, [
    bufferedSecrets,
    openTargetAndQuitBootstrapIfNeeded,
    props,
    submitting,
    writeBufferedSecretsIfAny,
  ]);

  const exitApp = useCallback((): void => {
    if (props.desktopApi?.quitApp) {
      void props.desktopApi.quitApp();
    } else {
      // Renderer outside of a real desktop session (tests, preview)
      // — fall through to the normal dismiss path.
      props.onDismiss(false);
    }
  }, [props]);

  const currentRailIndex = railIndexForStep(step);

  return (
    <div
      className="onboarding-wizard-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="First-run setup"
    >
      <div className="onboarding-wizard-overlay__scrim" />
      {/* Single consistent frame width across all steps. Earlier
          iterations narrowed Welcome / Done / Models-Providers but
          the jump between "cozy 720px" and "expansive 1120px" was
          jarring as the operator advanced. Keep one canvas;
          constrain inner text widths instead so short screens don't
          look sparse. */}
      <div className="onboarding-wizard">
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
          onClose={handleSkip}
        />
        {step !== "welcome" && step !== "bootstrap-confirm" ? (
          <WizardRail
            currentIndex={currentRailIndex}
            chosenDensity={density}
            chosenCodexProfileModel={codexProfileModel}
          />
        ) : null}
        <div className="onboarding-wizard__body">
          {step === "bootstrap-confirm" ? (
            <BootstrapConfirmStep
              requestedName={props.bootInfo?.requestedProfileName ?? ""}
              source={
                props.bootInfo?.decisionKind === "missing-named-profile"
                  ? "missing-named"
                  : "no-profile"
              }
              onContinue={goNext}
              onQuit={() => {
                if (props.desktopApi?.quitApp) {
                  void props.desktopApi.quitApp();
                } else {
                  // Renderer outside of a real desktop session (tests,
                  // dev preview) — fall through to the normal dismiss
                  // path so the wizard still closes.
                  props.onDismiss(false);
                }
              }}
              submitting={submitting}
            />
          ) : null}
          {step === "models-providers" ? (
            <BackendRequirementsStep
              settings={props.settings}
              desktopApi={props.desktopApi}
              bufferedGrokKey={bufferedGrokKey}
              onBufferGrokKey={(value) => setBufferedSecret("grokApiKey", value)}
            />
          ) : null}
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
              mode={codexProfileModel === "isolated" ? "isolated" : "multiple"}
              names={codexProfileNames}
              onChange={setCodexProfileNames}
              desktopApi={props.desktopApi}
              onAuthStateChange={setCodexAuthSnapshot}
              globalXaiKey={bufferedGrokKey}
              xaiKeyByProfile={xaiKeyByProfile}
              onSetXaiKeyForProfile={setXaiKeyForProfile}
            />
          ) : null}
          {step === "shared-codex-login" ? (
            <SharedCodexLoginStep
              desktopApi={props.desktopApi}
              onAuthStateChange={setSharedAuthed}
            />
          ) : null}
          {step === "messaging-safety" ? (
            <MessagingSafetyStep
              acknowledged={acknowledged}
              onAcknowledgedChange={setAcknowledged}
              onSkipMessaging={skipMessaging}
              onContinue={goNext}
              submitting={submitting}
              // Multi-profile context: in Multiple / Isolated modes the
              // wizard provisions N profiles and lands the operator
              // inside the first one. Messaging is configured for that
              // first profile only; the others need their own
              // post-launch Settings trip. Shared mode collapses to a
              // single profile so we skip the notice.
              multiProfileTarget={
                codexProfileModel !== "shared" && codexProfileNames.length >= 1
                  ? {
                      firstProfileName: codexProfileNames[0]!,
                      otherProfileNames: codexProfileNames.slice(1),
                    }
                  : undefined
              }
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
              bufferedSecrets={bufferedSecrets}
              onBufferSecret={setBufferedSecret}
              targetProfileName={
                codexProfileModel !== "shared"
                  ? codexProfileNames[0]
                  : undefined
              }
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
          codexAuthAllAuthed={codexAuthSnapshot.allAuthed}
          codexAuthNamedRows={codexAuthSnapshot.namedRows}
          codexLoginDeferred={codexLoginDeferred}
          onDeferCodexLogin={() => setCodexLoginDeferred(true)}
          sharedAuthed={sharedAuthed}
          sharedLoginDeferred={sharedLoginDeferred}
          onDeferSharedLogin={() => setSharedLoginDeferred(true)}
          backendRequirementSatisfied={isBackendRequirementSatisfied(
            props.settings.snapshot,
            bufferedGrokKey,
          )}
          density={density}
          codexProfileModel={codexProfileModel}
          onBack={goPrev}
          onSkip={handleSkip}
          onNext={goNext}
          onFinish={() => void persistAndComplete()}
        />
        {dismissModalOpen ? (
          <DismissConfirmModal
            submitting={submitting}
            onCancel={() => setDismissModalOpen(false)}
            onSkipAndUseDefault={() => void skipAndUseDefault()}
            onExit={exitApp}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Confirmation modal rendered when the operator tries to dismiss the
 * wizard while running in bootstrap mode (via the X close button,
 * the Skip link in the footer, or ESC). Bootstrap dismiss is
 * irreversible-ish — either we create a `default` profile mapped to
 * the operator's existing Codex install (and they see all of their
 * existing Codex Desktop threads on the next launch) or we quit the
 * app — so the fork has to be explicit, not silent.
 *
 * The middle button ("Skip and use default") runs the same
 * provisioning path that picking Shared mode + clicking Finish
 * would. The settings buffer (theme/density/messaging ack, plus
 * any xAI key the operator typed) still graduates onto the new
 * default profile, so they don't lose what they already typed.
 */
function DismissConfirmModal(props: {
  submitting: boolean;
  onCancel: () => void;
  onSkipAndUseDefault: () => void;
  onExit: () => void;
}) {
  return (
    <div
      className="onboarding-wizard__dismiss-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-dismiss-modal-heading"
    >
      <div className="onboarding-wizard__dismiss-modal-scrim" />
      <div className="onboarding-wizard__dismiss-modal-body">
        <h2
          id="onboarding-dismiss-modal-heading"
          className="onboarding-wizard__dismiss-modal-title"
        >
          Skip setup?
        </h2>
        <p className="onboarding-wizard__dismiss-modal-prose">
          If you skip, PwrAgent will create a <code>default</code> profile
          that <strong>reuses your existing Codex login</strong> at{" "}
          <code>~/.codex/</code> — which probably means you&rsquo;ll see all
          your existing Codex Desktop threads in the sidebar.
        </p>
        <p className="onboarding-wizard__dismiss-modal-prose">
          If that&rsquo;s not what you want — for example, you wanted an
          isolated PwrAgent profile separate from your Codex account —
          click <strong>Exit PwrAgent</strong> instead, then relaunch and
          walk through the wizard with Isolated or Multiple selected.
        </p>
        <div className="onboarding-wizard__dismiss-modal-actions">
          <button
            type="button"
            className="onboarding-wizard__btn onboarding-wizard__btn--link"
            disabled={props.submitting}
            onClick={props.onExit}
          >
            Exit PwrAgent
          </button>
          <span className="onboarding-wizard__spacer" />
          <button
            type="button"
            className="onboarding-wizard__btn onboarding-wizard__btn--ghost"
            disabled={props.submitting}
            onClick={props.onCancel}
          >
            Cancel — back to setup
          </button>
          <button
            type="button"
            className="onboarding-wizard__btn onboarding-wizard__btn--primary"
            disabled={props.submitting}
            onClick={props.onSkipAndUseDefault}
          >
            Skip and use default →
          </button>
        </div>
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
  const eyebrow = props.isReplay
    ? "Replay"
    : props.step === "bootstrap-confirm"
      ? "Set up profile"
      : "Welcome";
  const crumb = (() => {
    switch (props.step) {
      case "bootstrap-confirm":
        return "Confirm new profile";
      case "welcome":
        return "First-run setup";
      case "thread-presentation":
        return "Step 1 — Thread presentation";
      case "models-providers":
        return "Step 2 — Models / Providers";
      case "codex-profile":
        return "Step 3 — Codex profile";
      case "name-codex-profiles":
        return "Step 3 — Name your profiles";
      case "shared-codex-login":
        return "Step 3 — Log in to Codex";
      case "messaging-safety":
        return "Step 4 — Messaging — Before you connect";
      case "messaging-providers":
        return "Step 4 — Messaging — Pick providers";
      case "provider-setup":
        return props.providerName
          ? `Step 4 — ${props.providerName}${props.providerPosition ? ` (${props.providerPosition})` : ""}`
          : "Step 4 — Provider setup";
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
    1: "Models / Providers",
    2:
      props.currentIndex > 2
        ? codexProfileLabel(props.chosenCodexProfileModel)
        : "Profiles",
    3: "Messaging",
    4: "Review",
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
          state === "done" ? `Step ${idx + 1} ✓` : idx === 4 ? "Done" : `Step ${idx + 1}`;
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
  /** True when every named row on `name-codex-profiles` has finished
   *  the Codex OAuth flow. Combined with `codexLoginDeferred`, drives
   *  the Continue button's enabled state on that step. */
  codexAuthAllAuthed: boolean;
  /** Count of non-blank profile-name rows. Used to differentiate
   *  "no names entered yet" (disable Continue for name validity) from
   *  "names entered but not logged in" (show the deferral link). */
  codexAuthNamedRows: number;
  /** Operator clicked "I'll log in later" — lift the auth gate on
   *  Continue without forcing them to finish. */
  codexLoginDeferred: boolean;
  onDeferCodexLogin: () => void;
  /** Shared-mode counterpart to `codexAuthAllAuthed`: true when the
   *  Codex system default has reported authenticated via the
   *  `shared-codex-login` step. */
  sharedAuthed: boolean;
  sharedLoginDeferred: boolean;
  onDeferSharedLogin: () => void;
  backendRequirementSatisfied: boolean;
  density: DesktopAppearanceDensity;
  codexProfileModel: DesktopCodexProfileModel;
  onBack: () => void;
  onSkip: () => void;
  onNext: () => void;
  onFinish: () => void;
}) {
  const showBack =
    props.step !== "welcome" &&
    props.step !== "done" &&
    props.step !== "bootstrap-confirm" &&
    !props.submitting;
  // `messaging-safety` and `bootstrap-confirm` render their own
  // Skip/Continue (or Quit/Continue) buttons in the body, so the
  // footer doesn't show a redundant exit link on those screens.
  const showSkip =
    props.step !== "done" &&
    props.step !== "messaging-safety" &&
    props.step !== "bootstrap-confirm";
  const skipLabel = (() => {
    if (props.step === "messaging-providers") return "Skip messaging setup";
    if (props.step === "provider-setup") return `Skip ${props.currentProviderName}`;
    return "Skip setup";
  })();

  let hint: string | undefined;
  if (props.step === "thread-presentation") {
    hint = `${densityLabel(props.density)} selected`;
  } else if (props.step === "codex-profile") {
    hint = `${codexProfileLabel(props.codexProfileModel)} selected`;
  } else if (props.step === "name-codex-profiles") {
    const isSingle = props.codexProfileModel === "isolated";
    if (!props.codexProfileNamesValid) {
      hint = isSingle
        ? "Lowercase letters, digits, _ , -. 1–31 chars."
        : "1–5 unique lowercase names (letters, digits, _ , -)";
    } else if (props.codexAuthAllAuthed) {
      hint = isSingle ? "Logged in" : "All profiles logged in";
    } else if (props.codexLoginDeferred) {
      hint = "Logins deferred — finish from Settings → Profiles later";
    } else {
      hint = isSingle ? "Log in to continue" : "Log in to each profile to continue";
    }
  } else if (props.step === "messaging-providers") {
    hint =
      props.providerCount > 0
        ? `${props.providerCount} provider${props.providerCount === 1 ? "" : "s"} selected`
        : "No providers selected";
  } else if (props.step === "provider-setup") {
    hint = `Provider ${props.providerSetupIndex + 1} of ${props.providerSetupTotal}`;
  } else if (props.step === "models-providers") {
    hint = props.backendRequirementSatisfied
      ? "Ready"
      : "Install Codex CLI or paste an xAI API key to continue";
  } else if (props.step === "shared-codex-login") {
    if (props.sharedAuthed) {
      hint = "Codex logged in";
    } else if (props.sharedLoginDeferred) {
      hint = "Login deferred — finish from Settings → Profiles later";
    } else {
      hint = "Log in to your Codex account to continue";
    }
  }

  let primary: ReactNode = null;
  if (props.step === "models-providers") {
    primary = (
      <button
        type="button"
        className="onboarding-wizard__btn onboarding-wizard__btn--primary"
        disabled={!props.backendRequirementSatisfied || props.submitting}
        onClick={props.onNext}
      >
        Continue →
      </button>
    );
  } else if (props.step === "welcome") {
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
  } else if (props.step === "shared-codex-login") {
    const sharedGateLifted = props.sharedAuthed || props.sharedLoginDeferred;
    primary = (
      <button
        type="button"
        className="onboarding-wizard__btn onboarding-wizard__btn--primary"
        disabled={!sharedGateLifted || props.submitting}
        onClick={props.onNext}
      >
        Continue →
      </button>
    );
  } else if (props.step === "name-codex-profiles") {
    const authGateLifted = props.codexAuthAllAuthed || props.codexLoginDeferred;
    primary = (
      <button
        type="button"
        className="onboarding-wizard__btn onboarding-wizard__btn--primary"
        disabled={
          !props.codexProfileNamesValid || !authGateLifted || props.submitting
        }
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
      {props.step === "name-codex-profiles" &&
      !props.codexLoginDeferred &&
      !props.codexAuthAllAuthed &&
      props.codexAuthNamedRows > 0 ? (
        <button
          type="button"
          className="onboarding-wizard__btn onboarding-wizard__btn--microlink"
          onClick={props.onDeferCodexLogin}
        >
          I&rsquo;ll log in later
        </button>
      ) : null}
      {props.step === "shared-codex-login" &&
      !props.sharedLoginDeferred &&
      !props.sharedAuthed ? (
        <button
          type="button"
          className="onboarding-wizard__btn onboarding-wizard__btn--microlink"
          onClick={props.onDeferSharedLogin}
        >
          I&rsquo;ll log in later
        </button>
      ) : null}
      {hint ? <span className="onboarding-wizard__hint">{hint}</span> : null}
      {primary}
    </footer>
  );
}

/* ----------------------------------------------------------------
   Step bodies
   ---------------------------------------------------------------- */

/**
 * Returns true when the live snapshot shows at least one valid backend
 * — either a discoverable Codex CLI candidate that's executable and at
 * the minimum supported version, OR an xAI/Grok API key configured in
 * the keychain. The wizard's Step 0 footer enables Continue based on
 * this; downstream wizard steps assume this has already been satisfied,
 * which lets them defer Codex CLI execution until a known-good backend
 * exists (see `CodexAppServerClient.isCodexBootstrapDeferred`).
 */
function isBackendRequirementSatisfied(
  snapshot: DesktopSettingsSnapshot | undefined,
  bufferedGrokKey: string,
): boolean {
  if (!snapshot) return false;
  const codexSelected = snapshot.models.codex.discovery.candidates.some(
    (candidate) => candidate.selected && candidate.executable,
  );
  const grokConfigured = snapshot.models.grok.apiKey.configured;
  // Buffered xAI key (entered in this wizard session but not yet
  // written to a profile keychain) satisfies the gate too — the
  // value will graduate to the chosen profile at Finish.
  const grokBuffered = bufferedGrokKey.trim().length > 0;
  return codexSelected || grokConfigured || grokBuffered;
}

function BackendRequirementsStep(props: {
  settings: DesktopSettingsState;
  desktopApi?: DesktopApi;
  /** Buffered xAI key value (held in wizard state, not yet
   *  encrypted+written to the keychain). Empty string means "no
   *  key in buffer." */
  bufferedGrokKey: string;
  onBufferGrokKey: (value: string) => void;
}) {
  const snapshot = props.settings.snapshot;
  const discovery = snapshot?.models.codex.discovery;
  const grokKey = snapshot?.models.grok.apiKey;
  const codexCandidate = discovery?.candidates.find(
    (candidate) => candidate.selected && candidate.executable,
  );
  const codexOk = Boolean(codexCandidate);
  // Buffered key counts as "Grok configured" for the wizard's gate.
  // The actual encrypt + write to the chosen profile's state.db
  // happens at Finish via `writeSecretsToProfile` — see the comment
  // on `WriteDesktopSecretsToProfileRequest` for why we defer.
  const grokOk = Boolean(grokKey?.configured) || props.bufferedGrokKey.length > 0;

  const [refreshing, setRefreshing] = useState(false);
  const [grokKeyInput, setGrokKeyInput] = useState("");

  const refresh = async (): Promise<void> => {
    if (!props.desktopApi?.refreshCodexDiscovery || refreshing) return;
    setRefreshing(true);
    try {
      await props.desktopApi.refreshCodexDiscovery({});
    } catch (caught) {
      // eslint-disable-next-line no-console
      console.warn("Onboarding: refreshCodexDiscovery failed", caught);
    } finally {
      setRefreshing(false);
    }
  };

  const saveGrokKey = (): void => {
    const value = grokKeyInput.trim();
    if (!value) return;
    props.onBufferGrokKey(value);
    setGrokKeyInput("");
  };
  const clearGrokKey = (): void => {
    props.onBufferGrokKey("");
  };

  return (
    <div className="onboarding-wizard__prereqs">
      <header className="onboarding-wizard__head">
        <h1 className="onboarding-wizard__title">
          Pick at least one model backend to continue
        </h1>
        <p className="onboarding-wizard__sub">
          PwrAgent runs on top of one or both of these providers. You only
          need one to get started — the rest of the wizard configures
          profiles and (optionally) messaging on top.
        </p>
      </header>

      <div className="onboarding-wizard__prereq-card">
        <div className="onboarding-wizard__prereq-head">
          <div>
            <div className="onboarding-wizard__prereq-title">Codex CLI</div>
            <div className="onboarding-wizard__prereq-sub">
              Required for the Codex backend. PwrAgent shells out to the
              installed binary; we don&rsquo;t bundle it.
            </div>
          </div>
          <span
            className={`onboarding-wizard__prereq-status ${
              codexOk
                ? "onboarding-wizard__prereq-status--ok"
                : "onboarding-wizard__prereq-status--missing"
            }`}
          >
            {codexOk ? (
              <>
                ✓ Found{codexCandidate?.version ? ` v${codexCandidate.version}` : ""}
              </>
            ) : (
              "Not found"
            )}
          </span>
        </div>
        {codexOk ? (
          <div className="onboarding-wizard__prereq-detail">
            <code>{codexCandidate?.command}</code>
            <button
              type="button"
              className="onboarding-wizard__btn onboarding-wizard__btn--ghost"
              disabled={refreshing}
              onClick={() => void refresh()}
            >
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        ) : (
          <div className="onboarding-wizard__prereq-detail">
            <details className="onboarding-wizard__prereq-paths">
              <summary>
                Searched {discovery?.candidates.length ?? 0} location
                {discovery && discovery.candidates.length === 1 ? "" : "s"}{" "}
                — none with a usable Codex
              </summary>
              <ul>
                {discovery?.candidates.map((candidate) => (
                  <li key={candidate.command}>
                    <code>{candidate.command}</code>
                    <span className="onboarding-wizard__prereq-paths-reason">
                      {candidate.executable
                        ? candidate.failureReason ?? "no version"
                        : candidate.failureReason === "not_found"
                          ? "not found"
                          : candidate.failureReason ?? "not executable"}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
            <div className="onboarding-wizard__prereq-install">
              <strong>Install:</strong>
              <ul>
                <li>
                  npm: <code>npm install -g @openai/codex</code>
                </li>
                <li>
                  pnpm: <code>pnpm add -g @openai/codex</code>
                </li>
                <li>
                  Homebrew (macOS / Linux):{" "}
                  <code>brew install --cask codex</code>
                </li>
              </ul>
              <button
                type="button"
                className="onboarding-wizard__btn onboarding-wizard__btn--ghost"
                disabled={refreshing}
                onClick={() => void refresh()}
              >
                {refreshing ? "Refreshing…" : "Refresh after install"}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="onboarding-wizard__prereq-card">
        <div className="onboarding-wizard__prereq-head">
          <div>
            <div className="onboarding-wizard__prereq-title">xAI API key</div>
            <div className="onboarding-wizard__prereq-sub">
              Required for the Grok backend. Encrypted with your OS keychain
              and saved to the profile you pick on the next steps.
            </div>
          </div>
          <span
            className={`onboarding-wizard__prereq-status ${
              grokOk
                ? "onboarding-wizard__prereq-status--ok"
                : "onboarding-wizard__prereq-status--missing"
            }`}
          >
            {grokOk
              ? props.bufferedGrokKey.length > 0
                ? "✓ Ready"
                : "✓ Configured"
              : "Not configured"}
          </span>
        </div>
        {!grokOk ? (
          <div className="onboarding-wizard__prereq-detail">
            <div className="onboarding-wizard__field-row">
              <input
                type="password"
                className="onboarding-wizard__input"
                placeholder="xai-…"
                value={grokKeyInput}
                onChange={(e) => setGrokKeyInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    saveGrokKey();
                  }
                }}
              />
              <button
                type="button"
                className="onboarding-wizard__btn onboarding-wizard__btn--ghost"
                disabled={!grokKeyInput.trim()}
                onClick={saveGrokKey}
              >
                Use this key
              </button>
            </div>
            <div className="onboarding-wizard__prereq-link">
              Get a key at{" "}
              <code>https://console.x.ai/team/default/api-keys</code>
            </div>
          </div>
        ) : props.bufferedGrokKey.length > 0 ? (
          // Buffered (entered now, not yet saved). Show a small undo so
          // the operator can clear/replace before Finish.
          <div className="onboarding-wizard__prereq-detail">
            <span className="onboarding-wizard__prereq-link">
              We&rsquo;ll save this key into the profile you pick next.
            </span>
            <button
              type="button"
              className="onboarding-wizard__btn onboarding-wizard__btn--link"
              onClick={clearGrokKey}
            >
              Clear / re-enter
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Slim confirmation step shown when the operator launched PwrAgent
 * with `--profile=foo` or `PWRAGENT_PROFILE=foo` and `foo` doesn't
 * exist on disk. Pre-#524 silently materialized the profile and
 * mapped it to Codex's system default; now we pause here to confirm
 * the operator actually wants to create it. "Set it up" continues
 * into the standard flow with the requested name already filled in
 * on the Profiles step. "Quit PwrAgent" exits cleanly so the
 * operator can re-launch with the correct name.
 */
function BootstrapConfirmStep(props: {
  requestedName: string;
  source: "missing-named" | "no-profile";
  onContinue: () => void;
  onQuit: () => void;
  submitting: boolean;
}) {
  const name = props.requestedName.trim() || "this profile";
  return (
    <div className="onboarding-wizard__bootstrap-confirm">
      <div className="onboarding-wizard__brand">
        Pwr<span>Agent</span>
      </div>
      <h1 className="onboarding-wizard__title onboarding-wizard__title--center">
        Set up <code>{name}</code>?
      </h1>
      <p className="onboarding-wizard__sub onboarding-wizard__sub--center">
        PwrAgent doesn&rsquo;t know a profile named <code>{name}</code> yet.
        You started this run via{" "}
        {props.source === "missing-named" ? (
          <>
            <code>--profile</code> or <code>PWRAGENT_PROFILE</code>
          </>
        ) : (
          "the launch environment"
        )}
        , so we can either walk you through creating it (paired with a
        new Codex auth profile of the same name) or quit so you can
        re-launch with a different name.
      </p>
      <ul className="onboarding-wizard__bootstrap-confirm-points">
        <li>
          <strong>What you&rsquo;ll do next:</strong> pick how PwrAgent
          relates to your Codex install (Shared / Isolated / Multiple),
          log into the Codex auth profile, and choose your theme +
          messaging preferences. Takes a couple of minutes.
        </li>
        <li>
          <strong>What you won&rsquo;t do:</strong> overwrite your
          existing <code>~/.codex/</code> default session, lose any
          threads, or commit to messaging — that part is optional.
        </li>
      </ul>
      <div className="onboarding-wizard__bootstrap-confirm-actions">
        <button
          type="button"
          className="onboarding-wizard__btn onboarding-wizard__btn--ghost"
          disabled={props.submitting}
          onClick={props.onQuit}
        >
          Quit PwrAgent
        </button>
        <button
          type="button"
          className="onboarding-wizard__btn onboarding-wizard__btn--primary"
          disabled={props.submitting}
          onClick={props.onContinue}
        >
          Set up <code>{name}</code> →
        </button>
      </div>
      <p className="onboarding-wizard__bootstrap-confirm-hint">
        Tip: launch without <code>--profile</code> / <code>PWRAGENT_PROFILE</code>{" "}
        to pick from existing profiles instead.
      </p>
    </div>
  );
}

function WelcomeStep() {
  return (
    <div className="onboarding-wizard__welcome">
      <div className="onboarding-wizard__brand">
        Pwr<span>Agent</span>
      </div>
      <h1 className="onboarding-wizard__title">
        A few short choices, then you&rsquo;re operating.
      </h1>
      <p className="onboarding-wizard__sub">
        Pick how your thread list looks, which model backend you&rsquo;ll run
        on, how PwrAgent relates to your Codex install, and (optionally) a
        messaging platform. Every choice persists in Settings and is
        reversible at any time.
      </p>
      <ol className="onboarding-wizard__welcome-list">
        <li>
          <span className="onboarding-wizard__welcome-num is-current">1</span>
          <div>
            <div className="onboarding-wizard__welcome-row-title">
              Thread presentation
            </div>
            <div className="onboarding-wizard__welcome-row-sub">
              Compact rows or Mission Control chips. Light, dark, or follow OS.
            </div>
          </div>
        </li>
        <li>
          <span className="onboarding-wizard__welcome-num">2</span>
          <div>
            <div className="onboarding-wizard__welcome-row-title">
              Models / Providers
            </div>
            <div className="onboarding-wizard__welcome-row-sub">
              Confirm Codex CLI is installed, or paste an xAI API key — one is
              enough.
            </div>
          </div>
        </li>
        <li>
          <span className="onboarding-wizard__welcome-num">3</span>
          <div>
            <div className="onboarding-wizard__welcome-row-title">
              Profiles
            </div>
            <div className="onboarding-wizard__welcome-row-sub">
              Share your existing Codex login, isolate a fresh one, or set up
              several at once.
            </div>
          </div>
        </li>
        <li>
          <span className="onboarding-wizard__welcome-num">4</span>
          <div>
            <div className="onboarding-wizard__welcome-row-title">
              Messaging
            </div>
            <div className="onboarding-wizard__welcome-row-sub">
              Optional. Skip and stay on the desktop, or connect Telegram /
              Discord / Slack / others.
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
          desc="It just works — you can move back to Codex Desktop from any thread started in PwrAgent and vice versa. Zero new logins."
          hint="Best for: trying PwrAgent without disturbing anything."
          badge={props.value === "shared" ? "Default" : undefined}
          selected={props.value === "shared"}
          onSelect={() => props.onChange("shared")}
          preview={<CodexDiagramShared />}
        />
        <ChoiceCard
          eyebrow="Isolated"
          title="Create a fresh Codex profile for PwrAgent"
          desc="If you want to keep PwrAgent threads isolated from Codex Desktop threads, or optionally use a different Codex account."
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
  onSkipMessaging: () => void;
  onContinue: () => void;
  submitting: boolean;
  /**
   * In Multiple / Isolated modes, identifies the profile messaging
   * will be configured for during this wizard (always the first
   * named profile — they're created in order, and we land the
   * operator inside the first one at Finish). When set, the safety
   * step prepends a notice so the operator knows the other profiles
   * stay messaging-free until they configure each one from Settings.
   *
   * `undefined` for Shared mode (only one profile exists — no
   * disambiguation needed).
   */
  multiProfileTarget?: { firstProfileName: string; otherProfileNames: readonly string[] };
}) {
  return (
    <div className="onboarding-wizard__safety">
      <div className="onboarding-wizard__safety-icon">
        <ShieldIcon />
      </div>
      <h1 className="onboarding-wizard__title onboarding-wizard__title--center">
        Messaging is optional — and worth thinking about first
      </h1>
      <p className="onboarding-wizard__sub onboarding-wizard__sub--center">
        Connecting a chat platform lets you drive PwrAgent from your phone.
        You can also skip this and stay on the desktop. Either way, three
        principles to read before you decide.
      </p>
      {props.multiProfileTarget
      && props.multiProfileTarget.otherProfileNames.length > 0 ? (
        <div className="onboarding-wizard__safety-multi-notice" role="note">
          <strong>Heads up:</strong> we'll set up messaging for{" "}
          <code>{props.multiProfileTarget.firstProfileName}</code> here. The
          other profile{props.multiProfileTarget.otherProfileNames.length === 1 ? "" : "s"}{" "}
          (
          {props.multiProfileTarget.otherProfileNames.map((name, i) => (
            <span key={name}>
              {i > 0 ? ", " : ""}
              <code>{name}</code>
            </span>
          ))}
          ) start without messaging. To configure messaging for{" "}
          {props.multiProfileTarget.otherProfileNames.length === 1 ? "it" : "them"},
          open each profile after the wizard finishes and use{" "}
          <strong>Settings → Messaging</strong>. Each profile needs its own
          bot — one bot token can only be polled by one process at a time.
        </div>
      ) : null}
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
      <div className="onboarding-wizard__safety-fork">
        <button
          type="button"
          className="onboarding-wizard__btn onboarding-wizard__btn--ghost"
          disabled={props.submitting}
          onClick={props.onSkipMessaging}
        >
          Skip messaging for now
        </button>
        <button
          type="button"
          className="onboarding-wizard__btn onboarding-wizard__btn--primary"
          disabled={!props.acknowledged || props.submitting}
          onClick={props.onContinue}
        >
          Continue to messaging setup →
        </button>
      </div>
      <p className="onboarding-wizard__safety-fork-hint">
        You can always add or change messaging providers later from
        Settings → Messaging.
      </p>
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
  // Same layout grammar as Multiple, but with a single paired row:
  // a new PwrAgent profile (named "pwragent" by default — user-editable
  // in the Step 2b naming step) connects to a brand-new Codex profile
  // of the same name. The footer reuses the Multiple diagram's
  // "UNTOUCHED" pattern so the operator sees that their existing Codex
  // default stays exactly where it is. This is what makes the data-leak
  // guarantee land visually for the single-profile-isolated case.
  return (
    <div className="onboarding-wizard__codex onboarding-wizard__codex--multiple">
      <div className="onboarding-wizard__codex-multi-pairs">
        <div className="onboarding-wizard__codex-multi-pair">
          <CodexNode label="pwragent" avatar="PA" accent compact tight />
          <span className="onboarding-wizard__codex-link onboarding-wizard__codex-link--small">→</span>
          <CodexNode
            label="pwragent"
            avatar="CX"
            meta="new — your login"
            compact
            tight
          />
        </div>
      </div>
      <div className="onboarding-wizard__codex-multi-default">
        <span className="onboarding-wizard__codex-multi-default-label">
          Untouched
        </span>
        <CodexNode label="(default)" avatar="PA" muted dashed compact tight />
        <span className="onboarding-wizard__codex-link onboarding-wizard__codex-link--dashed">
          ╌╌
        </span>
        <CodexNode
          label="Codex default"
          avatar="CX"
          meta="your existing login"
          muted
          dashed
          compact
          tight
        />
      </div>
    </div>
  );
}

function CodexDiagramMultiple() {
  // Three PwrAgent profiles (work, personal, projects) each map to a
  // Codex profile of the same name. Codex `personal` and `projects`
  // happen to share an upstream OpenAI login (joe@example.com) — they're
  // still separate Codex profile dirs under ~/.codex/auth-profiles, but
  // both auth as the same account. `work` uses a different login.
  // The existing `default` Codex profile is left untouched on disk and
  // is intentionally shown as a faded dashed node in the footer so the
  // operator sees "we don't touch your default Codex" at a glance.
  return (
    <div className="onboarding-wizard__codex onboarding-wizard__codex--multiple">
      <div className="onboarding-wizard__codex-multi-pairs">
        <div className="onboarding-wizard__codex-multi-pair">
          <CodexNode label="work" avatar="PA" accent compact tight />
          <span className="onboarding-wizard__codex-link onboarding-wizard__codex-link--small">→</span>
          <CodexNode
            label="work"
            avatar="CX"
            meta="work@example.com"
            compact
            tight
          />
        </div>
        <div className="onboarding-wizard__codex-multi-pair">
          <CodexNode label="personal" avatar="PA" accent compact tight />
          <span className="onboarding-wizard__codex-link onboarding-wizard__codex-link--small">→</span>
          <CodexNode
            label="personal"
            avatar="CX"
            meta="joe@example.com"
            compact
            tight
          />
        </div>
        <div className="onboarding-wizard__codex-multi-pair">
          <CodexNode label="projects" avatar="PA" accent compact tight />
          <span className="onboarding-wizard__codex-link onboarding-wizard__codex-link--small">→</span>
          <CodexNode
            label="projects"
            avatar="CX"
            meta="joe@example.com"
            compact
            tight
          />
        </div>
      </div>
      <div className="onboarding-wizard__codex-multi-default">
        <span className="onboarding-wizard__codex-multi-default-label">
          Untouched
        </span>
        <CodexNode label="(default)" avatar="PA" muted dashed compact tight />
        <span className="onboarding-wizard__codex-link onboarding-wizard__codex-link--dashed">
          ╌╌
        </span>
        <CodexNode
          label="Codex default"
          avatar="CX"
          meta="your existing login"
          muted
          dashed
          compact
          tight
        />
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
  /** Even tighter padding for high-density diagrams (Multiple). */
  tight?: boolean;
  /** Render as a desaturated/hint state — used for the "untouched" pair. */
  muted?: boolean;
  /** Switch the border to dashed (companion to muted). */
  dashed?: boolean;
}) {
  const classes = ["onboarding-wizard__codex-node"];
  if (props.accent) classes.push("is-accent");
  if (props.compact) classes.push("is-compact");
  if (props.tight) classes.push("is-tight");
  if (props.muted) classes.push("is-muted");
  if (props.dashed) classes.push("is-dashed");
  return (
    <div className={classes.join(" ")}>
      <span className="onboarding-wizard__codex-avatar">{props.avatar}</span>
      <div className="onboarding-wizard__codex-node-text">
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

/**
 * Per-row login state for the inline Codex login UX on the
 * name-codex-profiles step. Keyed by the row's *committed* name (the
 * name at the moment the operator clicked "Log in" — name edits after
 * that point are blocked by `isRowLocked`). `ok` carries email/plan
 * from the JWT so the row can display them inline as confirmation.
 */
type RowLoginState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "waiting"; url?: string; detail?: string }
  | { kind: "checking"; url?: string }
  | { kind: "ok"; email?: string; planType?: string }
  | { kind: "error"; detail: string; url?: string };

function NameCodexProfilesStep(props: {
  /** Isolated = single profile (max 1). Multiple = 1–5 profiles. */
  mode: "isolated" | "multiple";
  names: string[];
  onChange: (next: string[]) => void;
  desktopApi?: DesktopApi;
  /** Called whenever the per-row login states change, so the wizard
   *  root can gate the footer Continue button on "all named rows
   *  authenticated". `namedRows` excludes blank inputs. */
  onAuthStateChange: (snapshot: { allAuthed: boolean; namedRows: number }) => void;
  /** Global xAI key from Models / Providers step (renderer buffer,
   *  not yet written to a keychain). When a row's per-profile
   *  override is unset, this value graduates to that profile. */
  globalXaiKey: string;
  /** Per-profile xAI key overrides keyed by the row's committed
   *  name. Empty string = "no override; inherit global". */
  xaiKeyByProfile: Record<string, string>;
  onSetXaiKeyForProfile: (profileName: string, value: string) => void;
}) {
  const maxCount = props.mode === "isolated" ? 1 : 5;
  const isSingle = props.mode === "isolated";
  // Login state keyed by the *committed* row name, so name edits before
  // Login is clicked don't carry orphan state, and so a Back-out and
  // re-entry to this step preserves authenticated rows.
  const [loginStates, setLoginStates] = useState<Record<string, RowLoginState>>({});
  const apiRef = useRef(props.desktopApi);
  apiRef.current = props.desktopApi;

  const stateFor = (name: string): RowLoginState =>
    loginStates[name] ?? { kind: "idle" };
  const setStateFor = (name: string, next: RowLoginState): void => {
    setLoginStates((prev) => ({ ...prev, [name]: next }));
  };

  const isRowLocked = (name: string): boolean => {
    const trimmed = name.trim();
    if (!trimmed) return false;
    const state = stateFor(trimmed).kind;
    return state === "starting" || state === "waiting" || state === "checking" || state === "ok";
  };

  const setAt = (idx: number, value: string): void => {
    const current = props.names[idx]?.trim() ?? "";
    if (isRowLocked(current)) return;
    const next = [...props.names];
    next[idx] = value;
    props.onChange(next);
  };
  const removeAt = (idx: number): void => {
    const current = props.names[idx]?.trim() ?? "";
    if (isRowLocked(current)) return;
    const next = [...props.names];
    next.splice(idx, 1);
    props.onChange(next);
  };
  const addOne = (): void => {
    if (props.names.length >= maxCount) return;
    props.onChange([...props.names, ""]);
  };

  /**
   * Kick off (or re-kick) login for one row. Creates the Codex auth
   * profile shell if it doesn't exist (idempotent — the IPC returns
   * `created: false` if it was already there), spawns `codex login`,
   * and surfaces the login URL so the operator can either let the
   * default browser open it or copy/paste into a different browser
   * with the right SSO session.
   */
  const startLogin = useCallback(
    async (name: string): Promise<void> => {
      const api = apiRef.current;
      if (
        !api?.createCodexAuthProfile ||
        !api.startCodexAuthProfileLogin ||
        !isValidProfileName(name)
      ) {
        return;
      }
      setStateFor(name, { kind: "starting" });
      try {
        await api.createCodexAuthProfile({ profile: name });
        const result = await api.startCodexAuthProfileLogin({ profile: name });
        if (result.authenticated) {
          // The shell reused an existing token — finish immediately
          // by re-reading identity via checkCodexAuthProfileStatus
          // (which extracts email + plan from the JWT).
          await refreshStatus(name);
          return;
        }
        setStateFor(name, {
          kind: "waiting",
          url: result.loginUrl,
          detail: result.detail,
        });
      } catch (caught) {
        setStateFor(name, {
          kind: "error",
          detail: caught instanceof Error ? caught.message : String(caught),
        });
      }
    },
    // refreshStatus is defined below — it's stable because it closes
    // over apiRef (which is mutable but read at call-time).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const refreshStatus = useCallback(async (name: string): Promise<void> => {
    const api = apiRef.current;
    if (!api?.checkCodexAuthProfileStatus || !isValidProfileName(name)) return;
    setLoginStates((prev) => {
      const existing = prev[name];
      // Only show a "checking" indicator if the row had something in
      // flight already; auto-recheck on focus shouldn't flash idle
      // rows into a checking state.
      if (!existing || existing.kind === "ok") return prev;
      return {
        ...prev,
        [name]: {
          kind: "checking",
          url: "url" in existing ? existing.url : undefined,
        },
      };
    });
    try {
      const result = await api.checkCodexAuthProfileStatus({ profile: name });
      if (result.authenticated) {
        setStateFor(name, {
          kind: "ok",
          email: result.email,
          planType: result.planType,
        });
      } else {
        setLoginStates((prev) => {
          const previousUrl =
            prev[name] && "url" in prev[name]! ? (prev[name] as { url?: string }).url : undefined;
          return {
            ...prev,
            [name]: {
              kind: "waiting",
              url: previousUrl,
              detail: result.detail,
            },
          };
        });
      }
    } catch (caught) {
      setStateFor(name, {
        kind: "error",
        detail: caught instanceof Error ? caught.message : String(caught),
      });
    }
  }, []);

  const copyLoginUrl = useCallback(async (url: string | undefined): Promise<void> => {
    const api = apiRef.current;
    if (!url || !api?.copyText) return;
    try {
      await api.copyText(url);
    } catch {
      // Best-effort; nothing to recover.
    }
  }, []);

  // Auto-recheck on window focus: when the operator finishes the OAuth
  // dance in a browser, focus returns to PwrAgent. Re-poll every row
  // that's in a non-terminal state.
  useEffect(() => {
    const api = apiRef.current;
    if (!api?.onWindowFocus) return undefined;
    return api.onWindowFocus(() => {
      for (const [name, state] of Object.entries(loginStates)) {
        if (state.kind === "waiting" || state.kind === "checking") {
          void refreshStatus(name);
        }
      }
    });
  }, [loginStates, refreshStatus]);

  // On mount, probe each valid name for an already-authenticated state
  // so back-nav doesn't lose login progress. Runs once per name → ok
  // transition, idempotent against reordering.
  useEffect(() => {
    const api = apiRef.current;
    if (!api?.checkCodexAuthProfileStatus) return;
    for (const raw of props.names) {
      const name = raw.trim();
      if (!isValidProfileName(name)) continue;
      if (stateFor(name).kind !== "idle") continue;
      void (async () => {
        try {
          const result = await api.checkCodexAuthProfileStatus!({ profile: name });
          if (result.authenticated) {
            setStateFor(name, {
              kind: "ok",
              email: result.email,
              planType: result.planType,
            });
          }
        } catch {
          // Silent — idle rows where the auth profile doesn't exist
          // yet legitimately fail this check. Showing an error here
          // would scream at the operator before they've even clicked
          // Log in.
        }
      })();
    }
    // We deliberately depend on names only — adding loginStates would
    // re-fire after every state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.names]);

  // Propagate auth completion to the wizard root for Continue gating.
  useEffect(() => {
    const validNames = props.names
      .map((name) => name.trim())
      .filter((name) => isValidProfileName(name));
    const allAuthed =
      validNames.length > 0 &&
      validNames.every((name) => stateFor(name).kind === "ok");
    props.onAuthStateChange({ allAuthed, namedRows: validNames.length });
    // stateFor is derived from loginStates; depending on names + loginStates
    // is sufficient to drive the snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loginStates, props.names]);

  return (
    <div>
      <header className="onboarding-wizard__head">
        <h1 className="onboarding-wizard__title">
          {isSingle
            ? "Name and log in to your isolated profile"
            : "Name and log in to your PwrAgent + Codex profiles"}
        </h1>
        <p className="onboarding-wizard__sub">
          {isSingle ? (
            <>
              The name applies to <strong>both sides</strong>: a new PwrAgent
              profile under <code>~/.pwragent/profiles/</code> and a matching
              Codex auth profile under <code>~/.codex/auth-profiles/</code>.
              Click <strong>Log in</strong> to start the Codex OAuth flow for
              that profile. Tip: focus the browser window that&rsquo;s already
              signed in to the right account first, or use{" "}
              <strong>Copy URL</strong> to paste the login link into the
              browser you want.
            </>
          ) : (
            <>
              Up to 5. Each name becomes <strong>both</strong> a new PwrAgent
              profile and a matching Codex auth profile of the same name.
              Click <strong>Log in</strong> on each row to start the Codex
              OAuth flow for that profile. Tip: focus the browser window
              that&rsquo;s already signed in to the right account first, or
              use <strong>Copy URL</strong> to paste the link into the browser
              you want.
            </>
          )}
        </p>
      </header>
      <div className="onboarding-wizard__profile-list">
        {props.names.map((name, idx) => {
          const trimmed = name.trim();
          const valid = trimmed === "" || isValidProfileName(trimmed);
          const state = trimmed ? stateFor(trimmed) : { kind: "idle" as const };
          const locked = isRowLocked(trimmed);
          return (
            <div
              key={idx}
              className={`onboarding-wizard__profile-row onboarding-wizard__profile-row--has-login is-${state.kind}`}
            >
              <div className="onboarding-wizard__profile-row-top">
                <span className="onboarding-wizard__profile-num">{idx + 1}</span>
                <input
                  type="text"
                  className={`onboarding-wizard__profile-input${valid ? "" : " is-invalid"}`}
                  placeholder={isSingle ? "pwragent" : "profile-name"}
                  value={name}
                  onChange={(e) => setAt(idx, e.target.value)}
                  aria-invalid={!valid}
                  readOnly={locked}
                />
                <ProfileRowLoginControls
                  name={trimmed}
                  valid={valid && trimmed.length > 0}
                  state={state}
                  onLogin={() => void startLogin(trimmed)}
                  onCheck={() => void refreshStatus(trimmed)}
                  onCopyUrl={() => void copyLoginUrl("url" in state ? state.url : undefined)}
                />
                {!isSingle && props.names.length > 1 ? (
                  <button
                    type="button"
                    className="onboarding-wizard__btn onboarding-wizard__btn--link"
                    onClick={() => removeAt(idx)}
                    aria-label={`Remove profile ${idx + 1}`}
                    disabled={locked}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
              <ProfileRowLoginStatus state={state} />
              {trimmed ? (
                <ProfileRowXaiKey
                  profileName={trimmed}
                  globalKey={props.globalXaiKey}
                  override={props.xaiKeyByProfile[trimmed] ?? ""}
                  onChange={(value) =>
                    props.onSetXaiKeyForProfile(trimmed, value)
                  }
                />
              ) : null}
            </div>
          );
        })}
        {!isSingle && props.names.length < maxCount ? (
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

function ProfileRowLoginControls(props: {
  name: string;
  valid: boolean;
  state: RowLoginState;
  onLogin: () => void;
  onCheck: () => void;
  onCopyUrl: () => void;
}) {
  if (props.state.kind === "ok") {
    return (
      <span className="onboarding-wizard__profile-row-status onboarding-wizard__profile-row-status--ok">
        ✓ Logged in
      </span>
    );
  }
  const hasUrl = "url" in props.state && Boolean(props.state.url);
  const inFlight =
    props.state.kind === "starting" || props.state.kind === "checking";
  const loginLabel = (() => {
    if (props.state.kind === "starting") return "Starting…";
    if (props.state.kind === "waiting") return "Re-open browser";
    if (props.state.kind === "error") return "Try again";
    if (props.state.kind === "checking") return "Checking…";
    return "Log in";
  })();
  return (
    <div className="onboarding-wizard__profile-row-actions">
      <button
        type="button"
        className="onboarding-wizard__btn onboarding-wizard__btn--ghost"
        disabled={!props.valid || inFlight}
        onClick={props.onLogin}
      >
        {loginLabel}
      </button>
      {hasUrl ? (
        <button
          type="button"
          className="onboarding-wizard__btn onboarding-wizard__btn--link"
          onClick={props.onCopyUrl}
        >
          Copy URL
        </button>
      ) : null}
      {props.state.kind === "waiting" ? (
        <button
          type="button"
          className="onboarding-wizard__btn onboarding-wizard__btn--link"
          onClick={props.onCheck}
        >
          Check status
        </button>
      ) : null}
    </div>
  );
}

function ProfileRowLoginStatus(props: { state: RowLoginState }) {
  if (props.state.kind === "ok") {
    const bits = [props.state.email, props.state.planType].filter(Boolean);
    return (
      <div className="onboarding-wizard__profile-row-detail onboarding-wizard__profile-row-detail--ok">
        {bits.length > 0 ? bits.join(" · ") : "Authenticated"}
      </div>
    );
  }
  if (props.state.kind === "waiting") {
    return (
      <div className="onboarding-wizard__profile-row-detail">
        Browser opened. Complete the Codex sign-in, then return here — we
        re-check automatically when this window regains focus.
      </div>
    );
  }
  if (props.state.kind === "error") {
    return (
      <div className="onboarding-wizard__profile-row-detail onboarding-wizard__profile-row-detail--error">
        {props.state.detail}
      </div>
    );
  }
  return null;
}

/**
 * Shared-mode login step. Only rendered when the operator picked
 * "Shared" on the Codex profile step AND their existing Codex
 * install hasn't been logged in yet (no `~/.codex/auth.json`). Reuses
 * the same row-status sub-components as the Multiple/Isolated naming
 * step, but operates on the Codex *system default* profile (empty
 * profile name on the IPC calls) rather than a named per-row entry.
 *
 * Why a dedicated step (vs. inline on the codex-profile step): the
 * Codex profile step is the operator's choice of *strategy*. The
 * login UX needs space for status + URL copy + retry controls; a
 * standalone step keeps both screens focused. The step is skipped
 * entirely when the system default is already authenticated.
 */
function SharedCodexLoginStep(props: {
  desktopApi?: DesktopApi;
  onAuthStateChange: (authed: boolean) => void;
}) {
  const [state, setState] = useState<RowLoginState>({ kind: "idle" });
  const apiRef = useRef(props.desktopApi);
  apiRef.current = props.desktopApi;
  // Empty string is the sentinel for the Codex system default; the
  // main-process IPC handlers resolve it to `~/.codex/` (see
  // `resolveRequiredCodexProfileHome`).
  const SYSTEM_DEFAULT = "";

  const refreshStatus = useCallback(async (): Promise<void> => {
    const api = apiRef.current;
    if (!api?.checkCodexAuthProfileStatus) return;
    setState((prev) => {
      if (prev.kind === "ok") return prev;
      const url = "url" in prev ? prev.url : undefined;
      return { kind: "checking", url };
    });
    try {
      const result = await api.checkCodexAuthProfileStatus({
        profile: SYSTEM_DEFAULT,
      });
      if (result.authenticated) {
        setState({
          kind: "ok",
          email: result.email,
          planType: result.planType,
        });
      } else {
        setState((prev) => {
          const url = "url" in prev ? prev.url : undefined;
          return { kind: "waiting", url, detail: result.detail };
        });
      }
    } catch (caught) {
      setState({
        kind: "error",
        detail: caught instanceof Error ? caught.message : String(caught),
      });
    }
  }, []);

  const startLogin = useCallback(async (): Promise<void> => {
    const api = apiRef.current;
    if (!api?.startCodexAuthProfileLogin) return;
    setState({ kind: "starting" });
    try {
      // Intentionally skip `createCodexAuthProfile` — the system
      // default `~/.codex/` already exists (or `codex login` will
      // create the dir). Creating a profile-dir-under-`profiles/`
      // would side-step the operator's choice to share, not
      // isolate.
      const result = await api.startCodexAuthProfileLogin({
        profile: SYSTEM_DEFAULT,
      });
      if (result.authenticated) {
        await refreshStatus();
        return;
      }
      setState({
        kind: "waiting",
        url: result.loginUrl,
        detail: result.detail,
      });
    } catch (caught) {
      setState({
        kind: "error",
        detail: caught instanceof Error ? caught.message : String(caught),
      });
    }
  }, [refreshStatus]);

  const copyLoginUrl = useCallback(
    async (url: string | undefined): Promise<void> => {
      const api = apiRef.current;
      if (!url || !api?.copyText) return;
      try {
        await api.copyText(url);
      } catch {
        // best-effort
      }
    },
    [],
  );

  // Probe on mount — the operator could have logged in via another
  // path between picking Shared and arriving here. Auto-recheck on
  // window focus too: returning from a browser SSO flow triggers
  // it without the operator clicking "Check status."
  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);
  useEffect(() => {
    const api = apiRef.current;
    if (!api?.onWindowFocus) return undefined;
    return api.onWindowFocus(() => {
      if (state.kind === "waiting" || state.kind === "checking") {
        void refreshStatus();
      }
    });
  }, [state, refreshStatus]);

  useEffect(() => {
    props.onAuthStateChange(state.kind === "ok");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <div>
      <header className="onboarding-wizard__head">
        <h1 className="onboarding-wizard__title">
          Log in to your Codex account
        </h1>
        <p className="onboarding-wizard__sub">
          You picked <strong>Shared</strong> — PwrAgent will reuse your
          existing Codex install at <code>~/.codex/</code>. We just need to
          confirm you&rsquo;re signed in. If you&rsquo;ve already logged in
          via Codex Desktop or the <code>codex</code> CLI, this step is
          probably already green; otherwise click <strong>Log in</strong>{" "}
          below.
        </p>
      </header>
      <div className="onboarding-wizard__profile-list">
        <div
          className={`onboarding-wizard__profile-row onboarding-wizard__profile-row--has-login is-${state.kind}`}
        >
          <div className="onboarding-wizard__profile-row-top">
            <span className="onboarding-wizard__profile-num">↻</span>
            <span
              className="onboarding-wizard__profile-input"
              style={{ display: "inline-flex", alignItems: "center" }}
            >
              <code style={{ fontWeight: 500 }}>System default</code>
              <span
                style={{
                  marginLeft: 8,
                  fontSize: 12,
                  color: "var(--text-muted)",
                }}
              >
                ~/.codex/
              </span>
            </span>
            <ProfileRowLoginControls
              name="system-default"
              valid={true}
              state={state}
              onLogin={() => void startLogin()}
              onCheck={() => void refreshStatus()}
              onCopyUrl={() =>
                void copyLoginUrl("url" in state ? state.url : undefined)
              }
            />
          </div>
          <ProfileRowLoginStatus state={state} />
        </div>
      </div>
    </div>
  );
}

/**
 * Inline xAI API key control per profile row. Three states:
 *   - Hidden chip ("Add xAI key (optional)"): default when no global
 *     key set and no override. Expanding shows the input.
 *   - "Uses global xAI key" chip: rendered when the operator typed
 *     a global key on Models / Providers but didn't override here.
 *     Expanding shows the input with the global value pre-filled
 *     (operator can replace).
 *   - "Override active" chip: rendered when an override is set.
 *     Always shows the input collapsed-style with Clear button.
 *
 * Override values flow into the wizard's `xaiKeyByProfile` map and
 * graduate to the matching profile's keychain at Finish. Per-row
 * keys NEVER write to `replaceSecret` — same defer-and-graduate
 * pattern as the global key on Models / Providers.
 */
function ProfileRowXaiKey(props: {
  profileName: string;
  globalKey: string;
  override: string;
  onChange: (value: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [value, setValue] = useState("");
  const hasGlobal = props.globalKey.length > 0;
  const hasOverride = props.override.length > 0;

  const save = (): void => {
    if (!value.trim()) return;
    props.onChange(value.trim());
    setValue("");
    setExpanded(false);
  };
  const clear = (): void => {
    props.onChange("");
    setValue("");
  };

  if (!expanded && !hasOverride) {
    return (
      <div className="onboarding-wizard__profile-row-xai is-collapsed">
        <button
          type="button"
          className="onboarding-wizard__btn onboarding-wizard__btn--link"
          onClick={() => setExpanded(true)}
        >
          {hasGlobal
            ? "Override xAI key for this profile"
            : "+ Add xAI key (optional)"}
        </button>
        {hasGlobal ? (
          <span className="onboarding-wizard__profile-row-xai-hint">
            Uses global xAI key
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="onboarding-wizard__profile-row-xai">
      <input
        type="password"
        className="onboarding-wizard__input"
        placeholder={
          hasOverride
            ? "Replace stored override (already set)"
            : hasGlobal
              ? "Override global xAI key"
              : "xai-…"
        }
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save();
          }
        }}
      />
      <button
        type="button"
        className="onboarding-wizard__btn onboarding-wizard__btn--ghost"
        disabled={!value.trim()}
        onClick={save}
      >
        {hasOverride ? "Replace" : "Use this"}
      </button>
      {hasOverride ? (
        <button
          type="button"
          className="onboarding-wizard__btn onboarding-wizard__btn--link"
          onClick={clear}
        >
          Clear override
        </button>
      ) : null}
      <button
        type="button"
        className="onboarding-wizard__btn onboarding-wizard__btn--link"
        onClick={() => {
          setExpanded(false);
          setValue("");
        }}
      >
        Cancel
      </button>
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
            <p>
              Add the bot to a supergroup or forum that contains only you and
              it, then send the pairing message inside any topic. Threads will
              land in that topic. Best for keeping the bot conversation in its
              own room separate from your DMs.
            </p>
            <p className="onboarding-wizard__pairing-warning">
              <strong>⚠ Telegram bot privacy:</strong> by default BotFather
              ships new bots with <em>privacy mode on</em>, which means the
              bot can&rsquo;t see plain messages in groups — only commands,
              @mentions, and replies. If your pairing message never gets a
              reply from the bot, you need to do <strong>one</strong> of:
            </p>
            <ul className="onboarding-wizard__pairing-warning-list">
              <li>
                <strong>@mention the bot</strong> in your pair message — e.g.{" "}
                <code>@yourbot pair &lt;token&gt;</code>. You&rsquo;ll need to
                @mention it on every message you want the bot to see.
              </li>
              <li>
                <strong>Make the bot an admin</strong> in the group. Admins
                always see all messages regardless of privacy mode.
              </li>
              <li>
                <strong>Turn privacy mode off</strong> in BotFather:{" "}
                <code>/mybots</code> → pick your bot → Bot Settings → Group
                Privacy → Turn off. The bot then sees every message in groups
                it&rsquo;s a member of.
              </li>
            </ul>
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
  bufferedSecrets: Record<string, string>;
  onBufferSecret: (name: string, value: string) => void;
  /**
   * In Multiple / Isolated modes, the profile name that will receive
   * this messaging config at Finish. Surfaced as an eyebrow on the
   * step header so the operator knows which profile they're
   * pasting tokens for — important when the operator has two or
   * more bot tokens in their head ("personal Telegram on this one,
   * work Telegram on the other"). `undefined` in Shared mode.
   */
  targetProfileName?: string;
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
        {props.targetProfileName ? (
          <span className="onboarding-wizard__provider-setup-eyebrow">
            For profile <code>{props.targetProfileName}</code>
          </span>
        ) : null}
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
            bufferedSecrets={props.bufferedSecrets}
            onBufferSecret={props.onBufferSecret}
            writeConfig={props.settings.writeConfig}
            replaceSecret={props.settings.replaceSecret}
            clearSecret={props.settings.clearSecret}
          />
        ))}
      </div>
      <ProviderIdentityProbe
        provider={props.provider}
        snapshot={snapshot}
        desktopApi={props.desktopApi}
      />
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
  bufferedSecrets: Record<string, string>;
  onBufferSecret: (name: string, value: string) => void;
  writeConfig: (patch: DesktopSettingsConfigPatch) => Promise<boolean>;
  replaceSecret: (
    secret: DesktopSettingsSecretName,
    value: string,
  ) => Promise<boolean>;
  clearSecret: (secret: DesktopSettingsSecretName) => Promise<boolean>;
}) {
  if (props.field.kind === "secret") {
    // Capture the narrowed name into a local so the closure passed
    // to `onBuffer` keeps type info when re-rendered. Without this
    // step, TS widens `props.field` back to the union.
    const secretName = props.field.name;
    return (
      <SecretFieldRow
        field={props.field}
        snapshot={props.snapshot}
        bufferedValue={props.bufferedSecrets[secretName] ?? ""}
        onBuffer={(value) => props.onBufferSecret(secretName, value)}
        replaceSecret={props.replaceSecret}
        clearSecret={props.clearSecret}
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

/**
 * Probe the provider's credentials and surface the bot identity
 * inline (e.g. "Connected as @pwragent_bot · api.telegram.org") so
 * the operator immediately sees the token landed on the right bot
 * account. Mirrors the Settings → Messaging "test connection"
 * affordance, but runs *automatically* once the underlying secret
 * is configured — the wizard's step is already a setup moment, so
 * the operator shouldn't need a separate Test click.
 *
 * Probe trigger: re-runs whenever the snapshot's primary-secret
 * `configured` flips from false → true, or the snapshot's
 * fetchedAt advances after a live secret replace. Failure surfaces
 * a short error line; the snapshot's "✓ saved" pill on the field
 * row still indicates the token *was* persisted.
 */
function ProviderIdentityProbe(props: {
  provider: OnboardingProvider;
  snapshot?: DesktopSettingsSnapshot;
  desktopApi?: DesktopApi;
}) {
  const [result, setResult] = useState<SettingsCredentialTestResult | undefined>(
    undefined,
  );
  const [running, setRunning] = useState(false);
  const configured = isPlatformPrimarySecretConfigured(props.provider, props.snapshot);
  const desktopApi = props.desktopApi;
  const probeKind: SettingsCredentialTestKind = props.provider;

  useEffect(() => {
    if (!configured || !desktopApi?.testSettingsCredentials) {
      // Nothing to probe — clear stale result when the secret is
      // unconfigured (e.g. operator pressed Clear).
      setResult(undefined);
      return;
    }
    let cancelled = false;
    setRunning(true);
    void desktopApi
      .testSettingsCredentials({ kind: probeKind })
      .then((next) => {
        if (!cancelled) setResult(next);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setResult({
          kind: probeKind,
          status: "failed",
          testedAt: Date.now(),
          durationMs: 0,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (!cancelled) setRunning(false);
      });
    return () => {
      cancelled = true;
    };
  }, [configured, desktopApi, probeKind]);

  if (!configured && !running && !result) return null;

  const status = running ? "testing" : (result?.status ?? "idle");
  return (
    <div
      className="onboarding-wizard__provider-identity"
      data-status={status}
      aria-live="polite"
    >
      {running ? (
        <span className="onboarding-wizard__provider-identity-text">
          Checking the bot account…
        </span>
      ) : result?.status === "ok" ? (
        <span className="onboarding-wizard__provider-identity-text">
          <span className="onboarding-wizard__provider-identity-pill is-ok">
            ✓ Connected
          </span>
          {result.account ? (
            <strong className="onboarding-wizard__provider-identity-account">
              {result.account}
            </strong>
          ) : null}
          {result.detail ? (
            <span className="onboarding-wizard__provider-identity-detail">
              {result.detail}
            </span>
          ) : null}
        </span>
      ) : result?.status === "failed" ? (
        <span className="onboarding-wizard__provider-identity-text">
          <span className="onboarding-wizard__provider-identity-pill is-err">
            ✕ Could not reach the bot
          </span>
          {result.errorMessage ? (
            <span className="onboarding-wizard__provider-identity-detail">
              {result.errorMessage}
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Read the configured state of a platform's *primary* identity-bearing
 * secret. Used by `ProviderIdentityProbe` to know when to run the
 * `testSettingsCredentials` probe. Each platform's identity-revealing
 * probe needs its own primary secret to be set — Telegram needs the
 * bot token, Slack needs both bot + signing secret, etc. We pick the
 * single most-load-bearing one per platform and call that the trigger.
 *
 * (We don't try to gate on EVERY secret being present — that would
 * silently hide the probe for multi-field providers like Slack until
 * all 3 are entered. Better to attempt the probe once the primary
 * token is present; the probe surfaces its own "missing X" message
 * for the rest.)
 */
function isPlatformPrimarySecretConfigured(
  provider: OnboardingProvider,
  snapshot?: DesktopSettingsSnapshot,
): boolean {
  if (!snapshot) return false;
  switch (provider) {
    case "telegram":
      return snapshot.messaging?.telegram?.botToken?.configured === true;
    case "discord":
      return snapshot.messaging?.discord?.botToken?.configured === true;
    case "mattermost":
      return snapshot.messaging?.mattermost?.botToken?.configured === true;
    case "slack":
      return snapshot.messaging?.slack?.botToken?.configured === true;
    case "feishu":
      return snapshot.messaging?.feishu?.appSecret?.configured === true;
    case "line":
      return snapshot.messaging?.line?.channelAccessToken?.configured === true;
  }
}

/**
 * Exported for unit tests in `__tests__/secret-field-row.test.tsx`.
 * Not intended to be imported from outside the onboarding feature.
 */
export function SecretFieldRow(props: {
  field: Extract<ProviderField, { kind: "secret" }>;
  snapshot?: DesktopSettingsSnapshot;
  /** Currently-buffered value (held in wizard state, encrypted +
   *  written to the chosen profile's keychain at Finish). */
  bufferedValue: string;
  onBuffer: (value: string) => void;
  /** Live-write a secret to the *current* profile's keychain (in
   *  bootstrap mode that's `.bootstrap`; otherwise the active
   *  profile). Used for messaging-runtime secrets so the runtime
   *  can actually start mid-wizard and the operator can complete
   *  pairing without leaving the wizard. The buffer still tracks
   *  the value too — at graduation `writeBufferedSecretsIfAny`
   *  copies it onto the target profile. */
  replaceSecret: (
    secret: DesktopSettingsSecretName,
    value: string,
  ) => Promise<boolean>;
  clearSecret: (secret: DesktopSettingsSecretName) => Promise<boolean>;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [liveError, setLiveError] = useState<string | undefined>(undefined);
  const state = readSecretState(props.snapshot, props.field.name);
  const configured = state?.configured ?? false;
  const buffered = props.bufferedValue.length > 0;
  const isRuntimeSecret = isMessagingRuntimeSecret(props.field.name);

  const save = async (): Promise<void> => {
    if (!value || busy) return;
    setLiveError(undefined);
    // Always buffer first — graduation reads from the buffer when
    // copying secrets onto the target profile.
    props.onBuffer(value);
    if (isRuntimeSecret) {
      // Messaging-runtime secrets must also land in the *current*
      // profile's keychain *now* so the runtime can start and the
      // operator's pairing message gets observed. In bootstrap mode
      // this writes to `.bootstrap/state.db`, which is fine — the
      // throwaway profile is torn down on graduation, and we
      // re-write the value onto the target profile from the buffer.
      setBusy(true);
      try {
        const ok = await props.replaceSecret(props.field.name, value);
        if (!ok) {
          setLiveError("Could not enable this provider — try again.");
          return;
        }
      } finally {
        setBusy(false);
      }
    }
    setValue("");
  };
  const clear = async (): Promise<void> => {
    if (busy) return;
    props.onBuffer("");
    if (isRuntimeSecret && configured) {
      setBusy(true);
      setLiveError(undefined);
      try {
        await props.clearSecret(props.field.name);
      } finally {
        setBusy(false);
      }
    }
  };
  return (
    <div className="onboarding-wizard__field">
      <div className="onboarding-wizard__field-head">
        <span className="onboarding-wizard__field-label">{props.field.label}</span>
        <span className="onboarding-wizard__field-status">
          {buffered ? (
            <span className="onboarding-wizard__field-pill is-ok">✓ Ready</span>
          ) : configured ? (
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
          placeholder={
            buffered
              ? "Replace the buffered value"
              : configured
                ? "Replace stored value"
                : props.field.placeholder
          }
          value={value}
          disabled={busy}
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
          disabled={!value || busy}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : buffered || configured ? "Replace" : "Use this"}
        </button>
        {buffered || (isRuntimeSecret && configured) ? (
          <button
            type="button"
            className="onboarding-wizard__btn onboarding-wizard__btn--link"
            disabled={busy}
            onClick={() => void clear()}
          >
            Clear
          </button>
        ) : null}
      </div>
      {liveError ? (
        <span className="onboarding-wizard__field-error">{liveError}</span>
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

/**
 * A pairing the operator approved during *this* wizard session.
 * Used to render a compact "you paired X, Y, Z" summary after the
 * pairing flow completes, so the operator can see what they've
 * authorized without leaving the step. Multiple entries accumulate
 * when the operator clicks "Pair another" — Telegram in particular
 * commonly wants both a DM pairing and one or more supergroup
 * pairings on the same bot.
 *
 * `actor`/`chat` are display labels resolved from the
 * pairing-changed event's `observedActor` / `observedChat` (handle
 * / displayName falling back to id). Kept as plain strings here
 * because this list is purely cosmetic — the authoritative source
 * is the per-platform `authorizedUserIds` / `authorizedSupergroups`
 * snapshot, which the new spawned profile's main window will
 * pick up after graduation.
 */
type SessionPairing = {
  entryId: string;
  scope: MessagingPairingScope;
  actor?: string;
  chat?: string;
};

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
  // Captured display info for the observed actor/chat — used to render
  // the inline "Approve @huntharo …" affordance and to seed the
  // session pairing list on approval.
  const [observedActorLabel, setObservedActorLabel] = useState<string | undefined>(
    undefined,
  );
  const [observedChatLabel, setObservedChatLabel] = useState<string | undefined>(
    undefined,
  );
  const [approving, setApproving] = useState(false);
  // Pairings approved during this wizard session, in order. Rendered
  // as a compact summary once at least one pairing has been approved.
  // Survives the "Pair another" reset (which only clears the *current*
  // in-flight token, not the running list).
  const [paired, setPaired] = useState<readonly SessionPairing[]>([]);
  // Set by "+ Pair another" — re-arms the active flow (Generate code
  // button, scope picker) without clearing the `paired` summary above.
  // Cleared on approval so the next approval falls back into compact
  // mode unless the operator re-clicks "Pair another".
  const [pairingAnother, setPairingAnother] = useState(false);
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
        setObservedActorLabel(
          event.entry.observedActor?.displayName
            ?? event.entry.observedActor?.id,
        );
        setObservedChatLabel(
          event.entry.observedChat?.title ?? event.entry.observedChat?.id,
        );
      }
    });
  }, [props.desktopApi, props.platform]);

  const approve = async (): Promise<void> => {
    const id = entryIdRef.current;
    if (!id || approving || !props.desktopApi?.approveMessagingPairing) return;
    setApproving(true);
    setError(undefined);
    try {
      await props.desktopApi.approveMessagingPairing({ entryId: id });
      setResolution("approved");
      setPaired((prev) => [
        ...prev,
        {
          entryId: id,
          scope,
          actor: observedActorLabel,
          chat: observedChatLabel,
        },
      ]);
      // Clear the pairing-token surface — the approved entry is now
      // captured in `paired`. The "Pair another" button (rendered
      // below when `paired.length > 0`) re-arms the flow.
      setMessage(undefined);
      setEntryId(undefined);
      setObservedActorLabel(undefined);
      setObservedChatLabel(undefined);
      setResolution(undefined);
      setPairingAnother(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setApproving(false);
    }
  };

  const pairAnother = (): void => {
    // Re-arm the active-flow surface (Generate-code button, scope
    // picker) so the operator can issue another pairing token.
    // Keeps the `paired` list intact above the surface so the
    // previously-approved entities stay visible.
    setMessage(undefined);
    setEntryId(undefined);
    setResolution(undefined);
    setObservedActorLabel(undefined);
    setObservedChatLabel(undefined);
    setError(undefined);
    setPairingAnother(true);
  };

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

  // Active-flow gate: when the operator hasn't approved anything
  // yet (or has clicked "+ Pair another"), render the full
  // token-generate / approve UI. After the first approval we
  // collapse to the compact "paired list + Pair another" layout —
  // surfacing exactly what the operator has authorized rather than
  // leaving the stale pairing code on screen.
  //
  // Note: an in-flight `message` or `resolution === "observed"`
  // also force active mode — this handles the rare case where a
  // pairing-changed event arrives *after* approval has already
  // cleared the surface (we want to react, not get stuck).
  const isActiveFlow =
    paired.length === 0
    || pairingAnother
    || message !== undefined
    || resolution === "observed";

  return (
    <div className="onboarding-wizard__pairing">
      <div className="onboarding-wizard__pairing-head">
        <span className="onboarding-wizard__field-label">{props.title}</span>
        <span className="onboarding-wizard__field-status">
          {paired.length > 0 && !isActiveFlow ? (
            <span className="onboarding-wizard__field-pill is-ok">
              ✓ paired ({paired.length})
            </span>
          ) : resolution === "approved" ? (
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
      {paired.length > 0 ? (
        <ul className="onboarding-wizard__paired-list">
          {paired.map((entry) => (
            <li
              key={entry.entryId}
              className="onboarding-wizard__paired-row"
            >
              <span className="onboarding-wizard__paired-scope">
                {labelForPairingScope(props.platform, entry.scope)}
              </span>
              <span className="onboarding-wizard__paired-actor">
                {entry.chat && entry.chat !== entry.actor
                  ? entry.chat
                  : entry.actor ?? "(no display name reported)"}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {isActiveFlow ? (
        <>
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
            // `div`, not `<p>`: help content for some scopes contains
            // its own `<p>` / `<ul>` blocks (e.g. Telegram bucket
            // scope surfaces a bot-privacy gotcha with bullets). Nested
            // `<p>` would be invalid HTML and React would silently
            // hoist children out, breaking the styling.
            <div className="onboarding-wizard__field-sub">{activeOption.help}</div>
          ) : null}
          {message && resolution !== "observed" ? (
            // Pairing tokens are one-time-use; once the bot has
            // reported the message landed we hide the code (the
            // operator already sent it, displaying it longer just
            // invites a confusing second paste). Below this block
            // the Approve banner takes over.
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
          ) : !message ? (
            <button
              type="button"
              className="onboarding-wizard__btn onboarding-wizard__btn--ghost"
              disabled={busy || !props.desktopApi?.generateMessagingPairingToken}
              onClick={() => void generate()}
            >
              {busy ? "Generating…" : "Generate pairing code"}
            </button>
          ) : null}
          {resolution === "observed" ? (
            // The bot has reported the pairing message — surface an
            // inline Approve so the operator can finish the pairing
            // without navigating to Settings → Messaging Activity.
            <div className="onboarding-wizard__pairing-approve">
              <div className="onboarding-wizard__pairing-approve-text">
                <span>
                  Message received from{" "}
                  <strong>{observedActorLabel ?? "this contact"}</strong>
                  {observedChatLabel && observedChatLabel !== observedActorLabel ? (
                    <>
                      {" in "}
                      <strong>{observedChatLabel}</strong>
                    </>
                  ) : null}
                  . Approve to finish pairing.
                </span>
              </div>
              <button
                type="button"
                className="onboarding-wizard__btn onboarding-wizard__btn--primary"
                disabled={approving || !props.desktopApi?.approveMessagingPairing}
                onClick={() => void approve()}
              >
                {approving ? "Approving…" : "Approve"}
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <button
          type="button"
          className="onboarding-wizard__btn onboarding-wizard__btn--link"
          onClick={pairAnother}
        >
          + Pair another
        </button>
      )}
      {error ? (
        <span className="onboarding-wizard__field-error">{error}</span>
      ) : null}
    </div>
  );
}

/**
 * Human label for a pairing scope, scoped by the onboarding-known
 * platforms so we say "DM" / "Supergroup" for Telegram, "DM" /
 * "Guild" for Discord, etc. Falls back to a generic "Group" /
 * "Conversation" label for any platform the wizard doesn't render
 * a setup step for (currently none — the union is wider than the
 * wizard's surface area to leave room for future providers).
 */
function labelForPairingScope(
  platform: MessagingChannelKind,
  scope: MessagingPairingScope,
): string {
  if (scope === "user_dm") return "DM";
  switch (platform) {
    case "telegram":
      return "Supergroup";
    case "discord":
      return "Guild";
    case "slack":
      return "Workspace";
    case "mattermost":
      return "Channel";
    case "feishu":
    case "line":
      return "Group";
    default:
      return "Conversation";
  }
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
