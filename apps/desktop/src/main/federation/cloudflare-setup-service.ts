import { randomBytes, X509Certificate } from "node:crypto";
import type { CloudflareSecurityCheck, CloudflareSetupStatus } from "@pwragent/shared";
import { CloudflareApi, applicationCoversHostname, cloudflareHostname, cloudflareMtlsPolicy, cloudflareScopeId, isExactMtlsPolicy, type AccessApplication } from "./cloudflare-api";
import { createCloudflareCa, issueCloudflareClient, type CloudflareCertificate } from "./cloudflare-certificates";
import type { CloudflareOriginProbes } from "./cloudflare-origin-probes";
import { validateCloudflareBoundary } from "./cloudflare-security-validation";

type Client = CloudflareCertificate & { id: string; label: string; expiresAt: string; revoked: boolean };
export type CloudflareSetupState = {
  version: 1;
  accountId: string;
  zoneId: string;
  zoneName: string;
  hostname: string;
  listenPort: number;
  name: string;
  ca: CloudflareCertificate;
  verifier: Client;
  clients: Client[];
  certificateId?: string;
  applicationId?: string;
  policyId?: string;
  tunnelId?: string;
  tunnelToken?: string;
  dnsId?: string;
};

export type CloudflareSetupDependencies = {
  load: () => Promise<CloudflareSetupState | undefined>;
  save: (state: CloudflareSetupState) => Promise<void>;
  verifyListener: (port: number) => CloudflareOriginProbes;
  connectorInstalled: () => Promise<boolean>;
  connectorRunning: () => boolean;
  startConnector: (token: string) => Promise<void>;
  stopConnector: () => Promise<void>;
  publishUrl: (url: string) => Promise<void>;
  api?: (token: string) => CloudflareApi;
};

export class CloudflareSetupService {
  private api?: CloudflareApi;
  private scope?: { accountId: string; zoneId: string; zoneName: string };
  private checks?: CloudflareSecurityCheck[];
  private checkedAt?: string;
  constructor(private readonly deps: CloudflareSetupDependencies) {}

  async status(): Promise<CloudflareSetupStatus> {
    const state = await this.deps.load();
    return {
      connected: Boolean(this.api),
      accountId: state?.accountId ?? this.scope?.accountId,
      zoneId: state?.zoneId ?? this.scope?.zoneId,
      zoneName: state?.zoneName ?? this.scope?.zoneName,
      hostname: state?.hostname,
      tunnelId: state?.tunnelId,
      applicationId: state?.applicationId,
      certificateId: state?.certificateId,
      phase: state ? state.dnsId ? "Published" : "Setup incomplete — resume creation" : undefined,
      connectorRunning: this.deps.connectorRunning(),
      connectorInstalled: await this.deps.connectorInstalled(),
      clients: state?.clients.map(({ id, label, expiresAt, revoked }) => ({ id, label, expiresAt, revoked })) ?? [],
      checks: this.checks,
      checkedAt: this.checkedAt,
    };
  }

  async connect(token: string, accountId: string, zoneId: string): Promise<void> {
    this.disconnect();
    cloudflareScopeId(accountId); cloudflareScopeId(zoneId);
    if (typeof token !== "string" || token.length < 20 || token.length > 4096 || /\s/.test(token)) throw new Error("Enter a Cloudflare API token.");
    const api = this.deps.api?.(token) ?? new CloudflareApi(token);
    const zone = await api.request<{ name: string; status: string; account: { id: string } }>(`/zones/${zoneId}`);
    if (zone.account.id !== accountId || zone.status !== "active") throw new Error("The zone must be active and belong to the selected account.");
    const state = await this.deps.load();
    if (state && (state.accountId !== accountId || state.zoneId !== zoneId)) throw new Error("This profile already manages a tunnel in a different account or zone.");
    await api.list(`/accounts/${accountId}/access/apps`);
    await api.list(`/accounts/${accountId}/access/certificates`);
    await api.list(`/accounts/${accountId}/cfd_tunnel?is_deleted=false`);
    this.api = api;
    this.scope = { accountId, zoneId, zoneName: zone.name };
  }

  disconnect(): void { this.api = undefined; this.scope = undefined; this.checks = undefined; this.checkedAt = undefined; }
  private apiClient(): CloudflareApi {
    if (!this.api) throw new Error("Connect a Cloudflare API token to audit or manage this tunnel.");
    return this.api;
  }
  private async state(): Promise<CloudflareSetupState> {
    const state = await this.deps.load();
    if (!state) throw new Error("Create the protected endpoint first.");
    return state;
  }
  private names(state: CloudflareSetupState): string[] {
    return [state.verifier, ...state.clients].filter((client) => !client.revoked).map((client) => client.id);
  }
  private async applications(state: CloudflareSetupState): Promise<AccessApplication[]> {
    const api = this.apiClient();
    const account = await api.list<AccessApplication>(`/accounts/${state.accountId}/access/apps`);
    const zone = await api.list<AccessApplication>(`/zones/${state.zoneId}/access/apps`);
    return [...new Map([...account, ...zone].filter((app) => applicationCoversHostname(app, state.hostname)).map((app) => [app.id, app])).values()];
  }

  async provision(hostname: string, listenPort: number): Promise<void> {
    const api = this.apiClient();
    if (!this.scope) throw new Error("Connect Cloudflare first.");
    hostname = cloudflareHostname(hostname, this.scope.zoneName);
    this.deps.verifyListener(listenPort);
    if (!await this.deps.connectorInstalled()) throw new Error("Install cloudflared before creating the endpoint.");
    this.checks = undefined;
    let state = await this.deps.load();
    if (state && (state.hostname !== hostname || state.listenPort !== listenPort)) throw new Error("Resume this profile's existing hostname and listener port.");
    if (!state) {
      const ca = await createCloudflareCa();
      const id = `pwragent-${randomBytes(16).toString("hex")}`;
      const verifier = await issueCloudflareClient(ca, id);
      state = { version: 1, ...this.scope, hostname, listenPort,
        name: `PwrAgent ${hostname} ${randomBytes(6).toString("hex")}`,
        ca, verifier: { ...verifier, id, label: "Endpoint validator", expiresAt: new X509Certificate(verifier.certificate).validTo, revoked: false }, clients: [] };
      // Persist encrypted keys before any external mutation; a failed secure store
      // cannot leave a public endpoint whose client keys were discarded.
      await this.deps.save(state);
    }
    const base = `/accounts/${state.accountId}`;
    const conflicts = await this.applications(state);
    if (conflicts.some((app) => app.id !== state.applicationId)) throw new Error("An Access application already covers this hostname. Choose a dedicated hostname; existing policies were not changed.");
    const dns = await api.list<{ id: string }>(`/zones/${state.zoneId}/dns_records?name=${hostname}`);
    if (dns.some((entry) => entry.id !== state.dnsId)) throw new Error("DNS already exists for this hostname. Existing records were not changed.");
    if (!state.certificateId) {
      const result = await api.request<{ id: string }>(`${base}/access/certificates`, "POST", {
        name: state.name, certificate: state.ca.certificate, associated_hostnames: [hostname],
      });
      state.certificateId = result.id;
      await this.deps.save(state);
    }
    if (!state.applicationId) {
      // Empty policy list denies all access while the certificate rule is added.
      const result = await api.request<{ id: string }>(`${base}/access/apps`, "POST", {
        name: state.name, domain: hostname, type: "self_hosted",
        app_launcher_visible: false, service_auth_401_redirect: false,
        policies: [],
      });
      state.applicationId = result.id;
      await this.deps.save(state);
    }
    if (!state.policyId) {
      const result = await api.request<{ id: string }>(`${base}/access/apps/${state.applicationId}/policies`, "POST", cloudflareMtlsPolicy(this.names(state)));
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

  async audit(requireDns = true): Promise<CloudflareSecurityCheck[]> {
    const state = await this.state();
    const api = this.apiClient();
    this.checks = undefined;
    const base = `/accounts/${state.accountId}`;
    if (!state.applicationId || !state.certificateId || !state.tunnelId) throw new Error("Resume endpoint creation before auditing.");
    const apps = await this.applications(state);
    const app = await api.request<AccessApplication>(`${base}/access/apps/${state.applicationId}`);
    const policies = await api.list<{ id: string }>(`${base}/access/apps/${state.applicationId}/policies`);
    const certificates = await api.list<{ id: string; associated_hostnames?: string[]; expires_on?: string }>(`${base}/access/certificates`);
    const matchingCas = certificates.filter((cert) => cert.associated_hostnames?.includes(state.hostname));
    const tunnel = await api.request<{ config: { ingress: Array<{ hostname?: string; path?: string; service: string }> } }>(`${base}/cfd_tunnel/${state.tunnelId}/configurations`);
    const expected = this.ingress(state);
    const checks: CloudflareSecurityCheck[] = [
      { label: "Dedicated Access application", passed: apps.length === 1 && apps[0].id === state.applicationId && app.domain === state.hostname && app.type === "self_hosted" && !(app.destinations?.length), detail: "Exact hostname, with no competing account or zone application." },
      { label: "Mandatory client certificate", passed: policies.length === 1 && policies[0].id === state.policyId && isExactMtlsPolicy(policies[0], this.names(state)), detail: "Only Service Auth for issued client names, requiring a valid certificate; no bypass or alternative policy." },
      { label: "Certificate authority", passed: matchingCas.length === 1 && matchingCas[0].id === state.certificateId && Date.parse(matchingCas[0].expires_on ?? "") > Date.now(), detail: "Only this setup's unexpired CA is associated with the hostname." },
      { label: "Tunnel origin", passed: tunnel.config.ingress.length === 2 && tunnel.config.ingress.every((rule, index) => rule.hostname === expected[index].hostname && rule.service === expected[index].service && !rule.path), detail: "Exact hostname to the selected loopback listener, followed by a 404 catch-all." },
    ];
    if (requireDns) {
      const dns = await api.list<{ id: string; type: string; content: string; proxied: boolean }>(`/zones/${state.zoneId}/dns_records?name=${state.hostname}`);
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
    if (Date.parse(state.verifier.expiresAt) < Date.now() + 7 * 86_400_000) {
      const renewed = await issueCloudflareClient(state.ca, state.verifier.id);
      state.verifier = { ...state.verifier, ...renewed, expiresAt: new X509Certificate(renewed.certificate).validTo };
      await this.deps.save(state);
    }
    const probes = this.deps.verifyListener(state.listenPort);
    try {
      checks.push(...await validateCloudflareBoundary({ endpoint: `https://${state.hostname}/`, credentials: state.verifier, probes }));
    } catch (error) {
      checks.push({ label: "Live endpoint validation", passed: false, detail: error instanceof Error ? error.message : "Endpoint validation failed." });
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

  async issue(label: string): Promise<Client> {
    if (!label.trim() || label.length > 80) throw new Error("Enter a client name of up to 80 characters.");
    const state = await this.state();
    this.deps.verifyListener(state.listenPort);
    if (state.clients.length >= 50) throw new Error("This setup supports up to 50 issued certificates.");
    if ((await this.audit()).some((check) => !check.passed)) throw new Error("Resolve the policy audit before issuing a client.");
    const id = `pwragent-${randomBytes(16).toString("hex")}`;
    const certificate = await issueCloudflareClient(state.ca, id);
    const client = { ...certificate, id, label: label.trim(), expiresAt: new Date(new X509Certificate(certificate.certificate).validTo).toISOString(), revoked: false };
    state.clients.push(client);
    // Save before admission so failure can be recovered/revoked by ID.
    await this.deps.save(state);
    await this.updatePolicy(state);
    this.checks = undefined;
    return client;
  }

  async revoke(id: string): Promise<void> {
    const state = await this.state();
    this.deps.verifyListener(state.listenPort);
    const client = state.clients.find((entry) => entry.id === id);
    if (!client) throw new Error("Client certificate was not found.");
    client.revoked = true;
    await this.updatePolicy(state);
    await this.deps.save(state);
    this.checks = undefined;
  }
  private async updatePolicy(state: CloudflareSetupState): Promise<void> {
    if (!state.applicationId || !state.policyId) throw new Error("Complete endpoint creation first.");
    await this.apiClient().request(`/accounts/${state.accountId}/access/apps/${state.applicationId}/policies/${state.policyId}`, "PUT", cloudflareMtlsPolicy(this.names(state)));
  }
}
