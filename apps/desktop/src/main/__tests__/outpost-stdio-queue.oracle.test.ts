import fs from "node:fs";
import { once } from "node:events";
import { createServer } from "node:http";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { buildProviderPickerEntries } from "@pwragent/shared/provider-picker";
import { canonicalDurableTurnRequest } from "@pwragent/shared/durable-turn-request";
import type { ListBackendsResponse } from "@pwragent/shared/contracts/backend";
import type { NavigationLaunchpadDraft } from "@pwragent/shared/contracts/navigation";
import type { SubmitDurableTurnRequest } from "@pwragent/shared/contracts/durable-turn-requests";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildOwnerFixture } from "./helpers/built-owner-fixture";
import { OUTPOST_VIEWER_CAPABILITIES, startOutpostDaemon, type OutpostDaemon } from "./helpers/outpost-daemon";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";

const PROVIDER_REFRESH_CAPABILITIES = [...OUTPOST_VIEWER_CAPABILITIES, "event_subscriptions" as const];

async function readBackendsWithSettledCodex(owner: OutpostDaemon, providerId: string, signal: AbortSignal): Promise<ListBackendsResponse> {
  // Admission needs only Codex and its catalog. The startup refresh event
  // also waits on other backends.
  for (;;) {
    signal.throwIfAborted();
    const snapshot = await owner.client.listBackends();
    signal.throwIfAborted();
    const codex = snapshot.backends.find(backend => backend.kind === "codex");
    const provider = codex?.codexModelProviders?.find(candidate => candidate.id === providerId);
    if (codex?.available && provider && provider.status !== "pending") return snapshot;
    await delay(50, undefined, { signal });
  }
}

function prepareProxyProfile(config: string): string {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/pa-proxy-"));
  const profile = path.join(root, "profiles", "t");
  fs.mkdirSync(path.join(profile, "state"), { recursive: true });
  fs.writeFileSync(path.join(profile, "config.toml"), `
[federation]
mode = "gateway"
listen_host = "127.0.0.1"
listen_port = 0
${config}`);
  return root;
}

describe.skipIf(process.platform === "win32")("the E2E Outpost's real Codex protocol fixture", () => {
  let directory: string;
  let preload: string;
  beforeAll(async () => {
    directory = fs.realpathSync(fs.mkdtempSync("/tmp/pa-stdio-"));
    preload = await buildOwnerFixture(directory, "headless", "", "stdio");
  });
  afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

  it("admits remote launches only through the configured provider when OpenAI is off", async ({ signal, onTestFinished }) => {
    const root = prepareProxyProfile(`
[[models.codex.providers]]
id = "empty-proxy"
name = "Empty proxy"
base_url = "http://127.0.0.1:1/v1"
discover_models = false

[[models.codex.providers]]
id = "listed-proxy"
name = "Listed proxy"
base_url = "http://127.0.0.1:1/v1"
models = ["listed-model"]

[[models.codex.providers]]
id = "proxy"
name = "Proxy"
base_url = "http://127.0.0.1:1/v1"
discover_models = false
models = ["proxy-model"]
`);
    let starting: Promise<OutpostDaemon> | undefined;
    onTestFinished(async () => {
      try {
        const host = await starting?.catch(() => undefined);
        await host?.close();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
    const data = path.join(root, "f");
    fs.mkdirSync(data);
    const oldThread = { backend: "codex" as const, threadId: "historical-openai" };
    const oldModel = "gpt-5.5";
    fs.writeFileSync(path.join(data, "fixture-threads.json"), JSON.stringify({
      [oldThread.threadId]: { id: oldThread.threadId, cwd: path.join(root, "w"), model: oldModel, modelProvider: "openai",
        name: "Existing OpenAI conversation", turns: [{ id: "old-turn", status: "completed", items: [] }] },
    }));
    fs.writeFileSync(path.join(data, "helper-title.json"), JSON.stringify({ title: "Unwanted helper" }));
    starting = startOutpostDaemon({ profileRoot: root, packageRoot: directory, fixturePreload: preload,
      env: { PWRAGENT_OUTPOST_OPENAI_PROVIDER: "off" } });
    const host = await starting;
    const calls = (): { method?: string; params?: { threadId?: string; model?: string; modelProvider?: string; ephemeral?: boolean } }[] =>
      fs.readFileSync(path.join(data, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const draft: NavigationLaunchpadDraft = { backend: "codex", directoryKey: "proxy-project", directoryPath: host.workspace,
      directoryKind: "directory", directoryLabel: "Proxy project", executionMode: "default", workMode: "local", prompt: "",
      createdAt: 1, updatedAt: 1 };
    const input = [{ type: "text" as const, text: "Run through the proxy" }];
    const launch = (model?: string) => host.client.materializeDirectoryLaunchpad({ directoryKey: draft.directoryKey,
      launchpad: { ...draft, model }, input });
    const { backends } = await readBackendsWithSettledCodex(host, "listed-proxy", signal);
    const codex = backends.find(backend => backend.kind === "codex");
    expect(codex?.available).toBe(true);
    expect(codex?.codexModelProviders).toContainEqual(expect.objectContaining({ id: "listed-proxy", status: "unavailable" }));
    // The static catalog is the oracle for what the owner can offer or run.
    expect(buildProviderPickerEntries(backends).map(entry => [entry.value, entry.models.map(model => model.id)]))
      .toEqual([["codex-provider:empty-proxy", []], ["codex-provider:listed-proxy", ["@listed-proxy/listed-model"]],
        ["codex-provider:proxy", ["@proxy/proxy-model"]]]);
    expect((await host.client.getNavigationLaunchpadConfig({ protocol: 2 })).defaults)
      .toMatchObject({ backend: "codex", codexModelProviderId: "proxy", model: "@proxy/proxy-model" });
    const effectCalls = () => calls().filter(call => ["model/list", "thread/start", "turn/start"].includes(call.method ?? ""));
    for (const model of ["fixture-model", "gpt-5.5", "@openai/gpt-5.5"]) {
      await expect(launch(model)).rejects.toThrow(/OpenAI.*disabled/i);
      expect(effectCalls()).toEqual([]);
    }
    await expect(host.client.materializeDirectoryLaunchpad({ directoryKey: draft.directoryKey, launchpad: draft, input,
      collaborationMode: { mode: "plan", settings: { model: oldModel } } })).rejects.toThrow(/OpenAI.*disabled/i);
    await expect(host.client.startTurn({ ...oldThread, input })).rejects.toThrow(/OpenAI.*disabled/i);
    const durable: SubmitDurableTurnRequest = {
      clientRequest: { version: 1, id: randomUUID(), createdAt: Date.now(), payloadHash: "" },
      request: { ...oldThread, model: oldModel, input },
    };
    durable.clientRequest.payloadHash = createHash("sha256").update(canonicalDurableTurnRequest(host.ownerInstanceId, durable)).digest("hex");
    await expect(host.client.submitTurnRequest(durable)).rejects.toThrow(/OpenAI.*disabled/i);
    expect(await host.client.getTurnRequest({ ...oldThread, id: durable.clientRequest.id })).toBeNull();
    expect((await host.client.resolveThread(oldThread)).thread).toMatchObject({ model: oldModel, title: "Existing OpenAI conversation" });
    expect(effectCalls()).toEqual([]);
    const created = await launch();
    expect(created).toMatchObject({ backend: "codex", turnId: expect.any(String) });
    expect(created.turnStartFailure).toBeUndefined();
    expect(effectCalls()).toEqual([
      expect.objectContaining({ method: "thread/start", params: expect.objectContaining({ model: "proxy-model", modelProvider: "proxy" }) }),
      expect.objectContaining({ method: "turn/start", params: expect.objectContaining({ threadId: created.threadId, model: "proxy-model" }) }),
    ]);
    await expect(host.client.startTurn({ backend: "codex", threadId: created.threadId, input, model: oldModel }))
      .rejects.toThrow(/OpenAI.*disabled/i);
    // Admission compares the provider of the thread that would be created
    // with the collaboration model, before creating any provider work.
    for (const model of [undefined, "@proxy/proxy-model"]) {
      await expect(host.client.materializeDirectoryLaunchpad({ directoryKey: draft.directoryKey, launchpad: { ...draft, model }, input,
        collaborationMode: { mode: "plan", settings: { model: "@listed-proxy/listed-model" } } })).rejects.toThrow(/collaboration model.*proxy/i);
    }
    expect(effectCalls()).toHaveLength(2);
  });

  it("uses the proxy preset when reading and sending stored OpenAI launchpads without saving it over their defaults", async () => {
    const root = prepareProxyProfile(`
[[models.codex.providers]]
id = "proxy"
name = "Proxy"
base_url = "http://127.0.0.1:1/v1"
discover_models = false
models = ["proxy-model"]

[[models.model_provider_defaults]]
provider = "codex-provider:proxy"
execution_mode = "default"
`);
    const directoryKey = "saved-project";
    const directoryPath = path.join(root, "w");
    const database = path.join(root, "profiles/t/state/state.db");
    const openai = { backend: "codex", executionMode: "full-access", model: "gpt-5.5" } as const;
    const proxy = { backend: "codex", executionMode: "default", codexModelProviderId: "proxy", model: "@proxy/proxy-model" } as const;
    let host: OutpostDaemon | undefined;
    try {
      const db = StateDb.open(database);
      let before;
      try {
        const store = new SqliteOverlayStore(db);
        before = await store.setLaunchpadDefaults(openai);
        await store.upsertDirectoryLaunchpad({ ...openai, directoryKey, directoryKind: "directory", directoryLabel: "Saved project",
          directoryPath, workMode: "local", prompt: "Continue the saved draft", createdAt: 1, updatedAt: 1 });
      } finally { db.close(); }
      host = await startOutpostDaemon({ profileRoot: root, packageRoot: directory, fixturePreload: preload,
        capabilities: [...OUTPOST_VIEWER_CAPABILITIES, "launchpad_metadata"],
        env: { PWRAGENT_OUTPOST_OPENAI_PROVIDER: "off", PWRAGENT_OUTPOST_EXECUTION_MODES: "default,auto,full-access" } });
      const { defaults, launchpad } = await host.client.getNavigationLaunchpadConfig({ protocol: 2, directoryKey });
      expect.soft(defaults).toMatchObject(proxy);
      expect.soft(launchpad).toMatchObject(proxy);
      const ensured = await host.client.ensureDirectoryLaunchpad({ directoryKey: "ensured-project", directoryPath,
        directoryKind: "directory", directoryLabel: "Saved project" });
      expect.soft(ensured.defaults).toMatchObject(proxy);
      expect.soft(ensured.launchpad).toMatchObject(proxy);

      // The stored draft has the same effective settings as the config read.
      await expect.soft(host.client.materializeDirectoryLaunchpad({ directoryKey, releaseLaunchpadOnSubmit: true }))
        .resolves.toMatchObject({ backend: "codex", executionMode: "default", turnId: expect.any(String) });
      await host.close();
      host = undefined;
      const reopened = StateDb.open(database);
      try {
        const store = new SqliteOverlayStore(reopened);
        expect(await store.getLaunchpadDefaults()).toEqual(before);
      } finally { reopened.close(); }
    } finally {
      await host?.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses a listed model for an omitted-model launch when discovery fails", async ({ signal, onTestFinished }) => {
    const discovery = Promise.withResolvers<void>();
    const endpoint = createServer(async (request, response) => {
      if (request.method !== "GET" || request.url !== "/v1/models") {
        response.writeHead(404).end();
        return;
      }
      await discovery.promise;
      response.writeHead(503).end();
    });
    let root: string | undefined;
    let starting: Promise<OutpostDaemon> | undefined;
    onTestFinished(async () => {
      discovery.resolve();
      try {
        const host = await starting?.catch(() => undefined);
        await host?.close();
      } finally {
        await new Promise<void>(resolve => endpoint.close(() => resolve()));
        if (root) fs.rmSync(root, { recursive: true, force: true });
      }
    });
    endpoint.listen(0, "127.0.0.1");
    await once(endpoint, "listening", { signal });
    signal.throwIfAborted();
    const address = endpoint.address();
    if (!address || typeof address === "string") throw new Error("Discovery fixture did not bind a loopback port");
    root = prepareProxyProfile(`
[[models.codex.providers]]
id = "proxy"
name = "Proxy"
base_url = "http://127.0.0.1:${address.port}/v1"
models = ["proxy-model"]
`);
    starting = startOutpostDaemon({ profileRoot: root, packageRoot: directory, fixturePreload: preload,
      capabilities: PROVIDER_REFRESH_CAPABILITIES,
      env: { PWRAGENT_OUTPOST_OPENAI_PROVIDER: "off" } });
    const owner = await starting;
    signal.throwIfAborted();
    // The test endpoint holds the catalog read open until the viewer has
    // seen pending. The owner must publish the failure before signaling the
    // refresh, and still offer the operator's listed model.
    owner.subscribe(["transcript"]);
    const before = await owner.client.listBackends({ includeUnavailable: true });
    signal.throwIfAborted();
    expect(before.backends.find(backend => backend.kind === "codex")?.codexModelProviders)
      .toContainEqual(expect.objectContaining({ id: "proxy", status: "pending" }));
    discovery.resolve();
    await owner.waitForEvent("navigation/providerThreads/refreshed", event => event.backend === "codex", signal);
    const { backends, providerRefresh } = await owner.client.listBackends();
    expect(["ready", "degraded"]).toContain(providerRefresh?.state);
    const codex = backends.find(backend => backend.kind === "codex");
    expect(codex?.available).toBe(true);
    expect(codex?.codexModelProviders)
      .toContainEqual(expect.objectContaining({ id: "proxy", status: "unavailable", error: "HTTP 503" }));
    expect.soft((await owner.client.getNavigationLaunchpadConfig({ protocol: 2 })).defaults)
      .toMatchObject({ codexModelProviderId: "proxy", model: "@proxy/proxy-model" });
    await expect(owner.client.startThread({ backend: "codex", cwd: owner.workspace }))
      .resolves.toMatchObject({ backend: "codex", threadId: expect.any(String) });
  });

  it("refuses an omitted model when the proxy-only owner has no configured catalog", async () => {
    const host = await startOutpostDaemon({ packageRoot: directory, fixturePreload: preload,
      env: { PWRAGENT_OUTPOST_OPENAI_PROVIDER: "off" } });
    try {
      const { backends } = await host.client.listBackends({ includeUnavailable: true });
      expect(backends.map(backend => backend.kind)).toEqual(["codex"]);
      expect(buildProviderPickerEntries(backends)).toEqual([]);
      await expect(host.client.startThread({ backend: "codex", cwd: host.workspace }))
        .rejects.toThrow(/No configured Codex model is available/);
      const calls = fs.readFileSync(path.join(host.env.PWRAGENT_TEST_DATA!, "calls.jsonl"), "utf8");
      expect(calls).not.toMatch(/"method":"(?:model\/list|thread\/start|turn\/start)"/);
    } finally {
      await host.close();
    }
  });

  it("queued replacement preserves sender ownership and held guidance returns to the same native turn", async () => {
    const host = await startOutpostDaemon({ packageRoot: directory, fixturePreload: preload,
      capabilities: [...OUTPOST_VIEWER_CAPABILITIES, "turn_queue_pause"], env: { PWRAGENT_OUTPOST_OPENAI_PROVIDER: undefined } });
    const displaced = `${host.workspace}-unavailable`;
    try {
      const created = await host.client.startThread({ backend: "codex", cwd: host.workspace });
      // A creation response also includes executionMode. Sending it back as
      // guidance would explicitly select turn settings and request a new turn.
      const ref = { backend: created.backend, threadId: created.threadId };
      const active = await host.client.startTurn({ ...ref, input: [{ type: "text", text: "slow" }] });
      const messageOrigin = { kind: "agent" as const, sourceThread: { backend: "codex" as const, threadId: "invented-sender" } };
      const input = [{ type: "text" as const, text: "Invented queued input" }];
      const queued = await host.client.startTurn({ ...ref, input, messageOrigin, delivery: "new_turn", queueEntryId: "stdio-waiting" });
      await expect(host.client.replaceQueuedMessage({ ...ref, input, queueEntryId: queued.queueEntryId! })).rejects.toThrow("Only the sending thread");
      const replacement = await host.client.replaceQueuedMessage({ ...ref, input: [{ type: "text", text: "Invented replacement" }],
        messageOrigin, queueEntryId: queued.queueEntryId! });
      expect(replacement.queueEntryId).not.toBe(queued.queueEntryId);
      await host.client.cancelQueuedTurn({ queueEntryId: replacement.queueEntryId! });
      await host.client.startTurn({ ...ref, queueEntryId: "stdio-agent-guidance", input: [{ type: "text", text: "hold-steer-ack" }], messageOrigin });
      await vi.waitFor(() => expect(fs.existsSync(path.join(host.env.PWRAGENT_TEST_DATA!, "steer.ready"))).toBe(true));
      const heldInput = [{ type: "text" as const, text: "Invented held guidance" }];
      const held = await host.client.startTurn({ ...ref, queueEntryId: "stdio-held", input: heldInput, messageOrigin });
      await host.client.setQueuedTurnPaused({ queueEntryId: held.queueEntryId!, paused: true });
      fs.renameSync(host.workspace, displaced);
      fs.writeFileSync(path.join(host.env.PWRAGENT_TEST_DATA!, "steer.release"), "release");
      await host.client.setQueuedTurnPaused({ queueEntryId: held.queueEntryId!, paused: false });
      const projection = () => host.client.getNavigationQueueProjection({ protocol: 2, ref });
      await vi.waitFor(async () => expect((await projection()).entries[0]?.manualReleaseRequired).toBe(true));
      const before = await projection();
      expect(await host.client.releaseQueuedTurn({ queueEntryId: held.queueEntryId! })).toMatchObject({ disposition: "blocked" });
      expect(await projection()).toEqual(before);
      fs.renameSync(displaced, host.workspace);
      expect(await host.client.releaseQueuedTurn({ queueEntryId: held.queueEntryId! })).toMatchObject({ disposition: "started", turnId: active.turnId });
      expect((await projection()).entries).toEqual([]);
      expect((await host.client.resolveThreadAdmissionState(ref)).activeTurn?.turnId).toBe(active.turnId);
      const calls = fs.readFileSync(path.join(host.env.PWRAGENT_TEST_DATA!, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(calls.filter(call => call.method === "turn/steer" && call.params.input[0].text === heldInput[0].text)).toHaveLength(1);
      await host.client.interruptTurn(active);
    } finally {
      if (fs.existsSync(displaced)) fs.renameSync(displaced, host.workspace);
      await host.close();
    }
  });
});
