import { randomBytes, X509Certificate } from "node:crypto";
import type { CloudflareSecurityCheck, CloudflareSetupStatus } from "@pwragent/shared";
import {
  CLOUDFLARE_OAUTH_CONFIGURATION,
  CLOUDFLARE_SIGN_IN_SESSION_DURATION,
  CLOUDFLARE_SIGN_IN_SESSION_LIMIT_MS,
  CloudflareApi,
  CloudflareApiError,
  applicationCoversHostname,
  cloudflareAdmissionPolicy,
  cloudflareEmails,
  cloudflareHostname,
  cloudflareIdentityPolicy,
  cloudflareScopeId,
  isExactAdmissionPolicy,
  isExactIdentityPolicy,
  isDedicatedApplication,
  isExpectedOAuthConfiguration,
  parseCloudflareDuration,
  type AccessApplication,
  type CloudflareGate,
} from "./cloudflare-api";
import { createCloudflareCa, issueCloudflareClient, type CloudflareCertificate } from "./cloudflare-certificates";
import type { CloudflareOriginProbes } from "./cloudflare-origin-probes";
import { validateCloudflareBoundary, type CloudflareProbeCredentials } from "./cloudflare-security-validation";

/**
 * One admitted client, under either gate.
 *
 * `id` is deliberately whatever the Access policy selects on — the certificate
 * common name under mTLS, the Cloudflare service-token id otherwise — so the
 * policy, the audit, and revocation all read the same field and need no branch.
 * The credential beside it is the half that differs.
 */
type Client = {
  id: string;
  label: string;
  expiresAt: string;
  revoked: boolean;
  certificate?: string;
  privateKey?: string;
  clientId?: string;
  clientSecret?: string;
  /** The federation invite shipped with this credential, so Revoke can end its peer too. */
  enrollmentId?: string;
};

export type CloudflareSetupState = {
  version: 1;
  /** Absent in setups written before service tokens existed; those are mTLS. */
  gate?: CloudflareGate;
  accountId: string;
  zoneId: string;
  zoneName: string;
  hostname: string;
  listenPort: number;
  name: string;
  /** mTLS only. Service-token setups never generate a certificate authority. */
  ca?: CloudflareCertificate;
  verifier: Client;
  /** Credential-holding clients; always empty under `oauth`, where people sign in. */
  clients: Client[];
  /** `oauth` only: who the identity policy allows to sign in. */
  emails?: string[];
  certificateId?: string;
  applicationId?: string;
  /** The Service Auth policy: every credential, or under `oauth` the validator alone. */
  policyId?: string;
  /** `oauth` only: the allow policy naming `emails`. */
  identityPolicyId?: string;
  tunnelId?: string;
  tunnelToken?: string;
  dnsId?: string;
};

/** Cloudflare's service-token record. `client_secret` is returned only once. */
type ServiceTokenResult = {
  id: string;
  client_id: string;
  client_secret?: string;
  expires_at?: string;
};

export function cloudflareSetupGate(state: Pick<CloudflareSetupState, "gate">): CloudflareGate {
  return state.gate === "service-token" || state.gate === "oauth" ? state.gate : "mtls";
}

/** What the setup has created in Cloudflare, in creation order, as the operator would name it. */
export function cloudflareSetupResources(state: CloudflareSetupState): string[] {
  const gate = cloudflareSetupGate(state);
  const tokens = gate === "mtls" ? 0 : [state.verifier, ...state.clients].filter((client) => !client.revoked).length;
  return [
    tokens === 1 ? "1 service token" : tokens > 1 ? `${tokens} service tokens` : "",
    state.certificateId ? "Certificate authority" : "",
    state.applicationId ? "Access application" : "",
    state.identityPolicyId ? "Sign-in policy" : "",
    state.policyId ? "Service Auth policy" : "",
    state.tunnelId ? "Tunnel" : "",
    state.dnsId ? "DNS record" : "",
  ].filter(Boolean);
}

export type CloudflareSetupDependencies = {
  load: () => Promise<CloudflareSetupState | undefined>;
  save: (state: CloudflareSetupState) => Promise<void>;
  /** Forget the setup record once everything it names is gone. */
  clear: () => Promise<void>;
  verifyListener: (port: number) => CloudflareOriginProbes;
  /**
   * The loopback port the gateway is listening on right now, if any. The audit
   * compares the tunnel against it: a record that matches the tunnel proves
   * nothing when the listener has since moved.
   */
  listeningPort?: () => number | undefined;
  connectorInstalled: () => Promise<boolean>;
  connectorRunning: () => boolean;
  startConnector: (token: string) => Promise<void>;
  stopConnector: () => Promise<void>;
  publishUrl: (url: string) => Promise<void>;
  /** Undo `publishUrl` when the endpoint it published is removed. */
  unpublishUrl?: (url: string) => Promise<void>;
  /**
   * `oauth` only: fetch the endpoint's sign-in metadata the way a client will,
   * returning the authorization server's host. Absent, validation skips it.
   */
  probeSignIn?: (endpoint: string) => Promise<string>;
  /**
   * End what a revoked client's federation invite led to: its peer and that
   * peer's open session, or the invite itself if it was never used.
   */
  revokeEnrollment?: (enrollmentId: string) => Promise<void>;
  api?: (token: string) => CloudflareApi;
};

/** The Access application's name, which Cloudflare's login page shows people. */
export function cloudflareApplicationName(hostname: string): string {
  return `PwrAgent federation · ${hostname}`;
}

/**
 * A sign-in endpoint's browser session must end when a sign-in would.
 *
 * Access honors its own session cookie in place of a sign-in until the
 * application's session duration ends, so this, not a cookie-replay probe, is
 * what bounds a removed person's browser session.
 */
function sessionLengthCheck(sessionDuration: string | undefined): CloudflareSecurityCheck {
  const duration = parseCloudflareDuration(sessionDuration);
  const passed = duration !== undefined && duration <= CLOUDFLARE_SIGN_IN_SESSION_LIMIT_MS;
  return {
    label: "Browser session length",
    passed,
    detail: passed
      ? "Access honors a browser session on this hostname for at most 15 minutes, so a removed person's session ends as their sign-in does."
      : `Access honors a browser session on this hostname for ${sessionDuration ?? "24h, its default"}, so a removed person stays signed in that long in a browser. Set the Access application's session duration to 15 minutes.`,
  };
}

export class CloudflareSetupService {
  private api?: CloudflareApi;
  private scope?: { accountId: string; zoneId: string; zoneName: string };
  private suggestedHostname?: string;
  private checks?: CloudflareSecurityCheck[];
  private checkedAt?: string;
  constructor(private readonly deps: CloudflareSetupDependencies) {}

  async status(): Promise<CloudflareSetupStatus> {
    const state = await this.deps.load();
    return {
      connected: Boolean(this.api),
      gate: state ? cloudflareSetupGate(state) : undefined,
      accountId: state?.accountId ?? this.scope?.accountId,
      zoneId: state?.zoneId ?? this.scope?.zoneId,
      zoneName: state?.zoneName ?? this.scope?.zoneName,
      hostname: state?.hostname,
      suggestedHostname: state ? undefined : this.suggestedHostname,
      listenPort: state?.listenPort,
      tunnelId: state?.tunnelId,
      applicationId: state?.applicationId,
      certificateId: state?.certificateId,
      phase: state ? state.dnsId ? "Published" : "Setup incomplete — resume creation" : undefined,
      connectorRunning: this.deps.connectorRunning(),
      connectorInstalled: await this.deps.connectorInstalled(),
      clients: state?.clients.map(({ id, label, expiresAt, revoked }) => ({ id, label, expiresAt, revoked })) ?? [],
      emails: state?.emails,
      resources: state ? cloudflareSetupResources(state) : undefined,
      checks: this.checks,
      checkedAt: this.checkedAt,
    };
  }

  async connect(token: string, accountId: string, zoneId: string, gate: CloudflareGate = "service-token"): Promise<void> {
    this.disconnect();
    cloudflareScopeId(accountId); cloudflareScopeId(zoneId);
    if (typeof token !== "string" || token.length < 20 || token.length > 4096 || /\s/.test(token)) throw new Error("Enter a Cloudflare API token.");
    const api = this.deps.api?.(token) ?? new CloudflareApi(token);
    const zone = await api.request<{ name: string; status: string; account: { id: string } }>(`/zones/${zoneId}`);
    if (zone.account.id !== accountId || zone.status !== "active") throw new Error("The zone must be active and belong to the selected account.");
    const state = await this.deps.load();
    if (state && (state.accountId !== accountId || state.zoneId !== zoneId)) throw new Error("This profile already manages a tunnel in a different account or zone.");
    // Probe the permission this gate will actually use. Listing certificates
    // for every gate made a token scoped for service tokens — the default —
    // fail here with a plan hint about mTLS it never needed.
    const credentialPath = (state ? cloudflareSetupGate(state) : gate) === "mtls" ? "certificates" : "service_tokens";
    await api.list(`/accounts/${accountId}/access/apps`);
    await api.list(`/accounts/${accountId}/access/${credentialPath}`);
    await api.list(`/accounts/${accountId}/cfd_tunnel?is_deleted=false`);
    this.api = api;
    this.scope = { accountId, zoneId, zoneName: zone.name };
    // Only a setup still to be created needs a name; a failed lookup just
    // leaves the field to the operator.
    this.suggestedHostname = state ? undefined : await this.freeHostname().catch(() => undefined);
  }

  disconnect(): void {
    this.api = undefined; this.scope = undefined; this.checks = undefined; this.checkedAt = undefined; this.suggestedHostname = undefined;
  }
  private apiClient(): CloudflareApi {
    if (!this.api) throw new Error("Connect a Cloudflare API token to audit or manage this tunnel.");
    return this.api;
  }
  private async state(): Promise<CloudflareSetupState> {
    const state = await this.deps.load();
    if (!state) throw new Error("Create the protected endpoint first.");
    return state;
  }
  /** Everything the Access policy currently admits: the validator plus live clients. */
  private admissionIds(state: CloudflareSetupState): string[] {
    return [state.verifier, ...state.clients].filter((client) => !client.revoked).map((client) => client.id);
  }

  /**
   * Mint one credential under the active gate.
   *
   * Under `service-token` the secret comes back exactly once, so it is stored
   * with the record before anything else can fail. Under `mtls` the key is
   * generated locally and the CA never leaves the host.
   */
  private async mintCredential(
    state: Pick<CloudflareSetupState, "gate" | "ca" | "accountId" | "name">,
    label: string,
  ): Promise<Client> {
    if (cloudflareSetupGate(state) === "mtls") {
      if (!state.ca) throw new Error("This setup has no certificate authority. Recreate the protected endpoint.");
      const id = `pwragent-${randomBytes(16).toString("hex")}`;
      const certificate = await issueCloudflareClient(state.ca, id);
      return { ...certificate, id, label,
        expiresAt: new Date(new X509Certificate(certificate.certificate).validTo).toISOString(), revoked: false };
    }
    const result = await this.apiClient().request<ServiceTokenResult>(
      `/accounts/${state.accountId}/access/service_tokens`, "POST",
      // `duration` is Cloudflare's own expiry vocabulary. 90 days matches what
      // the certificate path issues, so both gates age the same way.
      { name: `${state.name} ${label}`.slice(0, 120), duration: "2160h" },
    );
    if (!result?.id || !result.client_id || !result.client_secret) {
      throw new Error("Cloudflare did not return a usable service token. Its secret is shown only once; check Service credentials before retrying.");
    }
    return {
      id: result.id,
      label,
      clientId: result.client_id,
      clientSecret: result.client_secret,
      expiresAt: result.expires_at ?? new Date(Date.now() + 90 * 86_400_000).toISOString(),
      revoked: false,
    };
  }
  private async applications(target: { accountId: string; zoneId: string; hostname: string }): Promise<AccessApplication[]> {
    return (await this.allApplications(target)).filter((app) => applicationCoversHostname(app, target.hostname));
  }

  private async allApplications(scope: { accountId: string; zoneId: string }): Promise<AccessApplication[]> {
    const api = this.apiClient();
    const [account, zone] = await Promise.all([
      api.list<AccessApplication>(`/accounts/${scope.accountId}/access/apps`),
      api.list<AccessApplication>(`/zones/${scope.zoneId}/access/apps`),
    ]);
    return [...new Map([...account, ...zone].map((app) => [app.id, app])).values()];
  }

  /**
   * Why `hostname` cannot be this setup's endpoint, or undefined when it can.
   * Anything this setup itself created (`owned`) does not count against it.
   */
  private async hostnameConflict(
    target: { accountId: string; zoneId: string; hostname: string },
    owned?: { applicationId?: string; dnsId?: string },
  ): Promise<string | undefined> {
    const apps = await this.applications(target);
    if (apps.some((app) => app.id !== owned?.applicationId)) {
      return `An Access application already covers ${target.hostname}. Choose a dedicated hostname; existing policies were not changed.`;
    }
    const dns = await this.apiClient().list<{ id: string }>(`/zones/${target.zoneId}/dns_records?name=${target.hostname}`);
    if (dns.some((entry) => entry.id !== owned?.dnsId)) {
      return `DNS already exists for ${target.hostname}. Existing records were not changed.`;
    }
    return undefined;
  }

  /**
   * A conventional name nothing in the zone uses yet: `federation.<zone>`, then
   * `federation-2.<zone>` and so on. Another profile's endpoint in the same
   * account commonly holds the first one.
   */
  private async freeHostname(): Promise<string | undefined> {
    const scope = this.scope;
    if (!scope) return undefined;
    const apps = await this.allApplications(scope);
    for (let index = 1; index <= 5; index++) {
      const hostname = `${index === 1 ? "federation" : `federation-${index}`}.${scope.zoneName}`;
      if (apps.some((app) => applicationCoversHostname(app, hostname))) continue;
      const dns = await this.apiClient().list<{ id: string }>(`/zones/${scope.zoneId}/dns_records?name=${hostname}`);
      if (!dns.length) return hostname;
    }
    return undefined;
  }

  async provision(
    hostname: string,
    listenPort: number,
    gate: CloudflareGate = "service-token",
    emails?: string[],
  ): Promise<void> {
    const api = this.apiClient();
    if (!this.scope) throw new Error("Connect Cloudflare first.");
    hostname = cloudflareHostname(hostname, this.scope.zoneName);
    this.deps.verifyListener(listenPort);
    if (!await this.deps.connectorInstalled()) throw new Error("Install cloudflared before creating the endpoint.");
    this.checks = undefined;
    let state = await this.deps.load();
    if (state && state.hostname !== hostname) {
      throw new Error(`This profile's endpoint is ${state.hostname}. Resume it, or start over to use ${hostname}.`);
    }
    if (state && state.listenPort !== listenPort) {
      // The listener moved since the tunnel was pointed at it — usually because
      // the first port belonged to another process. Follow it: the ingress below
      // is rewritten from the record, and the audit then checks the new port.
      state.listenPort = listenPort;
      await this.deps.save(state);
    }
    // The gate decides the policy selector and the credential type, so a resumed
    // setup keeps the one it was created with rather than half-migrating.
    if (state && cloudflareSetupGate(state) !== gate) {
      throw new Error("This profile's endpoint already uses a different admission gate. Disconnect and recreate it to change gates.");
    }
    // Before anything is minted: a name that is already taken must fail with
    // nothing to clean up, not after a validator token exists.
    const conflict = await this.hostnameConflict({ ...this.scope, hostname }, state);
    if (conflict) throw new Error(conflict);
    // Checked before the first external call: an empty or malformed allowlist
    // must not leave a minted validator token behind.
    const allowed = gate === "oauth" && !state ? cloudflareEmails(emails) : undefined;
    if (!state) {
      const base = {
        version: 1 as const, gate, ...this.scope, hostname, listenPort,
        name: `PwrAgent ${hostname} ${randomBytes(6).toString("hex")}`,
        ...(allowed ? { emails: allowed } : {}),
      };
      if (gate === "mtls") {
        const ca = await createCloudflareCa();
        const id = `pwragent-${randomBytes(16).toString("hex")}`;
        const verifier = await issueCloudflareClient(ca, id);
        state = { ...base, ca,
          verifier: { ...verifier, id, label: "Endpoint validator", expiresAt: new X509Certificate(verifier.certificate).validTo, revoked: false },
          clients: [] };
      } else {
        // The validator is an ordinary service token, so the positive control
        // exercises the same admission path a real client will.
        state = { ...base, verifier: await this.mintCredential(base, "Endpoint validator"), clients: [] };
      }
      // Persist encrypted credentials before any further external mutation; a
      // failed secure store cannot leave a public endpoint whose client
      // credentials were discarded. A service-token secret is unrecoverable.
      await this.deps.save(state);
    }
    const base = `/accounts/${state.accountId}`;
    if (cloudflareSetupGate(state) === "mtls" && !state.certificateId) {
      if (!state.ca) throw new Error("This setup has no certificate authority. Recreate the protected endpoint.");
      const result = await api.request<{ id: string }>(`${base}/access/certificates`, "POST", {
        name: state.name, certificate: state.ca.certificate, associated_hostnames: [hostname],
      });
      state.certificateId = result.id;
      await this.deps.save(state);
    }
    if (!state.applicationId) {
      // Empty policy list denies all access while the certificate rule is added.
      const result = await api.request<{ id: string }>(`${base}/access/apps`, "POST", {
        // People see this name on Cloudflare's login page, so it names the
        // endpoint and leaves out the random suffix the other resources carry.
        name: cloudflareApplicationName(hostname), domain: hostname, type: "self_hosted",
        app_launcher_visible: false, service_auth_401_redirect: false,
        policies: [],
        ...(cloudflareSetupGate(state) === "oauth"
          ? { oauth_configuration: CLOUDFLARE_OAUTH_CONFIGURATION, session_duration: CLOUDFLARE_SIGN_IN_SESSION_DURATION }
          : {}),
      });
      state.applicationId = result.id;
      await this.deps.save(state);
    }
    if (cloudflareSetupGate(state) === "oauth" && !state.identityPolicyId) {
      if (!state.emails?.length) throw new Error("This setup has no sign-in allowlist. Recreate the protected endpoint.");
      const result = await api.request<{ id: string }>(`${base}/access/apps/${state.applicationId}/policies`, "POST",
        cloudflareIdentityPolicy(state.emails));
      state.identityPolicyId = result.id;
      await this.deps.save(state);
    }
    if (!state.policyId) {
      const result = await api.request<{ id: string }>(`${base}/access/apps/${state.applicationId}/policies`, "POST",
        cloudflareAdmissionPolicy(cloudflareSetupGate(state), this.admissionIds(state)));
      state.policyId = result.id;
      await this.deps.save(state);
    }
    if (!state.tunnelId) {
      const result = await api.request<{ id: string; token: string }>(`${base}/cfd_tunnel`, "POST", { name: state.name, config_src: "cloudflare" });
      state.tunnelId = result.id;
      state.tunnelToken = result.token;
      await this.deps.save(state);
    }
    if (!state.tunnelToken) {
      state.tunnelToken = await api.request<string>(`${base}/cfd_tunnel/${state.tunnelId}/token`);
      await this.deps.save(state);
    }
    this.deps.verifyListener(listenPort);
    await api.request(`${base}/cfd_tunnel/${state.tunnelId}/configurations`, "PUT", { config: { ingress: this.ingress(state) } });
    const checks = await this.audit(false);
    if (checks.some((check) => !check.passed)) throw new Error("Cloudflare policy audit failed. DNS was not published; inspect the checks below.");
    if (!state.dnsId) {
      const result = await api.request<{ id: string }>(`/zones/${state.zoneId}/dns_records`, "POST", {
        type: "CNAME", name: hostname, content: `${state.tunnelId}.cfargotunnel.com`, proxied: true, ttl: 1,
      });
      state.dnsId = result.id;
      await this.deps.save(state);
    }
    await this.deps.publishUrl(`wss://${hostname}`);
    await this.start();
  }

  private ingress(state: CloudflareSetupState) {
    return [{ hostname: state.hostname, service: `http://127.0.0.1:${state.listenPort}` }, { service: "http_status:404" }];
  }

  /**
   * The tunnel must match the record, and the record must match the listener.
   * Checking only the first let a tunnel pointed at a port the gateway had left
   * pass while every request went nowhere, or to another process.
   */
  private originCheck(
    state: CloudflareSetupState,
    ingress: Array<{ hostname?: string; path?: string; service: string }>,
  ): CloudflareSecurityCheck {
    const expected = this.ingress(state);
    const matches = ingress.length === 2
      && ingress.every((rule, index) => rule.hostname === expected[index].hostname && rule.service === expected[index].service && !rule.path);
    const live = this.deps.listeningPort ? this.deps.listeningPort() : state.listenPort;
    if (matches && live !== state.listenPort) {
      return { label: "Tunnel origin", passed: false, detail: live
        ? `The tunnel sends traffic to 127.0.0.1:${state.listenPort}, but the gateway listens on 127.0.0.1:${live}. Move the tunnel to port ${live} in step 4.`
        : `The tunnel sends traffic to 127.0.0.1:${state.listenPort}, but the gateway is not listening there.` };
    }
    return { label: "Tunnel origin", passed: matches, detail: "Exact hostname to the selected loopback listener, followed by a 404 catch-all." };
  }

  async audit(requireDns = true): Promise<CloudflareSecurityCheck[]> {
    const state = await this.state();
    const api = this.apiClient();
    this.checks = undefined;
    const base = `/accounts/${state.accountId}`;
    // A service-token endpoint has no certificate authority, so requiring a
    // certificateId here would report every one of them as half-created.
    if (!state.applicationId || !state.tunnelId
      || (cloudflareSetupGate(state) === "mtls" && !state.certificateId)
      || (cloudflareSetupGate(state) === "oauth" && !state.identityPolicyId)) {
      throw new Error("Resume endpoint creation before auditing.");
    }
    const gate = cloudflareSetupGate(state);
    // None of these reads depends on another, so they run together.
    const [apps, app, policies, tunnel, credentials, dns] = await Promise.all([
      this.applications(state),
      api.request<AccessApplication>(`${base}/access/apps/${state.applicationId}`),
      api.list<{ id: string }>(`${base}/access/apps/${state.applicationId}/policies`),
      api.request<{ config: { ingress: Array<{ hostname?: string; path?: string; service: string }> } }>(`${base}/cfd_tunnel/${state.tunnelId}/configurations`),
      // The certificate list under mTLS, the service-token list otherwise.
      api.list<{ id: string; associated_hostnames?: string[]; expires_on?: string }>(
        `${base}/access/${gate === "mtls" ? "certificates" : "service_tokens"}`),
      requireDns
        ? api.list<{ id: string; type: string; content: string; proxied: boolean }>(`/zones/${state.zoneId}/dns_records?name=${state.hostname}`)
        : Promise.resolve(undefined),
    ]);
    const servicePolicy = policies.find((policy) => policy.id === state.policyId);
    const identityPolicy = policies.find((policy) => policy.id === state.identityPolicyId);
    const admitted = this.admissionIds(state);
    const checks: CloudflareSecurityCheck[] = [
      { label: "Dedicated Access application", passed: apps.length === 1 && apps[0].id === state.applicationId && isDedicatedApplication(app, state.hostname), detail: "Exact hostname, with no competing account or zone application." },
      ...(gate === "oauth" ? [
        { label: "Managed OAuth sign-in", passed: isExpectedOAuthConfiguration(app.oauth_configuration), detail: "Clients are offered sign-in, and sign-in redirects are limited to 127.0.0.1 on the signing-in machine." },
        // Exactly two policies: anything else — a bypass, an Everyone rule, a
        // second allow list — is an alternative way in that this setup did not make.
        { label: "Allowed people", passed: policies.length === 2 && isExactIdentityPolicy(identityPolicy, state.emails ?? []), detail: "Only the listed email addresses may sign in; no bypass or alternative policy." },
        { label: "Validator service token", passed: policies.length === 2 && isExactAdmissionPolicy(gate, servicePolicy, admitted), detail: "Service Auth admits only this gateway's own validation token." },
        sessionLengthCheck(app.session_duration),
      ] : gate === "mtls" ? [
        { label: "Mandatory client certificate", passed: policies.length === 1 && servicePolicy !== undefined && isExactAdmissionPolicy(gate, servicePolicy, admitted), detail: "Only Service Auth for issued client names, requiring a valid certificate; no bypass or alternative policy." },
      ] : [
        { label: "Mandatory service token", passed: policies.length === 1 && servicePolicy !== undefined && isExactAdmissionPolicy(gate, servicePolicy, admitted), detail: "Only Service Auth for this setup's issued tokens; no bypass, alternative policy, or additional selector." },
      ]),
      this.originCheck(state, tunnel.config.ingress),
    ];
    if (gate === "mtls") {
      const matchingCas = credentials.filter((cert) => cert.associated_hostnames?.includes(state.hostname));
      checks.push({ label: "Certificate authority", passed: matchingCas.length === 1 && matchingCas[0].id === state.certificateId && Date.parse(matchingCas[0].expires_on ?? "") > Date.now(), detail: "Only this setup's unexpired CA is associated with the hostname." });
    } else {
      // Every id the policy admits has to still exist as a live token. A policy
      // naming a deleted token would otherwise read as a passing allowlist.
      const live = new Set(credentials.map((token) => token.id));
      checks.push({ label: "Issued service tokens", passed: admitted.length > 0 && admitted.every((id) => live.has(id)), detail: "Every token the policy admits still exists in this account." });
    }
    if (dns) {
      checks.push({ label: "Proxied DNS", passed: dns.length === 1 && dns[0].id === state.dnsId && dns[0].type === "CNAME" && dns[0].proxied && dns[0].content === `${state.tunnelId}.cfargotunnel.com`, detail: "The hostname routes through Cloudflare to this tunnel." });
    }
    this.checks = checks;
    this.checkedAt = new Date().toISOString();
    return checks;
  }

  async validate(): Promise<void> {
    const checks = await this.audit();
    if (checks.some((check) => !check.passed)) return;
    const state = await this.state();
    if (cloudflareSetupGate(state) === "mtls" && state.ca
      && Date.parse(state.verifier.expiresAt) < Date.now() + 7 * 86_400_000) {
      const renewed = await issueCloudflareClient(state.ca, state.verifier.id);
      state.verifier = { ...state.verifier, ...renewed, expiresAt: new X509Certificate(renewed.certificate).validTo };
      await this.deps.save(state);
    }
    const credentials = this.probeCredentials(state.verifier);
    if (!credentials) throw new Error("This setup has no validator credential. Recreate the protected endpoint.");
    const probes = this.deps.verifyListener(state.listenPort);
    const gate = cloudflareSetupGate(state);
    try {
      checks.push(...await validateCloudflareBoundary({ endpoint: `https://${state.hostname}/`, credentials, probes, gate }));
    } catch (error) {
      checks.push({ label: "Live endpoint validation", passed: false, detail: error instanceof Error ? error.message : "Endpoint validation failed." });
    }
    if (gate === "oauth" && this.deps.probeSignIn) {
      // The boundary probe proves strangers are refused; this proves a person
      // will actually be offered a way to sign in, which is the other half.
      try {
        const server = await this.deps.probeSignIn(`wss://${state.hostname}`);
        checks.push({ label: "Sign-in discovery", passed: true, detail: `Clients are directed to sign in at ${server}.` });
      } catch (error) {
        checks.push({ label: "Sign-in discovery", passed: false, detail: error instanceof Error ? error.message : "Sign-in metadata could not be read." });
      }
    }
    this.checkedAt = new Date().toISOString();
  }

  async start(): Promise<void> {
    const state = await this.state();
    this.deps.verifyListener(state.listenPort);
    if (!state.dnsId || !state.tunnelToken) throw new Error("Complete endpoint creation before starting the connector.");
    await this.deps.startConnector(state.tunnelToken);
  }
  async stop(): Promise<void> { await this.deps.stopConnector(); }

  /**
   * Delete everything this setup recorded, then forget it.
   *
   * Only recorded ids are touched, so an unrelated app, tunnel, or record in
   * the same account is never at risk. DNS goes first: once the hostname stops
   * routing, nothing that follows can leave a public route without its Access
   * gate. Each id is cleared and saved as its resource goes, so a failure
   * partway leaves a record of exactly what remains and a retry resumes there.
   * A resource already deleted by hand counts as gone.
   */
  async remove(): Promise<string> {
    const state = await this.state();
    const api = this.apiClient();
    const base = `/accounts/${state.accountId}`;
    const gone = async (path: string, method = "DELETE", body?: unknown) => {
      try { await api.request(path, method, body); }
      catch (error) { if (!(error instanceof CloudflareApiError && error.status === 404)) throw error; }
    };
    this.checks = undefined;
    await this.deps.stopConnector();
    if (state.dnsId) {
      await gone(`/zones/${state.zoneId}/dns_records/${state.dnsId}`);
      state.dnsId = undefined;
      await this.deps.save(state);
    }
    if (state.tunnelId) {
      // Cloudflare refuses to delete a tunnel that still lists connections,
      // and the list lags the connector that was just stopped.
      await gone(`${base}/cfd_tunnel/${state.tunnelId}/connections`);
      await gone(`${base}/cfd_tunnel/${state.tunnelId}`);
      state.tunnelId = undefined;
      state.tunnelToken = undefined;
      await this.deps.save(state);
    }
    if (state.applicationId) {
      // Its policies were created on the application and go with it.
      await gone(`${base}/access/apps/${state.applicationId}`);
      state.applicationId = undefined;
      state.policyId = undefined;
      state.identityPolicyId = undefined;
      await this.deps.save(state);
    }
    if (state.certificateId) {
      // A CA still associated with a hostname cannot be deleted.
      await gone(`${base}/access/certificates/${state.certificateId}`, "PUT", { name: state.name, associated_hostnames: [] });
      await gone(`${base}/access/certificates/${state.certificateId}`);
      state.certificateId = undefined;
      await this.deps.save(state);
    }
    if (cloudflareSetupGate(state) !== "mtls") {
      for (const client of [state.verifier, ...state.clients]) {
        if (client.revoked) continue;
        await gone(`${base}/access/service_tokens/${client.id}`);
        client.revoked = true;
        client.clientSecret = undefined;
        await this.deps.save(state);
      }
    }
    await this.deps.unpublishUrl?.(`wss://${state.hostname}`);
    await this.deps.clear();
    this.suggestedHostname = await this.freeHostname().catch(() => undefined);
    return state.hostname;
  }

  /** The half of a client record the probe presents at Cloudflare's edge. */
  private probeCredentials(client: Client): CloudflareProbeCredentials | undefined {
    if (client.certificate && client.privateKey) {
      return { certificate: client.certificate, privateKey: client.privateKey };
    }
    if (client.clientId && client.clientSecret) {
      return { accessClientId: client.clientId, accessClientSecret: client.clientSecret };
    }
    return undefined;
  }

  /**
   * The audit gate every client hand-off passes. Under `oauth` it is the whole
   * of issuing: the file carries an endpoint and an invite, and the person
   * brings their own identity.
   */
  async assertShareable(): Promise<CloudflareSetupState> {
    const state = await this.state();
    this.deps.verifyListener(state.listenPort);
    if ((await this.audit()).some((check) => !check.passed)) throw new Error("Resolve the policy audit before sharing a client setup.");
    return state;
  }

  async issue(label: string): Promise<Client> {
    if (!label.trim() || label.length > 80) throw new Error("Enter a client name of up to 80 characters.");
    const current = await this.state();
    if (cloudflareSetupGate(current) === "oauth") {
      throw new Error("Clients of a sign-in endpoint sign in as themselves; share a setup file instead of issuing a credential.");
    }
    if (current.clients.length >= 50) throw new Error("This setup supports up to 50 issued clients.");
    const state = await this.assertShareable();
    const client = await this.mintCredential(state, label.trim());
    state.clients.push(client);
    // Save before admission so a failure can be recovered or revoked by id. A
    // service-token secret exists nowhere else once Cloudflare has returned it.
    await this.deps.save(state);
    await this.updatePolicy(state);
    this.checks = undefined;
    return client;
  }

  /**
   * Revoke one client's credential, and the federation peer its setup file
   * enrolled. Resolves whether that peer was ended too: a client with no
   * recorded enrollment has an open session only its peer can close.
   */
  async revoke(id: string): Promise<boolean> {
    const state = await this.state();
    this.deps.verifyListener(state.listenPort);
    const client = state.clients.find((entry) => entry.id === id);
    if (!client) throw new Error("Client credential was not found.");
    client.revoked = true;
    // Drop admission first under either gate: a failure after this point leaves
    // the credential locked out, which is the safe direction.
    await this.updatePolicy(state);
    if (cloudflareSetupGate(state) === "service-token") {
      // A revoked certificate stays valid until it expires, so removing it from
      // the policy is the whole revocation. A service token is a Cloudflare
      // resource and outlives the policy edit, so delete it too.
      await this.apiClient().request(`/accounts/${state.accountId}/access/service_tokens/${client.id}`, "DELETE");
      client.clientSecret = undefined;
    }
    await this.deps.save(state);
    this.checks = undefined;
    // Access checks a credential only when a connection opens, so a session
    // that is already open outlives everything above. Revoking the peer the
    // file enrolled is what closes it.
    if (!client.enrollmentId || !this.deps.revokeEnrollment) return false;
    await this.deps.revokeEnrollment(client.enrollmentId);
    return true;
  }

  /** Remember which federation invite went out with an issued credential. */
  async recordEnrollment(clientId: string, enrollmentId: string): Promise<void> {
    const state = await this.state();
    const client = state.clients.find((entry) => entry.id === clientId);
    if (!client) throw new Error("Client credential was not found.");
    client.enrollmentId = enrollmentId;
    await this.deps.save(state);
  }
  /**
   * Replace an `oauth` endpoint's allowlist.
   *
   * Cloudflare is updated before local state, so a removal takes effect even if
   * the save then fails. Access re-evaluates a person at each token refresh,
   * so someone removed here loses access within one access-token lifetime.
   */
  async setEmails(emails: unknown): Promise<void> {
    const state = await this.state();
    if (cloudflareSetupGate(state) !== "oauth") throw new Error("Only a sign-in endpoint has an email allowlist.");
    const allowed = cloudflareEmails(emails);
    if (!state.applicationId || !state.identityPolicyId) throw new Error("Complete endpoint creation first.");
    await this.apiClient().request(
      `/accounts/${state.accountId}/access/apps/${state.applicationId}/policies/${state.identityPolicyId}`, "PUT",
      cloudflareIdentityPolicy(allowed));
    state.emails = allowed;
    await this.deps.save(state);
    this.checks = undefined;
  }

  private async updatePolicy(state: CloudflareSetupState): Promise<void> {
    if (!state.applicationId || !state.policyId) throw new Error("Complete endpoint creation first.");
    await this.apiClient().request(`/accounts/${state.accountId}/access/apps/${state.applicationId}/policies/${state.policyId}`, "PUT",
      cloudflareAdmissionPolicy(cloudflareSetupGate(state), this.admissionIds(state)));
  }
}
