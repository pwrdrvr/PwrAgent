import { Fragment, useEffect, useRef, useState } from "react";
import type {
  AcpAgentSettingsEntry,
  AcpManagedBuildStatus,
  DesktopSettingsSnapshot,
  DesktopSettingsValue,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { managedGrokReleaseUrl } from "../../lib/grok-build-channel";
import { BACKEND_SUMMARIES_REFRESH_EVENT } from "../../lib/useBackendSummaries";
import { SettingsField, SettingsSection, ToggleField } from "./SettingsLayout";
import { SettingsCopyValue } from "./SettingsCopyValue";
import { SettingsPathRow, type SettingsPathRowChip } from "./SettingsPathRow";
import { acpRelativeTime, acpStatusLabel } from "./acp-agent-copy";
import {
  acpAgentEnabledInSnapshot,
  displayOrderedAcpEntries,
} from "./useAcpAgentCatalog";

const KIMI_CODE_INSTALL_GUIDE_URL =
  "https://www.kimi.com/help/kimi-code/cli-getting-started";
const KIMI_CODE_INSTALL_COMMAND =
  "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash";
const KIMI_CODE_WINDOWS_INSTALL_COMMAND =
  "irm https://code.kimi.com/kimi-code/install.ps1 | iex";

type AcpCliPathUpdateResult =
  | { saved: false }
  | {
      saved: true;
      verification: "verified" | "failed" | "deferred";
    };

/** Look up the persisted CLI-path override for an agent by its registry id. */
function cliPathSnapshotFor(
  snapshot: DesktopSettingsSnapshot | undefined,
  registryId: string,
): DesktopSettingsValue<string> | undefined {
  const agents = snapshot?.acpAgents as
    | Record<string, { cliPath?: DesktopSettingsValue<string> } | undefined>
    | undefined;
  return agents?.[registryId]?.cliPath;
}

function managedGrokBuildsSnapshot(
  snapshot: DesktopSettingsSnapshot | undefined,
): boolean {
  return snapshot?.acpAgents.grok?.managedBuilds !== false;
}

/**
 * Renders each discovered ACP agent (Gemini / Grok / Kimi / Qwen) as its own
 * `SettingsSection`, styled identically to the Codex section (SettingsField
 * rows + the shared SettingsPathRow install list). Returns a FRAGMENT — no
 * stack/header of its own — so the caller (ModelsSettings) renders these as
 * siblings of the Codex section inside one "Backends & credentials" stack.
 */
export function AcpAgentsSettings(props: {
  catalogRefreshing?: boolean;
  desktopApi?: DesktopApi;
  /** Render only the agent with this registry id — the focused
   *  per-provider screen. Omitted = every discovered agent. */
  only?: string;
  saving?: boolean;
  snapshot?: DesktopSettingsSnapshot;
  /** Persist a per-agent CLI-path override (also used to "pin" a discovered
   *  install — picking an install writes its command as the override). */
  onCliPathChange?: (registryId: string, cliPath: string) => Promise<boolean>;
  /** Persist a per-agent enabled flag (off = hidden from the model picker). */
  onEnabledChange?: (registryId: string, enabled: boolean) => Promise<void>;
  /** Persist whether PwrAgent downloads and prefers its Grok fork build. */
  onManagedGrokBuildsChange?: (enabled: boolean) => Promise<boolean>;
}) {
  const [entries, setEntries] = useState<AcpAgentSettingsEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function refresh(
    refreshRegistry = false,
    force = false,
  ): Promise<boolean> {
    if (!props.desktopApi?.listAcpAgents) {
      setError("ACP registry controls are unavailable in this build.");
      setLoading(false);
      return false;
    }
    if (!refreshRegistry && entries.length === 0) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }
    try {
      const response = await props.desktopApi.listAcpAgents({
        ...(refreshRegistry
          ? { discoveryIntent: "settings-user-action" as const }
          : {}),
        refresh: refreshRegistry,
        ...(force ? { force: true } : {}),
        ...(refreshRegistry && props.only
          ? { registryIds: [props.only] }
          : {}),
      });
      setEntries(response.entries);
      setError(response.error);
      if (refreshRegistry) {
        window.dispatchEvent(new Event(BACKEND_SUMMARIES_REFRESH_EVENT));
      }
      return true;
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
      return false;
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  // Run the initial cache read exactly once. Mounting or focusing a provider
  // must never probe or launch it; the row's Refresh/Save actions own that
  // provider-scoped discovery budget. The ref only collapses StrictMode's
  // double-invoked mount effect.
  const didInitialLoad = useRef(false);
  useEffect(() => {
    if (didInitialLoad.current) {
      return;
    }
    if (!props.desktopApi?.listAcpAgents) {
      void refresh(false);
      return;
    }
    didInitialLoad.current = true;
    void refresh(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.desktopApi]);

  const visibleEntries = props.only
    ? entries.filter((entry) => entry.registryId === props.only)
    : displayOrderedAcpEntries(entries);

  return (
    <>
      {visibleEntries.map((entry) => (
        <Fragment key={entry.backendId}>
          {entry.registryId === "kimi"
          && entry.incompatibleInstances?.length ? (
            <LegacyKimiCompatibilityCard
              desktopApi={props.desktopApi}
              entry={entry}
            />
          ) : null}
          <AcpAgentSection
            entry={entry}
            cliPathSnapshot={cliPathSnapshotFor(props.snapshot, entry.registryId)}
            enabled={acpAgentEnabledInSnapshot(props.snapshot, entry.registryId)}
            managedGrokBuilds={managedGrokBuildsSnapshot(props.snapshot)}
            saving={props.saving}
            refreshing={refreshing || loading || props.catalogRefreshing}
            onCliPathChange={
              props.onCliPathChange
                ? async (registryId, cliPath) => {
                    const saved = await props.onCliPathChange?.(
                      registryId,
                      cliPath,
                    );
                    if (!saved) {
                      return { saved: false };
                    }
                    if (!acpAgentEnabledInSnapshot(props.snapshot, registryId)) {
                      return { saved: true, verification: "deferred" };
                    }
                    return {
                      saved: true,
                      verification: await refresh(true, true)
                        ? "verified"
                        : "failed",
                    };
                  }
                : undefined
            }
            onEnabledChange={props.onEnabledChange}
            onManagedGrokBuildsChange={props.onManagedGrokBuildsChange}
            onRefresh={() => refresh(true, true)}
          />
        </Fragment>
      ))}
      {!loading && visibleEntries.length === 0 ? (
        <SettingsSection
          eyebrow="Models"
          title="AI providers"
          sectionId="acp-unavailable"
        >
          <p className="settings-empty">
            {error
              ?? (props.only
                ? "This provider is unavailable right now."
                : "No AI providers are available right now.")}
          </p>
        </SettingsSection>
      ) : null}
    </>
  );
}

function LegacyKimiCompatibilityCard(props: {
  desktopApi?: DesktopApi;
  entry: AcpAgentSettingsEntry;
}) {
  const incompatibleInstances = props.entry.incompatibleInstances ?? [];
  const hasCurrentKimiCode = props.entry.installed;
  const installCommand = /Windows/i.test(window.navigator.userAgent)
    ? KIMI_CODE_WINDOWS_INSTALL_COMMAND
    : KIMI_CODE_INSTALL_COMMAND;

  return (
    <SettingsSection
      eyebrow="Compatibility"
      title={
        hasCurrentKimiCode
          ? "Legacy Python kimi-cli ignored"
          : "Current Kimi Code required"
      }
      sectionId="kimi-compatibility"
      chip={hasCurrentKimiCode ? "Legacy ignored" : "Action required"}
      chipKind="warn"
    >
      <div className="settings-fields">
        <SettingsField
          label="Provider collision"
          sub={
            hasCurrentKimiCode
              ? "PwrAgent found the supported Kimi Code install and will not launch these older Python binaries."
              : "The detected kimi command is the retired Python kimi-cli. Its ACP models are incompatible with current Kimi Code and are excluded from model discovery."
          }
          source={`${incompatibleInstances.length} ignored`}
          control={
            <div
              className="settings-paths"
              aria-label="Ignored legacy Kimi installs"
            >
              {incompatibleInstances.map((instance) => (
                <SettingsPathRow
                  key={instance.command}
                  path={instance.command}
                  chips={[
                    { label: "legacy Python", tone: "muted" },
                    {
                      label: instance.version
                        ? `v${instance.version}`
                        : "version unknown",
                      tone: "muted",
                    },
                  ]}
                  selected={false}
                  disabled
                />
              ))}
            </div>
          }
        />
        {!hasCurrentKimiCode ? (
          <SettingsField
            label="Install Kimi Code"
            sub="Install the current TypeScript-based CLI, then click Refresh in the Kimi Code section. PwrAgent also checks the official ~/.kimi-code/bin location automatically."
            control={
              <div className="settings-fields">
                <SettingsCopyValue
                  value={installCommand}
                  desktopApi={props.desktopApi}
                  label="Kimi Code install command"
                />
                <div className="settings-inline-actions">
                  <a
                    className="button button--secondary"
                    href={KIMI_CODE_INSTALL_GUIDE_URL}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open install guide
                  </a>
                </div>
              </div>
            }
          />
        ) : null}
      </div>
    </SettingsSection>
  );
}

function AcpAgentSection(props: {
  entry: AcpAgentSettingsEntry;
  cliPathSnapshot: DesktopSettingsValue<string> | undefined;
  enabled: boolean;
  managedGrokBuilds: boolean;
  saving?: boolean;
  refreshing?: boolean;
  onCliPathChange?: (
    registryId: string,
    cliPath: string,
  ) => Promise<AcpCliPathUpdateResult>;
  onEnabledChange?: (registryId: string, enabled: boolean) => Promise<void>;
  onManagedGrokBuildsChange?: (enabled: boolean) => Promise<boolean>;
  onRefresh: () => Promise<boolean>;
}) {
  const { entry, enabled } = props;
  const instances = entry.instances ?? [];
  const rejectedInstances = entry.rejectedInstances ?? [];
  const savedPath = props.cliPathSnapshot?.value ?? "";
  const [draft, setDraft] = useState(savedPath);
  const [pathUpdating, setPathUpdating] = useState(false);
  const [pathActionError, setPathActionError] = useState<string | undefined>();
  useEffect(() => {
    setDraft(savedPath);
  }, [savedPath]);

  const detail =
    entry.lastDiscoveryError ?? entry.lastError ?? entry.unavailableReason;
  const normalizedSavedPath = savedPath.trim();
  const envForced = props.cliPathSnapshot?.source === "env";
  const checkingPath = pathUpdating || props.refreshing === true;
  const overrideActive =
    enabled
    && normalizedSavedPath !== ""
    && entry.activeCommand === normalizedSavedPath;
  const activeOverrideInstance = overrideActive
    ? instances.find((instance) => instance.command === normalizedSavedPath)
    : undefined;
  const overrideHelp = normalizedSavedPath === ""
    ? undefined
    : !enabled
      ? "Enable this provider, then click Refresh to verify the saved path before use."
      : checkingPath
        ? "Checking this path and provider capabilities…"
        : overrideActive
          ? `Active for new threads${activeOverrideInstance?.version
            ? ` · v${activeOverrideInstance.version}`
            : ""}.`
          : undefined;
  // A manual path that resolves to a PwrAgent-managed version directory turns
  // an auto-updating channel into a permanent pin: newer verified builds keep
  // downloading and never run. Nothing else on the pane says so, and clicking
  // "Use" on a managed row is enough to end up here.
  const pinnedManagedBuild =
    entry.registryId === "grok"
    && overrideActive
    && entry.managedBuild?.pinnedBehind === true
      ? entry.managedBuild
      : undefined;
  const inactiveOverrideError =
    enabled
    && normalizedSavedPath !== ""
    && !checkingPath
    && !overrideActive
      ? entry.activeCommand
        ? `Saved override is not active. New threads currently use ${entry.activeCommand}.`
        : "Saved override is not active. This provider cannot launch new threads."
      : undefined;

  async function commitPath(nextPath: string): Promise<void> {
    if (!props.onCliPathChange) {
      return;
    }
    setDraft(nextPath);
    setPathActionError(undefined);
    setPathUpdating(true);
    try {
      const result = await props.onCliPathChange(entry.registryId, nextPath);
      if (!result.saved) {
        setDraft(savedPath);
        setPathActionError("PwrAgent couldn't save this path.");
      } else if (result.verification === "failed") {
        setPathActionError(
          "Path was saved, but PwrAgent couldn't verify it. Click Refresh to try again.",
        );
      }
    } catch (error) {
      setDraft(savedPath);
      setPathActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setPathUpdating(false);
    }
  }

  async function refreshPathStatus(): Promise<void> {
    setPathActionError(undefined);
    const refreshed = await props.onRefresh();
    if (!refreshed && normalizedSavedPath !== "") {
      setPathActionError(
        "PwrAgent couldn't verify the saved path. Click Refresh to try again.",
      );
    }
  }

  const pathControlsDisabled =
    props.saving || pathUpdating || props.refreshing || envForced;

  return (
    <SettingsSection
      eyebrow="Models"
      title={entry.name}
      sectionId={`acp-${entry.registryId}`}
      chip={enabled ? acpStatusLabel(entry) : "Disabled"}
      chipKind={enabled ? (entry.installed ? "ok" : "muted") : "muted"}
    >
      <div className="settings-fields">
        {props.onEnabledChange ? (
          <ToggleField
            checked={enabled}
            disabled={props.saving || pathUpdating || props.refreshing}
            label="Enabled"
            switchQualifier={entry.name}
            sub="Show this agent in the model picker and launch threads with it."
            onChange={(next) => {
              // Guarded above, but the optional call still types as possibly
              // undefined and the row needs a promise to hold pending on.
              return props.onEnabledChange?.(entry.registryId, next)
                ?? Promise.resolve();
            }}
          />
        ) : null}

        {entry.registryId === "grok" && props.onManagedGrokBuildsChange ? (
          <ToggleField
            checked={props.managedGrokBuilds}
            disabled={props.saving || pathUpdating || props.refreshing || !enabled}
            label="PwrAgent build"
            switchQualifier="Grok"
            // The row holds pending across the config write AND the agent
            // rescan chained below, so "Saving…" would name only the first
            // and shortest part of the wait.
            pendingLabel="Saving and rescanning…"
            source={entry.managedBuild?.repository}
            sub="PwrAgent downloads, verifies and installs Grok builds from pwrdrvr/grok-build. New threads use the newest verified build. Packaged macOS and Windows apps require platform signing; manual paths still win."
            actions={
              props.managedGrokBuilds && entry.managedBuild ? (
                <ManagedBuildStatus
                  managedBuild={entry.managedBuild}
                  // Deliberately not `pathControlsDisabled`: that folds in
                  // `envForced`, which says the CLI *path* comes from the
                  // environment. A release check has nothing to do with which
                  // path is in effect, so an env override must not disable it.
                  busy={props.saving === true || pathUpdating}
                  refreshing={props.refreshing === true}
                  onCheckForUpdates={() => void refreshPathStatus()}
                  onUseNewestBuild={
                    // Clearing the config override cannot dislodge an
                    // environment one, so the button is absent rather than
                    // disabled when it could not do what it says.
                    props.onCliPathChange && !envForced
                      ? () => {
                          void commitPath("");
                        }
                      : undefined
                  }
                />
              ) : null
            }
            onChange={(next) => {
              // The refresh is awaited rather than floated, so the row stays
              // pending until the agent list actually reflects the change.
              return props.onManagedGrokBuildsChange?.(next).then((saved) => {
                if (saved) {
                  return props.onRefresh();
                }
              }) ?? Promise.resolve();
            }}
          />
        ) : null}

        <SettingsField
          label="Detected paths"
          sub={
            enabled
              ? "Binaries detected on this machine. The active one runs new threads — click Use to pick another."
              : "Previously detected binaries. Enable this provider and Refresh before launching new threads."
          }
          source={`${instances.length + rejectedInstances.length} found`}
          error={detail}
          control={
            <div className="settings-paths" aria-label={`${entry.name} installs`}>
              {instances.length === 0 && rejectedInstances.length === 0 ? (
                <p className="settings-empty">Not installed.</p>
              ) : (
                <>
                  {instances.map((instance) => {
                    const active =
                      enabled && instance.command === entry.activeCommand;
                    const newestManagedBuild =
                      instance.pwrAgentBuildTag !== undefined
                      && instance.pwrAgentBuildTag
                        === entry.managedBuild?.installedTag;
                    // Explicit keys: this array is spliced between renders
                    // (the channel chip appears once discovery labels the
                    // instance), and SettingsPathRow's `tone-index` fallback
                    // only holds for a stable array.
                    const chips: SettingsPathRowChip[] = [];
                    // Which product this binary is, before which version it
                    // is: "v1.0.5" next to "v1.0.4-pwragent.2" reads as one
                    // release behind until you know they are different builds
                    // from different publishers.
                    if (entry.registryId === "grok") {
                      chips.push(
                        instance.pwrAgentBuild
                          ? {
                              key: "channel",
                              label: "PwrAgent build",
                              tone: newestManagedBuild ? "ok" : "muted",
                            }
                          : { key: "channel", label: "xAI build", tone: "muted" },
                      );
                    }
                    chips.push(
                      {
                        key: "source",
                        label: instance.source === "override" ? "override" : "path",
                        tone: "muted",
                      },
                      {
                        key: "version",
                        label: instance.version
                          ? `v${instance.version}`
                          : "version unknown",
                        tone: "muted",
                      },
                    );
                    if (!active) {
                      chips.push({
                        key: "availability",
                        label: "available",
                        tone: "muted",
                      });
                    }
                    return (
                      <SettingsPathRow
                        key={instance.command}
                        path={instance.command}
                        chips={chips}
                        selected={active}
                        selectedLabel="Using"
                        useLabel="Use"
                        disabled={pathControlsDisabled}
                        onUse={
                          props.onCliPathChange
                            ? () => {
                                void commitPath(instance.command);
                              }
                            : undefined
                        }
                      />
                    );
                  })}
                  {rejectedInstances.map((instance) => (
                    <SettingsPathRow
                      key={instance.command}
                      path={instance.command}
                      chips={[
                        {
                          label: instance.source === "override" ? "override" : "path",
                          tone: "muted",
                        },
                        {
                          label: instance.version
                            ? `v${instance.version}`
                            : "version unknown",
                          tone: "muted",
                        },
                        {
                          label: rejectedAcpInstanceLabel(instance.reason),
                          tone: "muted",
                        },
                      ]}
                      selected={false}
                    />
                  ))}
                </>
              )}
            </div>
          }
        />

        {props.onCliPathChange ? (
          <SettingsField
            label="Manual path"
            sub={
              envForced
                ? "This path is controlled by an environment override set before PwrAgent launched."
                : enabled
                  ? "Enter an absolute path. Save checks it immediately and updates the binary used by new threads."
                  : "Save an absolute path now. Enable this provider, then Refresh to verify it before use."
            }
            source={
              envForced
                ? "env override"
                : pinnedManagedBuild
                  ? "pinning a PwrAgent build"
                  : overrideActive
                    ? "active override"
                    : normalizedSavedPath
                      ? "saved override"
                      : undefined
            }
            help={
              pinnedManagedBuild
                ? `This path pins one PwrAgent build. ${pinnedManagedBuild.installedTag} is already downloaded and verified but will never run. Clear it to follow the newest build again.`
                : overrideHelp
            }
            error={pathActionError ?? inactiveOverrideError}
            control={
              <div className="settings-secret">
                <input
                  aria-label={`${entry.name} manual path`}
                  aria-invalid={Boolean(pathActionError ?? inactiveOverrideError)}
                  className="settings-input"
                  disabled={pathControlsDisabled}
                  placeholder="Manual path — e.g. /Users/you/.local/bin/agent"
                  type="text"
                  value={draft}
                  onChange={(event) => setDraft(event.currentTarget.value)}
                />
                <button
                  className="button button--secondary"
                  disabled={
                    pathControlsDisabled
                    || draft.trim() === normalizedSavedPath
                  }
                  type="button"
                  onClick={() => void commitPath(draft.trim())}
                >
                  {pathUpdating ? "Checking…" : "Save"}
                </button>
                <button
                  className="button button--ghost"
                  disabled={pathControlsDisabled || draft === ""}
                  type="button"
                  onClick={() => void commitPath("")}
                >
                  Clear
                </button>
              </div>
            }
          />
        ) : null}

        <SettingsField
          label="Re-probe"
          sub={
            entry.registryId === "grok" && entry.managedBuild
              ? "Re-run discovery for enabled agents (versions, installs, capabilities). Release checks have their own control above."
              : "Re-run discovery for enabled agents (versions, installs, capabilities)."
          }
          control={
            <div className="settings-inline-actions">
              <button
                className="button button--secondary"
                disabled={props.refreshing || pathUpdating}
                type="button"
                onClick={() => void refreshPathStatus()}
              >
                {props.refreshing ? "Discovering…" : "Refresh"}
              </button>
            </div>
          }
        />
      </div>
    </SettingsSection>
  );
}

/**
 * The PwrAgent build channel, reported as a channel rather than as a switch.
 *
 * Four facts in the order an operator asks for them: which tag is installed,
 * whether it is the one running, when PwrAgent last checked, and what to press.
 * There is deliberately no "install" verb in the common case — on this channel
 * PwrAgent has already downloaded, verified and installed the newest build, so
 * asking the operator to install it would be asking for work already done. The
 * one state that needs a person is a manual path pinning an older build, which
 * never resolves on its own.
 */
function ManagedBuildStatus(props: {
  busy: boolean;
  managedBuild: AcpManagedBuildStatus;
  refreshing: boolean;
  onCheckForUpdates: () => void;
  onUseNewestBuild?: () => void;
}) {
  const { managedBuild } = props;
  const pinned = managedBuild.pinnedBehind === true;
  const checkedAt = managedBuild.checkedAt;
  // Three states, because "installed" and "running" are different facts. An
  // operator whose manual path points at a vendor install has the newest
  // verified build on disk and is not running any of it; saying only
  // "installed · newest verified build" would read as "this is what my threads
  // use".
  const inUse = managedBuild.activeTag !== undefined;
  return (
    <div className="acp-build">
      <p className="acp-build__line">
        {managedBuild.installedTag ? (
          <>
            <span
              className={`status-dot${inUse && !pinned ? " status-dot--ok" : " status-dot--warning"}`}
              aria-hidden="true"
            />
            <span className="acp-build__tag">{managedBuild.installedTag}</span>
            <span className="acp-build__state">
              {pinned
                ? `installed and verified · not in use, a manual path pins ${managedBuild.activeTag}`
                : inUse
                  ? "installed · newest verified build"
                  : "installed and verified · not in use, another Grok install is active"}
              {checkedAt !== undefined
                ? ` · checked ${acpRelativeTime(checkedAt)}`
                : ""}
            </span>
          </>
        ) : (
          <>
            <span className="status-dot" aria-hidden="true" />
            <span className="acp-build__state">
              No verified build downloaded yet.
            </span>
          </>
        )}
      </p>
      <div className="settings-inline-actions">
        {pinned && props.onUseNewestBuild ? (
          <button
            className="button button--primary"
            disabled={props.busy}
            type="button"
            onClick={props.onUseNewestBuild}
          >
            Use newest build
          </button>
        ) : null}
        <button
          className="button button--secondary"
          disabled={props.busy}
          type="button"
          onClick={props.onCheckForUpdates}
        >
          {props.refreshing ? "Checking…" : "Check for updates"}
        </button>
        {managedBuild.installedTag ? (
          <a
            className="button button--ghost"
            href={managedGrokReleaseUrl(
              managedBuild.repository,
              managedBuild.installedTag,
            )}
            target="_blank"
            rel="noreferrer"
          >
            Release notes
          </a>
        ) : null}
      </div>
    </div>
  );
}

function rejectedAcpInstanceLabel(
  reason: NonNullable<AcpAgentSettingsEntry["rejectedInstances"]>[number]["reason"],
): string {
  switch (reason) {
    case "probe-timed-out":
      return "ACP check timed out";
    case "version-probe-failed":
      return "version check failed";
    case "acp-help-mismatch":
      return "not recognized as ACP";
    default:
      return "ACP check failed";
  }
}
