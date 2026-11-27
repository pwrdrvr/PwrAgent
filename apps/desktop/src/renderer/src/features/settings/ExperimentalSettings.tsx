import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import {
  type DesktopSettingsConfigPatch,
  type DesktopSettingsSecretName,
  type DesktopSettingsSnapshot,
  type DesktopTokenMiserUsage,
} from "@pwragent/shared/contracts/settings";
import type { DesktopHelperModelSettings } from "@pwragent/shared/helper-models";
import { useEffect, useState } from "react";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionGroup,
  SettingsSectionStack,
  ToggleField,
} from "./SettingsLayout";
import { sourceBadge } from "./settings-fields";
import { ResearchHarnessSettings } from "./ResearchHarnessSettings";
import {
  TokenMiserLegacySettings,
  TokenMiserV2Settings,
  useTokenMiserLegacyState,
} from "./TokenMiserSettings";

const DEFAULT_CODEX_DEFAULT_MODE_REQUEST_USER_INPUT = {
  value: false,
  source: "default" as const,
};

export function ExperimentalSettings(props: {
  desktopApi?: DesktopApi;
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  /** The owner's backend catalog, for the Token Miser (v2) model pickers. */
  backends?: readonly BackendSummary[];
  onSaveHelperModels?: (helperModels: DesktopHelperModelSettings) => Promise<unknown>;
  onTokenMiserEnabledChange: (enabled: boolean) => Promise<void>;
  onTokenMiserFocusedSummariesEnabledChange: (enabled: boolean) => Promise<void>;
  onTokenMiserDiagnosticsEnabledChange: (enabled: boolean) => Promise<void>;
  onTokenMiserPollingReviewsEnabledChange: (enabled: boolean) => Promise<void>;
  onTokenMiserDefaultEnabledChange: (enabled: boolean) => Promise<void>;
  onCodexToolDiscoveryChange: (enabled: boolean) => Promise<void>;
  onCodexAgentToolsMcpChange: (enabled: boolean) => Promise<void>;
  onResearchEnabledChange: (enabled: boolean) => Promise<void>;
  onResourceCheckoutsEnabledChange: (enabled: boolean) => Promise<void>;
  onWriteConfig: (patch: DesktopSettingsConfigPatch, onError?: (message: string) => void) => Promise<boolean>;
  onClearSecret: (secret: DesktopSettingsSecretName) => Promise<boolean>;
  onReplaceSecret: (secret: DesktopSettingsSecretName, value: string) => Promise<boolean>;
  onCodexDefaultModeRequestUserInputChange: (
    enabled: boolean,
  ) => Promise<void>;
}) {
  const codexToolDiscovery = props.snapshot.experimental.codexToolDiscovery
    ?? { value: true, source: "default" as const };
  const codexAgentToolsMcp = props.snapshot.experimental.codexAgentToolsMcp
    ?? { value: false, source: "default" as const };
  const researchEnabled = props.snapshot.experimental.researchEnabled
    ?? { value: false, source: "default" as const };
  const resourceCheckoutsEnabled = props.snapshot.experimental.resourceCheckoutsEnabled
    ?? { value: false, source: "default" as const };
  const tokenMiserLegacy = useTokenMiserLegacyState(props.snapshot);
  const [tokenMiserUsage, setTokenMiserUsage] = useState<DesktopTokenMiserUsage>();
  useEffect(() => {
    let cancelled = false;
    void props.desktopApi?.readTokenMiserUsage?.().then((usage) => {
      if (!cancelled) setTokenMiserUsage(usage);
    }).catch(() => {
      // Unavailable accounting must not block configuration or imply zero usage.
    });
    return () => { cancelled = true; };
  }, [props.desktopApi]);
  const codexDefaultModeRequestUserInput =
    props.snapshot.experimental.codexDefaultModeRequestUserInput ??
    DEFAULT_CODEX_DEFAULT_MODE_REQUEST_USER_INPUT;

  return (
    <SettingsSectionStack paneId="experimental" aria-label="Experimental settings">
      <SettingsPanelHead
        eyebrow="Experimental"
        title="Experimental features"
        help="Features that may change shape or be removed without notice."
      />

      <SettingsSection
        eyebrow="Experimental"
        title="Codex Tool Discovery"
        description="Reduce startup context by letting Codex search for PwrAgent tools and load their instructions when needed. Enabled by default."
        chip={codexToolDiscovery.value ? "On" : "Off"}
        chipKind={codexToolDiscovery.value ? "ok" : "default"}
      >
        <div className="settings-fields">
          <ToggleField
            checked={codexToolDiscovery.value}
            disabled={props.saving}
            label="Load PwrAgent tools on demand"
            sub="Use tool search in Codex Code Mode."
            help="Applies to new threads and the next turn when the Codex runtime supports refreshing tools. Start a new thread on older runtimes. Other providers are unchanged."
            source={sourceBadge(codexToolDiscovery)}
            onChange={props.onCodexToolDiscoveryChange}
          />
        </div>
      </SettingsSection>

      <SettingsSection
        eyebrow="Experimental"
        title="PwrAgent Tools via MCP"
        description="Expose PwrAgent tools through the pwragent_apps server in new Codex threads."
        chip={codexAgentToolsMcp.value ? "On" : "Off"}
        chipKind={codexAgentToolsMcp.value ? "ok" : "default"}
      >
        <div className="settings-fields">
          <ToggleField
            checked={codexAgentToolsMcp.value}
            disabled={props.saving}
            label="Use MCP for PwrAgent tools"
            help="Applies to new Codex threads. Each thread keeps the tool transport it started with."
            source={sourceBadge(codexAgentToolsMcp)}
            onChange={props.onCodexAgentToolsMcpChange}
          />
        </div>
      </SettingsSection>

      <SettingsSection
        eyebrow="Experimental"
        title="Research runs"
        description="Coordinate workers from any local thread, track findings and review research in the thread’s Research panel. Disabled by default."
        chip={researchEnabled.value ? "On" : "Off"}
        chipKind={researchEnabled.value ? "ok" : "default"}
      >
        <div className="settings-fields">
          <ToggleField
            checked={researchEnabled.value}
            disabled={props.saving}
            label="Enable research runs"
            sub={codexToolDiscovery.value
              ? "Works in Codex, Claude and ACP threads."
              : "Works in Claude and ACP threads. Codex threads also need Codex Tool Discovery."}
            help="Turning this off hides the Research panel, removes its tools and stops active research runs. Saved findings remain available when re-enabled. New threads and runtimes with tool refresh pick up changes on their next turn."
            source={sourceBadge(researchEnabled)}
            onChange={props.onResearchEnabledChange}
          />
        </div>
      </SettingsSection>

      <ResearchHarnessSettings
        desktopApi={props.desktopApi}
        saving={props.saving}
        snapshot={props.snapshot}
        onWriteConfig={props.onWriteConfig}
        onClearSecret={props.onClearSecret}
        onReplaceSecret={props.onReplaceSecret}
      />

      <SettingsSection
        eyebrow="Experimental"
        title="Federation resources"
        description="Expose local CPU and Federation resource checkout tools for agent discovery and reservations. Disabled by default."
        chip={resourceCheckoutsEnabled.value ? "On" : "Off"}
        chipKind={resourceCheckoutsEnabled.value ? "ok" : "default"}
      >
        <div className="settings-fields">
          <ToggleField
            checked={resourceCheckoutsEnabled.value}
            disabled={props.saving}
            label="Enable resource checkout tools"
            sub="Applies to Codex, Claude and ACP threads."
            help="Turning this off blocks new agent reservations. Threads can still check status, release their holds, and cancel queued requests. The Resources window stays available. New threads and runtimes with tool refresh pick up changes on their next turn."
            source={sourceBadge(resourceCheckoutsEnabled)}
            onChange={props.onResourceCheckoutsEnabledChange}
          />
        </div>
      </SettingsSection>

      <TokenMiserV2Settings
        saving={props.saving}
        snapshot={props.snapshot}
        backends={props.backends ?? []}
        onWriteConfig={props.onWriteConfig}
        onSaveHelperModels={async (helperModels) => await props.onSaveHelperModels?.(helperModels)}
        onTokenMiserDefaultEnabledChange={props.onTokenMiserDefaultEnabledChange}
      />

      <SettingsSection
        eyebrow="Experimental"
        title="Codex Skill Questions"
        description="Allow Codex skills to pause ordinary turns for structured questions when the installed Codex build supports default-mode request_user_input."
        chip={codexDefaultModeRequestUserInput.value ? "On" : "Off"}
        chipKind={codexDefaultModeRequestUserInput.value ? "ok" : "default"}
      >
        <div className="settings-fields">
          <ToggleField
            checked={codexDefaultModeRequestUserInput.value}
            disabled={props.saving}
            label="Enable Codex skill questions"
            sub="Let Codex skills pause turns to ask questions."
            help="Enables Codex's default-mode request_user_input feature for Codex threads."
            source={sourceBadge(codexDefaultModeRequestUserInput)}
            onChange={(enabled) => {
              return props.onCodexDefaultModeRequestUserInputChange(enabled);
            }}
          />
        </div>
      </SettingsSection>

      <SettingsSectionGroup
        groupId="experimental-discontinued"
        eyebrow="Deprecated"
        title="Soon to be removed"
        description="Replaced by newer features and planned for removal. These keep working until then."
        chip={tokenMiserLegacy.enabled ? "Legacy on" : "All off"}
        chipKind={tokenMiserLegacy.enabled ? "warn" : "default"}
        defaultCollapsed={!tokenMiserLegacy.enabled}
        aria-label="Soon to be removed experimental settings"
      >
        <TokenMiserLegacySettings
          desktopApi={props.desktopApi}
          saving={props.saving}
          snapshot={props.snapshot}
          legacy={tokenMiserLegacy}
          usage={tokenMiserUsage}
          onTokenMiserEnabledChange={props.onTokenMiserEnabledChange}
          onTokenMiserFocusedSummariesEnabledChange={props.onTokenMiserFocusedSummariesEnabledChange}
          onTokenMiserDiagnosticsEnabledChange={props.onTokenMiserDiagnosticsEnabledChange}
          onTokenMiserPollingReviewsEnabledChange={props.onTokenMiserPollingReviewsEnabledChange}
        />
      </SettingsSectionGroup>
    </SettingsSectionStack>
  );
}
