import type { DesktopSettingsSnapshot } from "@pwragent/shared";
import {
  SettingsField,
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionGroup,
  SettingsSectionStack,
} from "./SettingsLayout";
import { SettingsSwitch } from "./SettingsSwitch";
import { sourceBadge } from "./settings-fields";

const DEFAULT_LIVE_TRANSCRIPT_EVENT_FILTERING = {
  value: false,
  source: "default" as const,
};

const DEFAULT_LIGHTWEIGHT_NAVIGATION_REFRESH = {
  value: false,
  source: "default" as const,
};

const DEFAULT_MARKDOWN_MATH_RENDERING = {
  value: false,
  source: "default" as const,
};

const DEFAULT_CODEX_DEFAULT_MODE_REQUEST_USER_INPUT = {
  value: false,
  source: "default" as const,
};

const DEFAULT_MANAGED_REVIEW = {
  value: false,
  source: "default" as const,
};

const DEFAULT_THREAD_TOOL_ACCOUNTING = {
  value: false,
  source: "default" as const,
};

export function ExperimentalSettings(props: {
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  onDiffCondensationEnabledChange: (enabled: boolean) => Promise<void>;
  onLiveTranscriptEventFilteringChange: (enabled: boolean) => Promise<void>;
  onLightweightNavigationRefreshChange: (enabled: boolean) => Promise<void>;
  onMarkdownMathRenderingChange: (enabled: boolean) => Promise<void>;
  onThreadToolAccountingChange: (enabled: boolean) => Promise<void>;
  onCodexDefaultModeRequestUserInputChange: (
    enabled: boolean,
  ) => Promise<void>;
  onManagedReviewChange: (enabled: boolean) => Promise<void>;
}) {
  const condensation = props.snapshot.experimental.diffCondensation;
  const liveTranscriptEventFiltering =
    props.snapshot.experimental.liveTranscriptEventFiltering ??
    DEFAULT_LIVE_TRANSCRIPT_EVENT_FILTERING;
  const lightweightNavigationRefresh =
    props.snapshot.experimental.lightweightNavigationRefresh ??
    DEFAULT_LIGHTWEIGHT_NAVIGATION_REFRESH;
  const markdownMathRendering =
    props.snapshot.experimental.markdownMathRendering ??
    DEFAULT_MARKDOWN_MATH_RENDERING;
  const threadToolAccounting =
    props.snapshot.experimental.threadToolAccounting ??
    DEFAULT_THREAD_TOOL_ACCOUNTING;
  const codexDefaultModeRequestUserInput =
    props.snapshot.experimental.codexDefaultModeRequestUserInput ??
    DEFAULT_CODEX_DEFAULT_MODE_REQUEST_USER_INPUT;
  const managedReview =
    props.snapshot.experimental.managedReview ?? DEFAULT_MANAGED_REVIEW;
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
        title="Tool Call Tracking"
        description="Show tool-call volume, command instances, output, and noisy-polling alerts in a dedicated thread panel."
        chip={threadToolAccounting.value ? "On" : "Off"}
        chipKind={threadToolAccounting.value ? "ok" : "default"}
      >
        <div className="settings-fields">
          <SettingsField
            label="Display tool call tracking"
            sub="Show the experimental Tool calls tab in the thread context rail."
            help="Collection stays on either way; this only controls the operator-facing tab."
            source={sourceBadge(threadToolAccounting)}
            control={
              <SettingsSwitch
                checked={threadToolAccounting.value}
                disabled={props.saving}
                label="Display tool call tracking"
                onChange={(enabled) => {
                  void props.onThreadToolAccountingChange(enabled);
                }}
              />
            }
          />
        </div>
      </SettingsSection>

      <SettingsSection
        eyebrow="Experimental"
        title="Markdown Math Rendering"
        description="Render LaTeX math delimiters in thread transcripts with KaTeX. Disabled by default while rendering quality and performance are evaluated."
        chip={markdownMathRendering.value ? "On" : "Off"}
        chipKind={markdownMathRendering.value ? "ok" : "default"}
      >
        <div className="settings-fields">
          <SettingsField
            label="Enable Markdown math rendering"
            sub="Render \\(…\\) and \\[…\\] expressions as typeset math."
            help="The KaTeX runtime is loaded on demand after this setting is enabled. Turning it off restores literal Markdown rendering."
            source={sourceBadge(markdownMathRendering)}
            control={
              <SettingsSwitch
                checked={markdownMathRendering.value}
                disabled={props.saving}
                label="Enable Markdown math rendering"
                onChange={(enabled) => {
                  void props.onMarkdownMathRenderingChange(enabled);
                }}
              />
            }
          />
        </div>
      </SettingsSection>

      <SettingsSection
        eyebrow="Experimental"
        title="Lightweight Navigation Refresh"
        description="Use a one-page active thread-list poll while focused and coalesce full refreshes after focus events. Disabled by default while this behavior is validated against external Codex changes."
        chip={lightweightNavigationRefresh.value ? "On" : "Off"}
        chipKind={lightweightNavigationRefresh.value ? "ok" : "default"}
      >
        <div className="settings-fields">
          <SettingsField
            label="Enable lightweight navigation refresh"
            sub="When on, foreground background polling reads only the most recently active page and focus refreshes are throttled."
            source={sourceBadge(lightweightNavigationRefresh)}
            control={
              <SettingsSwitch
                checked={lightweightNavigationRefresh.value}
                disabled={props.saving}
                label="Enable lightweight navigation refresh"
                onChange={(enabled) => {
                  void props.onLightweightNavigationRefreshChange(enabled);
                }}
              />
            }
          />
        </div>
      </SettingsSection>

      <SettingsSection
        eyebrow="Experimental"
        title="PwrAgent-managed Code Review"
        description="Run code reviews in a PwrAgent-managed child turn instead of Codex's native review lifecycle. Disabled by default while failure handling and usage attribution are validated."
        chip={managedReview.value ? "On" : "Off"}
        chipKind={managedReview.value ? "ok" : "default"}
      >
        <div className="settings-fields">
          <SettingsField
            label="Enable managed code review"
            sub="Route desktop and messaging /review requests through a managed child turn."
            help="Existing threads are not migrated; turning this off restores native Codex review/start for the next review."
            source={sourceBadge(managedReview)}
            control={
              <SettingsSwitch
                checked={managedReview.value}
                disabled={props.saving}
                label="Enable managed code review"
                onChange={(enabled) => {
                  void props.onManagedReviewChange(enabled);
                }}
              />
            }
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
          <SettingsField
            label="Enable Codex skill questions"
            sub="Let Codex skills pause turns to ask questions."
            help="Enables Codex's default-mode request_user_input feature for Codex threads."
            source={sourceBadge(codexDefaultModeRequestUserInput)}
            control={
              <SettingsSwitch
                checked={codexDefaultModeRequestUserInput.value}
                disabled={props.saving}
                label="Enable Codex skill questions"
                onChange={(enabled) => {
                  void props.onCodexDefaultModeRequestUserInputChange(enabled);
                }}
              />
            }
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
          description="Send focused-diff hunks to Codex GPT-5.6 Luna to decide which are safe to hide. Disabled by default — every diff renders in full and no structured-generation request fires."
          chip={condensation.enabled.value ? "On" : "Off"}
          chipKind={condensation.enabled.value ? "ok" : "default"}
        >
          <div className="settings-fields">
            <SettingsField
              label="Enable diff condensation"
              sub="Use Codex GPT-5.6 Luna to hide low-signal diff hunks."
              help="Each focused-diff request is sent to Codex, regardless of the launchpad default. If Codex is unavailable, the full diff remains visible."
              source={sourceBadge(condensation.enabled)}
              control={
                <SettingsSwitch
                  checked={condensation.enabled.value}
                  disabled={props.saving}
                  label="Enable diff condensation"
                  onChange={(enabled) => {
                    void props.onDiffCondensationEnabledChange(enabled);
                  }}
                />
              }
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
            <SettingsField
              label="Enable live transcript event filtering"
              sub="Ignore unrelated live transcript events."
              help="Live transcript notifications for other threads no longer update the focused thread view."
              source={sourceBadge(liveTranscriptEventFiltering)}
              control={
                <SettingsSwitch
                  checked={liveTranscriptEventFiltering.value}
                  disabled={props.saving}
                  label="Enable live transcript event filtering"
                  onChange={(enabled) => {
                    void props.onLiveTranscriptEventFilteringChange(enabled);
                  }}
                />
              }
            />
          </div>
        </SettingsSection>
      </SettingsSectionGroup>
    </SettingsSectionStack>
  );
}
