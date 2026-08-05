// Covers the shape an `ssh://` endpoint actually runs in production: the real
// SshStdioSocket carrying a real WebSocket upgrade and the real Noise
// handshake. The unit tests drive the duplex directly and the transport tests
// use a plain TCP socket, so neither exercises this combination — which is
// exactly how a bug in the child-exit path stayed invisible.
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FederationProtocolEnvelope } from "@pwragent/shared";
import { createFederationEnrollmentInvite } from "../federation/federation-enrollment";
import { generateFederationIdentityKeyPair } from "../federation/federation-identity";
import { generateNoiseStaticKeyPair } from "../federation/federation-noise";
import {
  dialFederationSshEndpoint,
  parseFederationSshEndpoint,
} from "../federation/federation-ssh";
import { FederationStore } from "../federation/federation-store";
import {
  connectFederationClient,
  FederationGatewayWebSocketServer,
} from "../federation/federation-transport";
import { StateDb } from "../state/state-db";

let stateDb: StateDb;
let store: FederationStore;
let tempDir: string;
let server: FederationGatewayWebSocketServer | undefined;
let gatewayKeyPair: ReturnType<typeof generateFederationIdentityKeyPair>;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-federation-ssh-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  store = new FederationStore(stateDb);
  gatewayKeyPair = generateFederationIdentityKeyPair();
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

/** Stands in for `ssh -W`: relays its stdio over a real TCP connection. */
class RelaySshChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private readonly upstream: net.Socket;

  constructor(port: number) {
    super();
    this.upstream = net.connect(port, "127.0.0.1");
    this.stdin.pipe(this.upstream);
    this.upstream.pipe(this.stdout);
    this.upstream.on("close", () => {
      // Real ssh exits 0 once its forwarded connection ends.
      setImmediate(() => this.emit("close", 0, null));
    });
    this.upstream.on("error", () => undefined);
  }

  kill(): boolean {
    this.upstream.destroy();
    return true;
  }
}

async function startGateway(noiseStatic: ReturnType<typeof generateNoiseStaticKeyPair>) {
  server = new FederationGatewayWebSocketServer({
    gatewayInstanceId: "gateway_one",
    gatewayPrivateKeyPem: gatewayKeyPair.privateKeyPem,
    gatewayPublicKeyPem: gatewayKeyPair.publicKeyPem,
    host: "127.0.0.1",
    port: 0,
    store,
    noiseStatic,
    onEnvelope: (envelope, connection) => {
      connection.sendEnvelope({
        id: "response-1",
        kind: "response",
        requestId: envelope.id,
        protocolVersion: 1,
        sourceInstanceId: "gateway_one",
        targetInstanceId: connection.peerId,
        createdAt: 2_000,
        result: { ok: true },
      });
    },
  });
  return await server.start();
}

describe("federation ssh transport", () => {
  it("carries the Noise handshake and envelopes over the ssh stdio forward", async () => {
    const gatewayNoise = generateNoiseStaticKeyPair();
    const clientNoise = generateNoiseStaticKeyPair();
    const clientKeyPair = generateFederationIdentityKeyPair();
    const invite = createFederationEnrollmentInvite({
      store,
      token: "invite-token-ssh-transport",
      gatewayInstanceId: "gateway_one",
      generatedAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
    });
    const { port } = await startGateway(gatewayNoise);
    const endpoint = parseFederationSshEndpoint(
      `ssh://gateway.lan/?forward=127.0.0.1:${port}`,
    );

    const reply = new Promise<FederationProtocolEnvelope>((resolve) => {
      void connectFederationClient({
        url: `ws://127.0.0.1:${port}`,
        createSocket: () =>
          dialFederationSshEndpoint(endpoint, {
            spawnFn: () =>
              new RelaySshChild(port) as unknown as ChildProcessWithoutNullStreams,
          }),
        mode: "enroll",
        gatewayInstanceId: "gateway_one",
        gatewayPublicKeyPem: gatewayKeyPair.publicKeyPem,
        peerInstanceId: "client_one",
        privateKeyPem: clientKeyPair.privateKeyPem,
        publicKeyPem: clientKeyPair.publicKeyPem,
        capabilities: ["remote_window"],
        inviteToken: invite.token,
        label: "Client",
        role: "client",
        noiseStatic: clientNoise,
        gatewayNoisePublicKey: gatewayNoise.publicKeyRaw,
        onEnvelope: resolve,
      }).then((client) => {
        client.sendEnvelope({
          id: "request-1",
          kind: "request",
          method: "thread.list",
          params: {},
          protocolVersion: 1,
          sourceInstanceId: "client_one",
          targetInstanceId: "gateway_one",
          createdAt: 1_000,
        });
      });
    });

    await expect(reply).resolves.toMatchObject({ result: { ok: true } });
    expect(store.getPeer("client_one")).toMatchObject({
      status: "connected",
      pinnedPublicKeyPem: clientKeyPair.publicKeyPem,
    });
  });

  it("closes an ssh-backed session without raising an uncaught error", async () => {
    const gatewayNoise = generateNoiseStaticKeyPair();
    const clientNoise = generateNoiseStaticKeyPair();
    const clientKeyPair = generateFederationIdentityKeyPair();
    const invite = createFederationEnrollmentInvite({
      store,
      token: "invite-token-ssh-close",
      gatewayInstanceId: "gateway_one",
      generatedAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
    });
    const { port } = await startGateway(gatewayNoise);
    const endpoint = parseFederationSshEndpoint(
      `ssh://gateway.lan/?forward=127.0.0.1:${port}`,
    );

    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", onUncaught);
    try {
      const client = await connectFederationClient({
        url: `ws://127.0.0.1:${port}`,
        createSocket: () =>
          dialFederationSshEndpoint(endpoint, {
            spawnFn: () =>
              new RelaySshChild(port) as unknown as ChildProcessWithoutNullStreams,
          }),
        mode: "enroll",
        gatewayInstanceId: "gateway_one",
        gatewayPublicKeyPem: gatewayKeyPair.publicKeyPem,
        peerInstanceId: "client_two",
        privateKeyPem: clientKeyPair.privateKeyPem,
        publicKeyPem: clientKeyPair.publicKeyPem,
        capabilities: ["remote_window"],
        inviteToken: invite.token,
        label: "Client",
        role: "client",
        noiseStatic: clientNoise,
        gatewayNoisePublicKey: gatewayNoise.publicKeyRaw,
      });
      client.close();
      await new Promise((resolve) => setTimeout(resolve, 300));
    } finally {
      process.off("uncaughtException", onUncaught);
    }

    expect(
      uncaught.map((error) =>
        error instanceof Error ? error.message : String(error),
      ),
    ).toEqual([]);
  });
});
