import { useEffect, useRef, useState } from "react";
import type {
  AcpAgentSettingsEntry,
  DesktopSettingsSnapshot,
  DesktopSettingsValue,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { SettingsField, SettingsSection } from "./SettingsLayout";
import { SettingsPathRow, type SettingsPathRowChip } from "./SettingsPathRow";
import { SettingsSwitch } from "./SettingsSwitch";
import { acpStatusLabel } from "./acp-agent-copy";

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
  onCliPathChange?: (registryId: string, cliPath: string) => Promise<void>;
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
  ): Promise<void> {
    if (!props.desktopApi?.listAcpAgents) {
      setError("ACP registry controls are unavailable in this build.");
      setLoading(false);
      return;
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
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : String(refreshError),
      );
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
        <AcpAgentSection
          key={entry.backendId}
          entry={entry}
          cliPathSnapshot={cliPathSnapshotFor(props.snapshot, entry.registryId)}
          enabled={enabledSnapshotFor(props.snapshot, entry.registryId)}
          saving={props.saving}
          refreshing={refreshing || loading}
          onCliPathChange={props.onCliPathChange}
          onEnabledChange={props.onEnabledChange}
          onRefresh={() => {
            void refresh(true, true);
          }}
        />
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

function AcpAgentSection(props: {
  entry: AcpAgentSettingsEntry;
  cliPathSnapshot: DesktopSettingsValue<string> | undefined;
  enabled: boolean;
  saving?: boolean;
  refreshing?: boolean;
  onCliPathChange?: (registryId: string, cliPath: string) => Promise<void>;
  onEnabledChange?: (registryId: string, enabled: boolean) => Promise<void>;
  onRefresh: () => void;
}) {
  const { entry, enabled } = props;
  const instances = entry.instances ?? [];
  const savedPath = props.cliPathSnapshot?.value ?? "";
  const [draft, setDraft] = useState(savedPath);
  useEffect(() => {
    setDraft(savedPath);
  }, [savedPath]);

  const detail =
    entry.lastDiscoveryError ?? entry.lastError ?? entry.unavailableReason;

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
                disabled={props.saving}
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
          sub="Binaries detected on this machine. The active one runs new threads — click Use to pick another."
          source={`${instances.length} found`}
          error={detail}
          control={
            <div
              className="settings-paths"
              aria-label={`${entry.name} installs`}
            >
              {instances.length === 0 ? (
                <p className="settings-empty">Not installed.</p>
              ) : (
                instances.map((instance) => {
                  const active = instance.command === entry.activeCommand;
                  const chips: SettingsPathRowChip[] = [
                    {
                      label:
                        instance.source === "override" ? "override" : "path",
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
                      disabled={props.saving}
                      onUse={
                        props.onCliPathChange
                          ? () => {
                              void props.onCliPathChange?.(
                                entry.registryId,
                                instance.command,
                              );
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
            sub="Override discovery with an absolute path. Save, then Refresh to re-probe."
            control={
              <div className="settings-secret">
                <input
                  aria-label={`${entry.name} manual path`}
                  className="settings-input"
                  disabled={props.saving}
                  placeholder="Manual path — e.g. /Users/you/.local/bin/agent"
                  type="text"
                  value={draft}
                  onChange={(event) => setDraft(event.currentTarget.value)}
                />
                <button
                  className="button button--secondary"
                  disabled={props.saving || draft.trim() === savedPath.trim()}
                  type="button"
                  onClick={() =>
                    props.onCliPathChange?.(entry.registryId, draft.trim())
                  }
                >
                  Save
                </button>
                <button
                  className="button button--ghost"
                  disabled={props.saving || draft === ""}
                  type="button"
                  onClick={() => {
                    setDraft("");
                    void props.onCliPathChange?.(entry.registryId, "");
                  }}
                >
                  Clear
                </button>
              </div>
            }
          />
        ) : null}

        <SettingsField
          label="Re-probe"
          sub="Re-run discovery for every agent (versions, installs, capabilities)."
          control={
            <div className="settings-inline-actions">
              <button
                className="button button--secondary"
                disabled={props.refreshing}
                type="button"
                onClick={props.onRefresh}
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
