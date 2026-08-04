import { useEffect, useState } from "react";
import type {
  DesktopFederationMode,
  DesktopSettingsSecretName,
  DesktopSettingsConfigPatch,
  DesktopSettingsSnapshot,
  FederationConnectionState,
  FederationDiagnosticEvent,
  FederationHealthStatus,
  FederationInstanceRole,
} from "@pwragent/shared";
import { DESKTOP_FEDERATION_MODES } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
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

  useEffect(() => {
    void loadHealth();
    const refreshInterval = window.setInterval(() => {
      void loadHealth();
    }, 2_000);
    return () => window.clearInterval(refreshInterval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.desktopApi]);

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
            }}
          >
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        }
      />

      {error ? <p className="settings-row__error">{error}</p> : null}

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
            sub="Cloudflare Tunnel URL or local WebSocket URL for peers."
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
          {actionError ? (
            <p className="settings-row__error">{actionError}</p>
          ) : null}
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
                    {peer.lastActivityAt
                      ? ` · Active ${formatTimestamp(peer.lastActivityAt)}`
                      : ""}
                  </span>
                  {peer.unavailableReason ? (
                    <span>{peer.unavailableReason}</span>
                  ) : null}
                  <button
                    className="button button--ghost"
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
                    Open
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
