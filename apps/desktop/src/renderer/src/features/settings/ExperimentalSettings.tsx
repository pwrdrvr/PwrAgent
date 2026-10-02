import {
  formatFilesystemPath,
  type DesktopSettingsSnapshot,
  type DesktopTokenMiserUsage,
} from "@pwragent/shared";
import { useEffect, useRef, useState } from "react";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  ManagedRuntimeProgressStrip,
  useManagedRuntimeProgress,
} from "./ManagedRuntimeProgress";
import {
  SettingsField,
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionGroup,
  SettingsSectionStack,
  ToggleField,
} from "./SettingsLayout";
import { sourceBadge } from "./settings-fields";

const DEFAULT_LIVE_TRANSCRIPT_EVENT_FILTERING = {
  value: false,
  source: "default" as const,
};

const DEFAULT_MARKDOWN_MATH_RENDERING = {
  value: true,
  source: "default" as const,
};

const DEFAULT_CODEX_DEFAULT_MODE_REQUEST_USER_INPUT = {
  value: false,
  source: "default" as const,
};

const DEFAULT_THREAD_TOOL_ACCOUNTING = {
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
  onDiffCondensationEnabledChange: (enabled: boolean) => Promise<void>;
  onLiveTranscriptEventFilteringChange: (enabled: boolean) => Promise<void>;
  onMarkdownMathRenderingChange: (enabled: boolean) => Promise<void>;
  onThreadToolAccountingChange: (enabled: boolean) => Promise<void>;
  onTokenMiserEnabledChange: (enabled: boolean) => Promise<void>;
  onTokenMiserFocusedSummariesEnabledChange: (enabled: boolean) => Promise<void>;
  onTokenMiserDiagnosticsEnabledChange: (enabled: boolean) => Promise<void>;
  onTokenMiserPollingReviewsEnabledChange: (enabled: boolean) => Promise<void>;
  onTokenMiserDefaultEnabledChange: (enabled: boolean) => Promise<void>;
  onCodexToolDiscoveryChange: (enabled: boolean) => Promise<void>;
  onCodexDefaultModeRequestUserInputChange: (
    enabled: boolean,
  ) => Promise<void>;
}) {
  const [tokenMiserWriteTarget, setTokenMiserWriteTarget] = useState<
    boolean | undefined
  >();
  const condensation = props.snapshot.experimental.diffCondensation;
  const codexToolDiscovery = props.snapshot.experimental.codexToolDiscovery
    ?? { value: true, source: "default" as const };
  const liveTranscriptEventFiltering =
    props.snapshot.experimental.liveTranscriptEventFiltering ??
    DEFAULT_LIVE_TRANSCRIPT_EVENT_FILTERING;
  const markdownMathRendering =
    props.snapshot.experimental.markdownMathRendering ??
    DEFAULT_MARKDOWN_MATH_RENDERING;
  const threadToolAccounting =
    props.snapshot.experimental.threadToolAccounting ??
    DEFAULT_THREAD_TOOL_ACCOUNTING;
  const tokenMiserEnabled =
    props.snapshot.experimental.tokenMiserEnabled ??
    DEFAULT_TOKEN_MISER_ENABLED;
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
  const codexDefaultModeRequestUserInput =
    props.snapshot.experimental.codexDefaultModeRequestUserInput ??
    DEFAULT_CODEX_DEFAULT_MODE_REQUEST_USER_INPUT;
  const discontinuedEnabledCount =
    (condensation.enabled.value ? 1 : 0) +
    (liveTranscriptEventFiltering.value ? 1 : 0);

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
        title="Token Miser"
        description="Keep accidental walls of Codex tool output out of the parent thread while preserving the exact result for targeted retrieval."
        chip={
          tokenMiserWriteTarget === true
            ? "Installing"
            : tokenMiserWriteTarget === false
              ? "Turning off"
              : tokenMiserInert
                ? "Not running"
                : !tokenMiserEnabled.value
                  ? "Off"
                  : tokenMiserSwitchPending
                    ? "Waiting for idle"
                    : tokenMiserStarting
                      ? "Starting"
                      : tokenMiserDefaultEnabled.value ? "Default on" : "Opt-in"
        }
        chipKind={
          tokenMiserWriteTarget === undefined && tokenMiserInert
            ? "warn"
            : tokenMiserEnabled.value && !tokenMiserStarting ? "ok" : "default"
        }
      >
        <div className="settings-fields">
          <ToggleField
            checked={tokenMiserWriteTarget ?? tokenMiserEnabled.value}
            disabled={
              props.saving || tokenMiserWriteTarget !== undefined
            }
            label="Make Token Miser available"
            sub="Download and activate PwrAgent's verified Codex build, then expose per-thread controls."
            help="Off by default. PwrAgent downloads, verifies, and durably selects its Token Miser-compatible Codex build; no path selection or hook approval is required. Update checks run only while this switch is on, and a new build takes over after active Codex turns finish. If activation or summarization is unavailable, the original result passes through unchanged."
            source={sourceBadge(tokenMiserEnabled)}
            actions={
              managedCodexProgress ? (
                <ManagedRuntimeProgressStrip
                  progress={managedCodexProgress}
                  waitingForIdle={managedCodex?.state === "pending-switch"}
                />
              ) : undefined
            }
            onChange={(enabled) => {
              setTokenMiserWriteTarget(enabled);
              return props.onTokenMiserEnabledChange(enabled).finally(() => {
                setTokenMiserWriteTarget(undefined);
              });
            }}
          />
          <ToggleField
            checked={tokenMiserDefaultEnabled.value}
            disabled={props.saving || !tokenMiserEnabled.value}
            label="Enable on threads by default"
            switchQualifier="Token Miser"
            sub="Threads without an explicit override inherit this setting. Individual threads can still turn Token Miser on or off from the composer menu."
            help="On preserves the original Token Miser behavior: every Codex thread uses it unless opted out. Off makes Token Miser available as a per-thread opt-in."
            source={sourceBadge(tokenMiserDefaultEnabled)}
            onChange={(enabled) => {
              return props.onTokenMiserDefaultEnabledChange(enabled);
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
            sub="Ask the Polling reviews model from AI Providers → Default Models to review ambiguous repeated tool calls before suggesting a Job Monitor."
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
        title="Tool Call Tracking"
        description="Show tool-call volume, command instances, output, and replay-risk history in a dedicated thread panel. Safety notices remain active while this is off."
        chip={threadToolAccounting.value ? "On" : "Off"}
        chipKind={threadToolAccounting.value ? "ok" : "default"}
      >
        <div className="settings-fields">
          <ToggleField
            checked={threadToolAccounting.value}
            disabled={props.saving}
            label="Display tool call tracking"
            sub="Show the experimental Tool calls tab in the thread context rail."
            help="Collection stays on either way; this only controls the operator-facing tab."
            source={sourceBadge(threadToolAccounting)}
            onChange={(enabled) => {
              return props.onThreadToolAccountingChange(enabled);
            }}
          />
        </div>
      </SettingsSection>

      <SettingsSection
        eyebrow="Experimental"
        title="Markdown Math Rendering"
        description="Render LaTeX math delimiters in thread transcripts with KaTeX. On by default; turn it off if rendering causes problems."
        chip={markdownMathRendering.value ? "On" : "Off"}
        chipKind={markdownMathRendering.value ? "ok" : "default"}
      >
        <div className="settings-fields">
          <ToggleField
            checked={markdownMathRendering.value}
            disabled={props.saving}
            label="Enable Markdown math rendering"
            sub="Render \\(…\\) and \\[…\\] expressions as typeset math."
            help="The KaTeX runtime loads only for messages with potential math. Turning this off restores literal Markdown rendering."
            source={sourceBadge(markdownMathRendering)}
            onChange={(enabled) => {
              return props.onMarkdownMathRenderingChange(enabled);
            }}
          />
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
        chip={discontinuedEnabledCount > 0 ? `${discontinuedEnabledCount} on` : "All off"}
        chipKind={discontinuedEnabledCount > 0 ? "ok" : "default"}
        defaultCollapsed
        aria-label="Soon to be discontinued experimental settings"
      >
        <SettingsSection
          eyebrow="Experimental"
          title="Diff Condensation"
          description="Send focused-diff hunks to Codex to decide which are safe to hide. Disabled by default — every diff renders in full and no structured-generation request fires. AI Providers → Default Models picks the model."
          chip={condensation.enabled.value ? "On" : "Off"}
          chipKind={condensation.enabled.value ? "ok" : "default"}
        >
          <div className="settings-fields">
            <ToggleField
              checked={condensation.enabled.value}
              disabled={props.saving}
              label="Enable diff condensation"
              sub="Use the Diff condensation model to hide low-signal diff hunks."
              help="Each focused-diff request is sent to Codex, regardless of the launchpad default. If Codex is unavailable, the full diff remains visible."
              source={sourceBadge(condensation.enabled)}
              onChange={(enabled) => {
                return props.onDiffCondensationEnabledChange(enabled);
              }}
            />

          </div>
        </SettingsSection>

        <SettingsSection
          eyebrow="Experimental"
          title="Live Transcript Event Filtering"
          description="Reduce renderer work from live transcript notifications by ignoring unrelated thread-local events and skipping duplicate activity updates. Disabled by default."
          chip={liveTranscriptEventFiltering.value ? "On" : "Off"}
          chipKind={liveTranscriptEventFiltering.value ? "ok" : "default"}
        >
          <div className="settings-fields">
            <ToggleField
              checked={liveTranscriptEventFiltering.value}
              disabled={props.saving}
              label="Enable live transcript event filtering"
              sub="Ignore unrelated live transcript events."
              help="Live transcript notifications for other threads no longer update the focused thread view."
              source={sourceBadge(liveTranscriptEventFiltering)}
              onChange={(enabled) => {
                return props.onLiveTranscriptEventFilteringChange(enabled);
              }}
            />
          </div>
        </SettingsSection>
      </SettingsSectionGroup>
    </SettingsSectionStack>
  );
}
