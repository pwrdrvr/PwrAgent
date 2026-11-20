import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { buildProviderPickerEntries, canonicalDurableTurnRequest, type NavigationLaunchpadDraft, type SubmitDurableTurnRequest } from "@pwragent/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildOwnerFixture } from "./helpers/built-owner-fixture";
import { OUTPOST_VIEWER_CAPABILITIES, startOutpostDaemon } from "./helpers/outpost-daemon";

describe.skipIf(process.platform === "win32")("the E2E Outpost's real Codex protocol fixture", () => {
  let directory: string;
  let preload: string;
  beforeAll(async () => {
    directory = fs.realpathSync(fs.mkdtempSync("/tmp/pa-stdio-"));
    preload = await buildOwnerFixture(directory, "headless", "", "stdio");
  });
  afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

  it("admits remote launches only through the configured provider when OpenAI is off", async () => {
    const root = fs.realpathSync(fs.mkdtempSync("/tmp/pa-proxy-"));
    const profile = path.join(root, "profiles", "t");
    const data = path.join(root, "f");
    fs.mkdirSync(profile, { recursive: true });
    fs.mkdirSync(data);
    const oldThread = { backend: "codex" as const, threadId: "historical-openai" };
    const oldModel = "gpt-5.5";
    fs.writeFileSync(path.join(data, "fixture-threads.json"), JSON.stringify({
      [oldThread.threadId]: { id: oldThread.threadId, cwd: path.join(root, "w"), model: oldModel, modelProvider: "openai",
        name: "Existing OpenAI conversation", turns: [{ id: "old-turn", status: "completed", items: [] }] },
    }));
    fs.writeFileSync(path.join(profile, "config.toml"), `
[federation]
mode = "gateway"
listen_host = "127.0.0.1"
listen_port = 0

[[models.codex.providers]]
id = "empty-proxy"
name = "Empty proxy"
base_url = "http://127.0.0.1:1/v1"
discover_models = false

[[models.codex.providers]]
id = "proxy"
name = "Proxy"
base_url = "http://127.0.0.1:1/v1"
discover_models = false
models = ["proxy-model"]
`);
    fs.writeFileSync(path.join(data, "helper-title.json"), JSON.stringify({ title: "Unwanted helper" }));
    const host = await startOutpostDaemon({ profileRoot: root, packageRoot: directory, fixturePreload: preload,
      env: { PWRAGENT_OUTPOST_OPENAI_PROVIDER: "off" } }).catch(error => {
      fs.rmSync(root, { recursive: true, force: true });
      throw error;
    });
    try {
      const calls = (): { method?: string; params?: { threadId?: string; model?: string; modelProvider?: string; ephemeral?: boolean } }[] =>
        fs.readFileSync(path.join(data, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
      const draft: NavigationLaunchpadDraft = { backend: "codex", directoryKey: "proxy-project", directoryPath: host.workspace,
        directoryKind: "directory", directoryLabel: "Proxy project", executionMode: "default", workMode: "local", prompt: "",
        createdAt: 1, updatedAt: 1 };
      const input = [{ type: "text" as const, text: "Run through the proxy" }];
      const launch = (model?: string) => host.client.materializeDirectoryLaunchpad({ directoryKey: draft.directoryKey,
        launchpad: { ...draft, model }, input });
      const { backends } = await vi.waitFor(async () => {
        const response = await host.client.listBackends();
        expect(response.backends.find(backend => backend.kind === "codex")?.available).toBe(true);
        return response;
      });
      // The static catalog is the oracle for what the owner can offer or run.
      expect(buildProviderPickerEntries(backends).map(entry => [entry.value, entry.models.map(model => model.id)]))
        .toEqual([["codex-provider:empty-proxy", []], ["codex-provider:proxy", ["@proxy/proxy-model"]]]);
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
      expect(effectCalls()).toHaveLength(2);
    } finally {
      await host.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
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
