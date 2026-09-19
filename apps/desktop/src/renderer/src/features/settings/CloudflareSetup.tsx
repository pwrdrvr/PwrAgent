import { useEffect, useState, type ReactNode } from "react";
import type {
  CloudflareFederationGate,
  CloudflareSetupDraft,
  CloudflareSetupLink,
  CloudflareSetupRequest,
  CloudflareSetupStatus,
  DesktopSettingsConfigPatch,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { AutomationFlow, AutomationStage } from "../automations/AutomationFunnel";
import { SettingsField, SettingsSection, type SettingsChipTone } from "./SettingsLayout";

type Props = {
  api?: DesktopApi;
  listenPort: string;
  listenHost?: string;
  mode?: string;
  onWriteConfig: (patch: DesktopSettingsConfigPatch) => Promise<boolean>;
  onSettingsChanged: () => Promise<void>;
  /** The manual credential form, for an endpoint set up outside this guide. */
  manual?: ReactNode;
  /** Whether this instance presents Cloudflare credentials as a client, so the chip does not read "Not set up". */
  manualConfigured?: boolean;
};

type StageProgress = { state: "done" | "current" | "waiting"; label: string };

const GATE_NAMES: Record<CloudflareFederationGate, string> = {
  "service-token": "Service token",
  oauth: "Sign-in",
  mtls: "mTLS",
};

const INVITE_HOURS = [1, 4, 8, 24];

/** Emails as typed: any mix of commas, semicolons, spaces, and newlines. */
/** An IPC failure's own message, without Electron's "Error invoking remote method" wrapper. */
function errorText(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback;
  return err.message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, "") || fallback;
}

function parseEmails(text: string): string[] {
  return text.split(/[\s,;]+/).map((entry) => entry.trim()).filter(Boolean);
}

function draftKey(accountId: string, zoneId: string, hostname: string, gate: CloudflareFederationGate, emails: string): string {
  return JSON.stringify([accountId.trim(), zoneId.trim(), hostname.trim(), gate, emails.trim()]);
}

export function CloudflareSetup(props: Props) {
  const { api, listenPort, onWriteConfig, onSettingsChanged } = props;
  const [status, setStatus] = useState<CloudflareSetupStatus>();
  const [token, setToken] = useState("");
  const [accountId, setAccountId] = useState("");
  const [zoneId, setZoneId] = useState("");
  const [hostname, setHostname] = useState("");
  const [emailsText, setEmailsText] = useState("");
  const [allowlistText, setAllowlistText] = useState("");
  const [label, setLabel] = useState("");
  const [password, setPassword] = useState("");
  const [inviteHours, setInviteHours] = useState(1);
  const [busy, setBusy] = useState<{ action: CloudflareSetupRequest["action"]; progress: string }>();
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<"gateway" | "client">("gateway");
  // Service tokens work on every Zero Trust plan, so they are the default.
  // A provisioned endpoint reports its own gate and the choice is fixed.
  const [gate, setGate] = useState<CloudflareFederationGate>("service-token");
  const [savedDraft, setSavedDraft] = useState("");

  useEffect(() => {
    let active = true;
    void api?.configureFederationCloudflare?.({ action: "status" }).then((value) => {
      if (!active) return;
      setStatus(value);
      const draft = value.draft ?? {};
      const loaded = {
        accountId: value.accountId ?? draft.accountId ?? "",
        zoneId: value.zoneId ?? draft.zoneId ?? "",
        hostname: value.hostname ?? draft.hostname ?? "",
        gate: value.gate ?? draft.gate ?? "service-token",
        emails: (value.emails ?? draft.emails ?? []).join("\n"),
      };
      setAccountId(loaded.accountId);
      setZoneId(loaded.zoneId);
      setHostname(loaded.hostname);
      setGate(loaded.gate);
      setEmailsText(loaded.emails);
      setAllowlistText((value.emails ?? []).join("\n"));
      setSavedDraft(draftKey(loaded.accountId, loaded.zoneId, loaded.hostname, loaded.gate, loaded.emails));
      // An instance that only connects through a sign-in endpoint has nothing
      // to set up as a gateway; open on the half it actually uses.
      if (value.signIn && !value.hostname) setTab("client");
    }).catch((err: unknown) => { if (active) setError(errorText(err, "Could not read Cloudflare setup.")); });
    return () => { active = false; };
  }, [api]);

  // A provisioned endpoint's gate is a fact, not a preference: the Access policy
  // and every issued credential are built around it. Only an unprovisioned
  // setup reads the local choice.
  const effectiveGate: CloudflareFederationGate = status?.gate ?? gate;
  const mtls = effectiveGate === "mtls";
  const oauth = effectiveGate === "oauth";
  const emails = parseEmails(emailsText);
  const disabled = Boolean(busy) || !api?.configureFederationCloudflare;
  const created = Boolean(status?.hostname);
  const published = status?.phase === "Published";
  // Once the account is connected, offer a free conventional name as a real
  // value. As a placeholder it read as already filled in, while Create stayed
  // disabled. The main process picks one nothing in the zone uses yet, since
  // another profile's endpoint often holds the first choice.
  const suggestedHostname = status?.suggestedHostname;
  useEffect(() => {
    if (suggestedHostname && !created) setHostname((current) => current.trim() ? current : suggestedHostname);
  }, [suggestedHostname, created]);
  // The tunnel sends traffic to the port the setup recorded; the listener may
  // have moved since, typically off a port another process already held.
  const livePort = Number(listenPort);
  const portMoved = Boolean(status?.listenPort && Number.isInteger(livePort) && livePort > 0 && status.listenPort !== livePort);
  const connected = Boolean(status?.connected);
  const installed = Boolean(status?.connectorInstalled);
  const connectorVersion = status?.connectorVersion ? ` ${status.connectorVersion}` : "";
  // Validation has run — not just the audit — and nothing failed.
  const verified = Boolean(status?.checks?.length && status.checks.every((check) => check.passed)
    && status.checks.some((check) => check.label.startsWith("WebSocket upgrade without")));
  const draft: CloudflareSetupDraft = {
    accountId, zoneId, hostname, gate: effectiveGate, emails: oauth ? emails : undefined,
  };
  const currentDraftKey = draftKey(accountId, zoneId, hostname, effectiveGate, oauth ? emails.join("\n") : "");
  const dirty = !created && currentDraftKey !== savedDraft;
  const started = created || Boolean(accountId || zoneId || hostname || token || emails.length);

  // The published allowlist box follows the endpoint's list until someone edits
  // it. Creating the endpoint is what first gives it a list.
  const allowlistPristine = parseEmails(allowlistText).join("\n") === (status?.emails ?? []).join("\n");
  const adopt = (next: CloudflareSetupStatus, replaceAllowlist = false) => {
    setStatus(next);
    if (replaceAllowlist || allowlistPristine) setAllowlistText((next.emails ?? []).join("\n"));
  };

  const run = async (request: CloudflareSetupRequest, progress: string) => {
    if (!api?.configureFederationCloudflare || busy) return;
    setBusy({ action: request.action, progress });
    setError(undefined);
    try {
      if (request.action === "provision") {
        const port = Number(listenPort);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Enter a valid federation listener port above.");
        const saved = await onWriteConfig({ federation: { mode: props.mode === "client" || props.mode === "dual" ? "dual" : "gateway", listenHost: "127.0.0.1", listenPort: port } });
        if (!saved) throw new Error("The gateway listener could not be enabled.");
      }
      const next = await api.configureFederationCloudflare(request);
      adopt(next, request.action === "set-emails");
      if (request.action === "connect") setToken("");
      if (request.action === "save-draft") setSavedDraft(currentDraftKey);
      // A removed setup's hostname goes with it, so the field takes the next
      // free name rather than offering the one just given up.
      if (request.action === "remove" && !next.hostname) setHostname("");
      if (request.action === "export-client" || request.action === "import-client") setPassword("");
      await onSettingsChanged();
    } catch (err) {
      setError(errorText(err, "Cloudflare setup failed."));
      try { adopt(await api.configureFederationCloudflare({ action: "status" })); } catch { /* Preserve the original error. */ }
    } finally { setBusy(undefined); }
  };

  // What stands between this form and a published endpoint, in the order the
  // stages ask for it. Empty once the endpoint exists.
  const missing: string[] = [];
  if (!created) {
    if (!connected) {
      if (!accountId.trim()) missing.push("Account ID");
      if (!zoneId.trim()) missing.push("Zone ID");
      if (!token.trim()) missing.push("API token");
    }
    if (!installed) missing.push("cloudflared");
    if (!hostname.trim()) missing.push("public hostname");
    if (oauth && emails.length === 0) missing.push("who can sign in");
  }
  const present = (items: Array<string | false>) => items.filter((entry): entry is string => Boolean(entry));
  const connectMissing = present([!accountId.trim() && "Account ID", !zoneId.trim() && "Zone ID", !token.trim() && "API token"]);
  const createMissing = present([
    !connected && "a connected Cloudflare account",
    !installed && "cloudflared",
    !hostname.trim() && "a public hostname",
    oauth && emails.length === 0 && "at least one email",
  ]);
  const shareMissing = present([
    !connected && "a connected Cloudflare account (step 2)",
    !label.trim() && "a client name",
    password.length < 12 && "a transfer password of 12+ characters",
  ]);

  // One stage is "Next": the first whose work is not done. After publishing,
  // the API token is gone on relaunch, and auditing or issuing needs it back.
  const current = [
    { key: "account", done: connected },
    { key: "connector", done: installed },
    { key: "endpoint", done: published },
    { key: "verify", done: verified },
  ].find((entry) => !entry.done)?.key ?? "share";
  const progress = (key: string, done: boolean, doneLabel: string): StageProgress =>
    done ? { state: "done", label: doneLabel }
      : key === current ? { state: "current", label: "Next" }
        : { state: "waiting", label: "Waiting" };

  const failedChecks = Boolean(status?.checks?.some((check) => !check.passed));
  const [chip, chipKind]: [string, SettingsChipTone] =
    status?.signIn?.state === "sign-in-required" ? ["Sign-in required", "warn"]
      : verified ? ["Verified", "ok"]
        : failedChecks ? ["Check failed", "err"]
          : published ? [GATE_NAMES[effectiveGate], "ok"]
            : started ? ["Incomplete", "warn"]
              : status?.signIn?.state === "signed-in" ? ["Signed in", "ok"]
                : props.manualConfigured ? ["Client set up", "ok"]
                  : ["Not set up", "muted"];

  const field = (name: string, value: string, change: (text: string) => void, placeholder: string, options: { secret?: boolean; locked?: boolean } = {}) => (
    <input className="settings-input" aria-label={name} value={value} onChange={(event) => change(event.target.value)} placeholder={placeholder}
      type={options.secret ? "password" : "text"} autoComplete="off" spellCheck={false} disabled={disabled || options.locked} />
  );
  const action = (name: string, request: CloudflareSetupRequest, progressText: string, primary = false, blocked = false) => (
    <button type="button" className={`button button--${primary ? "primary" : "secondary"}`} disabled={disabled || blocked}
      onClick={() => void run(request, progressText)}>{name}</button>
  );
  // Reference links stay enabled while an operation runs: an operator reading the
  // docs mid-setup is the case they exist for. They carry no request payload, so
  // they cannot collide with the main-process busy latch.
  const link = (name: string, target: CloudflareSetupLink) => (
    <button type="button" className="cloudflare-setup__link" disabled={!api?.configureFederationCloudflare}
      onClick={() => void api?.configureFederationCloudflare?.({ action: "open-link", link: target })}>{name}</button>
  );
  const saveDraft = action("Save draft", { action: "save-draft", draft }, "Saving draft…", false, !dirty);
  const needs = (items: string[]) => items.length
    ? <p className="cloudflare-setup__needs">Still needed: {items.join(", ")}.</p>
    : null;

  // Creating the endpoint rewrites the federation listener, so say exactly
  // what changes before the operator commits to it.
  const port = Number(listenPort) || listenPort;
  const modeChange = props.mode === "gateway" || props.mode === "dual" ? ""
    : props.mode === "client" ? " Federation mode changes from client to dual, so this instance keeps its own gateway connection too."
      : " Federation turns on in gateway mode.";
  const hostChange = props.listenHost && props.listenHost !== "127.0.0.1"
    ? ` The listener moves from ${props.listenHost} to 127.0.0.1, so it is reachable only through the tunnel.`
    : "";
  const signingIn = busy?.action === "sign-in";
  // Waiting on the browser. A login method that refuses the person strands the
  // browser on a blank page, so the way back is offered up front rather than
  // after the wait times out. Both buttons work outside the busy latch.
  const signInHelp = (lead: string) => <div className="cloudflare-setup__notice" role="note">
    <p>{lead} If Cloudflare says &ldquo;That account does not have access&rdquo; or leaves a blank page, open the sign-in page again and use an email the gateway allows; one-time PIN works with any address.</p>
    <div className="settings-button-row">
      <button type="button" className="button button--secondary"
        onClick={() => void api?.configureFederationCloudflare?.({ action: "reopen-sign-in" }).then(adopt, () => undefined)}>Open the sign-in page again</button>
      <button type="button" className="button button--secondary"
        onClick={() => void api?.configureFederationCloudflare?.({ action: "cancel-sign-in" })}>Cancel sign-in</button>
    </div>
  </div>;

  return <SettingsSection sectionId="cloudflare" eyebrow="Private access over the Internet" title="Cloudflare Access" chip={chip} chipKind={chipKind}>
    <div className="cloudflare-setup">
      <p className="cloudflare-setup__intro">Give this gateway a public <code>wss://</code> address that Cloudflare guards. Anyone without an approved credential or sign-in is turned away at Cloudflare&rsquo;s edge, before the request reaches this computer. PwrAgent&rsquo;s own encryption still authenticates every peer behind it.</p>
      <ul className="cloudflare-setup__facts">
        <li><strong>Cost</strong> Free on Cloudflare&rsquo;s Zero Trust Free plan (up to 50 users), with a domain already on Cloudflare. Nothing to buy: no signing certificate and no certificate authority.</li>
        <li><strong>Installs</strong> The gateway runs <code>cloudflared</code>. Client machines need only PwrAgent.</li>
        <li><strong>Hand-off</strong> Each client gets one encrypted setup file, and a password you send separately.</li>
      </ul>
      <div className="settings-button-row" role="group" aria-label="Cloudflare setup role">
        <button type="button" className={`button button--${tab === "gateway" ? "primary" : "secondary"}`} aria-pressed={tab === "gateway"} disabled={disabled} onClick={() => setTab("gateway")}>Set up this gateway</button>
        <button type="button" className={`button button--${tab === "client" ? "primary" : "secondary"}`} aria-pressed={tab === "client"} disabled={disabled} onClick={() => setTab("client")}>Connect this client</button>
      </div>

      {tab === "gateway" ? <>
        {!published && started ? <p className="cloudflare-setup__state" role="status">
          {created
            ? "Endpoint creation stopped partway. Resume it or start over in step 4; nothing is published until every check passes."
            : missing.length
              ? <><strong>Incomplete.</strong> Still needed: {missing.join(", ")}. Save a draft to finish later; nothing is enabled until you create the endpoint.</>
              : <><strong>Ready.</strong> Everything needed to create the endpoint is in place.</>}
        </p> : null}
        <div className="automation-funnel cloudflare-setup__funnel">
          <AutomationStage verb="Choose" title="How clients get in" progress={{ state: "done", label: created ? "Locked" : GATE_NAMES[effectiveGate] }}>
            <fieldset className="cloudflare-setup__gate" disabled={disabled || created}>
              <legend>Admission</legend>
              <label>
                <input type="radio" name="cloudflare-gate" value="service-token" checked={effectiveGate === "service-token"}
                  onChange={() => setGate("service-token")} />
                <span><strong>Service token</strong> <em>Recommended</em> — any Zero Trust plan, including Free. Cloudflare issues each client an ID and secret, carried inside its encrypted setup file. Revoke one client without touching the others.</span>
              </label>
              <label>
                <input type="radio" name="cloudflare-gate" value="oauth" checked={oauth} onChange={() => setGate("oauth")} />
                <span><strong>Sign in with an identity</strong> <em>Beta</em> — any Zero Trust plan. Each person signs in through your organization&rsquo;s login methods, such as GitHub or a one-time PIN, in their own browser, and stays signed in for up to two weeks. No secret to hand out: access follows an email allowlist.</span>
              </label>
              <label>
                <input type="radio" name="cloudflare-gate" value="mtls" checked={mtls} onChange={() => setGate("mtls")} />
                <span><strong>Client certificate (mTLS)</strong> — Contract (Enterprise) plans only. PwrAgent creates a private certificate authority and one certificate per client; nothing is purchased and no machine has to trust a new root.</span>
              </label>
              {created ? <p className="cloudflare-setup__hint">This endpoint was created for {oauth ? "sign-in" : mtls ? "client certificates" : "service tokens"}. Changing how clients get in means recreating it.</p> : null}
            </fieldset>
            {oauth ? <div className="cloudflare-setup__notice" role="note">
              <strong>Sign-in uses Cloudflare&rsquo;s Managed OAuth, which Cloudflare marks Beta.</strong>
              <p>People sign in with whatever login methods your Zero Trust organization has. One-time PIN works with no setup; GitHub needs an OAuth app registered once. Each person who signs in uses one of the Free plan&rsquo;s 50 seats.</p>
              <div className="settings-button-row">
                {link("Managed OAuth documentation", "oauth-docs")}
                {link("Add GitHub as a login method", "github-login-docs")}
                {link("Open login methods in the dashboard", "dash-login-methods")}
              </div>
            </div> : null}
            {mtls ? <div className="cloudflare-setup__notice" role="note">
              <strong>Access mTLS requires a Contract (Enterprise) Zero Trust plan. Confirmed unavailable on the Free plan.</strong>
              <p>On a Free plan the certificate-authority upload is refused with &ldquo;maximum number of certificates has been reached&rdquo; even with none stored — the quota is zero. Cloudflare&rsquo;s plan comparison marks mTLS authentication as Contract-only, while the feature&rsquo;s own documentation lists pay-as-you-go. PwrAgent has not yet validated this gate on a Contract plan.</p>
              <p>Service tokens and sign-in gate the same endpoint at the same edge, on any plan.</p>
              <div className="settings-button-row">
                {link("Compare Zero Trust plans", "mtls-plans")}
                {link("Access mTLS documentation", "mtls-docs")}
                {link("Open Mutual TLS in the dashboard", "dash-mtls")}
              </div>
            </div> : null}
          </AutomationStage>
          <AutomationFlow caption="PwrAgent creates everything in your Cloudflare account through a scoped API token" />

          <AutomationStage verb="Connect" title="Cloudflare account" progress={progress("account", connected, "Connected")}>
            {connected ? <div className="cloudflare-setup__account">
              <span>Connected · {status?.zoneName}</span>
              {action("Disconnect API token", { action: "disconnect" }, "Disconnecting…")}
            </div> : <>
              {created ? <p>The API token is held only in memory, so it is needed again after PwrAgent restarts — to audit, validate, or issue clients. The published endpoint keeps working without it.</p>
                : <p>Use a domain already active on Cloudflare. The API token is held in memory until you disconnect or quit PwrAgent; the account and zone IDs can be saved as a draft.</p>}
              <div className="settings-button-row">
                {action("Create API token in Cloudflare", { action: "token-link" }, "Opening Cloudflare…")}
                {link("Open your domain’s Overview for the IDs", "dash-zone-overview")}
              </div>
              <details className="cloudflare-setup__help">
                <summary>Token permissions</summary>
                <p>The link fills in every permission below except the two marked Add, which Cloudflare cannot prefill. Add those, scope the token to your account and this domain, and choose an expiry.</p>
                <ul>
                  <li>Account → Cloudflare Tunnel → Edit</li>
                  <li>Account → Access: Apps and Policies → Edit</li>
                  <li><strong>Add:</strong> {mtls ? "Account → Access: Mutual TLS Certificates → Edit" : "Account → Access: Service Tokens → Edit"}</li>
                  <li><strong>Add:</strong> Zone → Access: Apps and Policies → Read</li>
                  <li>Zone → DNS → Edit; Zone → Zone → Read</li>
                </ul>
                {oauth ? <p>Sign-in still uses one service token: the gateway&rsquo;s own, for checking the endpoint with no person present.</p> : null}
                <div className="settings-button-row">
                  {mtls ? link("Allowed CA signature algorithms", "signature-algorithms") : link("Service token documentation", "service-token-docs")}
                </div>
              </details>
              <SettingsField label="Account ID" control={field("Cloudflare account ID", accountId, setAccountId, "32-character account ID", { locked: created })} />
              <SettingsField label="Zone ID" control={field("Cloudflare zone ID", zoneId, setZoneId, "32-character zone ID", { locked: created })} />
              <SettingsField label="API token" sub="Not saved to disk." control={field("Cloudflare setup API token", token, setToken, "Paste scoped API token", { secret: true })} />
              <div className="settings-button-row">
                {action("Connect Cloudflare", { action: "connect", token, accountId, zoneId, gate: effectiveGate }, "Checking account and permissions…", true, connectMissing.length > 0)}
                {created ? null : saveDraft}
              </div>
              {needs(connectMissing)}
            </>}
          </AutomationStage>
          <AutomationFlow caption="The tunnel connects outward from this computer; no inbound port opens" />

          <AutomationStage verb="Install" title="Tunnel connector" progress={progress("connector", installed, "Installed")}>
            <p>{status?.connectorRunning ? `cloudflared${connectorVersion} is running.`
              : installed ? `cloudflared${connectorVersion} is installed. PwrAgent starts it with the gateway.`
                : "Install cloudflared on this computer, then check again. PwrAgent runs it for you; there is nothing to configure in it."}</p>
            {!installed ? <div className="settings-button-row">
              {action("Install cloudflared", { action: "install-link" }, "Opening installation guide…")}
              {action("Check again", { action: "status" }, "Checking connector…")}
            </div> : null}
            {installed && status?.connectorUpdate ? <div className="cloudflare-setup__notice" role="note">
              <strong>cloudflared {status.connectorUpdate} is available.</strong>
              <p>Update it the way you installed it; with Homebrew, run <code>brew upgrade cloudflared</code>.{status.connectorRunning ? " The running connector keeps the old version until you stop and start it in step 5." : ""}</p>
              <div className="settings-button-row">
                {link("How to update cloudflared", "cloudflared-update-docs")}
                {action("Check again", { action: "status" }, "Checking connector…")}
              </div>
            </div> : null}
          </AutomationStage>
          <AutomationFlow caption={oauth ? "Cloudflare admits only the people on your allowlist" : mtls ? "Cloudflare admits only certificates from this gateway’s authority" : "Cloudflare admits only tokens this gateway issued"} />

          <AutomationStage verb="Create" title="Protected endpoint" progress={progress("endpoint", published, "Published")}>
            {published ? <>
              <div className="cloudflare-setup__endpoint"><code>wss://{status?.hostname}</code><span>{status?.phase}</span></div>
              {portMoved ? <div className="cloudflare-setup__notice" role="note">
                <strong>The tunnel points at a port the gateway no longer uses.</strong>
                <p>Cloudflare sends this endpoint&rsquo;s traffic to 127.0.0.1:{status?.listenPort}, but the gateway listener is set to {livePort}. Move the tunnel, or set the listener back to {status?.listenPort}.</p>
                <div className="settings-button-row">
                  {action(`Move tunnel to port ${livePort}`, { action: "provision", hostname: status?.hostname ?? "", listenPort: livePort, gate: effectiveGate },
                    "Moving the tunnel and re-checking the policy…", true, !connected)}
                </div>
                {!connected ? <p className="cloudflare-setup__hint">Connect the Cloudflare account in step 2 to move the tunnel.</p> : null}
              </div> : null}
              {oauth ? <>
                <SettingsField label="Who can sign in" sub="One email per line. A removed person&rsquo;s PwrAgent disconnects at its next access refresh, within 15 minutes; revoke their peer in Federation to end the session now."
                  control={<textarea className="settings-input cloudflare-setup__textarea" aria-label="People who can sign in" value={allowlistText} rows={3}
                    onChange={(event) => setAllowlistText(event.target.value)} spellCheck={false} disabled={disabled} />} />
                <div className="settings-button-row">
                  {action("Update allowlist", { action: "set-emails", emails: parseEmails(allowlistText) }, "Updating the Access policy…", false,
                    !connected || allowlistPristine || parseEmails(allowlistText).length === 0)}
                </div>
                {!connected ? <p className="cloudflare-setup__hint">Connect the Cloudflare account in step 2 to change the allowlist.</p> : null}
              </> : null}
              <div className="settings-button-row">
                {action("Remove endpoint", { action: "remove" }, "Removing the endpoint from Cloudflare…", false, !connected)}
              </div>
              <p className="cloudflare-setup__hint">Deletes the DNS record, tunnel, Access application, and credentials this setup created, after you confirm. Nothing else in the account changes.{!connected ? " Connect the Cloudflare account in step 2 first." : ""}</p>
            </> : <>
              {created ? <div className="cloudflare-setup__notice" role="note">
                <strong>Creation stopped before the endpoint was published.</strong>
                <p>{status?.resources?.length ? `Created in Cloudflare so far: ${status.resources.join(", ")}.` : "Nothing was created in Cloudflare yet."}
                  {portMoved ? ` The tunnel was set up for 127.0.0.1:${status?.listenPort}; the gateway listener is now ${livePort}, and resuming moves the tunnel there.` : ""}</p>
                <p>Resume to finish with these, or start over to delete exactly these and begin again. Nothing else in the account is touched.</p>
              </div> : null}
              <SettingsField label="Public hostname" sub={status?.zoneName
                ? `A new name directly under ${status.zoneName}. Existing DNS records and Access policies are never changed.`
                : "A new name directly under your domain, such as federation.example.com. Existing DNS records and Access policies are never changed."}
                control={field("Cloudflare public hostname", hostname, setHostname, status?.zoneName ? `A new name under ${status.zoneName}` : "federation.example.com", { locked: created })} />
              {oauth ? <SettingsField label="Who can sign in" sub="One email per line. Each must match the email the person’s login method reports."
                control={<textarea className="settings-input cloudflare-setup__textarea" aria-label="People who can sign in" value={emailsText} rows={3}
                  placeholder="you@example.com" onChange={(event) => setEmailsText(event.target.value)} spellCheck={false} disabled={disabled || created} />} /> : null}
              <p>Creating the endpoint uses this profile&rsquo;s saved listener port, so the gateway listens on 127.0.0.1:{port}; to use another port, change it in Configuration and save it first.{modeChange}{hostChange} PwrAgent then creates {oauth ? "the gateway’s validation token, an Access application with sign-in and an email allowlist," : mtls ? "a private certificate authority, an Access application with a certificate-only policy," : "the gateway’s validation token, an Access application with a token-only policy,"} and a tunnel — and publishes {hostname.trim() || "the hostname"} only after reading the policy back.</p>
              <div className="settings-button-row">
                {action(created ? "Resume endpoint creation" : "Create protected endpoint",
                  { action: "provision", hostname, listenPort: Number(listenPort), gate: effectiveGate, emails: oauth ? emails : undefined },
                  oauth ? "Creating validation token, sign-in policy, and tunnel…" : mtls ? "Creating CA, Access policy, and tunnel…" : "Creating service token, Access policy, and tunnel…",
                  true, createMissing.length > 0)}
                {created ? action("Start over", { action: "remove" }, "Deleting what this setup created…", false, !connected) : saveDraft}
              </div>
              {needs(createMissing)}
            </>}
          </AutomationStage>
          <AutomationFlow caption="Validation proves strangers are refused at Cloudflare and never reach this computer" />

          <AutomationStage verb="Verify" title="Endpoint security" progress={progress("verify", verified, "Verified")}>
            {status?.tunnelId ? <>
              <div className="settings-button-row">
                {action("Audit Cloudflare settings", { action: "audit" }, "Auditing live Cloudflare configuration…", false, !connected)}
                {action("Validate Endpoint Security", { action: "validate" }, oauth ? "Testing sign-in refusal and gateway observations…" : "Testing credential admission and gateway observations…", true, !connected || !status.connectorRunning)}
                {status.connectorRunning ? action("Stop connector", { action: "stop" }, "Stopping connector…") : action("Start connector", { action: "start" }, "Starting connector…", false, !published)}
              </div>
              <p className="cloudflare-setup__hint">Validation reads the live policy back, then sends HTTPS and WebSocket requests with and without {oauth ? "the gateway’s token" : `a ${mtls ? "certificate" : "service token"}`}. A pass needs Cloudflare to refuse the second at its edge and this gateway to see none of it.{!connected ? " Connect the Cloudflare account in step 2 to run it." : ""}</p>
              {status.checks ? <div className="cloudflare-setup__checks" aria-label="Endpoint security results">
                {status.checks.map((check) => <div key={check.label} className={check.passed ? "is-pass" : "is-fail"}>
                  <span>{check.passed ? "PASS" : "FAIL"}</span><div><strong>{check.label}</strong><p>{check.detail}</p></div>
                </div>)}
                <small>Checked {status.checkedAt ? new Date(status.checkedAt).toLocaleString() : "now"}. Results describe this check, not later policy changes.</small>
              </div> : null}
              <div className="settings-button-row cloudflare-setup__dash">
                <span>Inspect in Cloudflare:</span>
                {oauth ? link("Login methods", "dash-login-methods") : mtls ? link("Mutual TLS", "dash-mtls") : link("Service Tokens", "dash-service-tokens")}
                {link("Access application", "dash-endpoint-application")}
                {link("Tunnels", "dash-tunnels")}
              </div>
            </> : <p className="cloudflare-setup__hint">Available once the endpoint exists.</p>}
          </AutomationStage>
          <AutomationFlow caption="Each client receives one encrypted file; its password travels separately" />

          <AutomationStage verb="Share" title="Clients" progress={progress("share", false, "Ready")}>
            {published ? <>
              <p>{oauth
                ? "The setup file holds this endpoint and a one-time enrollment invite — no credential. The person opens it on their machine and signs in with an allowed email."
                : `The setup file holds this endpoint, a one-time enrollment invite, and a new 90-day ${mtls ? "client certificate" : "service token"} for that client alone. Move it any way you like; it is encrypted with the transfer password.`}</p>
              <SettingsField label="Client name" sub="Shown in this list and in Federation." control={field("Cloudflare client name", label, setLabel, "Travel laptop")} />
              <SettingsField label="Transfer password" sub="At least 12 characters. Send it separately from the file."
                control={field("Cloudflare client transfer password", password, setPassword, "Password for the encrypted setup file", { secret: true })} />
              <SettingsField label="Invite expires after" sub="The client must open the file within this window."
                control={<select className="settings-select" aria-label="Invite lifetime" value={inviteHours} disabled={disabled}
                  onChange={(event) => setInviteHours(Number(event.target.value))}>
                  {INVITE_HOURS.map((hours) => <option key={hours} value={hours}>{hours === 1 ? "1 hour" : `${hours} hours`}</option>)}
                </select>} />
              <div className="settings-button-row">
                {action(oauth ? "Save client setup file" : "Issue & save client setup", { action: "export-client", label, password, inviteTtlHours: inviteHours },
                  oauth ? "Creating the invite and encrypting setup…" : `Issuing ${mtls ? "client certificate" : "service token"} and encrypting setup…`, false,
                  shareMissing.length > 0)}
              </div>
              {needs(shareMissing)}
              {status?.clients.map((client) => <div className="cloudflare-setup__client" key={client.id}>
                <div><strong>{client.label}</strong><small>{client.revoked ? "Revoked" : `Expires ${new Date(client.expiresAt).toLocaleDateString()}`}</small></div>
                {!client.revoked && action(mtls ? "Revoke certificate" : "Revoke service token", { action: "revoke-client", id: client.id },
                  mtls ? "Revoking certificate admission…" : "Revoking service token…", false, !connected)}
              </div>)}
              {status?.clients.length ? <p className="cloudflare-setup__hint">Revoking removes the credential from the Access policy{mtls ? "" : " and deletes it in Cloudflare"}, and revokes the federation peer that enrolled with its setup file, which ends that peer&rsquo;s open session.</p> : null}
            </> : <p className="cloudflare-setup__hint">Available once the endpoint is published.</p>}
          </AutomationStage>
        </div>
      </> : <div className="automation-funnel cloudflare-setup__funnel">
        <AutomationStage verb="Get" title="Setup file from the gateway">
          <p>On the gateway, open Settings → Federation → Cloudflare Access and save a client setup file. Bring the <code>.pwrcf</code> file to this computer, and get its password from the person who made it.</p>
        </AutomationStage>
        <AutomationFlow caption="The file names the endpoint and carries a one-time enrollment invite" />
        <AutomationStage verb="Open" title="Connect with the file">
          <p>PwrAgent decrypts the file, installs the credential it carries — or opens your browser to sign in, if the endpoint uses sign-in — and enrolls this profile with the gateway.</p>
          <SettingsField label="Transfer password" control={field("Cloudflare client import password", password, setPassword, "Password from the gateway", { secret: true })} />
          <div className="settings-button-row">
            {action("Open client setup file", { action: "import-client", password }, "Decrypting client setup and connecting…", true, !password)}
          </div>
          {busy?.action === "import-client" ? signInHelp("If this file uses sign-in, finish it in your browser.") : null}
        </AutomationStage>
        {status?.signIn ? <>
          <AutomationFlow caption="Access refreshes quietly while PwrAgent runs" />
          <AutomationStage verb="Sign in" title="Cloudflare Access sign-in">
            <p className="cloudflare-setup__state" role="status">
              {status.signIn.state === "signed-in"
                ? <><strong>Signed in</strong>{status.signIn.signedInAt ? ` since ${new Date(status.signIn.signedInAt).toLocaleString()}` : ""}. Access refreshes automatically; you sign in again after two weeks, or sooner if you are removed from the allowlist.</>
                : status.signIn.state === "sign-in-required"
                  ? <><strong>Sign-in required.</strong> {status.signIn.lastError ?? "Your Cloudflare sign-in expired."} Federation reconnects once you sign in.</>
                  : <><strong>Signed out.</strong> Sign in to connect to <code>{status.signIn.endpoint}</code>.</>}
            </p>
            {signingIn ? signInHelp("Finish signing in in your browser.") : <div className="settings-button-row">
              {status.signIn.state === "signed-in"
                ? action("Sign out", { action: "sign-out" }, "Signing out…")
                : action("Sign in", { action: "sign-in" }, "Finish signing in in your browser…", true)}
            </div>}
          </AutomationStage>
        </> : null}
      </div>}

      {busy ? <p role="status" aria-live="polite">{busy.progress}</p> : null}
      {status?.message ? <p role="status">{status.message}</p> : null}
      {error ? <p className="cloudflare-setup__error" role="alert">{error}</p> : null}

      {props.manual ? <details className="cloudflare-setup__manual">
        <summary>Enter Cloudflare credentials manually</summary>
        <p>For an endpoint set up outside this guide. These are the credentials this instance presents when it connects to a Cloudflare endpoint as a client.</p>
        {props.manual}
      </details> : null}
    </div>
  </SettingsSection>;
}
