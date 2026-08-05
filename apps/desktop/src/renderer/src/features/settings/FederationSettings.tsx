import { useEffect, useState } from "react";
import type {
  DesktopFederationMode,
  DesktopSettingsSecretName,
  DesktopSettingsConfigPatch,
  DesktopSettingsSnapshot,
  FederationConnectionState,
  FederationCapability,
  FederationDiagnosticEvent,
  FederationHealthStatus,
  FederationInstanceRole,
  FederationTailscaleMode,
  FederationTailscaleStatus,
} from "@pwragent/shared";
import { DESKTOP_FEDERATION_MODES } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { formatRunningDurationMs } from "../../lib/format-duration";
import {
  SettingsField,
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
} from "./SettingsLayout";

type FederationSettingsProps = {
  desktopApi?: DesktopApi;
  onSettingsChanged: () => Promise<void>;
  onClearSecret: (secret: DesktopSettingsSecretName) => Promise<boolean>;
  onReplaceSecret: (
    secret: DesktopSettingsSecretName,
    value: string,
  ) => Promise<boolean>;
  onWriteConfig: (patch: DesktopSettingsConfigPatch) => Promise<boolean>;
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
};

export function FederationSettings(props: FederationSettingsProps) {
  const [health, setHealth] = useState<FederationHealthStatus>();
  const [diagnosticEvents, setDiagnosticEvents] = useState<
    FederationDiagnosticEvent[]
  >([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [tailscaleStatus, setTailscaleStatus] = useState<FederationTailscaleStatus>();
  const [tailscaleLoading, setTailscaleLoading] = useState(false);
  const [tailscaleConfiguring, setTailscaleConfiguring] =
    useState<FederationTailscaleMode>();
  const [funnelAcknowledged, setFunnelAcknowledged] = useState(false);
  const [generatedInvite, setGeneratedInvite] = useState("");
  const [inviteToImport, setInviteToImport] = useState("");
  const [revokingPeerId, setRevokingPeerId] = useState<string>();
  const [mode, setMode] = useState<DesktopFederationMode>(
    props.snapshot.federation.mode.value,
  );
  const [listenHost, setListenHost] = useState(
    props.snapshot.federation.listenHost.value,
  );
  const [listenPort, setListenPort] = useState(
    String(props.snapshot.federation.listenPort.value),
  );
  const [publicUrl, setPublicUrl] = useState(
    props.snapshot.federation.publicUrl.value,
  );
  const [gatewayUrl, setGatewayUrl] = useState(
    props.snapshot.federation.gatewayUrl.value,
  );
  const [cloudflareMtlsEnabled, setCloudflareMtlsEnabled] = useState(
    props.snapshot.federation.cloudflareMtlsEnabled.value,
  );
  const [
    cloudflareAccessServiceAuthEnabled,
    setCloudflareAccessServiceAuthEnabled,
  ] = useState(
    props.snapshot.federation.cloudflareAccessServiceAuthEnabled.value,
  );
  const [cloudflareClientCertificate, setCloudflareClientCertificate] =
    useState("");
  const [cloudflareClientPrivateKey, setCloudflareClientPrivateKey] =
    useState("");
  const [cloudflareAccessClientId, setCloudflareAccessClientId] = useState("");
  const [cloudflareAccessClientSecret, setCloudflareAccessClientSecret] =
    useState("");

  useEffect(() => {
    setMode(props.snapshot.federation.mode.value);
    setListenHost(props.snapshot.federation.listenHost.value);
    setListenPort(String(props.snapshot.federation.listenPort.value));
    setPublicUrl(props.snapshot.federation.publicUrl.value);
    setGatewayUrl(props.snapshot.federation.gatewayUrl.value);
    setCloudflareMtlsEnabled(
      props.snapshot.federation.cloudflareMtlsEnabled.value,
    );
    setCloudflareAccessServiceAuthEnabled(
      props.snapshot.federation.cloudflareAccessServiceAuthEnabled.value,
    );
  }, [props.snapshot]);

  const loadHealth = async () => {
    const diagnosticsReader = props.desktopApi?.readFederationDiagnostics;
    const healthReader = props.desktopApi?.readFederationHealth;
    if (!diagnosticsReader && !healthReader) {
      setError("Federation diagnostics are unavailable.");
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      if (diagnosticsReader) {
        const response = await diagnosticsReader({ limit: 50 });
        setHealth(response.health);
        setDiagnosticEvents(response.events);
      } else if (healthReader) {
        const response = await healthReader({});
        setHealth(response.health);
        setDiagnosticEvents([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const loadTailscaleStatus = async () => {
    if (!props.desktopApi?.readFederationTailscaleStatus) return;
    setTailscaleLoading(true);
    try {
      const response = await props.desktopApi.readFederationTailscaleStatus({});
      setTailscaleStatus(response.status);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setTailscaleLoading(false);
    }
  };

  useEffect(() => {
    void loadHealth();
    void loadTailscaleStatus();
    const refreshInterval = window.setInterval(() => {
      void loadHealth();
    }, 2_000);
    return () => window.clearInterval(refreshInterval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.desktopApi]);

  const configureTailscale = async (tailscaleMode: FederationTailscaleMode) => {
    if (
      !props.desktopApi?.configureFederationTailscale
      || !props.desktopApi.readFederationHealth
    ) return;
    setActionError(undefined);
    setTailscaleConfiguring(tailscaleMode);
    try {
      const parsedListenPort = parseFederationListenPort(listenPort);
      const gatewayMode = mode === "dual" ? "dual" : "gateway";
      const listenerWritten = await props.onWriteConfig({
        federation: {
          mode: gatewayMode,
          listenHost: "127.0.0.1",
          listenPort: parsedListenPort,
        },
      });
      if (!listenerWritten) {
        throw new Error(
          "PwrAgent could not start the federation listener. Tailscale was not changed.",
        );
      }
      const listenerHealth = await props.desktopApi.readFederationHealth({});
      const expectedListenUrl = `ws://127.0.0.1:${parsedListenPort}`;
      if (listenerHealth.health.listenUrl !== expectedListenUrl) {
        throw new Error(
          "PwrAgent did not bind the selected loopback port. Tailscale was not changed.",
        );
      }
      const response = await props.desktopApi.configureFederationTailscale({
        mode: tailscaleMode,
        listenPort: parsedListenPort,
      });
      const written = await props.onWriteConfig({
        federation: {
          publicUrl: response.gatewayUrl,
        },
      });
      if (!written) {
        throw new Error(
          "Tailscale was configured, but its Public URL could not be saved.",
        );
      }
      setMode(gatewayMode);
      setListenHost("127.0.0.1");
      setPublicUrl(response.gatewayUrl);
      setTailscaleStatus(response.status);
      await props.onSettingsChanged();
      await loadHealth();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setTailscaleConfiguring(undefined);
    }
  };

  const effectiveHealth =
    health ??
    ({
      enabled: props.snapshot.federation.mode.value !== "disabled",
      role: props.snapshot.federation.mode.value === "gateway" ||
        props.snapshot.federation.mode.value === "dual"
        ? props.snapshot.federation.mode.value
        : "client",
      status: props.snapshot.federation.mode.value === "disabled" ? "disabled" : "disconnected",
      listenUrl:
        props.snapshot.federation.mode.value === "disabled"
          ? undefined
          : `ws://${props.snapshot.federation.listenHost.value}:${props.snapshot.federation.listenPort.value}`,
      publicUrl: trimmedOrUndefined(props.snapshot.federation.publicUrl.value),
      peers: [],
    } satisfies FederationHealthStatus);
  const now = Date.now();

  return (
    <SettingsSectionStack paneId="federation" aria-label="Federation settings">
      <SettingsPanelHead
        eyebrow="Federation"
        title="Instance Federation"
        help="Remote instance connectivity, sanitized peer status, and gateway diagnostics."
        action={
          <button
            className="button button--secondary"
            type="button"
            disabled={
              loading ||
              (!props.desktopApi?.readFederationDiagnostics &&
                !props.desktopApi?.readFederationHealth)
            }
            onClick={() => {
              void loadHealth();
              void loadTailscaleStatus();
            }}
          >
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        }
      />

      {error ? <p className="settings-row__error">{error}</p> : null}
      {actionError ? (
        <p className="settings-row__error">{actionError}</p>
      ) : null}

      <SettingsSection
        eyebrow="Setup"
        title="Configuration"
        chip={props.saving ? "Saving" : "Editable"}
        chipKind={props.saving ? "warn" : "muted"}
      >
        <div className="settings-fields">
          <SettingsField
            label="Mode"
            sub="Gateway listens for peers; client connects to a gateway."
            control={
              <select
                value={mode}
                disabled={props.saving}
                onChange={(event) => setMode(event.target.value as DesktopFederationMode)}
              >
                {DESKTOP_FEDERATION_MODES.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </select>
            }
          />
          <SettingsField
            label="Listen host"
            sub="Local address for gateway mode."
            control={
              <input
                value={listenHost}
                disabled={props.saving}
                onChange={(event) => setListenHost(event.target.value)}
              />
            }
          />
          <SettingsField
            label="Listen port"
            sub="Local port for gateway mode."
            control={
              <input
                inputMode="numeric"
                value={listenPort}
                disabled={props.saving}
                onChange={(event) => setListenPort(event.target.value)}
              />
            }
          />
          <SettingsField
            label="Public URL"
            sub="Cloudflare Tunnel, Tailscale, or local WebSocket URL for peers."
            control={
              <input
                value={publicUrl}
                disabled={props.saving}
                onChange={(event) => setPublicUrl(event.target.value)}
              />
            }
          />
          <SettingsField
            label="Gateway URL"
            sub="Client-mode gateway WebSocket URL."
            control={
              <input
                value={gatewayUrl}
                disabled={props.saving}
                onChange={(event) => setGatewayUrl(event.target.value)}
              />
            }
          />
          <div className="settings-button-row">
            <button
              className="button button--primary"
              type="button"
              disabled={props.saving}
              onClick={() => {
                void props.onWriteConfig({
                  federation: {
                    mode,
                    listenHost,
                    listenPort: Number.parseInt(listenPort, 10) || 0,
                    publicUrl,
                    gatewayUrl,
                    cloudflareMtlsEnabled,
                    cloudflareAccessServiceAuthEnabled,
                  },
                }).then(() => loadHealth());
              }}
            >
              Save federation settings
            </button>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        eyebrow="End-to-end security"
        title="PwrAgent Encrypted Transport"
        chip="Required"
        chipKind="ok"
      >
        <div className="settings-fields">
          <SettingsField
            label="Protocol"
            sub="Every federation frame is encrypted before it enters the WebSocket transport."
            control={<code>Noise IK · X25519 · AES-256-GCM · SHA-256</code>}
          />
          <SettingsField
            label="Channel key"
            sub="Created automatically and stored in the system credential store."
            control={
              <span>
                {props.snapshot.federation.noiseStaticPrivateKey.configured
                  ? "Stored securely"
                  : "Created when federation starts"}
              </span>
            }
          />
          <SettingsField
            label="Gateway pinning"
            sub="Enrollment invites pin both the gateway signing key and Noise channel key."
            control={<span>Required</span>}
          />
          <p className="federation-security-note">
            The signed federation identity proof is bound to the Noise handshake.
            Cloudflare, Tailscale, SSH, and TLS can add outer transport controls,
            but they do not replace this application-level encryption.
          </p>
        </div>
      </SettingsSection>

      <SettingsSection
        eyebrow="Enrollment"
        title="Invites"
        chip={generatedInvite ? "Generated" : "Ready"}
        chipKind={generatedInvite ? "ok" : "muted"}
      >
        <div className="settings-fields">
          <SettingsField
            label="Generate invite"
            sub="Creates a one-time client enrollment payload."
            control={
              <button
                className="button button--secondary"
                type="button"
                disabled={!props.desktopApi?.generateFederationInvite}
                onClick={() => {
                  setActionError(undefined);
                  props.desktopApi?.generateFederationInvite?.({})
                    .then((response) => setGeneratedInvite(response.invite))
                    .catch((err: unknown) =>
                      setActionError(err instanceof Error ? err.message : String(err)),
                    );
                }}
              >
                Generate invite
              </button>
            }
          />
          {generatedInvite ? (
            <SettingsField
              label="Invite payload"
              sub="Paste this into the client instance."
              control={
                <textarea
                  readOnly
                  rows={4}
                  value={generatedInvite}
                />
              }
            />
          ) : null}
          <SettingsField
            label="Import invite"
            sub="Paste a gateway invite on the client instance."
            control={
              <textarea
                rows={4}
                value={inviteToImport}
                disabled={!props.desktopApi?.importFederationInvite}
                onChange={(event) => setInviteToImport(event.target.value)}
              />
            }
          />
          <div className="settings-button-row">
            <button
              className="button button--secondary"
              type="button"
              disabled={!props.desktopApi?.importFederationInvite || !inviteToImport.trim()}
              onClick={() => {
                setActionError(undefined);
                props.desktopApi?.importFederationInvite?.({ invite: inviteToImport })
                  .then(async () => {
                    setInviteToImport("");
                    await props.onSettingsChanged();
                    await loadHealth();
                  })
                  .catch((err: unknown) =>
                    setActionError(err instanceof Error ? err.message : String(err)),
                  );
              }}
            >
              Import invite
            </button>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        eyebrow="Runtime"
        title="Connection"
        chip={statusLabel(effectiveHealth.status)}
        chipKind={chipKindForStatus(effectiveHealth.status)}
      >
        <div className="settings-fields">
          <SettingsField
            label="Mode"
            sub="Configured role for this profile."
            control={<code>{props.snapshot.federation.mode.value}</code>}
          />
          <SettingsField
            label="Runtime role"
            sub="Role advertised by the federation health surface."
            control={<span>{roleLabel(effectiveHealth.role)}</span>}
          />
          <SettingsField
            label="Local listener"
            sub="Loopback or local bind target used by gateway modes."
            control={<code>{effectiveHealth.listenUrl ?? "Not listening"}</code>}
          />
          <SettingsField
            label="Public URL"
            sub="Cloudflare Tunnel or other remote endpoint."
            control={<code>{effectiveHealth.publicUrl ?? "Not configured"}</code>}
          />
          <SettingsField
            label="Gateway URL"
            sub="Outbound target used by client mode."
            control={
              <code>
                {trimmedOrUndefined(props.snapshot.federation.gatewayUrl.value) ??
                  "Not configured"}
              </code>
            }
          />
          {effectiveHealth.unavailableReason ? (
            <p className="settings-row__error">
              {effectiveHealth.unavailableReason}
            </p>
          ) : null}
        </div>
      </SettingsSection>

      <SettingsSection
        eyebrow="Peers"
        title="Federation Instances"
        chip={`${effectiveHealth.peers.length}`}
      >
        <p className="federation-peer-help">
          Choose Browse remote threads to open a separate window for a
          connected instance. Threads, prompts, approvals, environments, and
          files stay on that machine.
        </p>
        {effectiveHealth.peers.length === 0 ? (
          <p className="settings-empty">No federation instances.</p>
        ) : (
          <dl className="settings-aboutkv">
            {effectiveHealth.peers.map((peer) => (
              <div key={peer.id}>
                <dt>{peer.label}</dt>
                <dd className="federation-peer-summary">
                  <span>
                    {peer.id} · {roleLabel(peer.role)} · {statusLabel(peer.status)}
                  </span>
                  <span>
                    Protocol {peer.protocolVersion ?? "unknown"} ·{" "}
                    {peer.capabilities.length} capabilities
                  </span>
                  {peer.lastConnectedAt ? (
                    <span>
                      Connected {formatTimestamp(peer.lastConnectedAt)}
                      {peer.status === "connected"
                        ? ` · Current session ${formatRunningDurationMs(
                            Math.max(0, now - peer.lastConnectedAt),
                          )}`
                        : ""}
                    </span>
                  ) : null}
                  {peer.lastActivityAt
                  && peer.lastActivityAt !== peer.lastConnectedAt ? (
                    <span>Last activity {formatTimestamp(peer.lastActivityAt)}</span>
                  ) : null}
                  <span>
                    Available: {formatFederationCapabilities(peer.capabilities)}
                  </span>
                  {peer.unavailableReason ? (
                    <span>{peer.unavailableReason}</span>
                  ) : null}
                  <button
                    className="button button--secondary"
                    type="button"
                    disabled={
                      peer.status !== "connected" ||
                      !props.desktopApi?.openFederationWindow
                    }
                    onClick={() => {
                      void props.desktopApi?.openFederationWindow?.({
                        target: { scope: "remote", instanceId: peer.id },
                        label: peer.label,
                      });
                    }}
                  >
                    Browse remote threads
                  </button>
                  {peer.canRevoke ? (
                    <button
                      className="button button--ghost"
                      type="button"
                      disabled={
                        peer.status === "revoked" ||
                        revokingPeerId === peer.id ||
                        !props.desktopApi?.revokeFederationPeer
                      }
                      onClick={() => {
                        setActionError(undefined);
                        setRevokingPeerId(peer.id);
                        props.desktopApi?.revokeFederationPeer?.({
                          peerId: peer.id,
                        })
                          .then(() => loadHealth())
                          .catch((err: unknown) =>
                            setActionError(
                              err instanceof Error ? err.message : String(err),
                            ),
                          )
                          .finally(() => setRevokingPeerId(undefined));
                      }}
                    >
                      {revokingPeerId === peer.id ? "Revoking..." : "Revoke"}
                    </button>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </SettingsSection>

      <SettingsSection
        eyebrow="Diagnostics"
        title="Recent Federation Activity"
        chip={`${diagnosticEvents.length}`}
      >
        {diagnosticEvents.length === 0 ? (
          <p className="settings-empty">No federation activity recorded.</p>
        ) : (
          <dl className="settings-aboutkv">
            {diagnosticEvents.map((event) => (
              <div key={event.eventId}>
                <dt>{diagnosticEventLabel(event.kind)}</dt>
                <dd className="federation-peer-summary">
                  <span>
                    {formatTimestamp(event.createdAt)}
                    {event.peerId ? ` · ${event.peerId}` : ""}
                  </span>
                  {event.detail ? <span>{event.detail}</span> : null}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </SettingsSection>

      <SettingsSection
        eyebrow="Private network / public relay"
        title="Tailscale Serve / Funnel Setup"
        chip={
          tailscaleStatus?.funnelConfigured
            ? "Funnel"
            : tailscaleStatus?.serveConfigured
              ? "Serve"
              : tailscaleStatus?.connected
                ? "Ready"
                : "Not ready"
        }
        chipKind={
          tailscaleStatus?.serveConfigured || tailscaleStatus?.funnelConfigured
            ? "ok"
            : "muted"
        }
      >
        <div className="settings-fields">
          <SettingsField
            label="Tailscale CLI"
            sub="PwrAgent delegates account login, HTTPS certificates, and routing to Tailscale."
            control={
              <span>
                {tailscaleLoading
                  ? "Checking..."
                  : tailscaleStatus?.installed
                    ? `Installed${tailscaleStatus.version ? ` · ${tailscaleStatus.version}` : ""}`
                    : "Not found"}
              </span>
            }
          />
          <SettingsField
            label="Tailnet"
            sub="Serve is reachable only by devices authorized in this tailnet."
            control={
              <span>
                {tailscaleStatus?.connected
                  ? tailscaleStatus.tailnetName ?? "Connected"
                  : tailscaleStatus?.unavailableReason ?? "Not connected"}
              </span>
            }
          />
          <SettingsField
            label="Gateway URL"
            sub="A dedicated path avoids replacing unrelated Serve or Funnel handlers."
            control={
              <code>{tailscaleStatus?.gatewayUrl ?? "Available after Tailscale login"}</code>
            }
          />
          <SettingsField
            label="Tailscale Serve"
            sub="Private HTTPS/WebSocket reachability for authenticated tailnet devices."
            control={
              <button
                className="button button--secondary"
                type="button"
                disabled={
                  props.saving ||
                  Boolean(tailscaleConfiguring) ||
                  !tailscaleStatus?.connected ||
                  !props.desktopApi?.configureFederationTailscale ||
                  !props.desktopApi?.readFederationHealth
                }
                onClick={() => void configureTailscale("serve")}
              >
                {tailscaleConfiguring === "serve"
                  ? "Setting up Serve..."
                  : "Set up Tailscale Serve"}
              </button>
            }
          />
          <SettingsField
            label="Tailscale Funnel"
            sub="Public HTTPS/WebSocket reachability. Internet traffic reaches Tailscale's edge before PwrAgent authentication rejects unknown peers."
            control={
              <div className="federation-tailscale-actions">
                <label>
                  <input
                    aria-label="Acknowledge public Funnel exposure"
                    type="checkbox"
                    checked={funnelAcknowledged}
                    onChange={(event) => setFunnelAcknowledged(event.target.checked)}
                  />{" "}
                  I understand this creates a public endpoint
                </label>
                <button
                  className="button button--secondary"
                  type="button"
                  disabled={
                    props.saving ||
                    Boolean(tailscaleConfiguring) ||
                    !tailscaleStatus?.connected ||
                    !funnelAcknowledged ||
                    !props.desktopApi?.configureFederationTailscale ||
                    !props.desktopApi?.readFederationHealth
                  }
                  onClick={() => void configureTailscale("funnel")}
                >
                  {tailscaleConfiguring === "funnel"
                    ? "Setting up Funnel..."
                    : "Set up Tailscale Funnel"}
                </button>
              </div>
            }
          />
          <p className="federation-security-note">
            Both modes proxy only <code>/pwragent-federation</code> to the local
            loopback listener. PwrAgent does not run Tailscale reset commands or
            remove other handlers.
          </p>
        </div>
      </SettingsSection>

      <SettingsSection
        eyebrow="Edge Policy"
        title="Cloudflare"
        chip={
          cloudflareMtlsEnabled ||
          cloudflareAccessServiceAuthEnabled
            ? "Configured"
            : "Optional"
        }
        chipKind={
          cloudflareMtlsEnabled ||
          cloudflareAccessServiceAuthEnabled
            ? "ok"
            : "muted"
        }
      >
        <div className="settings-fields">
          <SettingsField
            label="mTLS"
            sub="Cloudflare edge certificate gate."
            control={
              <input
                aria-label="mTLS"
                type="checkbox"
                checked={cloudflareMtlsEnabled}
                onChange={(event) =>
                  setCloudflareMtlsEnabled(event.target.checked)
                }
              />
            }
          />
          <SettingsField
            label="Client certificate"
            sub={secretStatus(
              props.snapshot.federation.cloudflareClientCertificate.configured,
            )}
            control={
              <textarea
                aria-label="Client certificate"
                rows={3}
                value={cloudflareClientCertificate}
                placeholder="PEM certificate"
                onChange={(event) =>
                  setCloudflareClientCertificate(event.target.value)
                }
              />
            }
          />
          <SettingsField
            label="Client private key"
            sub={secretStatus(
              props.snapshot.federation.cloudflareClientPrivateKey.configured,
            )}
            control={
              <textarea
                aria-label="Client private key"
                rows={3}
                value={cloudflareClientPrivateKey}
                placeholder="PEM private key"
                onChange={(event) =>
                  setCloudflareClientPrivateKey(event.target.value)
                }
              />
            }
          />
          <SettingsField
            label="Access service auth"
            sub="Cloudflare Access service-token gate."
            control={
              <input
                aria-label="Access service auth"
                type="checkbox"
                checked={cloudflareAccessServiceAuthEnabled}
                onChange={(event) =>
                  setCloudflareAccessServiceAuthEnabled(event.target.checked)
                }
              />
            }
          />
          <SettingsField
            label="Access client ID"
            sub={secretStatus(
              props.snapshot.federation.cloudflareAccessClientId.configured,
            )}
            control={
              <input
                aria-label="Access client ID"
                type="password"
                value={cloudflareAccessClientId}
                placeholder="Cloudflare Access client ID"
                onChange={(event) =>
                  setCloudflareAccessClientId(event.target.value)
                }
              />
            }
          />
          <SettingsField
            label="Access client secret"
            sub={secretStatus(
              props.snapshot.federation.cloudflareAccessClientSecret.configured,
            )}
            control={
              <input
                aria-label="Access client secret"
                type="password"
                value={cloudflareAccessClientSecret}
                placeholder="Cloudflare Access client secret"
                onChange={(event) =>
                  setCloudflareAccessClientSecret(event.target.value)
                }
              />
            }
          />
          <div className="settings-button-row">
            <button
              className="button button--secondary"
              type="button"
              disabled={props.saving}
              onClick={() => {
                setActionError(undefined);
                void saveCloudflareSettings({
                  config: {
                    cloudflareMtlsEnabled,
                    cloudflareAccessServiceAuthEnabled,
                  },
                  secrets: [
                    [
                      "federationCloudflareClientCertificate",
                      cloudflareClientCertificate,
                    ],
                    [
                      "federationCloudflareClientPrivateKey",
                      cloudflareClientPrivateKey,
                    ],
                    [
                      "federationCloudflareAccessClientId",
                      cloudflareAccessClientId,
                    ],
                    [
                      "federationCloudflareAccessClientSecret",
                      cloudflareAccessClientSecret,
                    ],
                  ],
                  onReplaceSecret: props.onReplaceSecret,
                  onWriteConfig: props.onWriteConfig,
                })
                  .then(async () => {
                    setCloudflareClientCertificate("");
                    setCloudflareClientPrivateKey("");
                    setCloudflareAccessClientId("");
                    setCloudflareAccessClientSecret("");
                    await props.onSettingsChanged();
                    await loadHealth();
                  })
                  .catch((err: unknown) =>
                    setActionError(
                      err instanceof Error ? err.message : String(err),
                    ),
                  );
              }}
            >
              Save edge policy
            </button>
            <button
              className="button button--ghost"
              type="button"
              disabled={props.saving}
              onClick={() => {
                setActionError(undefined);
                void Promise.all([
                  props.onClearSecret(
                    "federationCloudflareClientCertificate",
                  ),
                  props.onClearSecret(
                    "federationCloudflareClientPrivateKey",
                  ),
                  props.onClearSecret("federationCloudflareAccessClientId"),
                  props.onClearSecret(
                    "federationCloudflareAccessClientSecret",
                  ),
                ])
                  .then(async (cleared) => {
                    if (cleared.some((result) => !result)) {
                      throw new Error(
                        "One or more Cloudflare credentials could not be cleared.",
                      );
                    }
                    const written = await props.onWriteConfig({
                      federation: {
                        cloudflareMtlsEnabled: false,
                        cloudflareAccessServiceAuthEnabled: false,
                      },
                    });
                    if (!written) {
                      throw new Error(
                        "Cloudflare edge policy could not be updated.",
                      );
                    }
                    setCloudflareMtlsEnabled(false);
                    setCloudflareAccessServiceAuthEnabled(false);
                    await props.onSettingsChanged();
                    await loadHealth();
                  })
                  .catch((err: unknown) =>
                    setActionError(
                      err instanceof Error ? err.message : String(err),
                    ),
                  );
              }}
            >
              Clear credentials
            </button>
          </div>
        </div>
      </SettingsSection>
    </SettingsSectionStack>
  );
}

async function saveCloudflareSettings(params: {
  config: {
    cloudflareMtlsEnabled: boolean;
    cloudflareAccessServiceAuthEnabled: boolean;
  };
  secrets: Array<[DesktopSettingsSecretName, string]>;
  onReplaceSecret: (
    secret: DesktopSettingsSecretName,
    value: string,
  ) => Promise<boolean>;
  onWriteConfig: (patch: DesktopSettingsConfigPatch) => Promise<boolean>;
}): Promise<void> {
  for (const [secret, value] of params.secrets) {
    if (value.trim()) {
      const saved = await params.onReplaceSecret(secret, value);
      if (!saved) {
        throw new Error(`Cloudflare credential ${secret} could not be saved.`);
      }
    }
  }
  const written = await params.onWriteConfig({
    federation: params.config,
  });
  if (!written) {
    throw new Error("Cloudflare edge policy could not be updated.");
  }
}

function secretStatus(configured: boolean): string {
  return configured
    ? "Stored securely. Leave blank to keep it."
    : "Not configured.";
}

function diagnosticEventLabel(kind: FederationDiagnosticEvent["kind"]): string {
  return kind
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatTimestamp(value: number): string {
  return new Date(value).toLocaleString();
}

function parseFederationListenPort(value: string): number {
  const trimmed = value.trim();
  const port = Number(trimmed);
  if (
    !/^\d+$/.test(trimmed)
    || !Number.isInteger(port)
    || port < 1
    || port > 65_535
  ) {
    throw new Error("Listen port must be an integer between 1 and 65535.");
  }
  return port;
}

const FEDERATION_CAPABILITY_LABELS: Record<FederationCapability, string> = {
  remote_window: "open a remote workspace",
  thread_navigation: "browse and create threads",
  thread_detail: "read transcripts",
  turn_control: "prompt, steer, and interrupt",
  pending_request_control: "handle approvals and questions",
  environment_actions: "run environments and scripts",
  federated_search: "search remote threads",
  messaging_route: "route messaging threads",
  gateway_relay: "reach sibling instances",
};

function formatFederationCapabilities(
  capabilities: FederationCapability[],
): string {
  if (capabilities.length === 0) return "no remote actions advertised";
  return capabilities
    .map((capability) => FEDERATION_CAPABILITY_LABELS[capability])
    .join(" · ");
}

function trimmedOrUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function roleLabel(role: FederationInstanceRole): string {
  switch (role) {
    case "gateway":
      return "Gateway";
    case "client":
      return "Client";
    case "dual":
      return "Dual";
  }
}

function statusLabel(status: FederationConnectionState): string {
  return status
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function chipKindForStatus(status: FederationConnectionState) {
  switch (status) {
    case "connected":
    case "listening":
      return "ok";
    case "connecting":
    case "handshaking":
    case "degraded":
      return "warn";
    case "disabled":
    case "disconnected":
      return "muted";
    case "rejected":
    case "revoked":
      return "err";
  }
}
