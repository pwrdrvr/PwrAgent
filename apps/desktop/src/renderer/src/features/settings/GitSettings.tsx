import { useState, type ReactNode } from "react";
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
  type DesktopSettingsSnapshot,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  SettingsField,
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
  ToggleField,
} from "./SettingsLayout";
import { GhToolSection, GitToolSection } from "./CommandToolsSettings";
import { sourceBadge } from "./settings-fields";

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
  onSaveGitPath: (path: string) => Promise<void>;
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

      {/*
        The same two sections the Applications pane renders, from the same
        module over the same config keys. An operator who lands here from a
        git failure repairs it here; one who goes looking for "what do you
        run and from where" finds it under Applications. Neither is a copy.
      */}
      <GitToolSection
        desktopApi={props.desktopApi}
        saving={props.saving}
        snapshot={props.snapshot}
        onRefresh={props.onRefresh}
        onSaveGitPath={props.onSaveGitPath}
      />
      <GhToolSection
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
          <ToggleField
            checked={backgroundPrPolling.value}
            disabled={props.saving}
            label="Enable background pull request status"
            sub="When on, the project you are viewing refreshes about every minute and other open projects refresh less often. Pull requests with no activity for a day stop being checked until you open their thread again. Requires the GitHub CLI to be signed in."
            source={sourceBadge(backgroundPrPolling)}
            onChange={(enabled) => {
              return props.onBackgroundPrPollingChange(enabled);
            }}
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
          <ToggleField
            checked={prAutoDispatchAllowed.value}
            disabled={props.saving || !backgroundPrPolling.value}
            label="Allow Auto-fix PR"
            sub={
              backgroundPrPolling.value
                ? "When enabled, a thread with Auto-fix PR on can receive one bounded repair turn for a newly failing or conflicting pull request."
                : "Turn on background pull request status above before allowing automatic PR repairs."
            }
            source={sourceBadge(prAutoDispatchAllowed)}
            onChange={(enabled) => {
              return props.onPrAutoDispatchAllowedChange(enabled);
            }}
          />
          <ToggleField
            checked={defaultPrAutoDispatchEnabled.value}
            disabled={actionsDisabled || checkingThreadEnable || hasPendingBulkAction}
            label="Enable Auto-fix PR for new threads and launchpads"
            sub={
              backgroundPrPolling.value && prAutoDispatchAllowed.value
                ? "New threads and launchpads start with this choice. Existing launchpads and threads keep their saved choice."
                : "This default is available when background pull request status and Auto-fix PR are allowed."
            }
            source={sourceBadge(defaultPrAutoDispatchEnabled)}
            actions={
              pendingLaunchpadApply ? (
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
              )
            }
            onChange={(enabled) => {
              return props.onDefaultPrAutoDispatchEnabledChange(enabled);
            }}
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
          <ToggleField
            checked={pausePrAutoDispatchWhenBudgetEmpty.value}
            disabled={props.saving}
            label="Pause Auto-fix PR when the budget is empty"
            sub="Pause automatic PR repairs until you acknowledge the safety stop. Thread-level Auto-fix PR choices are left unchanged."
            source={sourceBadge(pausePrAutoDispatchWhenBudgetEmpty)}
            onChange={(enabled) => {
              return props.onPausePrAutoDispatchWhenBudgetEmptyChange(enabled);
            }}
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
