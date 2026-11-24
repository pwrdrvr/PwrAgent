import { useState } from "react";
import type {
  DesktopSettingsConfigPatch,
  DesktopSettingsSecretName,
  DesktopSettingsSecretState,
  DesktopSettingsSnapshot,
} from "@pwragent/shared/contracts/settings";
import {
  MATHOS_PLATFORM_API_KEY_ENV,
  normalizeResearchHarnessConfig,
  researchHarnessArgsFromLines,
  type ResearchHarnessCheck,
} from "@pwragent/shared/research-harness";
import type { DesktopApi } from "../../lib/desktop-api";
import { SecretField } from "./SecretField";
import { SettingsField, SettingsSection } from "./SettingsLayout";
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

/**
 * What the hosted MathOS Platform offers a bridge, from the authenticated
 * compatibility probe in docs/research-harness-adapter.md. These are facts
 * about the deployed platform, separate from the configured bridge's own
 * answer to Check bridge.
 */
const PLATFORM_SUPPORT: Array<{ label: string; available: boolean; detail: string }> = [
  { label: "Import swarm records", available: true, detail: "Read-only. No model calls." },
  { label: "Run or stop a swarm", available: false, detail: "The hosted runtime does not offer these operations to a bridge." },
  { label: "Discovery snapshots", available: false, detail: "The hosted runtime has no discovery reads. A bridge to a development runtime can provide them." },
];

/**
 * Settings › Experimental › Open Math Harness. The bridge fields are one
 * explicit-save form over `[research.harness]`; the Platform key is a secret
 * row that saves on its own and never comes back to the window.
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
  const savedArgsText = (saved?.args ?? []).join("\n");
  const draft = useSettingsDraft({
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
  const values = draft.values;
  const configured = Boolean(saved?.command);

  const save = async (): Promise<boolean> => {
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
    setWriting(true);
    setError(undefined);
    try {
      const ok = await props.onWriteConfig(
        { research: { harness: normalized.value } },
        (message) => setError({ message }),
      );
      if (ok) {
        // What is stored can differ from what was typed (blank lines, spaces).
        draft.discard();
        setCheck(undefined);
      }
      return ok;
    } finally {
      setWriting(false);
    }
  };

  const remove = async () => {
    setWriting(true);
    setError(undefined);
    try {
      if (await props.onWriteConfig({ research: { harness: null } }, (message) => setError({ message }))) {
        draft.discard();
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

  const runCheck = async () => {
    if (!props.desktopApi?.checkResearchHarnessBridge) return;
    setChecking(true);
    try {
      setCheck(await props.desktopApi.checkResearchHarnessBridge());
    } catch (failure) {
      setCheck({ ok: false, checkedAt: Date.now(), error: ownerMessage(failure) });
    } finally {
      setChecking(false);
    }
  };

  const disabled = props.saving || writing;
  const fieldError = (field: string) => (error?.field === field ? error.message : undefined);
  const bridgeName = saved?.command ? fileName(saved.command) : undefined;

  return (
    <SettingsSection
      eyebrow="Experimental · Research"
      title="Open Math Harness"
      sectionId="open-math-harness"
      description="Bring swarm records and discovery snapshots from Open Math Harness into a Research run. A bridge is a program you install; PwrAgent starts it and talks to it over stdio."
      chip={configured ? "Bridge set" : "No bridge"}
      chipKind={configured ? "ok" : "default"}
    >
      <div className="settings-fields">
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
        <div className="settings-button-row">
          <button type="button" className="button button--primary" disabled={disabled || !draft.dirty} onClick={() => void save()}>
            Save bridge
          </button>
          {draft.dirty ? (
            <button type="button" className="button button--ghost" disabled={disabled} onClick={discard}>
              Discard
            </button>
          ) : null}
          {configured ? (
            <button type="button" className="button button--ghost" disabled={disabled} onClick={() => void remove()}>
              Remove bridge
            </button>
          ) : null}
        </div>
        {error && !error.field ? <p className="settings-row__error" role="alert">{error.message}</p> : null}
        <SecretField
          label="MathOS Platform API key"
          sub={<>Stored encrypted on this machine and given only to the bridge, as <code>{MATHOS_PLATFORM_API_KEY_ENV}</code>.</>}
          help="Never written to config.toml, shown again, or sent to an agent or a model."
          secret="mathosPlatformApiKey"
          state={research?.platformApiKey ?? UNSET_SECRET}
          disabled={props.saving || !(research?.platformApiKey.writable ?? false)}
          onClearSecret={props.onClearSecret}
          onReplaceSecret={props.onReplaceSecret}
        />
        <SettingsField
          label="Bridge check"
          sub="Starts the saved bridge and asks what it supports. No model call."
          control={
            <div className="settings-control-row">
              <button
                type="button"
                className="button button--secondary"
                disabled={!configured || checking || !props.desktopApi?.checkResearchHarnessBridge}
                onClick={() => void runCheck()}
              >
                {checking ? "Checking…" : check ? "Check again" : "Check bridge"}
              </button>
              <span className="settings-harness-status" role="status">
                {!configured
                  ? "Save a bridge first."
                  : check
                    ? check.ok ? `${bridgeName} · responding` : check.error
                    : `${bridgeName} · not checked`}
              </span>
            </div>
          }
          actions={check?.ok ? (
            <span className="settings-harness-capabilities" aria-label="Bridge supports">
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
          help={draft.dirty ? "Checks the saved bridge, not unsaved edits." : undefined}
        />
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
      </div>
    </SettingsSection>
  );
}

function fileName(command: string): string {
  return command.split(/[\\/]/).filter(Boolean).pop() ?? command;
}

function ownerMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : "The bridge check failed";
  return text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}
