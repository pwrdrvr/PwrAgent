import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
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
  it.each(["direct", "symlink"])("uses the current navigation, composer, transcript and project contracts (%s workspace)", async (workspaceKind) => {
    const repo = process.cwd();
    const packageRoot = path.join(repo, "packages/pwragent");
    execFileSync(process.execPath, [path.join(packageRoot, "scripts/build.mjs")], { cwd: repo, stdio: "pipe" });
    // The outpost listens on $PWRAGENT_HOME/profiles/t/state/headless/rpc.sock
    // and refuses a socket path over 100 bytes (the Unix sun_path limit). A
    // root inside the checkout makes that depend on where the checkout lives,
    // and Sandboxer's ~/pwragent/wt/<sha> worktrees overflow it. /tmp keeps
    // the path short everywhere; os.tmpdir() does not on macOS, where it
    // resolves to a long /private/var/folders/... path. Canonicalize the short
    // root so every fixture path uses the outpost's realpath identity (on
    // macOS /tmp is an alias for /private/tmp, which is still short enough).
    const root = realpathSync(mkdtempSync("/tmp/pwragent-h-"));
    const workspace = path.join(root, "w");
    const home = path.join(root, "c");
    const data = path.join(root, "f");
    for (const directory of [workspace, home, data]) mkdirSync(directory);
    // Exercise alias resolution on Linux too, while all RPC requests and
    // assertions continue to use the canonical project/directory identity.
    const workspaceInput = workspaceKind === "symlink" ? path.join(root, "alias") : workspace;
    if (workspaceKind === "symlink") symlinkSync(workspace, workspaceInput, "dir");
    const env = { ...process.env, PWRAGENT_HOME: root, PWRAGENT_PROFILE: "t", PWRAGENT_TEST_DATA: data };
    const cli = path.join(packageRoot, "bin/pwragent.js");
    const daemon = spawn(process.execPath, [cli, "serve", "--workspace", workspaceInput, "--codex-home", home,
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
        capabilities: ["remote_window", "thread_navigation", "thread_detail", "turn_control", "messaging_route", "messaging_destinations", "messaging_files", "environment_actions"], deferReceiving: true,
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
      expect(await client.supportsMessagingPdfTools(ref)).toBe(true);
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
      const config = await client.getNavigationLaunchpadConfig({ protocol: 2, directoryKey: workspace });
      expect(config.directoryKey).toBe(workspace);
      expect(config.defaults?.workMode).toBe("local");
      const materialized = await client.materializeDirectoryLaunchpad({ directoryKey: workspace,
        launchpad: { ...config.defaults!, executionMode: "auto", workMode: "local", directoryKey: workspace, directoryKind: "directory",
          directoryLabel: "workspace", directoryPath: workspace, prompt: "", createdAt: Date.now(), updatedAt: Date.now() },
        input: [{ type: "text", text: "hello" }],
      });
      expect(materialized.workMode).toBe("local");
      expect(materialized.turnId).toBeTruthy();
      expect(materialized.turnStartFailure).toBeUndefined();
      let launchpadRead = await client.readThread({ backend: "codex", threadId: materialized.threadId });
      for (let attempt = 0; !launchpadRead.replay.lastAssistantMessage && attempt < 100; attempt++) {
        await delay(20);
        launchpadRead = await client.readThread({ backend: "codex", threadId: materialized.threadId });
      }
      expect(launchpadRead.replay.lastAssistantMessage).toBe("Fixture result");
      const projectOutput = await promisify(execFile)(process.execPath, [cli, "project-create", "--name", "contract-project"], { env });
      const project = JSON.parse(projectOutput.stdout) as { path: string };
      expect(project.path).toBe(path.join(workspace, "contract-project"));
      const projectThread = await client.startThread({ backend: "codex", cwd: project.path });
      const messageOrigin = { kind: "messaging" as const,
        causalMessagingSource: { ownerId: "fixture-provider-owner", requestId: "fixture-human-request", instanceId: viewerId },
        messaging: { platform: "slack" as const, surface: { id: "fixture-conversation", kind: "thread" as const }, actor: { platformUserId: "fixture-actor" } } };
      const projectTurn = await client.startTurn({ backend: "codex", threadId: projectThread.threadId,
        messageOrigin, input: [{ type: "text", text: "project-specific chat turn" }] });
      let reply = await client.readTurnAssistantReply({ backend: "codex", threadId: projectThread.threadId, turnId: projectTurn.turnId, text: "Fixture result" });
      for (let attempt = 0; !reply.message && attempt < 100; attempt++) {
        await delay(20);
        reply = await client.readTurnAssistantReply({ backend: "codex", threadId: projectThread.threadId, turnId: projectTurn.turnId, text: "Fixture result" });
      }
      expect(reply.message?.text).toBe("Fixture result");
      const projectPage = await client.getNavigationQueryPage({ protocol: 2, consumer: "remote-window", query: { kind: "directory", directoryKey: project.path } });
      expect(projectPage.entries[0].row.ref.threadId).toBe(projectThread.threadId);
      expect(projectPage.entries[0].row.projectKey).toBe(project.path);
    } finally {
      connection?.close();
      daemon.kill("SIGTERM");
      await exited;
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
});
