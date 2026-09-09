import { useEffect, useState } from "react";
import type { CloudflareSetupRequest, CloudflareSetupStatus, DesktopSettingsConfigPatch } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { SettingsField, SettingsSection } from "./SettingsLayout";

type Props = {
  api?: DesktopApi;
  listenPort: string;
  mode?: string;
  onWriteConfig: (patch: DesktopSettingsConfigPatch) => Promise<boolean>;
  onSettingsChanged: () => Promise<void>;
};

export function CloudflareSetup({ api, listenPort, mode, onWriteConfig, onSettingsChanged }: Props) {
  const [status, setStatus] = useState<CloudflareSetupStatus>();
  const [token, setToken] = useState("");
  const [accountId, setAccountId] = useState("");
  const [zoneId, setZoneId] = useState("");
  const [hostname, setHostname] = useState("");
  const [label, setLabel] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<"gateway" | "client">("gateway");

  useEffect(() => {
    let active = true;
    void api?.configureFederationCloudflare?.({ action: "status" }).then((value) => {
      if (!active) return;
      setStatus(value);
      setAccountId(value.accountId ?? "");
      setZoneId(value.zoneId ?? "");
      setHostname(value.hostname ?? "");
    }).catch((err: unknown) => { if (active) setError(err instanceof Error ? err.message : "Could not read Cloudflare setup."); });
    return () => { active = false; };
  }, [api]);

  const run = async (request: CloudflareSetupRequest, progress: string) => {
    if (!api?.configureFederationCloudflare || busy) return;
    setBusy(progress);
    setError(undefined);
    try {
      if (request.action === "provision") {
        const port = Number(listenPort);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Enter a valid federation listener port above.");
        const saved = await onWriteConfig({ federation: { mode: mode === "client" || mode === "dual" ? "dual" : "gateway", listenHost: "127.0.0.1", listenPort: port } });
        if (!saved) throw new Error("The gateway listener could not be enabled.");
      }
      setStatus(await api.configureFederationCloudflare(request));
      if (request.action === "connect") setToken("");
      if (request.action === "export-client" || request.action === "import-client") setPassword("");
      await onSettingsChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cloudflare setup failed.");
      try { setStatus(await api.configureFederationCloudflare({ action: "status" })); } catch { /* Preserve the original error. */ }
    } finally { setBusy(undefined); }
  };

  const disabled = Boolean(busy) || !api?.configureFederationCloudflare;
  const field = (name: string, value: string, change: (text: string) => void, placeholder: string, secret = false) => (
    <input className="settings-input" aria-label={name} value={value} onChange={(event) => change(event.target.value)} placeholder={placeholder}
      type={secret ? "password" : "text"} autoComplete="off" spellCheck={false} disabled={disabled} />
  );
  const action = (name: string, request: CloudflareSetupRequest, progress: string, primary = false, blocked = false) => (
    <button type="button" className={`button button--${primary ? "primary" : "secondary"}`} disabled={disabled || blocked}
      onClick={() => void run(request, progress)}>{name}</button>
  );

  return <SettingsSection eyebrow="Private access over the Internet" title="Cloudflare secure setup"
    chip={status?.hostname ? "mTLS" : "Setup"} chipKind="muted">
    <div className="cloudflare-setup">
      <p className="cloudflare-setup__intro">A public address that only your certificate holders can use. Create the tunnel, issue client certificates, and verify that Cloudflare blocks everyone else before they reach this gateway.</p>
      <div className="settings-button-row" role="group" aria-label="Cloudflare setup role">
        <button type="button" className={`button button--${tab === "gateway" ? "primary" : "secondary"}`} aria-pressed={tab === "gateway"} disabled={disabled} onClick={() => setTab("gateway")}>Set up this gateway</button>
        <button type="button" className={`button button--${tab === "client" ? "primary" : "secondary"}`} aria-pressed={tab === "client"} disabled={disabled} onClick={() => setTab("client")}>Connect this client</button>
      </div>
      {tab === "gateway" ? <>
        <ol className="cloudflare-setup__steps">
          <li className={status?.connected ? "is-complete" : "is-current"}>Cloudflare account</li>
          <li className={status?.hostname ? "is-complete" : status?.connected ? "is-current" : ""}>Protected endpoint</li>
          <li className={status?.checks && status.checks.length >= 9 && status.checks.every((check) => check.passed) ? "is-complete" : status?.hostname ? "is-current" : ""}>Verify & connect</li>
        </ol>
        {!status?.connected ? <div className="settings-fields">
          <p>Use a domain already active on Cloudflare and a Zero Trust account. PwrAgent creates its own CA and 90-day client certificates; no purchased CA certificate is needed.</p>
          <div className="settings-button-row">{action("Create API token in Cloudflare", { action: "token-link" }, "Opening Cloudflare…")}</div>
          <details className="cloudflare-setup__help" open>
            <summary>Token permissions and scope</summary>
            <p>The link prefills DNS, Zone, and Access permissions. Add the remaining permissions below, scope the token to your account and domain, and choose an expiry.</p>
            <ul>
              <li>Account → Cloudflare Tunnel → Edit</li>
              <li>Account → Access: Apps and Policies → Edit</li>
              <li>Account → Access: Mutual TLS Certificates → Edit</li>
              <li>Zone → Access: Apps and Policies → Edit (includes the zone audit)</li>
              <li>Zone → DNS → Edit; Zone → Zone → Read</li>
            </ul>
            <p>Copy Account ID and Zone ID from your domain’s Overview page. The API token stays in memory until you disconnect or quit PwrAgent.</p>
          </details>
          <SettingsField label="Account ID" control={field("Cloudflare account ID", accountId, setAccountId, "32-character account ID")} />
          <SettingsField label="Zone ID" control={field("Cloudflare zone ID", zoneId, setZoneId, "32-character zone ID")} />
          <SettingsField label="API token" control={field("Cloudflare setup API token", token, setToken, "Paste scoped API token", true)} />
          <div className="settings-button-row">{action("Connect Cloudflare", { action: "connect", token, accountId, zoneId }, "Checking account and permissions…", true, !token || !accountId || !zoneId)}</div>
        </div> : <div className="cloudflare-setup__account"><span>Connected · {status.zoneName}</span>{action("Disconnect API token", { action: "disconnect" }, "Disconnecting…")}</div>}
        <div className="settings-fields">
          <SettingsField label="Tunnel connector" sub="Runs while this gateway is enabled. PwrAgent restarts it with the gateway on the next app launch."
            control={<span>{status?.connectorRunning ? "Running" : status?.connectorInstalled ? "Installed" : "cloudflared required"}</span>} />
          {!status?.connectorInstalled && <div className="settings-button-row">{action("Install cloudflared", { action: "install-link" }, "Opening installation guide…")}{action("Check installation", { action: "status" }, "Checking connector…")}</div>}
          {status?.connected && (!status.tunnelId || status.phase?.startsWith("Setup incomplete")) && <>
            <SettingsField label="Public hostname" sub={`A new hostname directly under ${status.zoneName}. Existing DNS and Access policies are preserved.`}
              control={field("Cloudflare public hostname", hostname, setHostname, `federation.${status.zoneName}`)} />
            {!status.tunnelId || status.phase?.startsWith("Setup incomplete") ? <>
              <p>This enables a gateway on 127.0.0.1:{listenPort}, creates a private CA and certificate-only Access policy, then publishes the tunnel hostname.</p>
              <div className="settings-button-row">{action(status.hostname ? "Resume endpoint creation" : "Create protected endpoint", { action: "provision", hostname, listenPort: Number(listenPort) }, "Creating CA, Access policy, and tunnel…", true, !hostname || !status.connectorInstalled)}</div>
            </> : null}
          </>}
        </div>
        {status?.tunnelId && <>
          <div className="cloudflare-setup__endpoint"><code>wss://{status.hostname}</code><span>{status.phase}</span></div>
          <div className="settings-button-row">
            {action("Audit Cloudflare settings", { action: "audit" }, "Auditing live Cloudflare configuration…", false, !status.connected)}
            {action("Validate Endpoint Security", { action: "validate" }, "Testing certificate admission and gateway observations…", true, !status.connected || !status.connectorRunning)}
            {status.connectorRunning ? action("Stop connector", { action: "stop" }, "Stopping connector…") : action("Start connector", { action: "start" }, "Starting connector…")}
          </div>
          <p className="cloudflare-setup__hint">Validation checks the live policy, then tries HTTPS and WebSocket requests with and without a certificate. A pass requires 403 at Cloudflare and no matching request at this gateway.</p>
          {status.checks && <div className="cloudflare-setup__checks" aria-label="Endpoint security results">
            {status.checks.map((check) => <div key={check.label} className={check.passed ? "is-pass" : "is-fail"}>
              <span>{check.passed ? "PASS" : "FAIL"}</span><div><strong>{check.label}</strong><p>{check.detail}</p></div>
            </div>)}
            <small>Checked {status.checkedAt ? new Date(status.checkedAt).toLocaleString() : "now"}. Results describe this check, not future policy changes.</small>
          </div>}
          <div className="settings-fields">
            <SettingsField label="New client" sub="Each client gets its own certificate and revocable identity." control={field("Cloudflare client name", label, setLabel, "Travel laptop")} />
            <SettingsField label="Transfer password" sub="At least 12 characters. Protects the setup file containing the private key and one-hour enrollment invite."
              control={field("Cloudflare client transfer password", password, setPassword, "Password for encrypted setup file", true)} />
            <div className="settings-button-row">{action("Issue & save client setup", { action: "export-client", label, password }, "Issuing client certificate and encrypting setup…", false, !status.connected || !label || password.length < 12)}</div>
          </div>
          {status.clients.map((client) => <div className="cloudflare-setup__client" key={client.id}>
            <div><strong>{client.label}</strong><small>{client.revoked ? "Revoked" : `Expires ${new Date(client.expiresAt).toLocaleDateString()}`}</small></div>
            {!client.revoked && action("Revoke certificate", { action: "revoke-client", id: client.id }, "Revoking certificate admission…", false, !status.connected)}
          </div>)}
          <p className="cloudflare-setup__hint">Certificate revocation blocks new connections. Revoke the peer in Federation to terminate an existing session immediately.</p>
        </>}
      </> : <div className="settings-fields">
        <p>On the gateway, choose “Issue & save client setup.” Bring that encrypted file here and enter its transfer password. PwrAgent installs the client certificate and imports the gateway invite together.</p>
        <SettingsField label="Transfer password" control={field("Cloudflare client import password", password, setPassword, "Password supplied by your gateway", true)} />
        <div className="settings-button-row">{action("Open client setup file", { action: "import-client", password }, "Decrypting client setup and connecting…", true, !password)}</div>
      </div>}
      {busy && <p role="status" aria-live="polite">{busy}</p>}
      {status?.message && <p role="status">{status.message}</p>}
      {error && <p className="cloudflare-setup__error" role="alert">{error}</p>}
    </div>
  </SettingsSection>;
}
