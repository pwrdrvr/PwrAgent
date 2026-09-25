import type { CloudflareSetupStatus } from "@pwragent/shared";
import type { CloudflareSetupState } from "./cloudflare-setup-service";
import type { CloudflareOriginProbes } from "./cloudflare-origin-probes";
import { requestCloudflareProbe, type CloudflareProbeCredentials } from "./cloudflare-security-validation";

type Connection = NonNullable<CloudflareSetupStatus["gatewayConnection"]>;
type Dependencies = {
  load: () => Promise<CloudflareSetupState | undefined>;
  enabled: () => boolean;
  probes: (port: number) => CloudflareOriginProbes | undefined;
  connector: { running: () => boolean; start: (token: string) => Promise<void>; stop: () => Promise<void> };
  request?: typeof requestCloudflareProbe;
};

/** Proves the public route reaches this process, regardless of tunnel ownership. */
export class CloudflareGateway {
  private generation = 0;
  private cached?: { key: string; probes: CloudflareOriginProbes; at: number; result: Connection };
  private pending?: { key: string; probes: CloudflareOriginProbes; result: Promise<Connection> };
  constructor(private readonly deps: Dependencies) {}

  async status(refresh = false): Promise<Connection> {
    if (!this.deps.enabled()) return { state: "disabled", connector: "none" };
    const generation = this.generation;
    const state = await this.deps.load();
    if (generation !== this.generation || !this.deps.enabled()) return { state: "disabled", connector: "none" };
    if (!state?.dnsId) return { state: "unconfigured", connector: "none" };
    const probes = this.deps.probes(state.listenPort);
    if (!probes) return { state: "listener-unavailable", connector: "none" };
    const key = JSON.stringify([state.hostname, state.tunnelId, state.listenPort, state.verifier.expiresAt]);
    if (!refresh && this.cached?.key === key && this.cached.probes === probes
      && Date.now() - this.cached.at < 30_000) return this.cached.result;
    if (this.pending?.key === key && this.pending.probes === probes) return this.pending.result;
    const result = this.probe(state, probes).then((connection): Connection => {
      if (generation !== this.generation || !this.deps.enabled()) return { state: "disabled", connector: "none" };
      if (this.deps.probes(state.listenPort) !== probes) return { state: "listener-unavailable", connector: "none" };
      this.cached = { key, probes, at: Date.now(), result: connection };
      return connection;
    });
    this.pending = { key, probes, result };
    try { return await result; }
    finally { if (this.pending?.result === result) this.pending = undefined; }
  }

  private async probe(state: CloudflareSetupState, probes: CloudflareOriginProbes): Promise<Connection> {
    const verifier = state.verifier;
    const credentials: CloudflareProbeCredentials | undefined = verifier.certificate && verifier.privateKey
      ? { certificate: verifier.certificate, privateKey: verifier.privateKey }
      : verifier.clientId && verifier.clientSecret
        ? { accessClientId: verifier.clientId, accessClientSecret: verifier.clientSecret } : undefined;
    if (!credentials) return { state: "unreachable", connector: "none", detail: "The saved gateway has no validation credential." };
    const probe = probes.arm();
    try {
      const response = await (this.deps.request ?? requestCloudflareProbe)({
        endpoint: `https://${state.hostname}/`, id: probe.id, credentials, upgrade: false, timeoutMs: 3000,
      });
      const reached = response.status === 204 && Boolean(response.ray) && response.proof === probe.proof && probe.observed();
      return {
        state: reached ? "connected" : "unreachable",
        connector: this.deps.connector.running() ? "pwragent" : reached ? "external" : "none",
        checkedAt: new Date().toISOString(),
        detail: reached ? "A request through the public Cloudflare endpoint reached this gateway and returned its private proof."
          : `HTTP ${response.status}; the public endpoint did not prove that it reaches this gateway.`,
      };
    } catch {
      return { state: "unreachable", connector: this.deps.connector.running() ? "pwragent" : "none",
        checkedAt: new Date().toISOString(), detail: "The public endpoint could not be reached. Check the tunnel, Access credentials, and network." };
    } finally { probe.close(); }
  }

  async start(): Promise<void> {
    if (!this.deps.enabled()) throw new Error("Enable Cloudflare Access for this gateway first.");
    const generation = this.generation;
    const connection = await this.status(true);
    if (generation !== this.generation || !this.deps.enabled()) return;
    // An existing tunnel demonstrably serves THIS gateway. Leave its service alone.
    if (connection.state === "connected") return;
    const state = await this.deps.load();
    if (generation !== this.generation || !this.deps.enabled()) return;
    if (!state?.dnsId || !state.tunnelToken) throw new Error("Complete endpoint creation before starting the connector.");
    if (!this.deps.probes(state.listenPort)) throw new Error("Enable the gateway on the tunnel’s saved origin port first.");
    await this.deps.connector.start(state.tunnelToken);
    this.cached = undefined;
  }

  async stop(): Promise<void> {
    this.generation++;
    this.cached = undefined;
    this.pending = undefined;
    // This connector only owns its child. Never kill a system service.
    await this.deps.connector.stop();
  }
}
