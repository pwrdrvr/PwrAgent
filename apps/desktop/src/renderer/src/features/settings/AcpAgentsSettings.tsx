import { useEffect, useState } from "react";
import type { AcpAgentSettingsEntry } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { BACKEND_SUMMARIES_REFRESH_EVENT } from "../../lib/useBackendSummaries";
import {
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
} from "./SettingsLayout";
import { acpInstallDisclosure, acpStatusLabel } from "./acp-agent-copy";

export function AcpAgentsSettings(props: { desktopApi?: DesktopApi }) {
  const [entries, setEntries] = useState<AcpAgentSettingsEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [confirming, setConfirming] = useState<AcpAgentSettingsEntry | undefined>();
  const [installingBackend, setInstallingBackend] = useState<string | undefined>();

  async function refresh(refreshRegistry = false): Promise<void> {
    if (!props.desktopApi?.listAcpAgents) {
      setError("ACP registry controls are unavailable in this build.");
      setLoading(false);
      return;
    }
    setLoading(true);
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
    }
  }

  useEffect(() => {
    void refresh(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.desktopApi]);

  async function install(entry: AcpAgentSettingsEntry): Promise<void> {
    if (!props.desktopApi?.installAcpAgent) {
      setError("ACP install controls are unavailable in this build.");
      return;
    }
    setInstallingBackend(entry.backendId);
    try {
      const response = await props.desktopApi.installAcpAgent({
        backendId: entry.backendId,
        distributionKind: entry.distributionKind,
        confirmed: true,
      });
      if (!response.ok) {
        setError(response.error ?? "ACP agent install failed.");
      }
      window.dispatchEvent(new Event(BACKEND_SUMMARIES_REFRESH_EVENT));
      setConfirming(undefined);
      await refresh(false);
    } catch (installError) {
      setError(installError instanceof Error ? installError.message : String(installError));
    } finally {
      setInstallingBackend(undefined);
    }
  }

  return (
    <SettingsSectionStack paneId="acp-agents" aria-label="ACP agent settings">
      <SettingsPanelHead
        eyebrow="Agents"
        title="ACP registry"
        help="Install allowlisted ACP coding agents as local third-party executables."
      />

      <SettingsSection eyebrow="ACP" title="Registry agents">
        <div className="settings-inline-actions">
          <button
            className="button button--secondary"
            type="button"
            onClick={() => {
              void refresh(true);
            }}
          >
            Refresh
          </button>
        </div>
        {loading ? <p className="settings-empty">Loading ACP agents...</p> : null}
        {error ? <p className="settings-row__error">{error}</p> : null}
        {!loading && entries.length === 0 ? (
          <p className="settings-empty">No allowlisted ACP agents found.</p>
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
              </dl>
              {entry.repositoryUrl || entry.websiteUrl ? (
                <p className="settings-acp-agent__links">
                  {entry.repositoryUrl ? <span>{entry.repositoryUrl}</span> : null}
                  {entry.websiteUrl ? <span>{entry.websiteUrl}</span> : null}
                </p>
              ) : null}
              {entry.lastError || entry.unavailableReason ? (
                <p className="settings-row__error">
                  {entry.lastError ?? entry.unavailableReason}
                </p>
              ) : null}
              {confirming?.backendId === entry.backendId ? (
                <div className="settings-acp-agent__confirm" role="alert">
                  <p>{acpInstallDisclosure(entry)}</p>
                  <div className="settings-inline-actions">
                    <button
                      className="button button--primary"
                      disabled={installingBackend === entry.backendId}
                      type="button"
                      onClick={() => {
                        void install(entry);
                      }}
                    >
                      Install
                    </button>
                    <button
                      className="button button--secondary"
                      type="button"
                      onClick={() => setConfirming(undefined)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  className="button button--secondary"
                  disabled={!entry.installable || installingBackend === entry.backendId}
                  type="button"
                  onClick={() => setConfirming(entry)}
                >
                  {entry.installed ? "Reinstall" : "Review install"}
                </button>
              )}
            </article>
          ))}
        </div>
      </SettingsSection>
    </SettingsSectionStack>
  );
}
