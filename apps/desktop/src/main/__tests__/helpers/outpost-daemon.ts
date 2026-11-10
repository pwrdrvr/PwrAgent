import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
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

export const OUTPOST_PACKAGE_ROOT = path.join(process.cwd(), "packages/pwragent");

/** Every grant a viewer can hold on an Outpost. */
export const OUTPOST_VIEWER_CAPABILITIES: FederationCapability[] = ["remote_window", "thread_navigation", "thread_detail",
  "turn_control", "durable_turn_requests_v1", "durable_steer_requests_v1", "messaging_route", "messaging_destinations", "messaging_files", "environment_actions"];

export type OutpostDaemon = {
  client: FederationRemoteBackendClient;
  rpc: FederationRpcEndpoint;
  /** `backend.event` payloads, in arrival order, once `subscribe` is called. */
  events: AgentEvent[];
  subscribe(eventClasses: string[]): void;
  workspace: string;
  cli: string;
  env: NodeJS.ProcessEnv;
  viewerId: string;
  ownerInstanceId: string;
  close(): Promise<void>;
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
  const env = { ...process.env, PWRAGENT_HOME: root, PWRAGENT_PROFILE: "t", PWRAGENT_TEST_DATA: data };
  const packageRoot = options.packageRoot ?? OUTPOST_PACKAGE_ROOT;
  const cli = path.join(packageRoot, "bin/pwragent.js");
  const daemon = spawn(process.execPath, [cli, "serve", "--workspace", workspaceInput, "--codex-home", home,
    "--codex-bin", path.join(packageRoot, "test/fixtures/codex.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  daemon.stdout.on("data", (chunk) => { output += String(chunk); });
  daemon.stderr.on("data", (chunk) => { errors += String(chunk); });
  const exited = new Promise<void>((resolve) => daemon.once("exit", () => resolve()));
  let connection: Awaited<ReturnType<typeof connectFederationClient>> | undefined;
  const close = async () => {
    connection?.close();
    daemon.kill("SIGTERM");
    await exited;
    if (!options.profileRoot) rmSync(root, { recursive: true, force: true });
  };
  try {
    for (let attempt = 0; !output.includes('"ready":true'); attempt++) {
      if (daemon.exitCode !== null || attempt >= 200) throw new Error(`Outpost startup failed: ${errors}`);
      await delay(20);
    }
    const issued = await promisify(execFile)(process.execPath, [cli, "federation-invite", "--port", "0"], { env });
    const invite = decodeFederationInvite(JSON.parse(issued.stdout).invite);
    const identity = generateFederationIdentityKeyPair();
    const viewerId = randomUUID();
    const events: AgentEvent[] = [];
    let rpc: FederationRpcEndpoint;
    connection = await connectFederationClient({ url: invite.gatewayUrl, mode: "enroll", ...identity,
      peerInstanceId: viewerId, role: "client", inviteToken: invite.token,
      gatewayInstanceId: invite.gatewayInstanceId, gatewayPublicKeyPem: invite.gatewayPublicKeyPem,
      gatewayNoisePublicKey: Buffer.from(invite.gatewayNoisePublicKey!, "base64"), noiseStatic: generateNoiseStaticKeyPair(),
      capabilities: options.capabilities ?? OUTPOST_VIEWER_CAPABILITIES, deferReceiving: true,
      onEnvelope: (envelope) => {
        if (envelope.kind === "notification" && envelope.method === "backend.event") {
          events.push(envelope.params as AgentEvent);
          return;
        }
        rpc.receiveEnvelope(envelope);
      },
    });
    const connected = connection;
    rpc = new FederationRpcEndpoint({ localInstanceId: viewerId, remoteInstanceId: invite.gatewayInstanceId,
      sendEnvelope: (envelope) => connected.sendEnvelope(envelope), defaultTimeoutMs: 3000 });
    connected.startReceiving();
    return {
      client: new FederationRemoteBackendClient(rpc), rpc, events, workspace, cli, env, viewerId, ownerInstanceId: invite.gatewayInstanceId, close,
      subscribe: (eventClasses) => connected.sendEnvelope({ kind: "notification", method: "federation.eventSubscription",
        id: randomUUID(), params: { eventClasses, threadSelection: { kind: "all" } }, protocolVersion: FEDERATION_PROTOCOL_VERSION,
        sourceInstanceId: viewerId, targetInstanceId: invite.gatewayInstanceId, createdAt: Date.now() }),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
