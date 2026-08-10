import { Fragment, useEffect, useRef, useState } from "react";
import type {
  AcpAgentSettingsEntry,
  DesktopSettingsSnapshot,
  DesktopSettingsValue,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { BACKEND_SUMMARIES_REFRESH_EVENT } from "../../lib/useBackendSummaries";
import { SettingsField, SettingsSection } from "./SettingsLayout";
import { SettingsCopyValue } from "./SettingsCopyValue";
import { SettingsPathRow, type SettingsPathRowChip } from "./SettingsPathRow";
import { SettingsSwitch } from "./SettingsSwitch";
import { acpStatusLabel } from "./acp-agent-copy";

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

/** Whether an agent is enabled per the snapshot (defaults to enabled). */
function enabledSnapshotFor(
  snapshot: DesktopSettingsSnapshot | undefined,
  registryId: string,
): boolean {
  const agents = snapshot?.acpAgents as
    | Record<string, { enabled?: boolean } | undefined>
    | undefined;
  return agents?.[registryId]?.enabled !== false;
}

/**
 * Renders each discovered ACP agent (Gemini / Grok / Kimi / Qwen) as its own
 * `SettingsSection`, styled identically to the Codex section (SettingsField
 * rows + the shared SettingsPathRow install list). Returns a FRAGMENT — no
 * stack/header of its own — so the caller (ModelsSettings) renders these as
 * siblings of the Codex section inside one "Backends & credentials" stack.
 */
export function AcpAgentsSettings(props: {
  desktopApi?: DesktopApi;
  saving?: boolean;
  snapshot?: DesktopSettingsSnapshot;
  /** Persist a per-agent CLI-path override (also used to "pin" a discovered
   *  install — picking an install writes its command as the override). */
  onCliPathChange?: (registryId: string, cliPath: string) => Promise<boolean>;
  /** Persist a per-agent enabled flag (off = hidden from the model picker). */
  onEnabledChange?: (registryId: string, enabled: boolean) => Promise<void>;
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
        refresh: refreshRegistry,
        ...(force ? { force: true } : {}),
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

  // Run the initial load exactly once. Mount renders cached agents immediately
  // (refresh(false) — pure cache read, no launches), then a registry refresh
  // that only probes undiscovered/stale agents. The ref guards React StrictMode
  // double-invoking this effect in dev (main also coalesces refreshes).
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
    void refresh(false).then(() => refresh(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.desktopApi]);

  return (
    <>
      {entries.map((entry) => (
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
            enabled={enabledSnapshotFor(props.snapshot, entry.registryId)}
            saving={props.saving}
            refreshing={refreshing || loading}
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
                    if (!enabledSnapshotFor(props.snapshot, registryId)) {
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
            onRefresh={() => refresh(true, true)}
          />
        </Fragment>
      ))}
      {!loading && entries.length === 0 ? (
        <SettingsSection
          eyebrow="Models"
          title="AI providers"
          sectionId="acp-unavailable"
        >
          <p className="settings-empty">
            {error ?? "No AI providers are available right now."}
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
  saving?: boolean;
  refreshing?: boolean;
  onCliPathChange?: (
    registryId: string,
    cliPath: string,
  ) => Promise<AcpCliPathUpdateResult>;
  onEnabledChange?: (registryId: string, enabled: boolean) => Promise<void>;
  onRefresh: () => Promise<boolean>;
}) {
  const { entry, enabled } = props;
  const instances = entry.instances ?? [];
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
          <SettingsField
            label="Enabled"
            sub="Show this agent in the model picker and launch threads with it."
            control={
              <SettingsSwitch
                checked={enabled}
                disabled={props.saving || pathUpdating || props.refreshing}
                label={`Enable ${entry.name}`}
                onChange={(next) => {
                  void props.onEnabledChange?.(entry.registryId, next);
                }}
              />
            }
          />
        ) : null}

        <SettingsField
          label="Installed paths"
          sub={
            enabled
              ? "Binaries detected on this machine. The active one runs new threads — click Use to pick another."
              : "Previously detected binaries. Enable this provider and Refresh before launching new threads."
          }
          source={`${instances.length} found`}
          error={detail}
          control={
            <div className="settings-paths" aria-label={`${entry.name} installs`}>
              {instances.length === 0 ? (
                <p className="settings-empty">Not installed.</p>
              ) : (
                instances.map((instance) => {
                  const active =
                    enabled && instance.command === entry.activeCommand;
                  const chips: SettingsPathRowChip[] = [
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
                  ];
                  if (!active) {
                    chips.push({ label: "available", tone: "muted" });
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
                })
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
                : overrideActive
                  ? "active override"
                  : normalizedSavedPath
                    ? "saved override"
                    : undefined
            }
            help={overrideHelp}
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
          sub="Re-run discovery for enabled agents (versions, installs, capabilities)."
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
