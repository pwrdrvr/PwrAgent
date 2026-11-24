import { useState } from "react";
import type {
  DesktopSettingsConfigPatch,
  DesktopSettingsSecretName,
  DesktopSettingsSecretState,
  DesktopSettingsSnapshot,
} from "@pwragent/shared/contracts/settings";
import {
  MATHOS_API_KEY,
  MATHOS_PLATFORM_DEFAULT_ORIGIN,
  normalizeMathosPlatformOrigin,
  normalizeResearchHarnessConfig,
  researchHarnessArgsFromLines,
  type MathosTeam,
  type ResearchHarnessCheck,
  type ResearchHarnessSource,
} from "@pwragent/shared/research-harness";
import { Select } from "../../components/Select";
import type { DesktopApi } from "../../lib/desktop-api";
import { SecretField } from "./SecretField";
import { SegmentedField, SettingsField, SettingsSection } from "./SettingsLayout";
import { useUnsavedSettingsChanges } from "./UnsavedSettingsChanges";
import { useSettingsDraft } from "./useSettingsDraft";
import "./research-harness-settings.css";

const UNSET_SECRET: DesktopSettingsSecretState = {
  configured: false,
  source: "unset",
  writable: false,
};

type Capability = keyof Extract<ResearchHarnessCheck, { ok: true }>["capabilities"];
const CAPABILITIES: Array<[Capability, string]> = [
  ["import", "Import"],
  ["discovery", "Discovery"],
  ["execute", "Execute"],
  ["cancel", "Cancel"],
  ["researchFunctions", "Research functions"],
];

const SOURCE_OPTIONS: Array<{ label: string; value: ResearchHarnessSource }> = [
  { label: "MathOS Platform", value: "mathos" },
  { label: "Custom bridge", value: "bridge" },
];

/**
 * What the hosted MathOS Platform offers PwrAgent, from the authenticated
 * compatibility probe in docs/research-harness-adapter.md: facts about the
 * deployed platform, separate from Check connection's live answer.
 */
const PLATFORM_SUPPORT: Array<{ label: string; available: boolean; detail: string }> = [
  { label: "Import swarm records", available: true, detail: "Read-only. No model calls." },
  { label: "Run or stop a swarm", available: false, detail: "The hosted runtime does not offer these operations to PwrAgent." },
  { label: "Discovery snapshots", available: false, detail: "The hosted runtime has no discovery reads. A custom bridge to a development runtime can provide them." },
];

/**
 * Settings › Experimental › Open Math Harness. One explicit-save form chooses
 * where Harness records come from and holds that source's settings: the MathOS
 * Platform team and address, or a custom bridge's `[research.harness]`. The
 * Platform key is a secret row that saves on its own and never comes back.
 */
export function ResearchHarnessSettings(props: {
  desktopApi?: DesktopApi;
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  onWriteConfig: (patch: DesktopSettingsConfigPatch, onError?: (message: string) => void) => Promise<boolean>;
  onClearSecret: (secret: DesktopSettingsSecretName) => Promise<boolean>;
  onReplaceSecret: (secret: DesktopSettingsSecretName, value: string) => Promise<boolean>;
}) {
  const research = props.snapshot.research;
  const saved = research?.harness;
  const savedSource: ResearchHarnessSource = research?.source ?? "mathos";
  const savedArgsText = (saved?.args ?? []).join("\n");
  const draft = useSettingsDraft({
    source: savedSource,
    team: research?.mathos?.team ?? "",
    origin: research?.mathos?.origin ?? "",
    command: saved?.command ?? "",
    args: savedArgsText,
    endpoint: saved?.endpoint ?? "",
    model: saved?.model ?? "",
    apiKeyEnv: saved?.apiKeyEnv ?? "",
  });
  const [error, setError] = useState<{ field?: string; message: string }>();
  const [writing, setWriting] = useState(false);
  const [check, setCheck] = useState<ResearchHarnessCheck>();
  const [checking, setChecking] = useState(false);
  const [teams, setTeams] = useState<MathosTeam[]>();
  const [teamsError, setTeamsError] = useState<string>();
  const [findingTeams, setFindingTeams] = useState(false);
  const values = draft.values;
  const source = values.source as ResearchHarnessSource;
  const platformKey = research?.platformApiKey ?? UNSET_SECRET;
  const savedTeam = research?.mathos?.team;
  const configured = savedSource === "mathos" ? Boolean(savedTeam && platformKey.configured) : Boolean(saved?.command);
  // The owner refuses every Harness request while Research runs are off; say so instead of asking.
  const researchOn = props.snapshot.experimental?.researchEnabled?.value === true;

  const save = async (): Promise<boolean> => {
    let patch: DesktopSettingsConfigPatch;
    if (source === "mathos") {
      const origin = normalizeMathosPlatformOrigin(values.origin);
      if (!origin.ok) {
        setError({ field: "origin", message: origin.error });
        return false;
      }
      if (!values.team) {
        setError({ field: "team", message: "Choose a team." });
        return false;
      }
      patch = { research: { source, mathos: { team: values.team, origin: origin.origin } } };
    } else {
      const normalized = normalizeResearchHarnessConfig({
        command: values.command,
        // The textarea cannot show a blank, padded or multi-line argument. Until
        // it is edited, save the arguments exactly as stored.
        args: saved && values.args === savedArgsText ? saved.args : researchHarnessArgsFromLines(values.args),
        endpoint: values.endpoint,
        model: values.model,
        apiKeyEnv: values.apiKeyEnv,
      });
      if (!normalized.ok) {
        setError({ field: normalized.field, message: normalized.error });
        return false;
      }
      patch = { research: { source, harness: normalized.value } };
    }
    setWriting(true);
    setError(undefined);
    try {
      const ok = await props.onWriteConfig(patch, (message) => setError({ message }));
      if (ok) {
        // What is stored can differ from what was typed (blank lines, the default address).
        draft.discard();
        setCheck(undefined);
      }
      return ok;
    } finally {
      setWriting(false);
    }
  };

  const removeBridge = async () => {
    setWriting(true);
    setError(undefined);
    try {
      if (await props.onWriteConfig({ research: { harness: null } }, (message) => setError({ message }))) {
        draft.discard("command", "args", "endpoint", "model", "apiKeyEnv");
        setCheck(undefined);
      }
    } finally {
      setWriting(false);
    }
  };

  const discard = () => {
    draft.discard();
    setError(undefined);
  };

  useUnsavedSettingsChanges(draft.dirty ? { label: "Open Math Harness", save, discard } : undefined);

  const choose = async () => {
    const picked = await props.desktopApi?.pickResearchHarnessBridge?.();
    if (picked?.path) draft.set("command", picked.path);
  };

  const findTeams = async () => {
    if (!props.desktopApi?.listMathosTeams) return;
    setFindingTeams(true);
    setTeamsError(undefined);
    try {
      const result = await props.desktopApi.listMathosTeams();
      if (!result.ok) {
        setTeamsError(result.error);
        return;
      }
      setTeams(result.teams);
      if (result.teams.length === 0) setTeamsError("This key belongs to no team.");
      // One team: that is the choice.
      else if (!values.team && result.teams.length === 1) draft.set("team", result.teams[0]!.id);
    } catch (failure) {
      setTeamsError(ownerMessage(failure, "Could not list your MathOS teams."));
    } finally {
      setFindingTeams(false);
    }
  };

  const runCheck = async () => {
    if (!props.desktopApi?.checkResearchHarnessBridge) return;
    setChecking(true);
    try {
      setCheck(await props.desktopApi.checkResearchHarnessBridge());
    } catch (failure) {
      setCheck({ ok: false, checkedAt: Date.now(), error: ownerMessage(failure, "The check failed") });
    } finally {
      setChecking(false);
    }
  };

  const disabled = props.saving || writing;
  const fieldError = (field: string) => (error?.field === field ? error.message : undefined);
  const checkTarget = savedSource === "mathos" ? "MathOS Platform" : saved?.command ? fileName(saved.command) : undefined;
  const teamOptions = teamChoices(teams, values.team);
  const savedOrigin = normalizeMathosPlatformOrigin(research?.mathos?.origin);

  return (
    <SettingsSection
      eyebrow="Experimental · Research"
      title="Open Math Harness"
      sectionId="open-math-harness"
      description="Import swarm records from Open Math Harness into a Research run, straight from the MathOS Platform or through a bridge program you install."
      chip={configured ? savedSource === "mathos" ? "MathOS Platform" : "Custom bridge" : "Not set up"}
      chipKind={configured ? "ok" : "default"}
    >
      <div className="settings-fields">
        <SegmentedField
          label="Connect with"
          sub="Where Research runs read Harness records from."
          disabled={disabled}
          options={SOURCE_OPTIONS}
          value={source}
          onChange={async (next) => {
            draft.set("source", next);
            setError(undefined);
          }}
        />
        {source === "mathos" ? (
          <>
            <SecretField
              label="MathOS Platform API key"
              sub="Stored encrypted on this machine. PwrAgent signs in to the platform with it."
              help="Never written to config.toml, shown again, or given to an agent, a model or another program. Saves on its own."
              secret="mathosPlatformApiKey"
              state={platformKey}
              validate={(value) => (MATHOS_API_KEY.test(value) ? undefined : "That is not a MathOS Platform API key: it has spaces or characters a key cannot hold.")}
              disabled={props.saving || !platformKey.writable}
              onClearSecret={props.onClearSecret}
              onReplaceSecret={props.onReplaceSecret}
            />
            <SettingsField
              label="Team"
              sub="The team whose MathOS VM holds the swarms."
              error={fieldError("team") ?? teamsError}
              control={
                <div className="settings-harness-path">
                  <Select
                    className="settings-input select-trigger"
                    aria-label="Team"
                    value={values.team}
                    options={teamOptions}
                    placeholder="Find your teams first"
                    disabled={disabled || teamOptions.length === 0}
                    onChange={(team) => draft.set("team", team)}
                  />
                  {props.desktopApi?.listMathosTeams ? (
                    <button
                      type="button"
                      className="button button--secondary"
                      disabled={disabled || findingTeams || !platformKey.configured}
                      onClick={() => void findTeams()}
                    >
                      {findingTeams ? "Finding…" : "Find teams"}
                    </button>
                  ) : null}
                </div>
              }
              help={platformKey.configured ? undefined : "Store the API key, then find your teams."}
            />
            <SettingsField
              label="Platform address"
              sub="Leave blank for the hosted MathOS Platform."
              error={fieldError("origin")}
              control={
                <input
                  className="settings-input"
                  aria-label="Platform address"
                  value={values.origin}
                  placeholder={MATHOS_PLATFORM_DEFAULT_ORIGIN}
                  spellCheck={false}
                  disabled={disabled}
                  onChange={(event) => draft.set("origin", event.target.value)}
                />
              }
              help={values.origin !== (research?.mathos?.origin ?? "") ? "Save the address before finding teams on it." : undefined}
            />
          </>
        ) : (
          <>
            <SettingsField
              label="Bridge program"
              sub="Full path to the installed bridge."
              error={fieldError("command")}
              control={
                <div className="settings-harness-path">
                  <input
                    className="settings-input"
                    aria-label="Bridge program"
                    value={values.command}
                    placeholder="/path/to/harness-bridge"
                    spellCheck={false}
                    disabled={disabled}
                    onChange={(event) => draft.set("command", event.target.value)}
                  />
                  {props.desktopApi?.pickResearchHarnessBridge ? (
                    <button type="button" className="button button--secondary" disabled={disabled} onClick={() => void choose()}>
                      Choose…
                    </button>
                  ) : null}
                </div>
              }
            />
            <SettingsField
              label="Arguments"
              sub="One per line, passed as written. No shell."
              error={fieldError("args")}
              control={
                <textarea
                  className="settings-input settings-harness-args"
                  aria-label="Bridge arguments"
                  rows={3}
                  value={values.args}
                  spellCheck={false}
                  disabled={disabled}
                  onChange={(event) => draft.set("args", event.target.value)}
                />
              }
            />
            <SettingsField
              label="Model endpoint"
              sub="Chat Completions URL. Only Run a new swarm uses it."
              error={fieldError("endpoint")}
              control={
                <input
                  className="settings-input"
                  aria-label="Model endpoint"
                  value={values.endpoint}
                  placeholder="https://…/v1/chat/completions"
                  spellCheck={false}
                  disabled={disabled}
                  onChange={(event) => draft.set("endpoint", event.target.value)}
                />
              }
            />
            <SettingsField
              label="Model"
              sub="The model PwrAgent calls for the bridge."
              error={fieldError("model")}
              control={
                <input
                  className="settings-input"
                  aria-label="Model"
                  value={values.model}
                  spellCheck={false}
                  disabled={disabled}
                  onChange={(event) => draft.set("model", event.target.value)}
                />
              }
            />
            <SettingsField
              label="Model key variable"
              sub="Environment variable holding the model key. This is not your MathOS Platform key."
              help="PwrAgent reads it for its own model calls and never passes it to the bridge. A MathOS model provider under AI Providers keeps its own key."
              error={fieldError("apiKeyEnv")}
              control={
                <input
                  className="settings-input"
                  aria-label="Model key variable"
                  value={values.apiKeyEnv}
                  placeholder="MY_MODEL_KEY"
                  spellCheck={false}
                  disabled={disabled}
                  onChange={(event) => draft.set("apiKeyEnv", event.target.value)}
                />
              }
              actions={saved?.apiKeyEnv && values.apiKeyEnv === saved.apiKeyEnv ? (
                <span className={`settings-harness-status${research?.modelKeyEnvSet ? "" : " settings-field__value--warn"}`}>
                  {saved.apiKeyEnv} {research?.modelKeyEnvSet ? "is set" : "is not set in PwrAgent’s environment"}
                </span>
              ) : undefined}
            />
          </>
        )}
        <div className="settings-button-row">
          <button type="button" className="button button--primary" disabled={disabled || !draft.dirty} onClick={() => void save()}>
            Save
          </button>
          {draft.dirty ? (
            <button type="button" className="button button--ghost" disabled={disabled} onClick={discard}>
              Discard
            </button>
          ) : null}
          {source === "bridge" && saved?.command ? (
            <button type="button" className="button button--ghost" disabled={disabled} onClick={() => void removeBridge()}>
              Remove bridge
            </button>
          ) : null}
        </div>
        {error && !error.field ? <p className="settings-row__error" role="alert">{error.message}</p> : null}
        <SettingsField
          label={savedSource === "mathos" ? "Connection check" : "Bridge check"}
          sub={savedSource === "mathos"
            ? `Signs in to ${savedOrigin.ok ? hostOf(savedOrigin.origin) : "the platform"} and asks the team’s VM what it offers. Never wakes an asleep VM.`
            : "Starts the saved bridge and asks what it supports. No model call."}
          control={
            <div className="settings-control-row">
              <button
                type="button"
                className="button button--secondary"
                disabled={!configured || !researchOn || checking || !props.desktopApi?.checkResearchHarnessBridge}
                onClick={() => void runCheck()}
              >
                {checking ? "Checking…" : check ? "Check again" : savedSource === "mathos" ? "Check connection" : "Check bridge"}
              </button>
              <span className="settings-harness-status" role="status">
                {!configured
                  ? savedSource === "mathos" ? "Store the API key and save a team first." : "Save a bridge first."
                  : !researchOn
                    ? "Turn on Research runs to check."
                  : check
                    ? check.ok ? `${checkTarget} · responding` : check.error
                    : `${checkTarget} · not checked`}
              </span>
            </div>
          }
          actions={check?.ok ? (
            <span className="settings-harness-capabilities" aria-label="Source supports">
              {CAPABILITIES.map(([key, label]) => (
                <span
                  key={key}
                  className={check.capabilities[key] ? "settings-card__chip settings-card__chip--ok" : "settings-card__chip"}
                >
                  {label}
                  <span className="settings-harness-sr-only">{check.capabilities[key] ? " supported" : " not supported"}</span>
                </span>
              ))}
            </span>
          ) : undefined}
          help={draft.dirty ? "Checks the saved settings, not unsaved edits." : undefined}
        />
        {source === "mathos" ? (
          <SettingsField
            label="MathOS Platform"
            sub="What a Research run can do with the hosted platform."
            control={
              <ul className="settings-harness-support" aria-label="MathOS Platform support">
                {PLATFORM_SUPPORT.map((row) => (
                  <li key={row.label}>
                    <span className={row.available ? "settings-card__chip settings-card__chip--ok" : "settings-card__chip settings-card__chip--warn"}>
                      {row.available ? "Available" : "Not yet"}
                    </span>{" "}
                    <span><strong>{row.label}</strong> · {row.detail}</span>
                  </li>
                ))}
              </ul>
            }
          />
        ) : null}
      </div>
    </SettingsSection>
  );
}

/** Found teams, plus the saved one when it was not found, so a saved choice always shows. */
function teamChoices(teams: MathosTeam[] | undefined, current: string): Array<{ value: string; label: string; description?: string }> {
  const options: Array<{ value: string; label: string; description?: string }> = (teams ?? []).map((team) => ({ value: team.id, label: team.name, description: team.id }));
  if (current && !options.some((option) => option.value === current)) options.unshift({ value: current, label: current });
  return options;
}

function hostOf(origin: string): string {
  return origin.replace(/^https?:\/\//, "");
}

function fileName(command: string): string {
  return command.split(/[\\/]/).filter(Boolean).pop() ?? command;
}

function ownerMessage(error: unknown, fallback: string): string {
  const text = error instanceof Error ? error.message : fallback;
  return text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}
