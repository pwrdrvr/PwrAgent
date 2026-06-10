import { useEffect, useState } from "react";
import type {
  DesktopFederationMode,
  DesktopSettingsConfigPatch,
  DesktopSettingsSnapshot,
  FederationConnectionState,
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
  onWriteConfig: (patch: DesktopSettingsConfigPatch) => Promise<boolean>;
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
};

export function FederationSettings(props: FederationSettingsProps) {
  const [health, setHealth] = useState<FederationHealthStatus>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [generatedInvite, setGeneratedInvite] = useState("");
  const [inviteToImport, setInviteToImport] = useState("");
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

  useEffect(() => {
    setMode(props.snapshot.federation.mode.value);
    setListenHost(props.snapshot.federation.listenHost.value);
    setListenPort(String(props.snapshot.federation.listenPort.value));
    setPublicUrl(props.snapshot.federation.publicUrl.value);
    setGatewayUrl(props.snapshot.federation.gatewayUrl.value);
  }, [props.snapshot]);

  const loadHealth = async () => {
    const reader = props.desktopApi?.readFederationHealth;
    if (!reader) {
      setError("Federation diagnostics are unavailable.");
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      const response = await reader({});
      setHealth(response.health);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadHealth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.desktopApi]);

  const effectiveHealth =
    health ??
    ({
      enabled: props.snapshot.federation.mode.value !== "disabled",
      role: props.snapshot.federation.mode.value === "gateway" ||
        props.snapshot.federation.mode.value === "dual"
        ? props.snapshot.federation.mode.value
        : "child",
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
            disabled={loading || !props.desktopApi?.readFederationHealth}
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
            sub="Gateway listens for peers; child connects to a gateway."
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
            sub="Child-mode gateway WebSocket URL."
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
            sub="Creates a one-time child enrollment payload."
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
              sub="Paste this into the child instance."
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
            sub="Paste a gateway invite on the child instance."
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
            sub="Outbound target used by child mode."
            control={
              <code>
                {trimmedOrUndefined(props.snapshot.federation.gatewayUrl.value) ??
                  "Not configured"}
              </code>
            }
          />
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
                <dd>
                  {peer.id} · {roleLabel(peer.role)} · {statusLabel(peer.status)}
                  <button
                    className="button button--ghost"
                    type="button"
                    disabled={
                      peer.status === "revoked" ||
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
          props.snapshot.federation.cloudflareMtlsEnabled.value ||
          props.snapshot.federation.cloudflareAccessServiceAuthEnabled.value
            ? "Configured"
            : "Optional"
        }
        chipKind={
          props.snapshot.federation.cloudflareMtlsEnabled.value ||
          props.snapshot.federation.cloudflareAccessServiceAuthEnabled.value
            ? "ok"
            : "muted"
        }
      >
        <div className="settings-fields">
          <SettingsField
            label="mTLS"
            sub="Cloudflare edge certificate gate."
            control={
              <span>
                {props.snapshot.federation.cloudflareMtlsEnabled.value
                  ? "Enabled"
                  : "Disabled"}
              </span>
            }
          />
          <SettingsField
            label="Access service auth"
            sub="Cloudflare Access service-token gate."
            control={
              <span>
                {props.snapshot.federation.cloudflareAccessServiceAuthEnabled.value
                  ? "Enabled"
                  : "Disabled"}
              </span>
            }
          />
        </div>
      </SettingsSection>
    </SettingsSectionStack>
  );
}

function trimmedOrUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function roleLabel(role: FederationInstanceRole): string {
  switch (role) {
    case "gateway":
      return "Gateway";
    case "child":
      return "Child";
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
