import { useState, type ReactNode } from "react";
import {
  DECISION_JEV_DEFAULT_MODEL,
  DECISION_JEV_ENDPOINT,
  DECISION_LOCAL_DEFAULT_ENDPOINT,
  DECISION_LOCAL_DEFAULT_MODEL,
  DECISION_PROVIDER_IDS,
  DECISION_PROVIDER_LINKS,
  decisionLocalEndpointProblem,
  normalizeDecisionLocalEndpoint,
  resolveDecisionModelSettings,
  type DecisionModelChoice,
  type DecisionProviderId,
  type DesktopDecisionModelSettings,
} from "@pwragent/shared/decision-models";
import {
  type DesktopSettingsSecretName,
  type DesktopSettingsSecretState,
  type DesktopSettingsSnapshot,
} from "@pwragent/shared/contracts/settings";
import { Select } from "../../components/Select";
import type { DesktopApi } from "../../lib/desktop-api";
import { SecretField } from "./SecretField";
import {
  SettingsField,
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
  ToggleField,
} from "./SettingsLayout";
import { SettingsTestBlock } from "./SettingsTestBlock";

/** The closed pickers draw as the AI Providers page's chip pills. */
const PICKER_CLASS = "settings-select settings-select--chip";

export const DECISION_PROVIDER_FOCUS: Record<DecisionProviderId, string> = {
  local: "decision-local",
  jev: "decision-jev",
};

export const DECISION_PROVIDER_NAMES: Record<DecisionProviderId, string> = {
  local: "Local decision model",
  jev: "TypeSafe Jev",
};

const UNSET_SECRET: DesktopSettingsSecretState = { configured: false, source: "unset", writable: false };

type SaveDecisionModels = (settings: DesktopDecisionModelSettings) => Promise<unknown>;

function decisionSettings(snapshot: DesktopSettingsSnapshot): DesktopDecisionModelSettings {
  return snapshot.models.decisionModels ?? {};
}

export function decisionSecrets(snapshot: DesktopSettingsSnapshot) {
  return snapshot.models.decisionSecrets ?? { localApiKey: UNSET_SECRET, jevApiKey: UNSET_SECRET };
}

/** Opens in the browser; main's window guard allows only safe external URLs. */
function LinkRow(props: { label: string; sub: ReactNode; links: { href: string; label: string }[] }) {
  return (
    <SettingsField
      label={props.label}
      sub={props.sub}
      control={
        <div className="settings-inline-actions">
          {props.links.map((link) => (
            <a key={link.href} className="button button--ghost" href={link.href} target="_blank" rel="noreferrer">
              {link.label}
            </a>
          ))}
        </div>
      }
    />
  );
}

/**
 * Defaults → Decisions on the AI Providers page: which decision model
 * PwrAgent uses, and whether live voice sends it camera frames.
 */
export function DecisionModelDefaults(props: {
  snapshot: DesktopSettingsSnapshot;
  saving: boolean;
  onSave: SaveDecisionModels;
}) {
  const settings = decisionSettings(props.snapshot);
  const resolved = resolveDecisionModelSettings(settings);
  const secrets = decisionSecrets(props.snapshot);
  const save = (change: Partial<DesktopDecisionModelSettings>) => props.onSave({ ...settings, ...change });
  // A saved choice whose provider is off reads as Off until it is back on.
  const chosenOff = resolved.chosenModel !== "off" && resolved.model === "off";
  const modelHelp = chosenOff
    ? <>{DECISION_PROVIDER_NAMES[resolved.chosenModel as DecisionProviderId]} is off, so no decision model is in use. Turn it on under Providers to use it again.</>
    : resolved.model === "local" ? <>Runs {resolved.localModel} at {resolved.localEndpoint}.</>
      : resolved.model === "jev" ? secrets.jevApiKey.configured
        ? <>Runs {resolved.jevModel} on TypeSafe.</>
        : <>Runs {resolved.jevModel} on TypeSafe once it has an API key, under Providers → {DECISION_PROVIDER_NAMES.jev}.</>
        : "Not set up. Live voice offers camera cues once the local decision model is chosen.";
  return (
    <SettingsSection
      eyebrow="Defaults"
      title="Decisions"
      sectionId="decision-model"
      description="A decision model answers typed questions with a probability for every answer, in one pass and without writing text. Both providers speak TypeSafe's System One API. Live voice uses the local one to read camera cues."
    >
      <div className="settings-fields">
        <SettingsField
          label="Decision model"
          control={
            <Select
              aria-label="Decision model"
              className={PICKER_CLASS}
              disabled={props.saving}
              value={resolved.model}
              options={[
                ...DECISION_PROVIDER_IDS
                  .filter((provider) => resolved.enabled[provider])
                  .map((provider) => ({ value: provider, label: DECISION_PROVIDER_NAMES[provider] })),
                { value: "off", label: "Off" },
              ]}
              onChange={(model) => { void save({ model: model as DecisionModelChoice }); }}
            />
          }
          help={modelHelp}
        />
        <ToggleField
          label="Camera cues in live voice"
          checked={resolved.cameraCues && resolved.model === "local"}
          disabled={props.saving}
          sub="Live voice can send camera frames to the decision model, so it can react to a gesture or to you stepping away."
          lockedReason={resolved.model === "local" ? undefined
            : !resolved.enabled.local ? "Turn on the local decision model to use camera cues."
            : resolved.model === "off" ? "Choose the local decision model to use camera cues."
              : "Camera frames go only to the local decision model, so they never leave this Mac."}
          onChange={async (cameraCues) => await save({ cameraCues })}
        />
      </div>
    </SettingsSection>
  );
}

function modelIdProblem(value: string): string | undefined {
  return value.length > 200 ? "Use a model id of 200 characters or fewer." : undefined;
}

/**
 * A provider section without blank keys or `enabled: true` (on is the
 * default), or undefined when nothing is left.
 */
function providerSection<T extends { enabled?: boolean; endpoint?: string; model?: string }>(section: T): T | undefined {
  const kept = {
    ...(section.enabled === false ? { enabled: false } : {}),
    ...(section.endpoint ? { endpoint: section.endpoint } : {}),
    ...(section.model ? { model: section.model } : {}),
  } as T;
  return Object.keys(kept).length ? kept : undefined;
}

/** The Enabled switch at the top of a decision provider's Connection section. */
function ProviderEnabledField(props: {
  provider: DecisionProviderId;
  enabled: boolean;
  saving: boolean;
  sub: ReactNode;
  onChange: (enabled: boolean) => Promise<unknown>;
}) {
  return (
    <ToggleField
      checked={props.enabled}
      disabled={props.saving}
      label="Enabled"
      switchQualifier={DECISION_PROVIDER_NAMES[props.provider]}
      sub={props.sub}
      onChange={props.onChange}
    />
  );
}

/** A text setting saved on Enter or on leaving the box, checked first. */
/** A text field that saves on Enter or blur. Escape restores the saved value. */
export function DraftTextField(props: {
  label: string;
  sub?: ReactNode;
  help?: ReactNode;
  value: string;
  placeholder: string;
  disabled?: boolean;
  validate?: (value: string) => string | undefined;
  onSave: (value: string | undefined) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const commit = async () => {
    if (draft === undefined) return;
    const next = draft.trim();
    const issue = next ? props.validate?.(next) : undefined;
    setProblem(issue);
    if (issue) return;
    if (next !== props.value) await props.onSave(next || undefined);
    setDraft(undefined);
  };
  return (
    <SettingsField
      label={props.label}
      sub={props.sub}
      help={props.help}
      error={problem}
      control={
        <input
          aria-label={props.label}
          aria-invalid={problem ? true : undefined}
          className="settings-input"
          disabled={props.disabled}
          placeholder={props.placeholder}
          spellCheck={false}
          value={draft ?? props.value}
          onBlur={() => { void commit(); }}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setProblem(undefined);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void commit();
            } else if (event.key === "Escape" && draft !== undefined) {
              event.preventDefault();
              setDraft(undefined);
              setProblem(undefined);
            }
          }}
        />
      }
    />
  );
}

/** AI Providers → Local decision model, or → TypeSafe Jev. */
export function DecisionProviderScreen(props: {
  provider: DecisionProviderId;
  snapshot: DesktopSettingsSnapshot;
  desktopApi?: DesktopApi;
  saving: boolean;
  onSave: SaveDecisionModels;
  onClearSecret: (secret: DesktopSettingsSecretName) => Promise<boolean>;
  onReplaceSecret: (secret: DesktopSettingsSecretName, value: string) => Promise<boolean>;
}) {
  const settings = decisionSettings(props.snapshot);
  const resolved = resolveDecisionModelSettings(settings);
  const secrets = decisionSecrets(props.snapshot);
  const name = DECISION_PROVIDER_NAMES[props.provider];
  const inUse = resolved.model === props.provider;
  const enabled = resolved.enabled[props.provider];
  const chip = enabled ? inUse ? "In use" : undefined : "Disabled";
  const chipKind = inUse ? "ok" : "muted";
  const saveLocal = (local: NonNullable<DesktopDecisionModelSettings["local"]>) =>
    props.onSave({ ...settings, local: providerSection({ ...settings.local, ...local }) });
  const saveJev = (jev: NonNullable<DesktopDecisionModelSettings["jev"]>) =>
    props.onSave({ ...settings, jev: providerSection({ ...settings.jev, ...jev }) });

  if (props.provider === "local") {
    return (
      <SettingsSectionStack paneId="models-decision-local" aria-label={`${name} settings`}>
        <SettingsPanelHead
          eyebrow="AI Providers"
          title={name}
          help="A System One server on this Mac, such as Cloudflare's Clef run by PwrSuiteLab. Live voice sends it camera frames for cues, and agents can run registered decisions on it."
        />
        <SettingsSection
          title="Connection"
          sectionId="decision-local-connection"
          chip={chip}
          chipKind={chipKind}
        >
          <div className="settings-fields">
            <ProviderEnabledField
              provider="local"
              enabled={enabled}
              saving={props.saving}
              sub="Agents can run decisions on it, and live voice can send it camera frames. Turning this off keeps its address, model and key."
              onChange={async (next) => await saveLocal({ enabled: next })}
            />
            <LinkRow
              label="Suggested model"
              sub="No local model yet? Cloudflare's Clef answers camera questions on a Mac."
              links={[
                { href: DECISION_PROVIDER_LINKS.clefModel, label: "Clef on Hugging Face" },
                { href: DECISION_PROVIDER_LINKS.clefAnnouncement, label: "Announcement" },
              ]}
            />
            <DraftTextField
              label="Endpoint"
              sub="The server's address on this Mac. PwrAgent posts decisions to /v1/systemone and reads /health to see how busy it is."
              value={settings.local?.endpoint ?? ""}
              placeholder={DECISION_LOCAL_DEFAULT_ENDPOINT}
              disabled={props.saving}
              validate={decisionLocalEndpointProblem}
              onSave={async (endpoint) => await saveLocal({
                endpoint: endpoint ? normalizeDecisionLocalEndpoint(endpoint) : undefined,
              })}
            />
            <DraftTextField
              label="Model"
              sub="The model id the server expects. PwrSuiteLab's Clef runtime accepts only clef-flash."
              value={settings.local?.model ?? ""}
              placeholder={DECISION_LOCAL_DEFAULT_MODEL}
              disabled={props.saving}
              validate={modelIdProblem}
              onSave={async (model) => await saveLocal({ model })}
            />
            <SecretField
              label="API key"
              sub="Optional. Sent as a bearer token, for a server behind a proxy that asks for one."
              secret="decisionLocalApiKey"
              state={secrets.localApiKey}
              disabled={props.saving}
              onClearSecret={props.onClearSecret}
              onReplaceSecret={props.onReplaceSecret}
            />
            <SettingsField
              label="Connection test"
              sub={`Confirms the server offers ${resolved.localModel} and reads how many decisions it is running. Runs no decision.`}
              control={
                <SettingsTestBlock
                  kind="decision-local"
                  desktopApi={props.desktopApi}
                  icon={<span aria-hidden="true">D</span>}
                  defaultName={resolved.localEndpoint}
                  defaultSub="GET /v1/models"
                />
              }
            />
          </div>
        </SettingsSection>
      </SettingsSectionStack>
    );
  }

  return (
    <SettingsSectionStack paneId="models-decision-jev" aria-label={`${name} settings`}>
      <SettingsPanelHead
        eyebrow="AI Providers"
        title={name}
        help="TypeSafe's hosted decision model. It takes text only, so camera frames never go to it. Agents can also run registered decisions on it with this key and model."
      />
      <SettingsSection
        title="Connection"
        sectionId="decision-jev-connection"
        chip={chip}
        chipKind={chipKind}
      >
        <div className="settings-fields">
          <ProviderEnabledField
            provider="jev"
            enabled={enabled}
            saving={props.saving}
            sub="Agents can run decisions on Jev. Turning this off keeps the saved key and model."
            onChange={async (next) => await saveJev({ enabled: next })}
          />
          <LinkRow
            label="Account"
            sub="Jev needs a TypeSafe API key."
            links={[
              { href: DECISION_PROVIDER_LINKS.jevConsole, label: "Get an API key" },
              { href: DECISION_PROVIDER_LINKS.jevDocs, label: "Jev docs" },
            ]}
          />
          <SecretField
            label="API key"
            secret="typesafeJevApiKey"
            state={secrets.jevApiKey}
            disabled={props.saving}
            onClearSecret={props.onClearSecret}
            onReplaceSecret={props.onReplaceSecret}
          />
          <DraftTextField
            label="Model"
            sub="A Jev model id."
            value={settings.jev?.model ?? ""}
            placeholder={DECISION_JEV_DEFAULT_MODEL}
            disabled={props.saving}
            validate={modelIdProblem}
            onSave={async (model) => await saveJev({ model })}
          />
          <SettingsField
            label="Connection test"
            sub={`Asks ${resolved.jevModel} one yes/no question with the saved key.`}
            control={
              <SettingsTestBlock
                kind="decision-jev"
                desktopApi={props.desktopApi}
                icon={<span aria-hidden="true">J</span>}
                defaultName={DECISION_JEV_ENDPOINT.replace(/^https:\/\//, "")}
                defaultSub="POST /v1/systemone"
                prerequisites={[{ label: "API key", met: secrets.jevApiKey.configured }]}
              />
            }
          />
        </div>
      </SettingsSection>
    </SettingsSectionStack>
  );
}
