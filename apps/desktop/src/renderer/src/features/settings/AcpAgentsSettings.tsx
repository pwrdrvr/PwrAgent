import { useEffect, useRef, useState } from "react";
import type {
  AcpAgentInstance,
  AcpAgentSettingsEntry,
  DesktopSettingsSnapshot,
  DesktopSettingsValue,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { SettingsSection } from "./SettingsLayout";
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

export function AcpAgentsSettings(props: {
  desktopApi?: DesktopApi;
  saving?: boolean;
  snapshot?: DesktopSettingsSnapshot;
  /** Persist a per-agent CLI-path override (also used to "pin" a discovered
   *  install — picking an install writes its command as the override). */
  onCliPathChange?: (registryId: string, cliPath: string) => Promise<void>;
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
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
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
    <SettingsSection
      eyebrow="ACP"
      title="ACP agents"
      description="ACP agent CLIs (Gemini, Grok, Kimi, Qwen) PwrAgent found on this machine. Pick which install to use when several are found, or set a manual path. Discovered agents are usable as a chat backend."
    >
      <div className="settings-inline-actions">
        <button
          className="button button--secondary"
          disabled={loading || refreshing}
          type="button"
          onClick={() => {
            // Explicit user action: re-probe every agent, bypassing the cache.
            void refresh(true, true);
          }}
        >
          {refreshing ? "Discovering…" : "Refresh"}
        </button>
      </div>
      {loading ? <p className="settings-empty">Loading ACP agents…</p> : null}
      {error ? <p className="settings-row__error">{error}</p> : null}
      {!loading && entries.length === 0 ? (
        <p className="settings-empty">No ACP agents discovered.</p>
      ) : null}
      <div className="settings-acp-agents">
        {entries.map((entry) => (
          <AcpAgentCard
            key={entry.backendId}
            entry={entry}
            cliPathSnapshot={cliPathSnapshotFor(props.snapshot, entry.registryId)}
            saving={props.saving}
            onCliPathChange={props.onCliPathChange}
          />
        ))}
      </div>
    </SettingsSection>
  );
}

function AcpAgentCard(props: {
  entry: AcpAgentSettingsEntry;
  cliPathSnapshot: DesktopSettingsValue<string> | undefined;
  saving?: boolean;
  onCliPathChange?: (registryId: string, cliPath: string) => Promise<void>;
}) {
  const { entry } = props;
  const instances = entry.instances ?? [];
  const installCount = instances.length;
  const activeInstance = instances.find(
    (instance) => instance.command === entry.activeCommand,
  );
  const pinned = activeInstance?.source === "override";

  const savedPath = props.cliPathSnapshot?.value ?? "";
  const [draft, setDraft] = useState(savedPath);
  useEffect(() => {
    setDraft(savedPath);
  }, [savedPath]);

  const pickInstall = (command: string): void => {
    void props.onCliPathChange?.(entry.registryId, command);
  };

  const summary = [
    `${installCount} install${installCount === 1 ? "" : "s"} found`,
    entry.version ? `active v${entry.version}` : undefined,
    installCount > 0 ? (pinned ? "pinned" : "auto") : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <article className="settings-acp-agent">
      <div className="settings-acp-agent__main">
        <div>
          <h3>{entry.name}</h3>
          <p>{installCount > 0 ? summary : "Not installed"}</p>
        </div>
        <span className="settings-acp-agent__status">{acpStatusLabel(entry)}</span>
      </div>

      {installCount > 0 ? (
        <ul className="settings-acp-instances">
          {instances.map((instance) => (
            <AcpInstanceRow
              key={instance.command}
              instance={instance}
              active={instance.command === entry.activeCommand}
              saving={props.saving}
              onUse={() => pickInstall(instance.command)}
            />
          ))}
        </ul>
      ) : null}

      {props.onCliPathChange ? (
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
            onClick={() => props.onCliPathChange?.(entry.registryId, draft.trim())}
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
      ) : null}

      {entry.lastDiscoveryError || entry.lastError || entry.unavailableReason ? (
        <p className="settings-row__error">
          {entry.lastDiscoveryError ?? entry.lastError ?? entry.unavailableReason}
        </p>
      ) : null}
    </article>
  );
}

function AcpInstanceRow(props: {
  instance: AcpAgentInstance;
  active: boolean;
  saving?: boolean;
  onUse: () => void;
}) {
  const { instance } = props;
  const meta = [
    instance.version ? `v${instance.version}` : undefined,
    instance.source === "override" ? "override" : "found",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className="settings-acp-instance">
      <code className="settings-acp-instance__path">{instance.command}</code>
      <span className="settings-acp-instance__meta">{meta}</span>
      {props.active ? (
        <span className="settings-acp-instance__using">Using</span>
      ) : (
        <button
          className="button button--ghost"
          disabled={props.saving}
          type="button"
          onClick={props.onUse}
        >
          Use
        </button>
      )}
    </li>
  );
}
