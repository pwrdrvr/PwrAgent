// Run with the checkout's tsx. Never opens a production profile or identity store.
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

async function main() {
  const disposers: (() => void | Promise<void>)[] = [];
  async function dispose() {
    for (const release of disposers.splice(0).reverse()) {
      try { await release(); } catch (error) { console.error("Fixture cleanup:", error); process.exitCode = 1; }
    }
  }
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const out = resolve(process.env.PWRWIN_OUTPUT ?? `${root}/.local/remote-window/live`);
    await mkdir(out, { recursive: true });
    process.env.PWRAGENT_HOME = await mkdtemp(`${tmpdir()}/pwrwin-live-`);
    const { StateDb } = await import("../../apps/desktop/src/main/state/state-db.ts");
    const { FederationStore } = await import("../../apps/desktop/src/main/federation/federation-store.ts");
    const { generateFederationIdentityKeyPair } = await import("../../apps/desktop/src/main/federation/federation-identity.ts");
    const { generateNoiseStaticKeyPair } = await import("../../apps/desktop/src/main/federation/federation-noise.ts");
    const { FederationRouter } = await import("../../apps/desktop/src/main/federation/federation-router.ts");
    const { FederationRpcEndpoint } = await import("../../apps/desktop/src/main/federation/federation-rpc.ts");
    const { connectFederationClient, FederationGatewayWebSocketServer } = await import("../../apps/desktop/src/main/federation/federation-transport.ts");
    const { startWindowPrototypeBridge } = await import("../../apps/desktop/src/main/federation/federation-window-prototype-bridge.ts");
    const db = StateDb.open(":memory:");
    disposers.push(() => db.close());
    const store = new FederationStore(db);
    const gatewayId = "pwr_fixture_gateway", ownerId = "pwr_fixture_source", viewerId = "pwr_fixture_viewer";
    const identity = generateFederationIdentityKeyPair(), noise = generateNoiseStaticKeyPair();
    const gatewayRouter = new FederationRouter({ localInstanceId: gatewayId });
    const ownerRouter = new FederationRouter({ localInstanceId: ownerId, trustedRelayPeerId: gatewayId });
    let stopped = false;
    const wireTimeline: unknown[] = [];
    const wire: Record<string, { bytes: number; messages: number }> = {};
    const noteWire = ({ peerId, direction, byteCount }: { peerId: string; direction: string; byteCount: number }) => {
      const row = wire[`${peerId}:${direction}`] ??= { bytes: 0, messages: 0 };
      row.bytes += byteCount; row.messages++;
      if (wireTimeline.length < 50000) wireTimeline.push({ at: Date.now(), peerId, direction, bytes: byteCount });
    };
    const gateway = new FederationGatewayWebSocketServer({
      gatewayInstanceId: gatewayId, gatewayPrivateKeyPem: identity.privateKeyPem,
      gatewayPublicKeyPem: identity.publicKeyPem, noiseStatic: noise,
      host: "127.0.0.1", port: 0, store, compressionEnabled: false,
      onConnection: connection => gatewayRouter.registerConnection(connection),
      onDisconnect: connection => gatewayRouter.unregisterConnection(connection.peerId),
      onEnvelope: (envelope, connection) => { void gatewayRouter.routeEnvelope({ envelope, sourcePeerId: connection.peerId }); },
      onEnvelopeTransfer: noteWire,
    });
    disposers.push(() => gateway.stop());
    const { url } = await gateway.start();
    async function connect(id: string, onEnvelope: (e: unknown) => void) {
      const keys = generateFederationIdentityKeyPair();
      // Fixture-only, RAM-only trust. No enrollment endpoint, file, real peer, or credential access.
      store.upsertPeer({ peer: { id, label: id, role: "client", status: "disconnected",
        capabilities: ["gateway_relay"], protocolVersion: 1, pinnedPublicKeyPem: keys.publicKeyPem }, updatedAt: Date.now() });
      return connectFederationClient({ url, mode: "reconnect", gatewayInstanceId: gatewayId,
        gatewayPublicKeyPem: identity.publicKeyPem, gatewayNoisePublicKey: noise.publicKeyRaw,
        peerInstanceId: id, privateKeyPem: keys.privateKeyPem, publicKeyPem: keys.publicKeyPem,
        noiseStatic: generateNoiseStaticKeyPair(), capabilities: ["gateway_relay"],
        onEnvelope: onEnvelope as never });
    }
    const ownerClient = await connect(ownerId, envelope => { void ownerRouter.routeEnvelope({ envelope: envelope as never, sourcePeerId: gatewayId }); });
    disposers.push(() => ownerClient.close());
    ownerRouter.registerConnection({ peerId: gatewayId, capabilities: ["gateway_relay"],
      sendEnvelope: e => ownerClient.sendEnvelope(e), sendEnvelopeWithBackpressure: e => ownerClient.sendEnvelopeWithBackpressure!(e) });
    let rpc: InstanceType<typeof FederationRpcEndpoint>;
    const requestDelayMs = Number(process.env.PWRWIN_REQUEST_DELAY_MS ?? 0);
    if (!Number.isFinite(requestDelayMs) || requestDelayMs < 0 || requestDelayMs > 500) throw new Error("Invalid request delay");
    const rpcTimers = new Set<ReturnType<typeof setTimeout>>();
    const viewerClient = await connect(viewerId, envelope => rpc.receiveEnvelope(envelope as never));
    disposers.push(() => viewerClient.close());
    rpc = new FederationRpcEndpoint({ localInstanceId: viewerId, remoteInstanceId: ownerId,
      sendEnvelope: envelope => {
        if (!requestDelayMs) { viewerClient.sendEnvelope(envelope); return; }
        const timer = setTimeout(() => { rpcTimers.delete(timer); if (!stopped) viewerClient.sendEnvelope(envelope); }, requestDelayMs);
        rpcTimers.add(timer);
      }, defaultTimeoutMs: 3000 });
    disposers.push(() => { for (const timer of rpcTimers) clearTimeout(timer); rpcTimers.clear(); rpc.rejectAll(new Error("closed")); });
    const begin = Date.now();
    const cpuStart = process.cpuUsage();
    let ownerReadyFile = "", viewerReadyFile = "";
    const sourceConfig = `${out}/source-config.json`, viewerConfig = `${out}/viewer-config.json`;
    await writeFile(sourceConfig, JSON.stringify({ peerId: viewerId, role: "source" }));
    await writeFile(viewerConfig, JSON.stringify({ peerId: ownerId, role: "viewer" }));
    const sourceBridge = await startWindowPrototypeBridge({ packaged: false, configPath: sourceConfig,
      router: ownerRouter, localInstanceId: ownerId, peerConnected: () => !stopped,
      requestPeer: async () => { throw new Error("source cannot call remote methods"); },
      log: { info: message => { ownerReadyFile = message.slice(message.indexOf("adapter ready: ") + 15); }, error: console.error } });
    if (sourceBridge) disposers.push(() => sourceBridge.dispose());
    const viewerBridge = await startWindowPrototypeBridge({ packaged: false, configPath: viewerConfig,
      router: new FederationRouter({ localInstanceId: viewerId }), localInstanceId: viewerId, peerConnected: () => !stopped,
      requestPeer: (_peer, method, params) => rpc.request({ method, params }),
      log: { info: message => { viewerReadyFile = message.slice(message.indexOf("adapter ready: ") + 15); }, error: console.error } });
    if (viewerBridge) disposers.push(() => viewerBridge.dispose());
    const helperLogs: string[] = [];
    const sourceProcess = spawn(process.execPath, [`${root}/scripts/remote-window-prototype/live-enrolled.mjs`,
      "--runtime-ready", ownerReadyFile, "--source-executable", `${root}/.local/remote-window/live-fixture`,
      "--output", `${out}/source`, ...(process.argv.includes("--allow-fixture-input") ? ["--allow-fixture-input"] : [])], { stdio: ["ignore", "pipe", "pipe"] });
    const viewerProcess = spawn(process.execPath, [`${root}/scripts/remote-window-prototype/live-enrolled.mjs`,
      "--runtime-ready", viewerReadyFile, "--output", `${out}/viewer`], { stdio: ["ignore", "pipe", "pipe"] });
    async function stopHelpers() {
      await Promise.all([sourceProcess, viewerProcess].map(async child => {
        if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => child.kill("SIGTERM"), 5000);
          child.once("exit", () => { clearTimeout(timer); resolve(); });
          child.kill("SIGINT");
        });
      }));
    }
    disposers.push(stopHelpers);
    for (const child of [sourceProcess, viewerProcess]) {
      child.stdout?.on("data", data => { if (helperLogs.length < 50) helperLogs.push(String(data).slice(0, 2000)); });
      child.stderr?.on("data", data => { if (helperLogs.length < 50) helperLogs.push(String(data).slice(0, 2000)); });
    }
    const stopSafely = () => { void stop().catch(error => { console.error(error); process.exitCode = 1; }); };
    process.once("SIGINT", stopSafely); process.once("SIGTERM", stopSafely);
    sourceProcess.once("error", stopSafely); viewerProcess.once("error", stopSafely);
    sourceProcess.once("exit", stopSafely); viewerProcess.once("exit", stopSafely);
    await writeFile(`${out}/fabric.json`, JSON.stringify({ pid: process.pid, viewerReady: `${out}/viewer/ready.json` }));
    console.log(`Live fixture ready. Viewer URL is in ${out}/viewer/ready.json (local fixture token). Ctrl-C stops capture.`);
    async function stop() {
      if (stopped) return;
      stopped = true;
      try {
        await stopHelpers();
        const readResult = async (role: string) => {
          try { return JSON.parse(await readFile(`${out}/${role}/result.json`, "utf8")); }
          catch { return { unavailable: `${role} helper did not produce a result` }; }
        };
        const sourceResult = await readResult("source"), viewerResult = await readResult("viewer");
        await writeFile(`${out}/result.json`, JSON.stringify({ schema: 1, measuredAt: new Date().toISOString(),
          path: "live native source helper -> runtime source adapter -> Noise source client -> loopback gateway -> Noise viewer client -> runtime viewer adapter -> browser WebCodecs",
          crossMachine: false, requestDelayMs, elapsedMs: Date.now() - begin, cpu: process.cpuUsage(cpuStart),
          nodeMaxRssKiB: process.resourceUsage().maxRSS, wire, wireTimeline, helperLogs,
          ...sourceResult, browser: viewerResult.browser, viewerResultError: viewerResult.unavailable }, null, 2));
      } finally { await dispose(); }
    }
  } catch (error) { await dispose(); throw error; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
