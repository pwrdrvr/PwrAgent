import { useEffect, useRef, useState } from "react";
import type {
  CelestialIconId,
  DesktopFederationMode,
  DesktopSettingsSecretName,
  DesktopSettingsConfigPatch,
  DesktopSettingsSnapshot,
  FederationConnectionState,
  FederationCapability,
  FederationDiagnosticEvent,
  FederationEndpointStatus,
  FederationHealthStatus,
  FederationInstanceRole,
  FederationTailscaleMode,
  FederationTailscaleStatus,
} from "@pwragent/shared";
import {
  CELESTIAL_ICON_IDS,
  DESKTOP_FEDERATION_MODES,
  formatFederationPeerDisplayLabel,
  isCelestialIconId,
  isFederationGatewayEndpointUrl,
} from "@pwragent/shared";
import { CelestialIcon } from "../../icons";
import type { DesktopApi } from "../../lib/desktop-api";
import { copyText } from "../../lib/copy-text";
import { formatRunningDurationMs } from "../../lib/format-duration";
import {
  SettingsField,
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
} from "./SettingsLayout";

const DIAGNOSTIC_EVENT_LIMIT = 50;

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
  const [inviteCopied, setInviteCopied] = useState(false);
  const inviteCopiedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const [inviteToImport, setInviteToImport] = useState("");
  const [importNotice, setImportNotice] = useState<string>();
  const [revokingPeerId, setRevokingPeerId] = useState<string>();
  const [settingIconFor, setSettingIconFor] = useState<string>();
  const [confirmingForget, setConfirmingForget] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const [mode, setMode] = useState<DesktopFederationMode>(
    props.snapshot.federation.mode.value,
  );
  const [instanceLabel, setInstanceLabel] = useState(
    props.snapshot.federation.instanceLabel.value,
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
  const [gatewayEndpointsText, setGatewayEndpointsText] = useState(
    props.snapshot.federation.gatewayEndpoints.value.join("\n"),
  );
  const [advertisedEndpointsText, setAdvertisedEndpointsText] = useState(
    props.snapshot.federation.advertisedEndpoints.value.join("\n"),
  );
  const [cloudflareEndpoint, setCloudflareEndpoint] = useState(
    props.snapshot.federation.cloudflareEndpoint.value,
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
    setInstanceLabel(props.snapshot.federation.instanceLabel.value);
    setListenHost(props.snapshot.federation.listenHost.value);
    setListenPort(String(props.snapshot.federation.listenPort.value));
    setPublicUrl(props.snapshot.federation.publicUrl.value);
    setGatewayEndpointsText(
      props.snapshot.federation.gatewayEndpoints.value.join("\n"),
    );
    setAdvertisedEndpointsText(
      props.snapshot.federation.advertisedEndpoints.value.join("\n"),
    );
    setCloudflareEndpoint(props.snapshot.federation.cloudflareEndpoint.value);
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
        const response = await diagnosticsReader({ limit: DIAGNOSTIC_EVENT_LIMIT });
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

  useEffect(() => {
    return () => {
      if (inviteCopiedTimerRef.current) {
        clearTimeout(inviteCopiedTimerRef.current);
      }
    };
  }, []);

  const copyGeneratedInvite = async (
    value?: string,
    options?: { silent?: boolean },
  ) => {
    const invite = value ?? generatedInvite;
    if (!invite) return;
    try {
      await copyText(invite, props.desktopApi);
      setInviteCopied(true);
      if (inviteCopiedTimerRef.current) {
        clearTimeout(inviteCopiedTimerRef.current);
      }
      inviteCopiedTimerRef.current = setTimeout(
        () => setInviteCopied(false),
        1500,
      );
    } catch (err) {
      if (!options?.silent) {
        setActionError(err instanceof Error ? err.message : String(err));
      }
    }
  };

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

  // Gateway-side fields only matter when this instance listens; the
  // gateway endpoints only matter when it dials out. Disable (never hide)
  // the irrelevant ones so the form teaches the mode split instead of
  // accepting values that silently do nothing.
  const listensForPeers = mode === "gateway" || mode === "dual";
  const dialsGateway = mode === "client" || mode === "dual";

  const effectiveHealth: FederationHealthStatus =
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
      gatewayEndpoints:
        props.snapshot.federation.mode.value === "client" ||
        props.snapshot.federation.mode.value === "dual"
          ? props.snapshot.federation.gatewayEndpoints.value.map((url) => ({
              url,
              state: "idle" as const,
            }))
          : undefined,
      peers: [],
    } satisfies FederationHealthStatus);
  const gatewayEndpointStatuses = effectiveHealth.gatewayEndpoints ?? [];
  const now = Date.now();

  const changeCelestialIcon = (instanceId: string, value: string) => {
    // The empty value is the Auto option: it clears an operator override
    // back to auto-assignment. Anything else must be a known icon id.
    if (value !== "" && !isCelestialIconId(value)) return;
    if (!props.desktopApi?.setCelestialIcon) return;
    setActionError(undefined);
    setSettingIconFor(instanceId);
    props.desktopApi
      .setCelestialIcon({ instanceId, icon: value === "" ? null : value })
      .then(() => loadHealth())
      .catch((err: unknown) =>
        setActionError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setSettingIconFor(undefined));
  };
  const connectionRemediation = effectiveHealth.unavailableReason
    ? remediationForConnectionFailure(effectiveHealth.unavailableReason)
    : undefined;

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
            label="Instance name"
            sub="Shown to peers instead of the raw instance id. Defaults to this machine's hostname."
            control={
              <input
                aria-label="Instance name"
                value={instanceLabel}
                placeholder="This machine's hostname"
                disabled={props.saving}
                onChange={(event) => setInstanceLabel(event.target.value)}
              />
            }
          />
          <SettingsField
            label="Instance icon"
            sub="This machine's celestial mark on the Star Map and thread viewers. Applies immediately and syncs across the federation."
            control={
              <span className="federation-celestial-picker">
                {effectiveHealth.localCelestialIcon ? (
                  <CelestialIcon
                    icon={effectiveHealth.localCelestialIcon}
                    size={16}
                  />
                ) : null}
                <select
                  aria-label="Instance icon"
                  value={effectiveHealth.localCelestialIcon ?? ""}
                  disabled={
                    !effectiveHealth.instanceId
                    || !props.desktopApi?.setCelestialIcon
                    || settingIconFor === effectiveHealth.instanceId
                  }
                  onChange={(event) => {
                    if (!effectiveHealth.instanceId) return;
                    changeCelestialIcon(
                      effectiveHealth.instanceId,
                      event.target.value,
                    );
                  }}
                >
                  <option value="">Auto</option>
                  {CELESTIAL_ICON_IDS.map((icon) => (
                    <option key={icon} value={icon}>
                      {celestialIconLabel(icon)}
                    </option>
                  ))}
                </select>
              </span>
            }
          />
          <SettingsField
            label="Listen host"
            sub={
              listensForPeers
                ? "Local address for gateway mode."
                : "Only used when Mode is gateway or dual."
            }
            control={
              <input
                aria-label="Listen host"
                value={listenHost}
                disabled={props.saving || !listensForPeers}
                onChange={(event) => setListenHost(event.target.value)}
              />
            }
          />
          <SettingsField
            label="Listen port"
            sub={
              listensForPeers
                ? "Local port for gateway mode."
                : "Only used when Mode is gateway or dual."
            }
            control={
              <input
                aria-label="Listen port"
                inputMode="numeric"
                value={listenPort}
                disabled={props.saving || !listensForPeers}
                onChange={(event) => setListenPort(event.target.value)}
              />
            }
          />
          <SettingsField
            label="Public URL"
            sub={
              listensForPeers
                ? "Cloudflare Tunnel, Tailscale, or local WebSocket URL for peers."
                : "Only used when Mode is gateway or dual."
            }
            control={
              <input
                aria-label="Public URL"
                value={publicUrl}
                disabled={props.saving || !listensForPeers}
                onChange={(event) => setPublicUrl(event.target.value)}
              />
            }
          />
          <SettingsField
            label="Gateway endpoints"
            sub={
              dialsGateway
                ? "Endpoints for one pinned gateway, one per line in fallback order. ws://, wss://, and ssh:// (user@host, optional ?forward=host:port) are supported."
                : "Only used when Mode is client or dual."
            }
            control={
              <textarea
                aria-label="Gateway endpoints"
                rows={3}
                value={gatewayEndpointsText}
                disabled={props.saving || !dialsGateway}
                onChange={(event) => setGatewayEndpointsText(event.target.value)}
              />
            }
          />
          <SettingsField
            label="Advertised endpoints"
            sub="Gateway mode: endpoints written into new enrollment invites, one per line. Defaults to the Public URL when empty."
            control={
              <textarea
                aria-label="Advertised endpoints"
                rows={3}
                value={advertisedEndpointsText}
                disabled={props.saving}
                onChange={(event) =>
                  setAdvertisedEndpointsText(event.target.value)
                }
              />
            }
          />
          <div className="settings-button-row">
            <button
              className="button button--primary"
              type="button"
              disabled={props.saving}
              onClick={() => {
                setActionError(undefined);
                const gatewayEndpoints = parseGatewayEndpoints(
                  gatewayEndpointsText,
                );
                const advertisedEndpoints = parseGatewayEndpoints(
                  advertisedEndpointsText,
                );
                const invalidEndpoint = [
                  ...gatewayEndpoints,
                  ...advertisedEndpoints,
                ].find((endpoint) => !isFederationGatewayEndpointUrl(endpoint));
                if (invalidEndpoint) {
                  setActionError(
                    `Endpoint "${invalidEndpoint}" must be a ws://, wss://, or ssh:// URL without an embedded password.`,
                  );
                  return;
                }
                void props.onWriteConfig({
                  federation: {
                    mode,
                    instanceLabel,
                    listenHost,
                    listenPort: Number.parseInt(listenPort, 10) || 0,
                    publicUrl,
                    gatewayEndpoints,
                    advertisedEndpoints,
                    cloudflareMtlsEnabled,
                    cloudflareAccessServiceAuthEnabled,
                  },
                }).then(async (written) => {
                  // A silent false here is how "I set it to client" turns
                  // into a disabled-mode surprise on the next launch.
                  if (!written) {
                    setActionError(
                      "Federation settings could not be saved to config.toml.",
                    );
                    return;
                  }
                  await props.onSettingsChanged();
                  await loadHealth();
                });
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
            sub={
              listensForPeers
                ? "Creates a one-time client enrollment payload and copies it to the clipboard."
                : "Invites are issued by the gateway. Switch Mode to gateway or dual to enroll clients from this instance."
            }
            control={
              <div className="federation-invite">
                <button
                  className="button button--secondary"
                  type="button"
                  disabled={
                    !listensForPeers ||
                    !props.desktopApi?.generateFederationInvite
                  }
                  onClick={() => {
                    setActionError(undefined);
                    props.desktopApi?.generateFederationInvite?.({})
                      .then(async (response) => {
                        setGeneratedInvite(response.invite);
                        // Auto-copy so the operator can paste straight into
                        // the client instance; best-effort with the Copy
                        // button as the manual fallback.
                        await copyGeneratedInvite(response.invite, {
                          silent: true,
                        });
                      })
                      .catch((err: unknown) =>
                        setActionError(err instanceof Error ? err.message : String(err)),
                      );
                  }}
                >
                  Generate invite
                </button>
                {generatedInvite ? (
                  <div className="federation-invite__message">
                    <code>{generatedInvite}</code>
                    <button
                      className="button button--ghost"
                      type="button"
                      onClick={() => void copyGeneratedInvite()}
                    >
                      {inviteCopied ? "Copied" : "Copy"}
                    </button>
                  </div>
                ) : null}
              </div>
            }
          />
          <SettingsField
            label="Import invite"
            sub="Paste a gateway invite on the client instance."
            control={
              <textarea
                rows={4}
                aria-label="Import invite"
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
                setImportNotice(undefined);
                props.desktopApi?.importFederationInvite?.({ invite: inviteToImport })
                  .then(async (response) => {
                    setInviteToImport("");
                    setImportNotice(
                      `Invite imported. Connecting to ${response.gatewayInstanceId}...`,
                    );
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
          {importNotice ? (
            <p className="federation-security-note">{importNotice}</p>
          ) : null}
        </div>
      </SettingsSection>

      {dialsGateway || effectiveHealth.clientEnrollment ? (
        <SettingsSection
          eyebrow="Pairing"
          title="Gateway Enrollment"
          chip={
            effectiveHealth.clientEnrollment
              ? effectiveHealth.clientEnrollment.pendingInvite
                ? "Pending"
                : "Paired"
              : "Not paired"
          }
          chipKind={
            effectiveHealth.clientEnrollment
              ? effectiveHealth.clientEnrollment.pendingInvite
                ? "warn"
                : "ok"
              : "muted"
          }
        >
          <div className="settings-fields">
            {effectiveHealth.clientEnrollment ? (
              <>
                <SettingsField
                  label="Gateway"
                  sub="Identity pinned by the imported invite."
                  control={
                    <code>
                      {peerDisplayName(
                        effectiveHealth.clientEnrollment.gatewayInstanceId,
                        effectiveHealth.peers,
                      )}
                    </code>
                  }
                />
                <SettingsField
                  label="Gateway endpoint"
                  sub={
                    gatewayEndpointStatuses.length > 1
                      ? `First of ${gatewayEndpointStatuses.length} endpoints tried for this pairing.`
                      : "Where this instance dials out."
                  }
                  control={
                    <code>
                      {effectiveHealth.clientEnrollment.gatewayUrl ??
                        "Not configured"}
                    </code>
                  }
                />
                {effectiveHealth.clientEnrollment.enrolledAt ? (
                  <SettingsField
                    label="Invite imported"
                    sub="When the current pairing was created."
                    control={
                      <span>
                        {formatTimestamp(
                          effectiveHealth.clientEnrollment.enrolledAt,
                        )}
                      </span>
                    }
                  />
                ) : null}
                {effectiveHealth.clientEnrollment.pendingInvite ? (
                  <p className="federation-security-note">
                    The invite has not been redeemed yet. Enrollment completes
                    on the first successful connection to the gateway.
                  </p>
                ) : null}
                <div className="settings-button-row">
                  {confirmingForget ? (
                    <>
                      <button
                        className="button button--primary"
                        type="button"
                        disabled={forgetting}
                        onClick={() => {
                          setActionError(undefined);
                          setForgetting(true);
                          props.desktopApi?.resetFederationEnrollment?.({})
                            .then(async () => {
                              setConfirmingForget(false);
                              await props.onSettingsChanged();
                              await loadHealth();
                            })
                            .catch((err: unknown) =>
                              setActionError(
                                err instanceof Error ? err.message : String(err),
                              ),
                            )
                            .finally(() => setForgetting(false));
                        }}
                      >
                        {forgetting ? "Forgetting..." : "Confirm forget"}
                      </button>
                      <button
                        className="button button--ghost"
                        type="button"
                        disabled={forgetting}
                        onClick={() => setConfirmingForget(false)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      className="button button--ghost"
                      type="button"
                      disabled={!props.desktopApi?.resetFederationEnrollment}
                      onClick={() => setConfirmingForget(true)}
                    >
                      Forget gateway
                    </button>
                  )}
                </div>
                {confirmingForget ? (
                  <p className="federation-security-note">
                    Forgetting removes the pinned gateway identity and keys
                    from this instance. Reconnecting later requires a fresh
                    invite from the gateway.
                  </p>
                ) : null}
              </>
            ) : (
              <p className="settings-empty">
                No gateway pairing saved. Import an invite to pair this
                instance.
              </p>
            )}
          </div>
        </SettingsSection>
      ) : null}

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
            label="Gateway endpoints"
            sub="Outbound candidates used by client mode, tried in order. The active endpoint carries the current session."
            control={
              gatewayEndpointStatuses.length === 0 ? (
                <span>Not configured</span>
              ) : (
                <div className="federation-peer-summary">
                  {gatewayEndpointStatuses.map((endpoint) => (
                    <span
                      key={endpoint.url}
                      className="federation-peer-summary"
                    >
                      <code>{endpoint.url}</code>
                      <span>
                        {endpointStateLabel(endpoint.state)}
                        {endpoint.lastConnectedAt
                          ? ` · Connected ${formatTimestamp(endpoint.lastConnectedAt)}`
                          : ""}
                      </span>
                      {endpoint.lastError ? (
                        <span>{endpoint.lastError}</span>
                      ) : null}
                    </span>
                  ))}
                </div>
              )
            }
          />
          {effectiveHealth.unavailableReason ? (
            <p className="settings-row__error">
              {effectiveHealth.unavailableReason}
            </p>
          ) : null}
          {connectionRemediation ? (
            <p className="federation-security-note">
              {connectionRemediation}
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
                <dt>
                  {formatFederationPeerDisplayLabel(
                    peer,
                    effectiveHealth.peers,
                  )}
                </dt>
                <dd className="federation-peer-summary">
                  <span>
                    {roleLabel(peer.role)} · {statusLabel(peer.status)}
                  </span>
                  <span>
                    Protocol {peer.protocolVersion ?? "unknown"} ·{" "}
                    {peer.capabilities.length} capabilities · Instance{" "}
                    <code>{peer.id}</code>
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
                  <span className="federation-celestial-picker">
                    {peer.celestialIcon ? (
                      <CelestialIcon icon={peer.celestialIcon} size={16} />
                    ) : null}
                    <select
                      aria-label={`Celestial icon for ${peer.label}`}
                      value={peer.celestialIcon ?? ""}
                      disabled={
                        !props.desktopApi?.setCelestialIcon
                        || settingIconFor === peer.id
                      }
                      onChange={(event) =>
                        changeCelestialIcon(peer.id, event.target.value)
                      }
                    >
                      <option value="">Auto</option>
                      {CELESTIAL_ICON_IDS.map((icon) => (
                        <option key={icon} value={icon}>
                          {celestialIconLabel(icon)}
                        </option>
                      ))}
                    </select>
                  </span>
                  <button
                    className="button button--secondary"
                    type="button"
                    disabled={
                      peer.status !== "connected" ||
                      !peer.capabilities.includes("remote_window") ||
                      !props.desktopApi?.openFederationWindow
                    }
                    onClick={() => {
                      void props.desktopApi?.openFederationWindow?.({
                        target: { scope: "remote", instanceId: peer.id },
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
        chip={
          diagnosticEvents.length >= DIAGNOSTIC_EVENT_LIMIT
            ? `${DIAGNOSTIC_EVENT_LIMIT}+`
            : `${diagnosticEvents.length}`
        }
      >
        {diagnosticEvents.length === 0 ? (
          <p className="settings-empty">No federation activity recorded.</p>
        ) : (
          <dl className="settings-aboutkv">
            {diagnosticEvents.map((event) => (
              <div key={event.eventId}>
                <dt>
                  {diagnosticEventLabel(event.kind)}
                  {(event.repeatCount ?? 1) > 1 ? ` ×${event.repeatCount}` : ""}
                </dt>
                <dd className="federation-peer-summary">
                  <span>
                    {formatTimestamp(event.createdAt)}
                    {event.peerId
                      ? ` · ${peerDisplayName(event.peerId, effectiveHealth.peers)}`
                      : ""}
                  </span>
                  {(event.repeatCount ?? 1) > 1 && event.firstSeenAt ? (
                    <span>
                      Repeated {event.repeatCount} times since{" "}
                      {formatTimestamp(event.firstSeenAt)}
                    </span>
                  ) : null}
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
            label="Cloudflare endpoint"
            sub="The one endpoint fronted by Cloudflare. Access tokens and client certificates are sent only to this host, because they travel in the WebSocket upgrade before the gateway's pinned keys are verified."
            control={
              <input
                aria-label="Cloudflare endpoint"
                value={cloudflareEndpoint}
                placeholder="wss://federation.example.com"
                disabled={props.saving}
                onChange={(event) => setCloudflareEndpoint(event.target.value)}
              />
            }
          />
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
                if (
                  cloudflareEndpoint.trim()
                  && !isFederationGatewayEndpointUrl(cloudflareEndpoint)
                ) {
                  setActionError(
                    "Cloudflare endpoint must be a wss:// URL matching one of the gateway endpoints.",
                  );
                  return;
                }
                void saveCloudflareSettings({
                  config: {
                    cloudflareEndpoint: cloudflareEndpoint.trim(),
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
                        cloudflareEndpoint: "",
                        cloudflareMtlsEnabled: false,
                        cloudflareAccessServiceAuthEnabled: false,
                      },
                    });
                    if (!written) {
                      throw new Error(
                        "Cloudflare edge policy could not be updated.",
                      );
                    }
                    setCloudflareEndpoint("");
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
    cloudflareEndpoint: string;
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
  scheduled_actions: "schedule and manage messages",
  pending_request_control: "handle approvals and questions",
  environment_actions: "run environments and scripts",
  federated_search: "search remote threads",
  messaging_route: "route messaging threads",
  pwrsnap_connection: "read PwrSnap availability",
  gateway_relay: "reach sibling instances",
  remote_pty: "open a remote terminal",
};

function formatFederationCapabilities(
  capabilities: FederationCapability[],
): string {
  if (capabilities.length === 0) return "no remote actions advertised";
  return capabilities
    .map((capability) => FEDERATION_CAPABILITY_LABELS[capability])
    .join(" · ");
}

/**
 * Actionable next step for a client connection failure. Keyed off the
 * redacted failure strings the main process reports; returns undefined
 * for transport-level failures where "keep retrying" is already the
 * right answer.
 */
function remediationForConnectionFailure(reason: string): string | undefined {
  if (
    reason.includes("unknown_peer") ||
    reason.includes("missing_invite") ||
    reason.includes("expired_invite") ||
    reason.includes("reused_invite")
  ) {
    return "This instance is not enrolled with the gateway anymore. Generate a fresh invite on the gateway and import it here.";
  }
  if (reason.includes("revoked_peer")) {
    return "The gateway revoked this instance. Generate a fresh invite on the gateway and import it here to re-enroll.";
  }
  if (reason.includes("wrong_gateway")) {
    return "The imported invite belongs to a different gateway. Generate an invite on the gateway this instance should join and import that one.";
  }
  if (
    reason.includes("bad_signature") ||
    reason.includes("Invalid federation auth") ||
    reason.includes("Encrypted federation frame authentication failed") ||
    reason.includes("Missing pinned gateway Noise key")
  ) {
    return "The pinned gateway keys no longer match — the gateway was likely re-installed or re-keyed. Generate a fresh invite on the gateway and import it here.";
  }
  if (
    reason.includes("does not support required Noise transport") ||
    reason.includes("invalid_protocol_version") ||
    reason.includes("Unexpected federation auth response")
  ) {
    return "The two instances are running incompatible PwrAgent versions. Update both instances to the same release and reconnect.";
  }
  if (
    reason.includes("capability_denied") ||
    reason.includes("policy_denied")
  ) {
    return "The gateway denied this session by policy. Review the gateway's federation settings.";
  }
  if (
    reason.includes("missing its gateway identity") ||
    reason.includes("missing its pinned gateway") ||
    reason.includes("gateway URL is not configured")
  ) {
    return "This instance has no gateway pairing. Import a federation invite to pair it.";
  }
  if (reason.includes("federation key cannot be decrypted")) {
    return "This machine's keychain identity changed (common for unsigned dev builds), so the stored federation key is unreadable. Forget the gateway pairing here, then generate and import a fresh invite.";
  }
  if (reason.includes("secret storage is unavailable")) {
    return "Federation keys need the system credential store. Re-enable secret storage (unset PWRAGENT_DEV_DISABLE_SECRET_STORAGE for dev builds) and restart.";
  }
  return undefined;
}

function peerDisplayName(
  peerId: string,
  peers: FederationHealthStatus["peers"],
): string {
  const peer = peers.find((candidate) => candidate.id === peerId);
  return peer && peer.label !== peerId
    ? formatFederationPeerDisplayLabel(peer, peers)
    : peerId;
}

function trimmedOrUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseGatewayEndpoints(text: string): string[] {
  const seen = new Set<string>();
  const endpoints: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    endpoints.push(trimmed);
  }
  return endpoints;
}

function endpointStateLabel(state: FederationEndpointStatus["state"]): string {
  switch (state) {
    case "active":
      return "Active";
    case "connecting":
      return "Connecting";
    case "failed":
      return "Failed";
    case "idle":
      return "Idle";
  }
}

function celestialIconLabel(icon: CelestialIconId): string {
  switch (icon) {
    case "sun":
      return "Sun";
    case "moon":
      return "Moon";
    case "ringed-planet":
      return "Ringed planet";
    case "tilted-ringed-planet":
      return "Steep-ring planet";
    case "black-hole":
      return "Black hole";
  }
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
