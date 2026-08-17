import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  DEFAULT_BACKGROUND_PR_POLLING,
  DEFAULT_PR_AUTO_DISPATCH_ALLOWED,
  DEFAULT_PR_AUTO_DISPATCH_BUDGET_CAPACITY,
  DEFAULT_PR_AUTO_DISPATCH_BUDGET_REFILL_PER_MINUTE,
  DEFAULT_PR_AUTO_DISPATCH_ENABLED_FOR_NEW_THREADS,
  DEFAULT_PAUSE_PR_AUTO_DISPATCH_WHEN_BUDGET_EMPTY,
  MAX_PR_AUTO_DISPATCH_BUDGET_CAPACITY,
  MAX_PR_AUTO_DISPATCH_BUDGET_REFILL_PER_MINUTE,
  MIN_PR_AUTO_DISPATCH_BUDGET_CAPACITY,
  MIN_PR_AUTO_DISPATCH_BUDGET_REFILL_PER_MINUTE,
  type DesktopGitDiscoveryCandidate,
  type DesktopGhDiscoveryCandidate,
  type DesktopSettingsSnapshot,
  type GhStatus,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { copyText } from "../../lib/copy-text";
import {
  SettingsField,
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
} from "./SettingsLayout";
import {
  SettingsPathRow,
  type SettingsPathRowChip,
} from "./SettingsPathRow";
import { SettingsSwitch } from "./SettingsSwitch";
import { sourceBadge } from "./settings-fields";
import {
  commandDiscoveryFailureDetail as sharedCommandDiscoveryFailureDetail,
  describeCommandDiscoveryFailure as describeSharedCommandDiscoveryFailure,
} from "./command-discovery-failure";

const DEFAULT_BACKGROUND_PR_POLLING_VALUE = {
  value: DEFAULT_BACKGROUND_PR_POLLING,
  source: "default" as const,
};

const DEFAULT_PR_AUTO_DISPATCH_ALLOWED_VALUE = {
  value: DEFAULT_PR_AUTO_DISPATCH_ALLOWED,
  source: "default" as const,
};

const DEFAULT_PR_AUTO_DISPATCH_ENABLED_VALUE = {
  value: DEFAULT_PR_AUTO_DISPATCH_ENABLED_FOR_NEW_THREADS,
  source: "default" as const,
};

const DEFAULT_PR_AUTO_DISPATCH_BUDGET_CAPACITY_VALUE = {
  value: DEFAULT_PR_AUTO_DISPATCH_BUDGET_CAPACITY,
  source: "default" as const,
};

const DEFAULT_PR_AUTO_DISPATCH_BUDGET_REFILL_PER_MINUTE_VALUE = {
  value: DEFAULT_PR_AUTO_DISPATCH_BUDGET_REFILL_PER_MINUTE,
  source: "default" as const,
};

const DEFAULT_PAUSE_PR_AUTO_DISPATCH_WHEN_BUDGET_EMPTY_VALUE = {
  value: DEFAULT_PAUSE_PR_AUTO_DISPATCH_WHEN_BUDGET_EMPTY,
  source: "default" as const,
};

export function GitSettings(props: {
  desktopApi?: DesktopApi;
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  onBackgroundPrPollingChange: (enabled: boolean) => Promise<void>;
  onPrAutoDispatchAllowedChange: (enabled: boolean) => Promise<void>;
  onDefaultPrAutoDispatchEnabledChange: (enabled: boolean) => Promise<void>;
  onPrAutoDispatchBudgetCapacityChange: (capacity: number) => Promise<void>;
  onPrAutoDispatchBudgetRefillPerMinuteChange: (
    refillPerMinute: number,
  ) => Promise<void>;
  onPausePrAutoDispatchWhenBudgetEmptyChange: (
    enabled: boolean,
  ) => Promise<void>;
  onRefresh: () => Promise<void>;
  onSaveGhPath: (path: string) => Promise<void>;
}) {
  const backgroundPrPolling =
    props.snapshot.git?.backgroundPrPolling ??
    DEFAULT_BACKGROUND_PR_POLLING_VALUE;
  const prAutoDispatchAllowed =
    props.snapshot.git?.prAutoDispatchAllowed ??
    DEFAULT_PR_AUTO_DISPATCH_ALLOWED_VALUE;
  const defaultPrAutoDispatchEnabled =
    props.snapshot.git?.defaultPrAutoDispatchEnabled ??
    DEFAULT_PR_AUTO_DISPATCH_ENABLED_VALUE;
  const prAutoDispatchBudgetCapacity =
    props.snapshot.git?.prAutoDispatchBudgetCapacity ??
    DEFAULT_PR_AUTO_DISPATCH_BUDGET_CAPACITY_VALUE;
  const prAutoDispatchBudgetRefillPerMinute =
    props.snapshot.git?.prAutoDispatchBudgetRefillPerMinute ??
    DEFAULT_PR_AUTO_DISPATCH_BUDGET_REFILL_PER_MINUTE_VALUE;
  const pausePrAutoDispatchWhenBudgetEmpty =
    props.snapshot.git?.pausePrAutoDispatchWhenBudgetEmpty ??
    DEFAULT_PAUSE_PR_AUTO_DISPATCH_WHEN_BUDGET_EMPTY_VALUE;
  const [pendingLaunchpadApply, setPendingLaunchpadApply] = useState<{
    directoryKeys: string[];
    enabled: boolean;
  }>();
  const [pendingThreadEnable, setPendingThreadEnable] = useState<{
    eligibleThreadCount: number;
    updatedThreadCount: number;
  }>();
  const [checkingThreadEnable, setCheckingThreadEnable] = useState(false);
  const [applying, setApplying] = useState(false);
  const [bulkStatus, setBulkStatus] = useState<string | undefined>();
  const automationAvailable =
    backgroundPrPolling.value && prAutoDispatchAllowed.value;
  const hasPendingBulkAction = Boolean(
    pendingLaunchpadApply || pendingThreadEnable,
  );
  const actionsDisabled = props.saving || applying || !automationAvailable;

  const previewLaunchpadApply = async (): Promise<void> => {
    if (!props.desktopApi?.getNavigationSnapshot) {
      setBulkStatus("Launchpad updates are unavailable in this build.");
      return;
    }
    try {
      const navigation = await props.desktopApi.getNavigationSnapshot();
      const directoryKeys = navigation.directories
        .filter((directory) => Boolean(directory.launchpad))
        .map((directory) => directory.key);
      if (directoryKeys.length === 0) {
        setBulkStatus("No launchpads are available to update.");
        return;
      }
      setBulkStatus(undefined);
      setPendingThreadEnable(undefined);
      setPendingLaunchpadApply({
        directoryKeys,
        enabled: defaultPrAutoDispatchEnabled.value,
      });
    } catch (error) {
      setBulkStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const applyToLaunchpads = async (): Promise<void> => {
    if (!pendingLaunchpadApply || !props.desktopApi?.updateDirectoryLaunchpad) {
      return;
    }
    setApplying(true);
    try {
      for (const directoryKey of pendingLaunchpadApply.directoryKeys) {
        await props.desktopApi.updateDirectoryLaunchpad({
          directoryKey,
          patch: { prAutoDispatchEnabled: pendingLaunchpadApply.enabled },
          stickySettingsChanged: true,
        });
      }
      setBulkStatus(
        `${pendingLaunchpadApply.enabled ? "Enabled" : "Turned off"} Auto-fix PR for ${pendingLaunchpadApply.directoryKeys.length} launchpad${
          pendingLaunchpadApply.directoryKeys.length === 1 ? "" : "s"
        }. Existing threads were not changed.`,
      );
      setPendingLaunchpadApply(undefined);
    } catch (error) {
      setBulkStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setApplying(false);
    }
  };

  const previewExistingThreadEnable = async (): Promise<void> => {
    if (!props.desktopApi?.setEligibleThreadsPrAutoDispatch) {
      setBulkStatus("Existing thread updates are unavailable in this build.");
      return;
    }
    setCheckingThreadEnable(true);
    try {
      const response = await props.desktopApi.setEligibleThreadsPrAutoDispatch({
        enabled: true,
        dryRun: true,
      });
      if (response.eligibleThreadCount === 0) {
        setBulkStatus("No existing threads have an open PR attached to their primary workspace.");
        return;
      }
      if (response.updatedThreadCount === 0) {
        setBulkStatus(
          `Auto-fix PR is already enabled for all ${response.eligibleThreadCount} eligible existing thread${
            response.eligibleThreadCount === 1 ? "" : "s"
          }.`,
        );
        return;
      }
      setBulkStatus(undefined);
      setPendingLaunchpadApply(undefined);
      setPendingThreadEnable(response);
    } catch (error) {
      setBulkStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setCheckingThreadEnable(false);
    }
  };

  const enableExistingThreads = async (): Promise<void> => {
    if (!pendingThreadEnable || !props.desktopApi?.setEligibleThreadsPrAutoDispatch) {
      return;
    }
    setApplying(true);
    try {
      const response = await props.desktopApi.setEligibleThreadsPrAutoDispatch({
        enabled: true,
      });
      setBulkStatus(
        response.updatedThreadCount > 0
          ? `Enabled Auto-fix PR for ${response.updatedThreadCount} existing thread${
              response.updatedThreadCount === 1 ? "" : "s"
            } with a primary attached pull request.`
          : "No existing thread preferences needed updating.",
      );
      setPendingThreadEnable(undefined);
    } catch (error) {
      setBulkStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setApplying(false);
    }
  };

  return (
    <SettingsSectionStack paneId="git" aria-label="Git settings">
      <SettingsPanelHead
        eyebrow="Git"
        title="Repository & pull requests"
        help="Configure the Git and GitHub tools PwrAgent uses for repository, worktree, and pull request status."
      />

      <GitStatusPanel
        desktopApi={props.desktopApi}
        saving={props.saving}
        snapshot={props.snapshot}
        onRefresh={props.onRefresh}
      />
      <GhStatusPanel
        desktopApi={props.desktopApi}
        saving={props.saving}
        snapshot={props.snapshot}
        onSaveGhPath={props.onSaveGhPath}
      />
      <SettingsSection
        eyebrow="Git"
        title="Background pull request status"
        description="Keep pull request status fresh across every open project instead of only the thread you have selected. Checks run in the background on a priority cadence and skip merged and closed pull requests."
        chip={backgroundPrPolling.value ? "On" : "Off"}
        chipKind={backgroundPrPolling.value ? "ok" : "default"}
      >
        <div className="settings-fields">
          <SettingsField
            label="Enable background pull request status"
            sub="When on, the project you are viewing refreshes about every minute and other open projects refresh less often. Pull requests with no activity for a day stop being checked until you open their thread again. Requires the GitHub CLI to be signed in."
            source={sourceBadge(backgroundPrPolling)}
            control={
              <SettingsSwitch
                checked={backgroundPrPolling.value}
                disabled={props.saving}
                label="Enable background pull request status"
                onChange={(enabled) => {
                  void props.onBackgroundPrPollingChange(enabled);
                }}
              />
            }
          />
        </div>
      </SettingsSection>
      <SettingsSection
        eyebrow="GitHub"
        title="Pull request automation"
        description="Control whether PwrAgent can schedule a bounded repair turn for a linked pull request that fails CI or becomes conflicted."
        chip={prAutoDispatchAllowed.value ? "Allowed" : "Off"}
        chipKind={prAutoDispatchAllowed.value ? "ok" : "default"}
      >
        <div className="settings-fields">
          <SettingsField
            label="Allow Auto-fix PR"
            sub={
              backgroundPrPolling.value
                ? "When enabled, a thread with Auto-fix PR on can receive one bounded repair turn for a newly failing or conflicting pull request."
                : "Turn on background pull request status above before allowing automatic PR repairs."
            }
            source={sourceBadge(prAutoDispatchAllowed)}
            control={
              <SettingsSwitch
                checked={prAutoDispatchAllowed.value}
                disabled={props.saving || !backgroundPrPolling.value}
                label="Allow Auto-fix PR"
                onChange={(enabled) => {
                  void props.onPrAutoDispatchAllowedChange(enabled);
                }}
              />
            }
          />
          <SettingsField
            label="Enable Auto-fix PR for new threads and launchpads"
            sub={
              backgroundPrPolling.value && prAutoDispatchAllowed.value
                ? "New threads and launchpads start with this choice. Existing launchpads and threads keep their saved choice."
                : "This default is available when background pull request status and Auto-fix PR are allowed."
            }
            source={sourceBadge(defaultPrAutoDispatchEnabled)}
            control={
              <>
                <SettingsSwitch
                  checked={defaultPrAutoDispatchEnabled.value}
                  disabled={actionsDisabled || checkingThreadEnable || hasPendingBulkAction}
                  label="Enable Auto-fix PR for new threads and launchpads"
                  onChange={(enabled) => {
                    void props.onDefaultPrAutoDispatchEnabledChange(enabled);
                  }}
                />
                {pendingLaunchpadApply ? (
                  <GitActionConfirmation
                    applying={applying}
                    confirmLabel="Apply"
                    label={`Apply to ${pendingLaunchpadApply.directoryKeys.length} launchpad${
                      pendingLaunchpadApply.directoryKeys.length === 1 ? "" : "s"
                    }?`}
                    sub="This saves the selected Auto-fix PR choice for each launchpad. Existing threads stay unchanged."
                    onCancel={() => setPendingLaunchpadApply(undefined)}
                    onConfirm={() => void applyToLaunchpads()}
                  />
                ) : (
                  <div className="settings-inline-actions">
                    <button
                      className="button button--secondary"
                      disabled={
                        actionsDisabled
                        || hasPendingBulkAction
                        || !props.desktopApi?.getNavigationSnapshot
                        || !props.desktopApi?.updateDirectoryLaunchpad
                      }
                      type="button"
                      onClick={() => void previewLaunchpadApply()}
                    >
                      Apply to launchpads
                    </button>
                  </div>
                )}
              </>
            }
          />
          <SettingsField
            label="Enable Auto-fix PR for existing threads"
            sub={
              automationAvailable
                ? "Enable it only for threads with an open pull request attached to their primary workspace. Informational and detached PR links are left alone."
                : "This bulk action is available when background pull request status and Auto-fix PR are allowed."
            }
            control={
              <>
                {pendingThreadEnable ? (
                  <GitActionConfirmation
                    applying={applying}
                    confirmLabel="Enable"
                    label={`Enable Auto-fix PR for ${pendingThreadEnable.updatedThreadCount} existing thread${
                      pendingThreadEnable.updatedThreadCount === 1 ? "" : "s"
                    }?`}
                    sub={`Only ${pendingThreadEnable.eligibleThreadCount} thread${
                      pendingThreadEnable.eligibleThreadCount === 1 ? " has" : "s have"
                    } an eligible primary attached PR. Other saved thread choices stay unchanged.`}
                    onCancel={() => setPendingThreadEnable(undefined)}
                    onConfirm={() => void enableExistingThreads()}
                  />
                ) : (
                  <div className="settings-inline-actions">
                    <button
                      className="button button--secondary"
                      disabled={
                        actionsDisabled
                        || checkingThreadEnable
                        || hasPendingBulkAction
                        || !props.desktopApi?.setEligibleThreadsPrAutoDispatch
                      }
                      type="button"
                      onClick={() => void previewExistingThreadEnable()}
                    >
                      {checkingThreadEnable
                        ? "Checking…"
                        : "Enable existing PR threads…"}
                    </button>
                  </div>
                )}
                {bulkStatus ? (
                  <p className="settings-empty" role="status">
                    {bulkStatus}
                  </p>
                ) : null}
              </>
            }
          />
          <BudgetNumberField
            disabled={props.saving}
            label="Automatic repair capacity"
            max={MAX_PR_AUTO_DISPATCH_BUDGET_CAPACITY}
            min={MIN_PR_AUTO_DISPATCH_BUDGET_CAPACITY}
            source={sourceBadge(prAutoDispatchBudgetCapacity)}
            sub="Maximum automatic repair dispatches retained for this PwrAgent profile."
            suffix="dispatches"
            value={prAutoDispatchBudgetCapacity.value}
            onSave={(capacity) => {
              void props.onPrAutoDispatchBudgetCapacityChange(capacity);
            }}
          />
          <BudgetNumberField
            disabled={props.saving}
            label="Automatic repair refill rate"
            max={MAX_PR_AUTO_DISPATCH_BUDGET_REFILL_PER_MINUTE}
            min={MIN_PR_AUTO_DISPATCH_BUDGET_REFILL_PER_MINUTE}
            source={sourceBadge(prAutoDispatchBudgetRefillPerMinute)}
            sub="Dispatch capacity restored each minute for this PwrAgent profile."
            suffix="per minute"
            value={prAutoDispatchBudgetRefillPerMinute.value}
            onSave={(refillPerMinute) => {
              void props.onPrAutoDispatchBudgetRefillPerMinuteChange(
                refillPerMinute,
              );
            }}
          />
          <SettingsField
            label="Pause Auto-fix PR when the budget is empty"
            sub="Pause automatic PR repairs until you acknowledge the safety stop. Thread-level Auto-fix PR choices are left unchanged."
            source={sourceBadge(pausePrAutoDispatchWhenBudgetEmpty)}
            control={
              <SettingsSwitch
                checked={pausePrAutoDispatchWhenBudgetEmpty.value}
                disabled={props.saving}
                label="Pause Auto-fix PR when the budget is empty"
                onChange={(enabled) => {
                  void props.onPausePrAutoDispatchWhenBudgetEmptyChange(enabled);
                }}
              />
            }
          />
        </div>
      </SettingsSection>
    </SettingsSectionStack>
  );
}

function GitActionConfirmation(props: {
  applying: boolean;
  confirmLabel: string;
  label: string;
  sub: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div aria-live="polite" className="settings-action-confirmation">
      <div className="settings-action-confirmation__copy">
        <strong>{props.label}</strong>
        <span>{props.sub}</span>
      </div>
      <div className="settings-inline-actions">
        <button
          className="button button--primary"
          disabled={props.applying}
          type="button"
          onClick={props.onConfirm}
        >
          {props.applying ? "Updating…" : props.confirmLabel}
        </button>
        <button
          className="button button--ghost"
          disabled={props.applying}
          type="button"
          onClick={props.onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function BudgetNumberField(props: {
  disabled?: boolean;
  label: string;
  max: number;
  min: number;
  source: string;
  sub?: ReactNode;
  suffix: string;
  value: number;
  onSave: (value: number) => void;
}) {
  const [value, setValue] = useState(String(props.value));

  return (
    <SettingsField
      label={props.label}
      sub={props.sub}
      source={props.source}
      control={
        <span className="settings-number">
          <input
            aria-label={props.label}
            className="settings-input settings-input--inline"
            disabled={props.disabled}
            max={props.max}
            min={props.min}
            type="number"
            value={value}
            onBlur={() => {
              const parsed = Number(value);
              if (!Number.isFinite(parsed)) {
                setValue(String(props.value));
                return;
              }
              const clamped = Math.min(
                Math.max(Math.trunc(parsed), props.min),
                props.max,
              );
              setValue(String(clamped));
              props.onSave(clamped);
            }}
            onChange={(event) => setValue(event.currentTarget.value)}
          />
          <span className="settings-source">{props.suffix}</span>
        </span>
      }
    />
  );
}

const XCODE_LICENSE_REMEDIATION_COMMAND = "sudo xcodebuild -license";

function GitStatusPanel(props: {
  desktopApi?: DesktopApi;
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  onRefresh: () => Promise<void>;
}) {
  const [loading, setLoading] = useState(false);
  const discovery = props.snapshot.applications.git.discovery;
  const selected = discovery.candidates.find((candidate) => candidate.selected);
  const hasWorkingGit = discovery.candidates.some((candidate) => candidate.executable);
  const visibleCandidates = discovery.candidates.filter(
    (candidate) =>
      candidate.executable || isXcodeLicenseCandidate(candidate) || !hasWorkingGit,
  );
  const xcodeLicenseCandidate = discovery.candidates.find((candidate) =>
    isXcodeLicenseCandidate(candidate)
  );
  const pill = describeGitStatusPill(discovery, xcodeLicenseCandidate);

  const refresh = async (): Promise<void> => {
    setLoading(true);
    try {
      await props.onRefresh();
    } finally {
      setLoading(false);
    }
  };

  return (
    <SettingsSection
      eyebrow="Git"
      title="Git"
      description={
        <>
          PwrAgent uses <code>git</code> to inspect repositories and create
          worktrees for new threads.
        </>
      }
    >
      <div className="settings-fields">
        <SettingsField
          label="Command status"
          sub="Checks the git command PwrAgent will use for repository and worktree operations."
          source={selected?.source ?? "auto"}
          control={
            <div className="settings-gh-status">
              <span className={`settings-pill settings-pill--${pill.tone}`}>
                {pill.label}
              </span>
              {selected?.command ? (
                <span className="settings-pathrow__path">
                  Path: <code>{selected.command}</code>
                </span>
              ) : null}
              {selected?.version ? (
                <span className="settings-pathrow__path">
                  Version: <code>{selected.version}</code>
                </span>
              ) : null}
              {xcodeLicenseCandidate ? (
                <div className="settings-gh-status">
                  <span className="settings-pathrow__path settings-error">
                    Apple&apos;s Git at <code>{xcodeLicenseCandidate.command}</code>{" "}
                    is blocked by the Xcode license check.
                  </span>
                  <span className="settings-pathrow__path">
                    Run this in Terminal, then follow the prompts:
                  </span>
                  <span className="settings-pathrow__path">
                    <code>{XCODE_LICENSE_REMEDIATION_COMMAND}</code>
                  </span>
                  <div className="settings-inline-actions">
                    <button
                      className="button button--secondary"
                      type="button"
                      onClick={() =>
                        void copyText(
                          XCODE_LICENSE_REMEDIATION_COMMAND,
                          props.desktopApi,
                        )
                      }
                    >
                      Copy command
                    </button>
                  </div>
                </div>
              ) : null}
              <div className="settings-inline-actions">
                <button
                  className="button button--secondary"
                  disabled={loading || props.saving}
                  type="button"
                  onClick={() => void refresh()}
                >
                  {loading ? "Checking…" : "Re-check"}
                </button>
              </div>
            </div>
          }
        />
        <SettingsField
          label="Available paths"
          sub={
            hasWorkingGit
              ? "Detected on this machine. The selected path is used."
              : "No working git executable was found. These are the paths PwrAgent checked."
          }
          control={
            <div className="settings-paths" aria-label="Git discovery">
              {visibleCandidates.length === 0 ? (
                <p className="settings-empty">No git candidates found.</p>
              ) : (
                visibleCandidates.map((candidate) => (
                  <GitCandidateRow
                    key={`${candidate.source}:${candidate.command}`}
                    candidate={candidate}
                  />
                ))
              )}
            </div>
          }
        />
      </div>
    </SettingsSection>
  );
}

function GhStatusPanel(props: {
  desktopApi?: DesktopApi;
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  onSaveGhPath: (path: string) => Promise<void>;
}) {
  const desktopApi = props.desktopApi;
  const [status, setStatus] = useState<GhStatus | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const gh = props.snapshot.applications.gh;
  const envForced = gh.path.source === "env";
  const discovery = status?.discovery ?? gh.discovery;
  const candidates = discovery.candidates;

  const load = useCallback(
    async (recheck: boolean) => {
      if (!desktopApi?.getGhStatus) return;
      setLoading(true);
      setError(undefined);
      try {
        const next = await desktopApi.getGhStatus({ recheck });
        setStatus(next);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setLoading(false);
      }
    },
    [desktopApi],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const pill = describeGhStatusPill(status);
  const selected = discovery.candidates.find((candidate) => candidate.selected);
  const resolvedCommand = selected?.command ?? discovery.selectedCommand;
  const resolvedVersion = selected?.version;
  const sourceLabel = gh.path.source === "default" ? "auto" : gh.path.source;
  const saveGhPath = async (path: string): Promise<void> => {
    await props.onSaveGhPath(path);
    await load(true);
  };

  return (
    <SettingsSection
      eyebrow="Git"
      title="GitHub CLI (gh)"
      description={
        <>
          PwrAgent uses <code>gh</code> to read pull request status for thread chips.
          It never opens, comments on, or merges PRs.
        </>
      }
    >
      <div className="settings-fields">
        <SettingsField
          label="Connection status"
          sub="Checks the selected gh path and GitHub auth scopes."
          source={sourceLabel}
          control={
            <div className="settings-gh-status">
              <span
                className={`settings-pill settings-pill--${pill.tone}`}
                aria-live="polite"
              >
                {pill.label}
              </span>
              {resolvedCommand ? (
                <span className="settings-pathrow__path">
                  Path: <code>{resolvedCommand}</code>
                </span>
              ) : null}
              {resolvedVersion ? (
                <span className="settings-pathrow__path">
                  Version: <code>{resolvedVersion}</code>
                </span>
              ) : null}
              {status?.account ? (
                <span className="settings-pathrow__path">
                  Signed in as <strong>{status.account}</strong>
                </span>
              ) : null}
              {status && status.installed && status.scopes.length > 0 ? (
                <span className="settings-pathrow__path">
                  Scopes: {status.scopes.join(", ")}
                </span>
              ) : null}
              {status?.reason ? (
                <span className="settings-pathrow__path">{status.reason}</span>
              ) : null}
              {error ? (
                <span className="settings-pathrow__path settings-error">{error}</span>
              ) : null}
              <div className="settings-inline-actions">
                <button
                  className="button button--secondary"
                  disabled={loading || !desktopApi?.getGhStatus}
                  type="button"
                  onClick={() => void load(true)}
                >
                  {loading ? "Checking…" : "Re-check"}
                </button>
              </div>
            </div>
          }
        />
        {gh.path.value.trim() || envForced ? (
          <SettingsField
            label="Discovery mode"
            sub="Clear the override and use the first discovered gh candidate."
            source={envForced ? "env override active" : "config"}
            control={
              <SettingsPathRow
                title="Auto discovery"
                chips={[{ label: "default", tone: "muted" }]}
                selected={false}
                disabled={props.saving || envForced}
                useLabel="Auto"
                onUse={() => void saveGhPath("")}
              />
            }
          />
        ) : null}
        <SettingsField
          label="Available paths"
          sub={
            candidates.some((candidate) => candidate.executable)
              ? "Detected on this machine. The selected path is used."
              : "No executable gh was found. These are the paths PwrAgent checked."
          }
          control={
            <div className="settings-paths" aria-label="GitHub CLI discovery">
              {candidates.length === 0 ? (
                <p className="settings-empty">No gh candidates found.</p>
              ) : (
                candidates.map((candidate) => (
                  <GhCandidateRow
                    key={`${candidate.source}:${candidate.command}`}
                    candidate={candidate}
                    disabled={props.saving || envForced}
                    onUse={(command) => void saveGhPath(command)}
                  />
                ))
              )}
            </div>
          }
        />
        <SettingsField
          label="Manual path"
          sub="Pick a gh executable outside the discovered locations."
          control={
            <div className="settings-inline-actions">
              <button
                className="button button--secondary"
                disabled={props.saving || envForced || !desktopApi?.pickGhCommand}
                type="button"
                onClick={() => {
                  void (async () => {
                    if (!desktopApi?.pickGhCommand) return;
                    setError(undefined);
                    const result = await desktopApi.pickGhCommand();
                    if (result.canceled) return;
                    if (result.error || !result.path) {
                      setError(result.error ?? "No gh path was selected.");
                      return;
                    }
                    await saveGhPath(result.path);
                  })();
                }}
              >
                Choose…
              </button>
            </div>
          }
        />
      </div>
    </SettingsSection>
  );
}

function GitCandidateRow(props: {
  candidate: DesktopGitDiscoveryCandidate;
}) {
  const candidate = props.candidate;
  const failureLabel = describeCommandDiscoveryFailure(candidate.failureReason);
  const chips: SettingsPathRowChip[] = [
    { label: describeGitCandidateSource(candidate.source), tone: "muted" },
  ];
  if (candidate.executable) {
    chips.push({
      label: candidate.version ?? "version unknown",
      tone: candidate.version ? "muted" : "err",
    });
  } else {
    chips.push({
      label: failureLabel ?? "Unavailable",
      tone: isXcodeLicenseCandidate(candidate) ? "warn" : "err",
    });
  }

  return (
    <SettingsPathRow
      title={candidate.command}
      path={commandDiscoveryFailureDetail(candidate.failureReason)}
      pathIsDetail
      chips={chips}
      selected={candidate.selected}
      disabled
    />
  );
}

function GhCandidateRow(props: {
  candidate: DesktopGhDiscoveryCandidate;
  disabled?: boolean;
  onUse: (command: string) => void;
}) {
  const candidate = props.candidate;
  const unavailableLabel = describeCommandDiscoveryFailure(candidate.failureReason);
  const chips: SettingsPathRowChip[] = [
    { label: candidate.source, tone: "muted" },
  ];
  if (candidate.executable) {
    // Only a real version belongs in the version slot. Routing a failure
    // label through here produced rows reading "Launch failed" next to
    // "Available"; the reason now rides the detail line instead.
    chips.push({
      label: candidate.version ?? "version unknown",
      tone: candidate.version ? "muted" : "err",
    });
  } else {
    chips.push({
      label: unavailableLabel ?? "Unavailable",
      tone: "err",
    });
  }
  if (candidate.executable && !candidate.selected) {
    chips.push({
      label: "Available",
      tone: "muted",
    });
  }

  return (
    <SettingsPathRow
      title={candidate.command}
      path={commandDiscoveryFailureDetail(
        candidate.failureReason ?? candidate.versionFailureReason,
      )}
      pathIsDetail
      chips={chips}
      selected={candidate.selected}
      disabled={props.disabled || !candidate.executable}
      onUse={candidate.executable ? () => props.onUse(candidate.command) : undefined}
    />
  );
}

function describeGitStatusPill(
  discovery: DesktopSettingsSnapshot["applications"]["git"]["discovery"],
  xcodeLicenseCandidate?: DesktopGitDiscoveryCandidate,
): {
  tone: "ok" | "warn" | "bad" | "neutral";
  label: string;
} {
  if (discovery.selectedCommand) {
    return xcodeLicenseCandidate
      ? { tone: "warn", label: "Available" }
      : { tone: "ok", label: "Available" };
  }
  if (xcodeLicenseCandidate) {
    return { tone: "bad", label: "Xcode license required" };
  }
  return { tone: "bad", label: "Not available" };
}

function describeGitCandidateSource(
  source: DesktopGitDiscoveryCandidate["source"],
): string {
  if (source === "xcode") return "Apple Git";
  if (source === "homebrew") return "Homebrew";
  if (source === "env") return "env";
  if (source === "path") return "PATH";
  return source;
}

function describeXcodeLicenseFailure(reason: string): string | undefined {
  return isXcodeLicenseFailure(reason) ? "Xcode license" : undefined;
}

function describeCommandDiscoveryFailure(reason?: string): string | undefined {
  return describeSharedCommandDiscoveryFailure(reason, describeXcodeLicenseFailure);
}

function commandDiscoveryFailureDetail(reason?: string): string | undefined {
  return sharedCommandDiscoveryFailureDetail(reason, describeXcodeLicenseFailure);
}

function isXcodeLicenseCandidate(
  candidate: DesktopGitDiscoveryCandidate,
): boolean {
  return candidate.command === "/usr/bin/git"
    && isXcodeLicenseFailure(candidate.failureReason ?? candidate.versionFailureReason);
}

function isXcodeLicenseFailure(reason?: string): boolean {
  return Boolean(
    reason?.includes("Xcode license")
      || reason?.includes("license agreements")
      || reason?.includes("xcodebuild -license"),
  );
}

function describeGhStatusPill(status: GhStatus | undefined): {
  tone: "ok" | "warn" | "bad" | "neutral";
  label: string;
} {
  if (!status) return { tone: "neutral", label: "Checking…" };
  if (!status.installed) return { tone: "bad", label: "Not installed" };
  if (!status.loggedIn) return { tone: "bad", label: "Not signed in" };
  if (!status.hasRepoScope)
    return { tone: "warn", label: "Missing `repo` scope" };
  return { tone: "ok", label: "Connected" };
}
