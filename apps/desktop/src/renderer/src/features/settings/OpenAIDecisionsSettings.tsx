import type {
  DesktopOpenAIDecisionsSettings,
  DesktopSettingsSecretName,
  DesktopSettingsSecretState,
  DesktopSettingsSnapshot,
} from "@pwragent/shared";
import { DraftTextField } from "./DecisionModelSettings";
import { SecretField } from "./SecretField";
import { SettingsPanelHead, SettingsSection, SettingsSectionStack } from "./SettingsLayout";

export const OPENAI_DECISIONS_FOCUS = "openai-decisions";

const UNSET_SECRET: DesktopSettingsSecretState = { configured: false, source: "unset", writable: false };

export function openAIDecisionsKeyState(snapshot: DesktopSettingsSnapshot): DesktopSettingsSecretState {
  return snapshot.models.openaiDecisions?.apiKey ?? UNSET_SECRET;
}

/** OpenAI dashboard ids are short and contain no whitespace. They are not keys. */
export function openAIDecisionsIdProblem(value: string): string | undefined {
  return value.length > 64 || /\s/.test(value)
    ? "Paste the id from the OpenAI dashboard: up to 64 characters, no spaces."
    : undefined;
}

/**
 * AI Providers → OpenAI Decisions. Separate from the Decisions choice
 * (Off, local Clef, Jev) and from Codex model providers: agents register
 * decisions with PwrAgent and PwrAgent runs them on OpenAI's API.
 */
export function OpenAIDecisionsScreen(props: {
  snapshot: DesktopSettingsSnapshot;
  saving: boolean;
  onSave: (settings: DesktopOpenAIDecisionsSettings) => Promise<unknown>;
  onClearSecret: (secret: DesktopSettingsSecretName) => Promise<boolean>;
  onReplaceSecret: (secret: DesktopSettingsSecretName, value: string) => Promise<boolean>;
}) {
  const settings = props.snapshot.models.openaiDecisions;
  const ids: DesktopOpenAIDecisionsSettings = {
    ...(settings?.organizationId ? { organizationId: settings.organizationId } : {}),
    ...(settings?.projectId ? { projectId: settings.projectId } : {}),
  };
  const keyState = openAIDecisionsKeyState(props.snapshot);
  return (
    <SettingsSectionStack paneId="models-openai-decisions" aria-label="OpenAI Decisions settings">
      <SettingsPanelHead
        eyebrow="AI Providers"
        title="OpenAI Decisions"
        help="Agents in any thread can register a decision once and run it again on new evidence. PwrAgent sends each run to OpenAI's Decisions API with gpt-6-luna. This is separate from the Decisions setting, which picks Clef or Jev for live voice."
      />
      <SettingsSection
        title="Connection"
        sectionId="openai-decisions-connection"
        chip={keyState.configured ? "Key saved" : "No API key"}
        chipKind={keyState.configured ? "ok" : "muted"}
      >
        <div className="settings-fields">
          <SecretField
            label="API key"
            sub="An OpenAI platform API key from a project that can call POST /v1/decisions. Signing in to ChatGPT or Codex does not provide one. Each run bills that API project, not your subscription."
            secret="openaiDecisionsApiKey"
            state={keyState}
            disabled={props.saving}
            onClearSecret={props.onClearSecret}
            onReplaceSecret={props.onReplaceSecret}
          />
          <DraftTextField
            label="Project ID"
            sub="Optional. Sent as OpenAI-Project when the key can reach more than one project."
            value={ids.projectId ?? ""}
            placeholder="proj_…"
            disabled={props.saving}
            validate={openAIDecisionsIdProblem}
            onSave={async (projectId) => await props.onSave({ ...ids, projectId })}
          />
          <DraftTextField
            label="Organization ID"
            sub="Optional. Sent as OpenAI-Organization when the key belongs to more than one organization."
            value={ids.organizationId ?? ""}
            placeholder="org-…"
            disabled={props.saving}
            validate={openAIDecisionsIdProblem}
            onSave={async (organizationId) => await props.onSave({ ...ids, organizationId })}
          />
        </div>
      </SettingsSection>
    </SettingsSectionStack>
  );
}
