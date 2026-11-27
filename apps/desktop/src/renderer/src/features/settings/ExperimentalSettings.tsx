import { formatFilesystemPath } from "@pwragent/shared/path-display";
import {
  type BoundedCommandHelperMode,
  type DesktopSettingsConfigPatch,
  type DesktopSettingsSecretName,
  type DesktopSettingsSnapshot,
  type DesktopTokenMiserUsage,
} from "@pwragent/shared/contracts/settings";
import { useEffect, useRef, useState } from "react";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  ManagedRuntimeProgressStrip,
  useManagedRuntimeProgress,
} from "./ManagedRuntimeProgress";
import {
  SegmentedField,
  SettingsField,
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionGroup,
  SettingsSectionStack,
  ToggleField,
} from "./SettingsLayout";
import { sourceBadge } from "./settings-fields";
import { ResearchHarnessSettings } from "./ResearchHarnessSettings";

const DEFAULT_CODEX_DEFAULT_MODE_REQUEST_USER_INPUT = {
  value: false,
  source: "default" as const,
};

const DEFAULT_TOKEN_MISER_ENABLED = {
  value: false,
  source: "default" as const,
};

const DEFAULT_TOKEN_MISER_DEFAULT_ENABLED = {
  value: true,
  source: "default" as const,
};

/**
 * Where diagnostic samples land, shown whether or not capture is on: the
 * operator turned capture on to read these files, and saved files outlive
 * the switch. The folder is created by the first batch write, so opening it
 * earlier is the expected miss, not an error.
 */
function TokenMiserDiagnosticsFolder(props: {
  directory: string;
  openPath?: DesktopApi["openPath"];
}) {
  const [note, setNote] = useState<string>();
  const opening = useRef(false);
  const openPath = props.openPath;

  const open = async () => {
    if (!openPath || opening.current) return;
    opening.current = true;
    try {
      const response = await openPath({ path: props.directory });
      setNote(response.opened
        ? undefined
        : response.missing
          ? "No samples saved yet."
          : response.error ?? "The folder could not be opened.");
    } catch (caught) {
      setNote(caught instanceof Error ? caught.message : String(caught));
    } finally {
      opening.current = false;
    }
  };

  return (
    <div className="settings-folder-line">
      <span className="settings-folder-line__path">
        {formatFilesystemPath(props.directory)}
      </span>
      <span className="settings-folder-line__actions">
        <span className="settings-folder-line__note" role="status">
          {note}
        </span>
        {openPath ? (
          <button
            type="button"
            className="button button--ghost settings-folder-line__action"
            onClick={() => void open()}
          >
            Open folder
          </button>
        ) : null}
      </span>
    </div>
  );
}

export function ExperimentalSettings(props: {
  desktopApi?: DesktopApi;
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  onTokenMiserEnabledChange: (enabled: boolean) => Promise<void>;
  onTokenMiserFocusedSummariesEnabledChange: (enabled: boolean) => Promise<void>;
  onTokenMiserDiagnosticsEnabledChange: (enabled: boolean) => Promise<void>;
  onTokenMiserPollingReviewsEnabledChange: (enabled: boolean) => Promise<void>;
  onTokenMiserDefaultEnabledChange: (enabled: boolean) => Promise<void>;
  onCodexToolDiscoveryChange: (enabled: boolean) => Promise<void>;
  onResearchEnabledChange: (enabled: boolean) => Promise<void>;
  onResourceCheckoutsEnabledChange: (enabled: boolean) => Promise<void>;
  onWriteConfig: (patch: DesktopSettingsConfigPatch, onError?: (message: string) => void) => Promise<boolean>;
  onClearSecret: (secret: DesktopSettingsSecretName) => Promise<boolean>;
  onReplaceSecret: (secret: DesktopSettingsSecretName, value: string) => Promise<boolean>;
  onCodexDefaultModeRequestUserInputChange: (
    enabled: boolean,
  ) => Promise<void>;
}) {
  const [tokenMiserWriteTarget, setTokenMiserWriteTarget] = useState<
    boolean | undefined
  >();
  const codexToolDiscovery = props.snapshot.experimental.codexToolDiscovery
    ?? { value: true, source: "default" as const };
  const researchEnabled = props.snapshot.experimental.researchEnabled
    ?? { value: false, source: "default" as const };
  const resourceCheckoutsEnabled = props.snapshot.experimental.resourceCheckoutsEnabled
    ?? { value: false, source: "default" as const };
  const tokenMiserEnabled =
    props.snapshot.experimental.tokenMiserEnabled ??
    DEFAULT_TOKEN_MISER_ENABLED;
  const boundedCommands = props.snapshot.experimental.tokenMiserBoundedCommands ?? DEFAULT_TOKEN_MISER_ENABLED;
  const boundedHelper = props.snapshot.experimental.tokenMiserBoundedHelper ?? { value: "deterministic", source: "default" } as const;
  const tokenMiserFocusedSummariesEnabled =
    props.snapshot.experimental.tokenMiserFocusedSummariesEnabled ??
    { value: false, source: "default" as const };
  const tokenMiserDiagnosticsEnabled =
    props.snapshot.experimental.tokenMiserDiagnosticsEnabled ??
    { value: false, source: "default" as const };
  const tokenMiserDiagnosticsDirectory =
    props.snapshot.runtime.tokenMiserDiagnosticsDirectory;
  const tokenMiserPollingReviewsEnabled =
    props.snapshot.experimental.tokenMiserPollingReviewsEnabled ??
    { value: false, source: "default" as const };
  const tokenMiserDefaultEnabled =
    props.snapshot.experimental.tokenMiserDefaultEnabled ??
    DEFAULT_TOKEN_MISER_DEFAULT_ENABLED;
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
  const tokenMiserActivation = props.snapshot.runtime.tokenMiser?.activation;
  const managedCodex = props.snapshot.runtime.tokenMiser?.managedCodex;
  const managedCodexProgress = useManagedRuntimeProgress(props.desktopApi, "codex");
  const tokenMiserSwitchPending =
    tokenMiserEnabled.value
    && managedCodex?.state === "pending-switch";
  // Only a contradiction is worth reporting: switched on, but the Codex side
  // never loaded. Off-and-unavailable is just off.
  const tokenMiserInert =
    tokenMiserEnabled.value
    && tokenMiserWriteTarget === undefined
    && !tokenMiserSwitchPending
    && (
      managedCodex?.state === "unavailable"
      || tokenMiserActivation?.state === "unavailable"
    );
  const tokenMiserStarting =
    tokenMiserEnabled.value
    && !tokenMiserInert
    && (
      tokenMiserSwitchPending
      || tokenMiserActivation?.state !== "active"
    );
  const managedCodexStatus = tokenMiserWriteTarget === true ? "Installing"
    : tokenMiserWriteTarget === false ? "Turning off"
    : tokenMiserInert ? "Not running"
    : tokenMiserSwitchPending ? "Waiting for idle"
    : tokenMiserStarting ? "Starting"
    : undefined;
  const captureSupported = props.snapshot.runtime.tokenMiser?.boundedCommandsSupported === true;
  const captureEnabled = captureSupported && boundedCommands.value;
  const tokenMiserAvailable = captureEnabled || (tokenMiserEnabled.value && !managedCodexStatus);
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

      <SettingsSection
        eyebrow="Experimental"
        title="Token Miser"
        description="Keep large command results available for retrieval and send bounded output to the parent thread."
        chip={tokenMiserAvailable
          ? tokenMiserDefaultEnabled.value ? "Default on" : "Opt-in"
          : managedCodexStatus ?? "Off"}
        chipKind={tokenMiserAvailable ? "ok" : tokenMiserInert ? "warn" : "default"}
      >
        <div className="settings-fields">
          <ToggleField
            checked={captureEnabled}
            disabled={props.saving || !captureSupported}
            label="Capture foreground command output"
            sub={captureSupported ? "Offer approved Git diffs and focused tests with exact log retrieval on stock or managed Codex, Claude and Antigravity."
              : "Foreground command capture requires a supported POSIX owner."}
            source={sourceBadge(boundedCommands)}
            onChange={(enabled) => props.onWriteConfig({ experimental: { tokenMiserBoundedCommands: enabled } })}
          />
          <SegmentedField<BoundedCommandHelperMode>
            value={boundedHelper.value}
            disabled={props.saving || !captureEnabled}
            label="Helper for ambiguous command output"
            sub="Repetitive progress is reduced locally. Codex uses your Token Miser helper. Decision model uses Defaults → Decisions and may incur per-call charges."
            options={[
              { label: "Local rules only", value: "deterministic" },
              { label: "Codex helper", value: "codex" },
              { label: "Decision model", value: "decision" },
            ]}
            source={sourceBadge(boundedHelper)}
            onChange={(helper) => props.onWriteConfig({ experimental: { tokenMiserBoundedHelper: helper } })}
          />
          <ToggleField
            checked={tokenMiserDefaultEnabled.value}
            disabled={props.saving || (!tokenMiserEnabled.value && !captureEnabled)}
            label="Enable on threads by default"
            switchQualifier="Token Miser"
            sub="Apply enabled Token Miser features to threads without an override. Change individual threads from the composer menu."
            source={sourceBadge(tokenMiserDefaultEnabled)}
            onChange={(enabled) => {
              return props.onTokenMiserDefaultEnabledChange(enabled);
            }}
          />
          <ToggleField
            checked={tokenMiserWriteTarget ?? tokenMiserEnabled.value}
            disabled={
              props.saving || tokenMiserWriteTarget !== undefined
            }
            label="Automatically reduce tool output in managed Codex"
            sub="Download PwrAgent's verified Codex build to summarize large tool results, including in Code Mode."
            help="PwrAgent checks for updates while this setting is on and switches builds after active Codex turns finish. If a summary is unavailable, the thread receives the original output."
            source={sourceBadge(tokenMiserEnabled)}
            actions={managedCodexProgress ? (
              <ManagedRuntimeProgressStrip
                progress={managedCodexProgress}
                waitingForIdle={managedCodex?.state === "pending-switch"}
              />
            ) : boundedCommands.value && managedCodexStatus ? (
              <span role="status">{managedCodexStatus}</span>
            ) : undefined}
            onChange={(enabled) => {
              setTokenMiserWriteTarget(enabled);
              return props.onTokenMiserEnabledChange(enabled).finally(() => {
                setTokenMiserWriteTarget(undefined);
              });
            }}
          />
          <ToggleField
            checked={tokenMiserFocusedSummariesEnabled.value}
            disabled={props.saving || !tokenMiserEnabled.value}
            label="Focused summaries"
            switchQualifier="Token Miser"
            sub="Let agents ask specific questions about preserved output without reading the full source into context."
            help="Off by default. Uses the configured Token Miser model and incurs additional helper usage. Turning this off stops new focused summaries; ordinary Token Miser summaries and exact-source reads remain available."
            source={sourceBadge(tokenMiserFocusedSummariesEnabled)}
            onChange={props.onTokenMiserFocusedSummariesEnabledChange}
          />
          <ToggleField
            checked={tokenMiserPollingReviewsEnabled.value}
            disabled={props.saving || !tokenMiserEnabled.value}
            label="Review hidden polling loops"
            switchQualifier="Token Miser"
            sub="Ask the helper model to review ambiguous repeated tool calls before suggesting a Job Monitor."
            help="Off by default. Obvious polling is still detected locally. This review sends only bounded timing, tool metadata, redacted Code Mode snippets, and recent assistant updates to the same helper-model selector Token Miser uses; it never includes full tool output. A review that finds productive work leaves the turn alone."
            source={sourceBadge(tokenMiserPollingReviewsEnabled)}
            onChange={props.onTokenMiserPollingReviewsEnabledChange}
          />
          <ToggleField
            checked={tokenMiserDiagnosticsEnabled.value}
            disabled={props.saving || !tokenMiserEnabled.value}
            label="Capture diagnostic samples"
            switchQualifier="Token Miser"
            sub="Save local samples of tool output, summaries, retrievals, and suspected retry bursts for offline review."
            help="Off by default. Samples can include tool output and intermediate assistant commentary, which may contain sensitive data. Final answers are never saved. Files stay on this machine, at most 24 files of 8 MB. Turning this off discards samples not yet written; saved files remain until you delete them."
            source={sourceBadge(tokenMiserDiagnosticsEnabled)}
            actions={
              tokenMiserDiagnosticsDirectory ? (
                <TokenMiserDiagnosticsFolder
                  directory={tokenMiserDiagnosticsDirectory}
                  openPath={props.desktopApi?.openPath}
                />
              ) : undefined
            }
            onChange={props.onTokenMiserDiagnosticsEnabledChange}
          />
          {tokenMiserInert ? (
            <SettingsField
              label="Codex could not load the gate"
              sub={managedCodex?.reason
                ?? tokenMiserActivation?.reason
                ?? "Managed Codex activation did not complete."}
              help="Token Miser fails open, so turns keep running with tool output unchanged — nothing is gated until this clears. Toggle availability off and on to retry the verified download and activation."
              control={
                <span className="settings-field__value settings-field__value--warn">
                  Enabled, not running
                </span>
              }
            />
          ) : null}
          {tokenMiserUsage && tokenMiserUsage.interceptionCount > 0 ? (
            <SettingsField
              label="Estimated parent-context savings"
              sub={`${tokenMiserUsage.interceptionCount.toLocaleString()} intercepted results · ${tokenMiserUsage.baselineParentTokens.toLocaleString()} baseline tokens − ${tokenMiserUsage.replacementTokens.toLocaleString()} summary tokens − ${tokenMiserUsage.retrievedTokens.toLocaleString()} retrieved tokens.`}
              help="This estimate measures tokens kept out of the parent thread after Codex's model-visible output cap. It is separate from the helper model's own token cost. Repeated retrievals count each time, so reading everything can make the savings negative."
              control={
                <span className="settings-field__value">
                  {tokenMiserUsage.estimatedParentTokensSaved >= 0 ? "Saved " : "Added "}
                  {Math.abs(
                    tokenMiserUsage.estimatedParentTokensSaved,
                  ).toLocaleString()} tokens
                </span>
              }
            />
          ) : null}
        </div>
      </SettingsSection>

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
        title="Soon to be discontinued"
        description="These features are being phased out and may be removed in a future release."
        chip="All off"
        defaultCollapsed
        aria-label="Soon to be discontinued experimental settings"
      >
        {null}
      </SettingsSectionGroup>
    </SettingsSectionStack>
  );
}
