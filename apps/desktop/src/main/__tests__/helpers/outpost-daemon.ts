import { buildOwnerFixture } from "./built-owner-fixture";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { FEDERATION_PROTOCOL_VERSION, type AgentEvent, type FederationCapability } from "@pwragent/shared";
import { FederationRemoteBackendClient } from "../../federation/federation-backend-bridge";
import { decodeFederationInvite } from "../../federation/federation-enrollment";
import { generateFederationIdentityKeyPair } from "../../federation/federation-identity";
import { generateNoiseStaticKeyPair } from "../../federation/federation-noise";
import { FederationRpcEndpoint } from "../../federation/federation-rpc";
import { connectFederationClient } from "../../federation/federation-transport";

export const OUTPOST_PACKAGE_ROOT = path.resolve(import.meta.dirname, "../../../../../../packages/pwragent");

/** Every grant a viewer can hold on an Outpost. */
export const OUTPOST_VIEWER_CAPABILITIES: FederationCapability[] = ["remote_window", "thread_navigation", "thread_detail",
  "federated_search", "turn_control", "durable_turn_requests_v1", "durable_steer_requests_v1", "messaging_route", "messaging_destinations", "messaging_files", "environment_actions"];

export type OutpostViewer = {
  client: FederationRemoteBackendClient;
  rpc: FederationRpcEndpoint;
  /** `backend.event` payloads, in arrival order, once `subscribe` is called. */
  events: AgentEvent[];
  subscribe(eventClasses: string[]): void;
  waitForEvent(method: string, matches: (event: AgentEvent) => boolean): Promise<AgentEvent>;
  viewerId: string;
  ownerInstanceId: string;
  close(): Promise<void>;
};

export type OutpostDaemon = OutpostViewer & {
  workspace: string;
  cli: string;
  env: NodeJS.ProcessEnv;
  enrollViewer(capabilities: FederationCapability[]): Promise<OutpostViewer>;
};

/**
 * Starts the standalone Outpost on the fake Codex fixture
 * and enrolls one viewer through a real invite, Noise handshake and RPC
 * endpoint, the way a desktop viewer connects.
 */
export async function startOutpostDaemon(options: {
  workspaceKind?: "direct" | "symlink";
  capabilities?: FederationCapability[];
  profileRoot?: string;
  packageRoot?: string;
  hostKind?: "desktop" | "headless";
  fixturePreload?: string;
} = {}): Promise<OutpostDaemon> {
  // The outpost listens on $PWRAGENT_HOME/profiles/t/state/headless/rpc.sock
  // and refuses a socket path over 100 bytes (the Unix sun_path limit). A
  // root inside the checkout makes that depend on where the checkout lives,
  // and Sandboxer's ~/pwragent/wt/<sha> worktrees overflow it. /tmp keeps
  // the path short everywhere; os.tmpdir() does not on macOS, where it
  // resolves to a long /private/var/folders/... path. Canonicalize the short
  // root so every fixture path uses the outpost's realpath identity (on
  // macOS /tmp is an alias for /private/tmp, which is still short enough).
  const root = options.profileRoot ?? realpathSync(mkdtempSync("/tmp/pwragent-h-"));
  const workspace = path.join(root, "w");
  const home = path.join(root, "c");
  const data = path.join(root, "f");
  for (const directory of [workspace, home, data]) mkdirSync(directory, { recursive: true });
  // Exercise alias resolution on Linux too, while all RPC requests and
  // assertions continue to use the canonical project/directory identity.
  const workspaceInput = options.workspaceKind === "symlink" ? path.join(root, "alias") : workspace;
  if (options.workspaceKind === "symlink") symlinkSync(workspace, workspaceInput, "dir");
  writeOutpostGatewayConfig(root);
  const env: NodeJS.ProcessEnv = { ...process.env, PWRAGENT_HOME: root, PWRAGENT_PROFILE: "t", PWRAGENT_TEST_DATA: data, CLAUDE_CONFIG_DIR: path.join(root, "claude") };
  const packageRoot = options.packageRoot ?? path.join(root, "owner-package");
  const guard = options.fixturePreload ?? (options.packageRoot ? undefined : await buildOwnerFixture(packageRoot, options.hostKind));
  if (guard) env.NODE_OPTIONS = `--require=${JSON.stringify(guard)}`;
  const cli = path.join(packageRoot, "bin/pwragent.js");
  const daemon = spawn(process.execPath, [cli, "serve", "--workspace", workspaceInput, "--codex-home", home,
    "--codex-bin", path.join(OUTPOST_PACKAGE_ROOT, "test/fixtures/codex.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  daemon.stdout.on("data", (chunk) => { output += String(chunk); });
  daemon.stderr.on("data", (chunk) => { errors += String(chunk); });
  const exited = new Promise<void>((resolve) => daemon.once("exit", () => resolve()));
  const connections = new Set<Awaited<ReturnType<typeof connectFederationClient>>>();
  const close = async () => {
    for (const connection of connections) connection.close();
    connections.clear();
    daemon.kill("SIGTERM");
    await exited;
    if (!options.profileRoot) rmSync(root, { recursive: true, force: true });
  };
  // Grants belong to an enrolled viewer. Independent viewers share one owner.
  const enrollViewer = async (capabilities: FederationCapability[]): Promise<OutpostViewer> => {
    // The gateway binds the port it advertises (configured as 0 above), so
    // no port is ever chosen here and released for the daemon to take.
    const issued = await promisify(execFile)(process.execPath, [cli, "federation-invite"], { env });
    const invite = decodeFederationInvite(JSON.parse(issued.stdout).invite);
    const identity = generateFederationIdentityKeyPair();
    const viewerId = randomUUID();
    const events: AgentEvent[] = [];
    const eventWaiters = new Set<(event: AgentEvent) => void>();
    let rpc: FederationRpcEndpoint;
    const connected = await connectFederationClient({ url: invite.gatewayUrl, mode: "enroll", ...identity,
      peerInstanceId: viewerId, role: "client", inviteToken: invite.token,
      gatewayInstanceId: invite.gatewayInstanceId, gatewayPublicKeyPem: invite.gatewayPublicKeyPem,
      gatewayNoisePublicKey: Buffer.from(invite.gatewayNoisePublicKey!, "base64"), noiseStatic: generateNoiseStaticKeyPair(),
      capabilities, deferReceiving: true,
      onEnvelope: (envelope) => {
        if (envelope.kind === "notification" && envelope.method === "backend.event") {
          const event = envelope.params as AgentEvent;
          events.push(event);
          for (const waiter of eventWaiters) waiter(event);
          return;
        }
        rpc.receiveEnvelope(envelope);
      },
    });
    connections.add(connected);
    rpc = new FederationRpcEndpoint({ localInstanceId: viewerId, remoteInstanceId: invite.gatewayInstanceId,
      sendEnvelope: (envelope) => connected.sendEnvelope(envelope), defaultTimeoutMs: 3000 });
    connected.startReceiving();
    return {
      client: new FederationRemoteBackendClient(rpc), rpc, events, viewerId, ownerInstanceId: invite.gatewayInstanceId,
      close: async () => { connected.close(); connections.delete(connected); },
      waitForEvent: (method, matches) => {
        const found = events.find(event => event.notification.method === method && matches(event));
        if (found) return Promise.resolve(found);
        return new Promise(resolve => {
          const waiter = (event: AgentEvent) => {
            if (event.notification.method !== method || !matches(event)) return;
            eventWaiters.delete(waiter); resolve(event);
          };
          eventWaiters.add(waiter);
        });
      },
      subscribe: (eventClasses) => connected.sendEnvelope({ kind: "notification", method: "federation.eventSubscription",
        id: randomUUID(), params: { eventClasses, threadSelection: { kind: "all" } }, protocolVersion: FEDERATION_PROTOCOL_VERSION,
        sourceInstanceId: viewerId, targetInstanceId: invite.gatewayInstanceId, createdAt: Date.now() }),
    };
  };
  try {
    for (let attempt = 0; !output.includes('"ready":true'); attempt++) {
      if (daemon.exitCode !== null || attempt >= 200) throw new Error(`Outpost startup failed (${daemon.exitCode}): ${errors} ${output.slice(-3000)}`);
      await delay(20);
    }
    const viewer = await enrollViewer(options.capabilities ?? OUTPOST_VIEWER_CAPABILITIES);
    return { ...viewer, workspace, cli, env, enrollViewer, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * Configures profile `t` as a loopback gateway on port 0 before the daemon
 * starts. The daemon's own listener takes an OS-assigned port and the invite
 * names it. A port reserved here and released for the daemon to bind could be
 * taken by any other socket in between.
 */
function writeOutpostGatewayConfig(root: string): void {
  const configPath = path.join(root, "profiles", "t", "config.toml");
  if (existsSync(configPath)) {
    // A reused profile keeps its config, which must still ask for port 0.
    if (!/^listen_port = 0$/m.test(readFileSync(configPath, "utf8"))) {
      throw new Error(`${configPath} must configure the federation gateway with listen_port = 0`);
    }
    return;
  }
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, "[onboarding]\ncompleted = false\n\n[federation]\nmode = \"gateway\"\n"
    + "listen_host = \"127.0.0.1\"\nlisten_port = 0\n");
}
