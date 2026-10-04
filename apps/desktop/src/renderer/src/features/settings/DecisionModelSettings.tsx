import { useState, type ReactNode } from "react";
import {
  DECISION_JEV_DEFAULT_MODEL,
  DECISION_JEV_ENDPOINT,
  DECISION_LOCAL_DEFAULT_ENDPOINT,
  DECISION_PROVIDER_LINKS,
  decisionLocalEndpointProblem,
  normalizeDecisionLocalEndpoint,
  resolveDecisionModelSettings,
  type DecisionModelChoice,
  type DecisionProviderId,
  type DesktopDecisionModelSettings,
  type DesktopSettingsSecretName,
  type DesktopSettingsSecretState,
  type DesktopSettingsSnapshot,
} from "@pwragent/shared";
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
  const modelHelp =
    resolved.model === "local" ? <>Runs on {resolved.localEndpoint}.</>
      : resolved.model === "jev" ? secrets.jevApiKey.configured
        ? <>Runs {resolved.jevModel} on TypeSafe.</>
        : <>Runs {resolved.jevModel} on TypeSafe once it has an API key, under Providers → {DECISION_PROVIDER_NAMES.jev}.</>
        : "Nothing uses a decision model.";
  return (
    <SettingsSection
      eyebrow="Defaults"
      title="Decisions"
      sectionId="decision-model"
      description="A decision model answers typed questions with a probability for every answer, in one pass and without writing text. Live voice uses it to read camera cues."
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
                { value: "local", label: DECISION_PROVIDER_NAMES.local },
                { value: "jev", label: DECISION_PROVIDER_NAMES.jev },
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
          lockedReason={resolved.model === "local"
            ? undefined
            : "Camera frames go only to the local decision model, so they never leave this Mac."}
          onChange={async (cameraCues) => await save({ cameraCues })}
        />
      </div>
    </SettingsSection>
  );
}

/** A text setting saved on Enter or on leaving the box, checked first. */
function DraftTextField(props: {
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

  if (props.provider === "local") {
    return (
      <SettingsSectionStack paneId="models-decision-local" aria-label={`${name} settings`}>
        <SettingsPanelHead
          eyebrow="AI Providers"
          title={name}
          help="A decision model served on this Mac, such as Cloudflare's Clef run by PwrSuiteLab. Live voice sends it camera frames for cues."
        />
        <SettingsSection
          title="Connection"
          sectionId="decision-local-connection"
          chip={inUse ? "In use" : undefined}
          chipKind="ok"
        >
          <div className="settings-fields">
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
              sub="The server's address on this Mac. PwrAgent posts frames to /decide and reads /health to see how busy it is."
              value={settings.local?.endpoint ?? ""}
              placeholder={DECISION_LOCAL_DEFAULT_ENDPOINT}
              disabled={props.saving}
              validate={decisionLocalEndpointProblem}
              onSave={async (endpoint) => await props.onSave({
                ...settings,
                local: endpoint ? { endpoint: normalizeDecisionLocalEndpoint(endpoint) } : undefined,
              })}
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
              sub="Reads the server's health, including how many decisions it is running. Runs no decision."
              control={
                <SettingsTestBlock
                  kind="decision-local"
                  desktopApi={props.desktopApi}
                  icon={<span aria-hidden="true">D</span>}
                  defaultName={resolved.localEndpoint}
                  defaultSub="GET /health"
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
        help="TypeSafe's hosted decision model. It takes text only, so camera frames never go to it."
      />
      <SettingsSection
        title="Connection"
        sectionId="decision-jev-connection"
        chip={inUse ? "In use" : undefined}
        chipKind="ok"
      >
        <div className="settings-fields">
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
            validate={(value) => value.length > 200 ? "Use a model id of 200 characters or fewer." : undefined}
            onSave={async (model) => await props.onSave({ ...settings, jev: model ? { model } : undefined })}
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
