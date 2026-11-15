import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
  buildProviderPickerEntries,
  formatCodexProviderModelId,
  type BackendModelOption,
  type BackendSummary,
  type CodexModelProviderSettings,
  type FederationProtocolEnvelope,
  type ListBackendsResponse,
} from "@pwragent/shared";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import {
  FEDERATION_BACKEND_METHOD_CAPABILITIES,
  FEDERATION_BACKEND_METHODS,
  registerFederationBackendHandlers,
  type FederationBackendOperations,
} from "../federation/federation-backend-bridge";
import { FederationRouter } from "../federation/federation-router";
import { DesktopConfigStore } from "../settings/config-store/desktop-config-store";
import { issueProviderDiscoveryPermit } from "../settings/provider-discovery-permit";

/**
 * Rule: once Settings saves the Codex model provider list, every surface that
 * reads the owner's backend summary, the new-thread provider picker and a
 * federation peer's `listBackends`, offers exactly the configured providers,
 * each with its listed models plus whatever its endpoint returned, beside
 * Codex's own models. No discovery, restart or app relaunch is needed.
 *
 * Oracle: the config owner. `DesktopConfigStore` holds the saved provider
 * list, and the fixture endpoint says which models a reachable provider has.
 */

const OPENAI_MODEL: BackendModelOption = { id: "gpt-5.4", label: "GPT-5.4", supportsReasoning: true };
const ENDPOINT_MODELS = ["mathos-coder", "mathos-prover"];

type ProviderDraft = {
  id: "mathos" | "bonsai";
  models: string[];
  discoverModels: boolean;
  port: number;
};

type Operation =
  /** `settle: false` saves again before the previous save is published. */
  | { kind: "save"; providers: ProviderDraft[]; settle: boolean }
  /** Settings' Refresh starts a Codex discovery that overlaps what follows. */
  | { kind: "discover" }
  | { kind: "endpoint"; up: boolean }
  | { kind: "codexList"; up: boolean };

const providerDraft = (id: ProviderDraft["id"]): fc.Arbitrary<ProviderDraft> => fc.record({
  id: fc.constant(id),
  models: fc.uniqueArray(fc.constantFrom<string>("fixture", "fixture-2", "mathos-coder"), { maxLength: 2 }),
  discoverModels: fc.boolean(),
  port: fc.constantFrom(18080, 18081),
});

const operation: fc.Arbitrary<Operation> = fc.oneof(
  { weight: 4, arbitrary: fc.record({
    kind: fc.constant("save" as const),
    providers: fc.tuple(fc.option(providerDraft("mathos"), { nil: undefined }), fc.option(providerDraft("bonsai"), { nil: undefined }))
      .map(([mathos, bonsai]) => [mathos, bonsai].filter((draft): draft is ProviderDraft => draft !== undefined)),
    settle: fc.boolean(),
  }) },
  { weight: 1, arbitrary: fc.constant({ kind: "discover" as const }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("endpoint" as const), up: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("codexList" as const), up: fc.boolean() }) },
);

function toSettings(draft: ProviderDraft): CodexModelProviderSettings {
  return {
    id: draft.id,
    name: draft.id === "mathos" ? "MathOS" : "PrismML Bonsai",
    baseUrl: `http://127.0.0.1:${draft.port}/v1`,
    ...(draft.models.length ? { models: draft.models } : {}),
    ...(draft.discoverModels ? {} : { discoverModels: false }),
  };
}

/** What the owner must offer for a saved list, read from the config owner. */
function expectedProviderModels(params: {
  providers: readonly CodexModelProviderSettings[];
  endpointUp: boolean;
}): string[] {
  return params.providers.flatMap((provider) => {
    const listed = provider.models ?? [];
    const read = provider.discoverModels !== false && params.endpointUp ? ENDPOINT_MODELS : [];
    return [...new Set([...listed, ...read])].map((model) => formatCodexProviderModelId(provider.id, model));
  });
}

function pickerProviderModels(backends: readonly BackendSummary[]): { ids: string[]; providers: string[] } {
  const entries = buildProviderPickerEntries(backends).filter((entry) => entry.codexModelProviderId);
  return {
    ids: entries.flatMap((entry) => entry.models.map((model) => model.id)),
    providers: entries.map((entry) => entry.codexModelProviderId!),
  };
}

async function runScenario(params: {
  discoverFirst: boolean;
  /** A turn holds the running App Server, which must then not restart. */
  turnActive: boolean;
  operations: Operation[];
  /** Orders the endpoint and model list replies, so reads can land late. */
  scheduler?: fc.Scheduler;
}): Promise<void> {
  const { scheduler } = params;
  const reply = <T>(value: T, label: string): Promise<T> =>
    scheduler ? scheduler.schedule(Promise.resolve(value), label) : Promise.resolve(value);
  const drive = async <T>(work: Promise<T>): Promise<T> => scheduler ? await scheduler.waitFor(work) : await work;
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pwragent-provider-publication-"));
  const configPath = path.join(tempRoot, "config.toml");
  await writeFile(configPath, "");
  const configStore = new DesktopConfigStore({ configPath });
  configStore.recordProviderDiscovery("codex", {
    candidates: [],
    selectedCommand: "/opt/pwragent/codex",
    selectedVersion: "0.162.1",
  });
  const configuredProviders = (): CodexModelProviderSettings[] =>
    [...(configStore.read("models").codex?.providers ?? [])] as CodexModelProviderSettings[];
  let endpointUp = true;
  let codexListUp = true;
  // Each reply is what the endpoint said when it was asked.
  const providerFetch = vi.fn(async () => await reply(endpointUp
    ? new Response(JSON.stringify({ data: ENDPOINT_MODELS.map((id) => ({ id })) }))
    : new Response(JSON.stringify({ error: { message: "maintenance" } }), { status: 503 }), "provider /models"));
  const closeCalls: number[] = [];
  const codexClient = {
    close: async () => { closeCalls.push(Date.now()); },
    onNotification: () => () => undefined,
    onPendingRequest: () => () => undefined,
    getInitializeResult: async () => ({ methods: ["thread/start"], userAgent: "codex/0.162.1" }),
    listModels: async () => {
      const up = codexListUp;
      await reply(undefined, "codex model/list");
      if (!up) throw new Error("model/list failed");
      return [OPENAI_MODEL];
    },
  };
  const registry = createDesktopBackendRegistry({
    codexClient: codexClient as never,
    configStore,
    overlayStore: { listOverlays: async () => [] } as never,
    discoverLocalAcpAgents: async () => [],
    isBootstrapMode: () => false,
    resolveCodexModelProviders: configuredProviders,
    resolveCodexModelProviderKeys: async () => ({}),
    codexModelProviderFetch: providerFetch,
  });
  if (params.turnActive) {
    (registry as unknown as { activeTurnKeys: Set<string> }).activeTurnKeys.add("codex:thread-1:turn-1");
  }
  const replies: FederationProtocolEnvelope[] = [];
  const router = new FederationRouter({ localInstanceId: "owner", methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES });
  router.registerConnection({ peerId: "viewer", capabilities: ["thread_detail"], sendEnvelope: (envelope) => { replies.push(envelope); } });
  registerFederationBackendHandlers({ router, backend: registry as unknown as FederationBackendOperations });
  let requestCount = 0;
  const federationBackends = async (): Promise<BackendSummary[]> => {
    const id = `list-${++requestCount}`;
    await router.routeEnvelope({ sourcePeerId: "viewer", envelope: {
      id, method: FEDERATION_BACKEND_METHODS.listBackends, params: { includeUnavailable: true },
      kind: "request", protocolVersion: 1, sourceInstanceId: "viewer", targetInstanceId: "owner", createdAt: 100,
    } });
    const response = replies.find((envelope) => "requestId" in envelope && envelope.requestId === id) as { result?: ListBackendsResponse } | undefined;
    return response?.result?.backends ?? [];
  };
  try {
    if (params.discoverFirst) {
      await drive(registry.listBackends({ includeUnavailable: true, refreshModels: "codex" }, issueProviderDiscoveryPermit("settings-user-action")));
    }
    let pending: Promise<unknown>[] = [];
    let unsettledSave = false;
    // A save drops every provider read, so the next read sees the endpoint
    // as it is now. Without a save the catalog keeps its last read until its
    // retry, which this scenario never reaches.
    let endpointUpAtSave = endpointUp;
    let closesBefore = closeCalls.length;
    const settleAndCheck = async () => {
      await drive(Promise.all(pending));
      pending = [];
      unsettledSave = false;
      await drive(registry.settleCodexModelProviderPublication());
      // A turn in progress keeps its App Server; a launch change waits.
      if (params.turnActive) expect(closeCalls.length).toBe(closesBefore);
      closesBefore = closeCalls.length;
      const configured = configuredProviders();
      const expected = expectedProviderModels({ providers: configured, endpointUp: endpointUpAtSave });
      for (const [surface, backends] of [
        ["local", (await registry.listBackends({ includeUnavailable: true })).backends],
        ["federation", await federationBackends()],
      ] as const) {
        const codex = backends.find((backend) => backend.kind === "codex");
        const picker = pickerProviderModels(backends);
        expect({ surface, ids: picker.ids }).toEqual({ surface, ids: expected });
        expect({ surface, providers: picker.providers }).toEqual({ surface, providers: configured.map((provider) => provider.id) });
        expect({ surface, states: (codex?.codexModelProviders ?? []).map((state) => [state.id, state.status]) }).toEqual({
          surface,
          states: configured.map((provider) => [
            provider.id,
            provider.discoverModels === false ? "off" : endpointUpAtSave ? "ready" : "unavailable",
          ]),
        });
        // Codex's own entry keeps offering models beside the providers'.
        expect((codex?.launchpadOptions?.models ?? []).filter((model) => !model.providerId).length).toBeGreaterThan(0);
      }
    };
    for (const step of params.operations) {
      if (step.kind === "endpoint" || step.kind === "codexList") {
        // An endpoint's state is fixed while a read of it is outstanding.
        if (pending.length || unsettledSave) await settleAndCheck();
        if (step.kind === "endpoint") endpointUp = step.up;
        else codexListUp = step.up;
        continue;
      }
      if (step.kind === "discover") {
        // A failed Codex model read rejects the refresh; Settings shows it.
        pending.push(registry.listBackends(
          { includeUnavailable: true, refreshModels: "codex" },
          issueProviderDiscoveryPermit("settings-user-action"),
        ).catch(() => undefined));
        continue;
      }
      const save = async () => {
        await configStore.write({ models: { codex: { providers: step.providers.map(toSettings) } } }, ["models"]);
        endpointUpAtSave = endpointUp;
      };
      unsettledSave = true;
      if (step.settle) {
        await save();
        await settleAndCheck();
      } else if (scheduler) {
        // An unsettled save lands among the replies of earlier reads, in
        // the order the scheduler picks.
        pending.push(reply(undefined, "settings save").then(save));
      } else {
        await save();
      }
    }
    await settleAndCheck();
  } finally {
    await registry.close();
    configStore.dispose();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

describe("Codex model provider publication", () => {
  it("offers exactly the saved providers on every surface after each Settings save", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.boolean(),
        fc.array(operation, { minLength: 1, maxLength: 8 }),
        fc.scheduler(),
        async (discoverFirst, turnActive, operations, scheduler) => {
          await runScenario({ discoverFirst, turnActive, operations, scheduler });
        },
      ),
      { numRuns: 40 },
    );
  });

  it("shows a Bonsai provider saved after discovery without an explicit refresh", async () => {
    // The operator's report, shrunk: Codex discovered with no providers, then
    // Settings saves Bonsai with a listed model and discovery off.
    await runScenario({
      discoverFirst: true,
      turnActive: true,
      operations: [{ kind: "save", providers: [{ id: "bonsai", models: ["fixture"], discoverModels: false, port: 18080 }], settle: true }],
    });
  });

  it("removes a provider and keeps listed models when its endpoint and Codex's list fail", async () => {
    await runScenario({
      discoverFirst: true,
      turnActive: true,
      operations: [
        { kind: "save", providers: [
          { id: "mathos", models: [], discoverModels: true, port: 18080 },
          { id: "bonsai", models: ["fixture"], discoverModels: false, port: 18080 },
        ], settle: true },
        { kind: "endpoint", up: false },
        { kind: "codexList", up: false },
        { kind: "save", providers: [{ id: "mathos", models: ["fixture"], discoverModels: true, port: 18081 }], settle: true },
        { kind: "save", providers: [], settle: true },
      ],
    });
  });

  it("reads a provider's endpoint when Codex's own model list fails on a model-only edit", async () => {
    // Only the listed models change, so the Codex launch and its summary
    // stay; Codex's model list is read first and fails, which used to leave
    // the endpoint unread and the provider pending with its listed ids only.
    await runScenario({
      discoverFirst: true,
      turnActive: true,
      operations: [
        { kind: "save", providers: [{ id: "mathos", models: ["fixture"], discoverModels: true, port: 18080 }], settle: true },
        // Adding MathOS changed the launch; discover again to cache a summary.
        { kind: "discover" },
        { kind: "codexList", up: false },
        { kind: "save", providers: [{ id: "mathos", models: ["fixture-2"], discoverModels: true, port: 18080 }], settle: true },
      ],
    });
  });

  it("re-reads a provider whose endpoint was down at save time once it is back, without reading Codex", async () => {
    // A launch-changing save drops the summary, so the save reads only the
    // provider endpoints. A provider found down there must still be retried,
    // and the retry must not ask Codex for its model list: without a summary
    // there may be no App Server, and no discovery permit to start one.
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pwragent-provider-retry-"));
    const configPath = path.join(tempRoot, "config.toml");
    await writeFile(configPath, "");
    const configStore = new DesktopConfigStore({ configPath });
    configStore.recordProviderDiscovery("codex", { candidates: [], selectedCommand: "/opt/pwragent/codex", selectedVersion: "0.162.1" });
    let endpointUp = false;
    const providerFetch = vi.fn(async () => endpointUp
      ? new Response(JSON.stringify({ data: ENDPOINT_MODELS.map((id) => ({ id })) }))
      : new Response(JSON.stringify({ error: { message: "maintenance" } }), { status: 503 }));
    const listModels = vi.fn(async () => [OPENAI_MODEL]);
    const registry = createDesktopBackendRegistry({
      codexClient: {
        close: async () => undefined,
        onNotification: () => () => undefined,
        onPendingRequest: () => () => undefined,
        getInitializeResult: async () => ({ methods: ["thread/start"], userAgent: "codex/0.162.1" }),
        listModels,
      } as never,
      configStore,
      overlayStore: { listOverlays: async () => [] } as never,
      discoverLocalAcpAgents: async () => [],
      isBootstrapMode: () => false,
      resolveCodexModelProviders: () => [...(configStore.read("models").codex?.providers ?? [])] as CodexModelProviderSettings[],
      resolveCodexModelProviderKeys: async () => ({}),
      codexModelProviderFetch: providerFetch,
    });
    const notifications: string[] = [];
    registry.onEvent((event) => {
      if (event.notification.method === "backend/providerStatus/updated") notifications.push(event.notification.method);
    });
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({ localInstanceId: "owner", methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES });
    router.registerConnection({ peerId: "viewer", capabilities: ["thread_detail"], sendEnvelope: (envelope) => { replies.push(envelope); } });
    registerFederationBackendHandlers({ router, backend: registry as unknown as FederationBackendOperations });
    let requestCount = 0;
    const federationBackends = async (): Promise<BackendSummary[]> => {
      const id = `list-${++requestCount}`;
      await router.routeEnvelope({ sourcePeerId: "viewer", envelope: {
        id, method: FEDERATION_BACKEND_METHODS.listBackends, params: { includeUnavailable: true },
        kind: "request", protocolVersion: 1, sourceInstanceId: "viewer", targetInstanceId: "owner", createdAt: 100,
      } });
      const response = replies.find((envelope) => "requestId" in envelope && envelope.requestId === id) as { result?: ListBackendsResponse } | undefined;
      return response?.result?.backends ?? [];
    };
    const surfaces = async () => [
      ["local", (await registry.listBackends({ includeUnavailable: true })).backends],
      ["federation", await federationBackends()],
    ] as const;
    const mathosState = (backends: readonly BackendSummary[]) =>
      backends.find((backend) => backend.kind === "codex")?.codexModelProviders?.find((state) => state.id === "mathos")?.status;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await configStore.write({ models: { codex: { providers: [
        toSettings({ id: "mathos", models: ["fixture"], discoverModels: true, port: 18080 }),
      ] } } }, ["models"]);
      await registry.settleCodexModelProviderPublication();
      for (const [surface, backends] of await surfaces()) {
        expect({ surface, status: mathosState(backends) }).toEqual({ surface, status: "unavailable" });
        expect({ surface, ids: pickerProviderModels(backends).ids }).toEqual({ surface, ids: ["@mathos/fixture"] });
      }
      endpointUp = true;
      notifications.length = 0;
      await vi.advanceTimersByTimeAsync(70_000);
      for (const [surface, backends] of await surfaces()) {
        expect({ surface, status: mathosState(backends) }).toEqual({ surface, status: "ready" });
        expect({ surface, ids: pickerProviderModels(backends).ids }).toEqual({
          surface,
          ids: ["@mathos/fixture", "@mathos/mathos-coder", "@mathos/mathos-prover"],
        });
      }
      expect(notifications.length).toBeGreaterThan(0);
      expect(listModels).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await registry.close();
      configStore.dispose();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  describe("a read that began before a save lands after it", () => {
    type Gate = { resolve: () => void };
    async function gatedOwner() {
      const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pwragent-provider-late-read-"));
      const configPath = path.join(tempRoot, "config.toml");
      await writeFile(configPath, "");
      const configStore = new DesktopConfigStore({ configPath });
      configStore.recordProviderDiscovery("codex", { candidates: [], selectedCommand: "/opt/pwragent/codex", selectedVersion: "0.162.1" });
      const mathos = (models: string[]): CodexModelProviderSettings =>
        ({ id: "mathos", name: "MathOS", baseUrl: "http://127.0.0.1:18080/v1", models });
      await configStore.write({ models: { codex: { providers: [mathos(["old-listed"])] } } }, ["models"]);
      let gated = false;
      const gates: Gate[] = [];
      const fetchCalls: Array<() => void> = [];
      const fetchStarted = () => new Promise<void>((resolve) => { fetchCalls.push(resolve); });
      const providerFetch = vi.fn(async () => {
        fetchCalls.shift()?.();
        if (gated) await new Promise<void>((resolve) => { gates.push({ resolve }); });
        return new Response(JSON.stringify({ data: [{ id: "mathos-coder" }] }));
      });
      const registry = createDesktopBackendRegistry({
        codexClient: {
          close: async () => undefined,
          onNotification: () => () => undefined,
          onPendingRequest: () => () => undefined,
          getInitializeResult: async () => ({ methods: ["thread/start"], userAgent: "codex/0.162.1" }),
          listModels: async () => [OPENAI_MODEL],
        } as never,
        configStore,
        overlayStore: { listOverlays: async () => [] } as never,
        discoverLocalAcpAgents: async () => [],
        isBootstrapMode: () => false,
        resolveCodexModelProviders: () => [...(configStore.read("models").codex?.providers ?? [])] as CodexModelProviderSettings[],
        resolveCodexModelProviderKeys: async () => ({}),
        codexModelProviderFetch: providerFetch,
      });
      const providerModelIds = async () => pickerProviderModels((await registry.listBackends({ includeUnavailable: true })).backends).ids;
      return {
        registry,
        configStore,
        mathos,
        gate: () => { gated = true; },
        fetchStarted,
        gates,
        providerModelIds,
        dispose: async () => {
          await registry.close();
          configStore.dispose();
          await rm(tempRoot, { recursive: true, force: true });
        },
      };
    }

    it("does not let the first discovery publish the provider list it read before a save", async () => {
      const owner = await gatedOwner();
      try {
        owner.gate();
        const discoveryRead = owner.fetchStarted();
        const discovery = owner.registry.listBackends(
          { includeUnavailable: true, refreshModels: "codex" },
          issueProviderDiscoveryPermit("settings-user-action"),
        );
        await discoveryRead;
        const saveRead = owner.fetchStarted();
        await owner.configStore.write({ models: { codex: { providers: [owner.mathos(["new-listed"])] } } }, ["models"]);
        await saveRead;
        // The save's read answers first, then the discovery's older one.
        owner.gates[1]!.resolve();
        owner.gates[0]!.resolve();
        await discovery;
        await owner.registry.settleCodexModelProviderPublication();
        expect(await owner.providerModelIds()).toEqual(["@mathos/new-listed", "@mathos/mathos-coder"]);
      } finally {
        await owner.dispose();
      }
    });

    it("does not let a Settings Refresh publish the provider list it read before a save", async () => {
      const owner = await gatedOwner();
      try {
        await owner.registry.listBackends(
          { includeUnavailable: true, refreshModels: "codex" },
          issueProviderDiscoveryPermit("settings-user-action"),
        );
        owner.gate();
        const refreshRead = owner.fetchStarted();
        const refresh = owner.registry.constructionPorts().refreshCodexProviderCatalogs({ rereadProviders: true });
        await refreshRead;
        const saveRead = owner.fetchStarted();
        await owner.configStore.write({ models: { codex: { providers: [owner.mathos(["new-listed"])] } } }, ["models"]);
        await saveRead;
        owner.gates[1]!.resolve();
        await owner.registry.settleCodexModelProviderPublication();
        owner.gates[0]!.resolve();
        await refresh;
        expect(await owner.providerModelIds()).toEqual(["@mathos/new-listed", "@mathos/mathos-coder"]);
      } finally {
        await owner.dispose();
      }
    });
  });
});
