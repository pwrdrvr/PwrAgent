import { useCallback, useState } from "react";
import type { DesktopApi } from "../../../lib/desktop-api";
import type { PwrAgentProfilesState } from "../../../lib/usePwrAgentProfiles";
import { newProfileNamesToCreate } from "./codex-profile-names";
import {
  CodexProfileChoiceStep,
  CodexProfilesPreviewList,
  NameCodexProfilesStep,
  type CodexProfilesAuthSnapshot,
  type CodexProfilesMode,
} from "./CodexProfileSteps";
import {
  GuidedFooterBack,
  GuidedFooterHint,
  GuidedFooterSpacer,
  GuidedSetupFrame,
} from "./GuidedSetupFrame";
import { openCreatedProfile, type ProfileHandoffOutcome } from "./profile-handoff";
import { provisionPairedProfiles } from "./provisionPairedProfiles";
import { ReviewSummary } from "./ReviewSummary";

type CodexProfilesStep = "choose" | "names" | "create" | "created";
const STEP_ORDER: readonly CodexProfilesStep[] = [
  "choose",
  "names",
  "create",
  "created",
];

/**
 * Guided Codex profile setup: one or several new PwrAgent profiles, each
 * paired with a Codex auth profile of the same name. Profiles are created
 * the way first-run setup creates them (`provisionPairedProfiles`), and
 * "Open" uses the same relaunch handoff (`openCreatedProfile`).
 */
export function CodexProfilesFlow(props: {
  desktopApi?: DesktopApi;
  profiles?: PwrAgentProfilesState;
  onClose: () => void;
}) {
  const [step, setStep] = useState<CodexProfilesStep>("choose");
  const [mode, setMode] = useState<CodexProfilesMode>("isolated");
  const [names, setNames] = useState<string[]>(["work"]);
  const [auth, setAuth] = useState<CodexProfilesAuthSnapshot>({
    allAuthed: false,
    namedRows: 0,
  });
  const [loginDeferred, setLoginDeferred] = useState(false);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string[]>([]);
  const [handoff, setHandoff] = useState<ProfileHandoffOutcome>();

  const existing = (props.profiles?.profiles ?? []).map((profile) => profile.name);
  const toCreate = newProfileNamesToCreate(names, existing);
  const failed = toCreate?.filter((name) => !created.includes(name)) ?? [];

  const changeMode = (next: CodexProfilesMode): void => {
    setMode(next);
    setNames((current) => {
      if (next === "isolated") {
        return current[0]?.trim() ? [current[0]] : ["work"];
      }
      if (current.length >= 2) return current;
      const first = current[0]?.trim();
      return first && first !== "personal" ? [first, "personal"] : ["work", "personal"];
    });
  };

  const create = async (): Promise<void> => {
    if (busy || !toCreate) return;
    setBusy(true);
    try {
      const done = await provisionPairedProfiles(props.desktopApi, toCreate);
      setCreated(done);
      await props.profiles?.refresh();
      setStep("created");
    } finally {
      setBusy(false);
    }
  };

  const open = useCallback(
    async (profile: string): Promise<void> => {
      if (busy) return;
      setBusy(true);
      try {
        const bootInfo = await props.desktopApi?.getBootInfo?.().catch(() => undefined);
        // Graduation is a no-op outside bootstrap mode; first-run setup
        // calls it unconditionally and so does this.
        if (props.desktopApi?.graduateBootstrapConfigToProfile) {
          try {
            await props.desktopApi.graduateBootstrapConfigToProfile({
              targetProfile: profile,
            });
          } catch (caught) {
            console.warn(
              `Guided setup: graduateBootstrapConfigToProfile failed for "${profile}"`,
              caught,
            );
          }
        }
        setHandoff(
          await openCreatedProfile({
            api: props.desktopApi,
            profile,
            bootMode: bootInfo?.mode,
            isDev: import.meta.env.DEV,
          }),
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, props.desktopApi],
  );

  const index = STEP_ORDER.indexOf(step);
  const steps = [
    { label: index > 0 ? (mode === "isolated" ? "One profile" : "Several") : "Choose" },
    { label: "Name and log in" },
    { label: "Create" },
    { label: "Done" },
  ];

  let hint: string | undefined;
  if (step === "names") {
    if (!toCreate) {
      hint = mode === "isolated"
        ? "Lowercase letters, digits, _ , -."
        : "1–5 unique lowercase names (letters, digits, _ , -)";
    } else if (auth.allAuthed) {
      hint = mode === "isolated" ? "Logged in" : "All profiles logged in";
    } else if (loginDeferred) {
      hint = "Logins deferred — finish from Settings → Profiles later";
    } else {
      hint = mode === "isolated" ? "Log in to continue" : "Log in to each profile to continue";
    }
  }

  let footer;
  if (step === "choose") {
    footer = (
      <>
        <GuidedFooterSpacer />
        <GuidedFooterHint>
          {mode === "isolated" ? "One profile selected" : "Several selected"}
        </GuidedFooterHint>
        <button
          type="button"
          className="guided-setup__btn guided-setup__btn--primary"
          onClick={() => setStep("names")}
        >
          Continue →
        </button>
      </>
    );
  } else if (step === "names") {
    const authGateLifted = auth.allAuthed || loginDeferred;
    footer = (
      <>
        <GuidedFooterBack onBack={() => setStep("choose")} />
        <GuidedFooterSpacer />
        {!loginDeferred && !auth.allAuthed && auth.namedRows > 0 ? (
          <button
            type="button"
            className="guided-setup__btn guided-setup__btn--microlink"
            onClick={() => setLoginDeferred(true)}
          >
            I&rsquo;ll log in later
          </button>
        ) : null}
        {hint ? <GuidedFooterHint>{hint}</GuidedFooterHint> : null}
        <button
          type="button"
          className="guided-setup__btn guided-setup__btn--primary"
          disabled={!toCreate || !authGateLifted}
          onClick={() => setStep("create")}
        >
          Continue →
        </button>
      </>
    );
  } else if (step === "create") {
    footer = (
      <>
        <GuidedFooterBack onBack={() => setStep("names")} disabled={busy} />
        <GuidedFooterSpacer />
        <button
          type="button"
          className="guided-setup__btn guided-setup__btn--primary"
          disabled={busy || !toCreate}
          onClick={() => void create()}
        >
          {busy
            ? "Creating…"
            : toCreate && toCreate.length > 1
              ? `Create ${toCreate.length} profiles`
              : "Create profile"}
        </button>
      </>
    );
  } else {
    const first = created[0];
    footer = (
      <>
        <GuidedFooterSpacer />
        {handoff ? <GuidedFooterHint>{handoffMessage(handoff)}</GuidedFooterHint> : null}
        {first && handoff?.kind !== "opened" ? (
          <button
            type="button"
            className="guided-setup__btn guided-setup__btn--ghost"
            disabled={busy}
            onClick={() => void open(first)}
          >
            {busy ? "Opening…" : `Open ${first}`}
          </button>
        ) : null}
        <button
          type="button"
          className="guided-setup__btn guided-setup__btn--primary"
          disabled={busy}
          onClick={props.onClose}
        >
          Done
        </button>
      </>
    );
  }

  return (
    <GuidedSetupFrame
      title="Add a Codex profile"
      crumb="Profiles — Add a Codex profile"
      steps={steps}
      currentIndex={index}
      busy={busy}
      onClose={props.onClose}
      footer={footer}
      stepKey={step}
    >
      {step === "choose" ? (
        <CodexProfileChoiceStep value={mode} onChange={changeMode} />
      ) : null}
      {step === "names" ? (
        <NameCodexProfilesStep
          mode={mode}
          names={names}
          onChange={setNames}
          existingProfiles={existing}
          desktopApi={props.desktopApi}
          onAuthStateChange={setAuth}
        />
      ) : null}
      {step === "create" && toCreate ? (
        <div>
          <header className="guided-setup__head">
            <h1 className="guided-setup__title">
              {toCreate.length > 1 ? "Create these profiles" : "Create this profile"}
            </h1>
            <p className="guided-setup__sub">
              Each PwrAgent profile pairs with the Codex login of the same
              name. This profile and its Codex login stay as they are.
              {auth.allAuthed
                ? ""
                : " Profiles you didn’t log in to can sign in later from Settings → Profiles."}
            </p>
          </header>
          <CodexProfilesPreviewList names={toCreate} />
        </div>
      ) : null}
      {step === "created" ? (
        <ReviewSummary
          title={
            created.length === 0
              ? "No profiles were created"
              : created.length === 1
                ? `Created ${created[0]}`
                : `Created ${created.length} profiles`
          }
          sub={
            failed.length > 0
              ? `Could not create ${failed.join(", ")}. Try again from Settings → Profiles.`
              : "Open a profile now, or later from the Profiles menu."
          }
          rows={(toCreate ?? []).map((name) => ({
            key: name,
            label: name,
            value: created.includes(name)
              ? `Paired with Codex login ${name}`
              : "Not created",
          }))}
        />
      ) : null}
    </GuidedSetupFrame>
  );
}

function handoffMessage(outcome: ProfileHandoffOutcome): string {
  switch (outcome.kind) {
    case "opened":
    case "handed-off":
      return "Opened in a new window";
    case "kept-bootstrap":
      return "The new window didn’t start in time; this one stays open";
    case "open-failed":
      return "Could not open it. Use the Profiles menu.";
    case "unavailable":
      return "Open it from the Profiles menu";
    case "dev-quit":
      return "Relaunch to open it";
  }
}
