import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { FederationRemoteBackendClient } from "../federation/federation-backend-bridge";
import { decodeFederationInvite } from "../federation/federation-enrollment";
import { generateFederationIdentityKeyPair } from "../federation/federation-identity";
import { generateNoiseStaticKeyPair } from "../federation/federation-noise";
import { FederationRpcEndpoint } from "../federation/federation-rpc";
import { connectFederationClient } from "../federation/federation-transport";

describe.skipIf(process.platform === "win32")("desktop client against the standalone outpost", () => {
  it("uses the current navigation, composer, transcript and project contracts", async () => {
    const repo = process.cwd();
    const packageRoot = path.join(repo, "packages/pwragent");
    execFileSync(process.execPath, [path.join(packageRoot, "scripts/build.mjs")], { cwd: repo, stdio: "pipe" });
    mkdirSync(path.join(repo, ".local"), { recursive: true });
    const root = mkdtempSync(path.join(repo, ".local/h"));
    const workspace = path.join(root, "w");
    const home = path.join(root, "c");
    const data = path.join(root, "f");
    for (const directory of [workspace, home, data]) mkdirSync(directory);
    const env = { ...process.env, PWRAGENT_HOME: root, PWRAGENT_PROFILE: "t", PWRAGENT_TEST_DATA: data };
    const cli = path.join(packageRoot, "bin/pwragent.js");
    const daemon = spawn(process.execPath, [cli, "serve", "--workspace", workspace, "--codex-home", home,
      "--codex-bin", path.join(packageRoot, "test/fixtures/codex.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    daemon.stdout.on("data", (chunk) => { output += String(chunk); });
    daemon.stderr.on("data", (chunk) => { errors += String(chunk); });
    const exited = new Promise<void>((resolve) => daemon.once("exit", () => resolve()));
    let connection: Awaited<ReturnType<typeof connectFederationClient>> | undefined;
    try {
      for (let attempt = 0; !output.includes('"ready":true'); attempt++) {
        if (daemon.exitCode !== null || attempt >= 200) throw new Error(`Outpost startup failed: ${errors}`);
        await delay(20);
      }
      const reserve = net.createServer();
      await new Promise<void>((resolve) => reserve.listen(0, "127.0.0.1", resolve));
      const port = (reserve.address() as net.AddressInfo).port;
      await new Promise<void>((resolve) => reserve.close(() => resolve()));
      const issued = await promisify(execFile)(process.execPath, [cli, "federation-invite", "--port", String(port)], { env });
      const invite = decodeFederationInvite(JSON.parse(issued.stdout).invite);
      const identity = generateFederationIdentityKeyPair();
      const viewerId = randomUUID();
      let rpc: FederationRpcEndpoint;
      connection = await connectFederationClient({ url: invite.gatewayUrl, mode: "enroll", ...identity,
        peerInstanceId: viewerId, role: "client", inviteToken: invite.token,
        gatewayInstanceId: invite.gatewayInstanceId, gatewayPublicKeyPem: invite.gatewayPublicKeyPem,
        gatewayNoisePublicKey: Buffer.from(invite.gatewayNoisePublicKey!, "base64"), noiseStatic: generateNoiseStaticKeyPair(),
        capabilities: ["remote_window", "thread_navigation", "thread_detail", "turn_control"], deferReceiving: true,
        onEnvelope: (envelope) => { rpc.receiveEnvelope(envelope); },
      });
      const connected = connection;
      rpc = new FederationRpcEndpoint({ localInstanceId: viewerId, remoteInstanceId: invite.gatewayInstanceId,
        sendEnvelope: (envelope) => connected.sendEnvelope(envelope), defaultTimeoutMs: 3000 });
      connected.startReceiving();
      const client = new FederationRemoteBackendClient(rpc);
      const providers = await client.listBackends({});
      expect(providers.backends[0].launchpadOptions?.models?.[0].id).toBe("fixture-model");
      const projects = await client.getProjectPage({});
      expect(projects.directories[0].path).toBe(workspace);
      const created = await client.startThread({ backend: "codex", cwd: workspace, executionMode: "auto" });
      const ref = { backend: "codex" as const, threadId: created.threadId };
      const page = await client.getNavigationQueryPage({ protocol: 2, consumer: "remote-window", query: { kind: "directory", directoryKey: workspace } });
      expect(page.entries[0].row.ref).toEqual(ref);
      expect(page.selectionDirectory?.path).toBe(workspace);
      expect((await client.getNavigationSelectedDetail({ protocol: 2, ref })).thread?.executionMode).toBe("auto");
      expect((await client.getNavigationQueueProjection({ protocol: 2, ref })).entries).toEqual([]);
      expect((await client.resolveThreadAdmissionState(ref)).thread?.id).toBe(created.threadId);
      const turn = await client.startTurn({ ...ref, input: [{ type: "text", text: "hello" }], queueEntryId: "stable-submission" });
      expect(turn.turnId).toBeTruthy();
      let read = await client.readThread(ref);
      for (let attempt = 0; !read.replay.lastAssistantMessage && attempt < 100; attempt++) {
        await delay(20);
        read = await client.readThread(ref);
      }
      expect(read.replay.lastAssistantMessage).toBe("Fixture result");
      // A lost response can be retried with the viewer's stable submission ID.
      expect((await client.startTurn({ ...ref, input: [{ type: "text", text: "hello" }], queueEntryId: "stable-submission" })).turnId).toBe(turn.turnId);
      await expect(client.startTurn({ ...ref, input: [{ type: "text", text: "different" }], queueEntryId: "stable-submission" })).rejects.toThrow("different input");
      expect((await client.getNavigationQueryPage({ protocol: 2, consumer: "remote-window", query: { kind: "directory-index", keys: ["missing"] } })).directories).toEqual([]);
    } finally {
      connection?.close();
      daemon.kill("SIGTERM");
      await exited;
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
});
