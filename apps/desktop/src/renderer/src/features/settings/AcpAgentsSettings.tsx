import { useEffect, useState } from "react";
import type { AcpAgentSettingsEntry } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
} from "./SettingsLayout";
import { acpStatusLabel } from "./acp-agent-copy";

export function AcpAgentsSettings(props: { desktopApi?: DesktopApi }) {
  const [entries, setEntries] = useState<AcpAgentSettingsEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function refresh(refreshRegistry = false): Promise<void> {
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

  useEffect(() => {
    void refresh(false).then(() => refresh(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.desktopApi]);

  return (
    <SettingsSectionStack paneId="acp-agents" aria-label="ACP agent settings">
      <SettingsPanelHead
        eyebrow="ACP"
        title="ACP Agents"
        help="Manage discovered ACP coding agents and their local runtime capabilities."
      />

      <SettingsSection eyebrow="ACP" title="Known agents">
        <div className="settings-inline-actions">
          <button
            className="button button--secondary"
            disabled={loading || refreshing}
            type="button"
            onClick={() => {
              void refresh(true);
            }}
          >
            {refreshing ? "Discovering..." : "Discover new"}
          </button>
        </div>
        {loading ? <p className="settings-empty">Loading ACP agents...</p> : null}
        {error ? <p className="settings-row__error">{error}</p> : null}
        {!loading && entries.length === 0 ? (
          <p className="settings-empty">No discovered ACP agents found.</p>
        ) : null}
        <div className="settings-acp-agents">
          {entries.map((entry) => (
            <article className="settings-acp-agent" key={entry.backendId}>
              <div className="settings-acp-agent__main">
                <div>
                  <h3>{entry.name}</h3>
                  <p>{entry.description ?? entry.distributionSource}</p>
                </div>
                <span className="settings-acp-agent__status">
                  {acpStatusLabel(entry)}
                </span>
              </div>
              <dl className="settings-acp-agent__meta">
                <div>
                  <dt>Version</dt>
                  <dd>{entry.version ?? "unknown"}</dd>
                </div>
                <div>
                  <dt>License</dt>
                  <dd>{entry.license ?? "unknown"}</dd>
                </div>
                <div>
                  <dt>Distribution</dt>
                  <dd>{entry.distributionKind} · {entry.distributionSource}</dd>
                </div>
                <div>
                  <dt>Verification</dt>
                  <dd>{entry.verificationStatus}</dd>
                </div>
                <div>
                  <dt>Auth</dt>
                  <dd>{formatAcpStatusValue(entry.authStatus)}</dd>
                </div>
                <div>
                  <dt>Last checked</dt>
                  <dd>{formatAcpTimestamp(acpLastCheckedAt(entry))}</dd>
                </div>
                {entry.runtime?.status ? (
                  <div>
                    <dt>Runtime</dt>
                    <dd>
                      {formatAcpStatusValue(entry.runtime.status)}
                      {entry.runtime.source ? ` · ${entry.runtime.source}` : ""}
                    </dd>
                  </div>
                ) : null}
                {entry.runtime?.protocolVersion ? (
                  <div>
                    <dt>Protocol</dt>
                    <dd>{entry.runtime.protocolVersion}</dd>
                  </div>
                ) : null}
                {entry.runtime?.modes?.availableModes.length ? (
                  <div>
                    <dt>Modes</dt>
                    <dd>
                      {entry.runtime.modes.availableModes
                        .map((mode) => mode.label)
                        .join(", ")}
                    </dd>
                  </div>
                ) : null}
                {entry.runtime?.configOptions?.length ? (
                  <div>
                    <dt>Options</dt>
                    <dd>
                      {entry.runtime.configOptions
                        .map((option) => option.label)
                        .join(", ")}
                    </dd>
                  </div>
                ) : null}
                {entry.runtime?.models?.availableModels.length ? (
                  <div>
                    <dt>Models</dt>
                    <dd>
                      {entry.runtime.models.availableModels
                        .map((model) => model.label ?? model.id)
                        .join(", ")}
                    </dd>
                  </div>
                ) : null}
              </dl>
              {entry.repositoryUrl || entry.websiteUrl ? (
                <p className="settings-acp-agent__links">
                  {entry.repositoryUrl ? <span>{entry.repositoryUrl}</span> : null}
                  {entry.websiteUrl ? <span>{entry.websiteUrl}</span> : null}
                </p>
              ) : null}
              {entry.lastDiscoveryError || entry.lastError || entry.unavailableReason ? (
                <p className="settings-row__error">
                  {entry.lastDiscoveryError ?? entry.lastError ?? entry.unavailableReason}
                </p>
              ) : null}
            </article>
          ))}
        </div>
      </SettingsSection>
    </SettingsSectionStack>
  );
}

function acpLastCheckedAt(entry: AcpAgentSettingsEntry): number | undefined {
  return (
    entry.lastDiscoveredAt ??
    entry.runtime?.checkedAt ??
    entry.runtime?.discoveredAt ??
    entry.updatedAt
  );
}

function formatAcpTimestamp(value: number | undefined): string {
  return value ? new Date(value).toLocaleString() : "never";
}

function formatAcpStatusValue(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}
