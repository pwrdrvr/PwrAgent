import { useEffect, useState } from "react";
import type {
  DesktopSettingsSnapshot,
  FederationConnectionState,
  FederationHealthStatus,
  FederationInstanceRole,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  SettingsField,
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
} from "./SettingsLayout";

type FederationSettingsProps = {
  desktopApi?: DesktopApi;
  snapshot: DesktopSettingsSnapshot;
};

export function FederationSettings(props: FederationSettingsProps) {
  const [health, setHealth] = useState<FederationHealthStatus>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

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

  const mode = props.snapshot.federation.mode.value;
  const effectiveHealth =
    health ??
    ({
      enabled: mode !== "disabled",
      role: mode === "gateway" || mode === "dual" ? mode : "child",
      status: mode === "disabled" ? "disabled" : "disconnected",
      listenUrl:
        mode === "disabled"
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
        eyebrow="Runtime"
        title="Connection"
        chip={statusLabel(effectiveHealth.status)}
        chipKind={chipKindForStatus(effectiveHealth.status)}
      >
        <div className="settings-fields">
          <SettingsField
            label="Mode"
            sub="Configured role for this profile."
            control={<code>{mode}</code>}
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
        title="Enrolled Peers"
        chip={`${effectiveHealth.peers.length}`}
      >
        {effectiveHealth.peers.length === 0 ? (
          <p className="settings-empty">No enrolled peers.</p>
        ) : (
          <dl className="settings-aboutkv">
            {effectiveHealth.peers.map((peer) => (
              <div key={peer.id}>
                <dt>{peer.label}</dt>
                <dd>
                  {peer.id} · {roleLabel(peer.role)} · {statusLabel(peer.status)}
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
