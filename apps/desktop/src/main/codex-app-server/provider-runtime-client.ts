import {
  parseCodexProviderModelId,
  type CodexModelProviderSettings,
} from "@pwragent/shared/codex-model-providers";
import { assertOutpostCodexProvider } from "../owner-runtime-policy";
import type { CodexAppServerClient } from "./desktop-client";
import {
  combineCodexAppServerRolloverOutcomes,
  type CodexAppServerRolloverOutcome,
} from "@pwragent/owner-core/codex-app-server/app-server-installation";

export type CodexClientRoute =
  "primary" | "thread" | "threadId" | "model" | "subscribe" | "all" | "provider" | "reportedProvider";
type Route = CodexClientRoute;
// Exhaustive: adding a public client operation requires choosing its runtime ownership.
// The app server generation pool routes by the same table.
export const CODEX_CLIENT_ROUTES: Record<keyof CodexAppServerClient, Route> = {
  close: "all",
  getAppServerRestartStatus: "primary",
  onAppServerRestartStatusChanged: "primary",
  onAppServerUnexpectedExit: "subscribe",
  restartAppServer: "all",
  resetAppServerRestarts: "all",
  readAppServerProcessSample: "primary",
  getAppServerRecycleStatus: "primary",
  // A generation pool's own lifecycle; each runtime has one.
  readAppServerExecutable: "primary",
  hasAppServerProcess: "primary",
  threadDependsOnAppServer: "primary",
  releaseThread: "primary",
  retireAppServerWhenIdle: "primary",
  // Each runtime owns a process; each decides from its own sample.
  maybeRecycleIdleAppServer: "all",
  getSubscribedThreadCount: "primary",
  // Each runtime keeps its own threads loaded and releases its own.
  unsubscribeIdleThreads: "all",
  recoverInvalidPersistedResponseMessageIds: "thread",
  onRealtimeEvent: "subscribe",
  onRealtimeDisconnect: "subscribe",
  startRealtime: "thread",
  stopRealtime: "threadId",
  appendRealtimeText: "threadId",
  onNotification: "subscribe",
  onRequest: "subscribe",
  getInitializeResult: "primary",
  isTokenMiserActivationNegotiated: "primary",
  readServerCapabilities: "primary",
  readThreadGoal: "thread",
  setThreadGoal: "thread",
  clearThreadGoal: "thread",
  readCodexHome: "primary",
  trustProject: "primary",
  invalidateThreadListings: "all",
  listThreads: "primary",
  listNativeSubAgentThreads: "primary",
  listThreadsForMigration: "primary",
  listRecentThreadDirectories: "primary",
  readArchiveCleanupThreadSummary: "threadId",
  listArchiveCleanupThreadsPage: "primary",
  archiveCleanupRecencyReads: "primary",
  enrichArchiveCleanupThreads: "primary",
  enrichThreadDirectories: "primary",
  listSkills: "primary",
  listMcpServers: "thread",
  reloadMcpConfig: "all",
  startMcpServerOAuthLogin: "primary",
  removeMcpServer: "all",
  resolveHelperModelSelection: "model",
  listModels: "primary",
  readAccount: "primary",
  readRateLimits: "primary",
  readAccountUsage: "primary",
  modelProviderForThread: "provider",
  reportedModelProviderForThread: "reportedProvider",
  readThreadPricingSnapshot: "threadId",
  readThreadTurn: "thread",
  readThreadToolInvocation: "thread",
  readTurnRoot: "thread",
  readThreadActivity: "thread",
  readThreadName: "threadId",
  readThreadSummary: "threadId",
  listBackgroundTerminals: "threadId",
  terminateBackgroundTerminal: "threadId",
  readThread: "thread",
  readThreadProtocolResult: "thread",
  readThreadModelSettings: "thread",
  exportThreadForHandoff: "threadId",
  prepareFreshNativeVoiceThread: "thread",
  refreshThreadTools: "thread",
  resumeNativeVoiceThread: "thread",
  injectThreadItems: "thread",
  // Each runtime resumes its own threads, including one started later.
  provideThreadDeveloperInstructions: "subscribe",
  provideThreadSkillExclusions: "subscribe",
  replaceThreadDeveloperInstructions: "thread",
  startThread: "model",
  forkThread: "thread",
  startTurn: "thread",
  generateTitle: "model",
  generateStructuredObject: "model",
  runHelperToolTurn: "model",
  readConfiguredMcpServerNames: "primary",
  startReview: "thread",
  setTurnApprovalReviewer: "thread",
  setThreadPermissions: "thread",
  archiveThread: "thread",
  retireReviewThread: "thread",
  deleteThread: "thread",
  restoreThread: "thread",
  renameThread: "thread",
  updateThreadMetadata: "thread",
  updateThreadWorkspace: "thread",
  interruptTurn: "thread",
  revertThread: "thread",
  compactThread: "thread",
  steerTurn: "thread",
  isAuthenticationRequired: "primary",
};
const ROUTES = CODEX_CLIENT_ROUTES;

type Method = keyof CodexAppServerClient;
type Callback = (...args: unknown[]) => unknown;
type Subscription = { method: Method; args: unknown[]; stops: Map<CodexAppServerClient, () => void> };
// Persisted reads and direct history edits do not need an inference catalog.
// A live provider runtime still owns these operations once it exists.
const PERSISTED_OPERATIONS = new Set<Method>([
  "readArchiveCleanupThreadSummary", "readThreadPricingSnapshot", "readThreadTurn", "readThreadActivity",
  "readThreadName", "readThreadSummary", "readThread", "readThreadProtocolResult", "readThreadModelSettings", "exportThreadForHandoff",
  "listBackgroundTerminals",
  "readThreadToolInvocation", "readTurnRoot",
  "readThreadGoal", "setThreadGoal", "clearThreadGoal",
  "archiveThread", "renameThread", "restoreThread", "deleteThread", "updateThreadMetadata",
]);
const PROVIDER_WORK = new Set<Method>([
  "startThread", "forkThread", "startTurn", "steerTurn", "startReview", "compactThread",
  "startRealtime", "appendRealtimeText", "runHelperToolTurn",
]);

/** Independent clients own their processes, caches, turn state, recovery and RPC IDs. */
export function createProviderRuntimeClient(
  primary: CodexAppServerClient,
  options: {
    resolveProviders: () => readonly CodexModelProviderSettings[];
    create: (provider: CodexModelProviderSettings) => CodexAppServerClient;
    openAiProviderEnabled?: boolean;
  },
): CodexAppServerClient {
  const runtimes = new Map<string, CodexAppServerClient>();
  const owners = new Map<string, string | undefined>();
  const subscriptions = new Set<Subscription>();
  let generation = 0;

  const invoke = (client: CodexAppServerClient, method: Method, args: unknown[]): unknown =>
    (client[method] as Callback).apply(client, args);
  const providerForThread = (threadId: string): string | undefined => {
    if (owners.has(threadId)) return owners.get(threadId);
    return primary.modelProviderForThread?.(threadId)
      ?? [...runtimes.values()].map((client) => client.modelProviderForThread?.(threadId)).find(Boolean);
  };
  // A runtime's threads run on its provider; the rest are as Codex reported.
  const reportedProviderForThread = (threadId: string): string | undefined =>
    owners.get(threadId)
      ?? primary.reportedModelProviderForThread?.(threadId)
      ?? [...runtimes.values()].map((client) => client.reportedModelProviderForThread?.(threadId)).find(Boolean);
  const observe = (value: unknown, runtimeProvider?: string): void => {
    const id = threadIdOf(value);
    if (id) owners.set(id, runtimeProvider ?? providerForThread(id));
  };
  const attach = (client: CodexAppServerClient, provider?: string): void => {
    client.onNotification((notification) => observe(notification.params, provider));
  };
  const subscribe = (subscription: Subscription, client: CodexAppServerClient, provider?: string): void => {
    const callback = subscription.args[0] as Callback;
    const realtime = subscription.method === "onRealtimeEvent" || subscription.method === "onRealtimeDisconnect";
    const args = realtime ? [(...values: unknown[]) => {
      const threadId = subscription.args[1];
      if (typeof threadId === "string") {
        const owner = providerForThread(threadId);
        if ((owner ? runtimes.get(owner) : undefined) !== (client === primary ? undefined : client)) return;
      }
      return callback(...values);
    }] : subscription.method === "onAppServerUnexpectedExit" ? [(threadIds?: ReadonlySet<string>) => {
      const ownedHere = (owner: string | undefined): boolean =>
        provider ? owner === provider : !owner || !runtimes.has(owner);
      // A generation pool names the threads of the one process that exited.
      const affected = threadIds
        ? new Set([...threadIds].filter((id) => ownedHere(owners.get(id))))
        : new Set([...owners].filter(([, owner]) => ownedHere(owner)).map(([id]) => id));
      return callback(affected);
    }] : subscription.method === "onRequest" && provider ? [(value: unknown) => {
      const request = record(value);
      const params = record(request?.params);
      return callback(request && params ? {
        ...request,
        params: { ...params, requestId: `${provider}:${params.requestId}` },
      } : value);
    }] : subscription.args;
    subscription.stops.set(client, invoke(client, subscription.method, args) as () => void);
  };
  const runtime = (providerId: string | undefined, selectedModel?: string): CodexAppServerClient => {
    // Settings changes defer shutdown while turns are active; their owner stays live.
    const existing = providerId ? runtimes.get(providerId) : undefined;
    if (existing) return existing;
    const provider = options.resolveProviders().find((entry) => entry.id === providerId);
    if (!provider) return primary;
    const selected = selectedModel && !provider.models?.includes(selectedModel)
      && !provider.modelMetadata?.some((model) => model.id === selectedModel)
      ? { ...provider, models: [...(provider.models ?? []), selectedModel] } : provider;
    const client = options.create(selected);
    runtimes.set(provider.id, client);
    attach(client, provider.id);
    for (const subscription of subscriptions) subscribe(subscription, client, provider.id);
    return client;
  };
  const dispatch = async (method: Method, route: Route, args: unknown[]): Promise<unknown> => {
    const startedAtGeneration = generation;
    const params = record(args[0]);
    const threadId = route === "threadId" ? args[0] : params?.threadId;
    const selection = typeof params?.model === "string" ? parseCodexProviderModelId(params.model) : undefined;
    const openAiDisabled = options.openAiProviderEnabled === false;
    if (openAiDisabled && (method === "generateTitle" || method === "generateStructuredObject" || method === "resolveHelperModelSelection")
      && !options.resolveProviders().some((provider) => provider.id === selection?.providerId)) {
      return method === "resolveHelperModelSelection" ? { source: "backend_current", verified: false }
        : { status: "unavailable", reason: "codex_structured_generation_unavailable" };
    }
    const restricted = openAiDisabled && PROVIDER_WORK.has(method);
    if (restricted && selection) assertOutpostCodexProvider(selection.providerId);
    // A fork from a rollout path reads its history from that file. A thread
    // handoff passes another machine's thread ID, which this App Server has
    // never stored, so reading it here fails with "thread not loaded".
    const forksFromPath = method === "forkThread"
      && typeof params?.path === "string"
      && params.path.trim() !== "";
    let owner: string | undefined;
    if (typeof threadId === "string") {
      if (!owners.has(threadId) && !forksFromPath) {
        await primary.readThreadSummary(threadId);
        owners.set(threadId, primary.modelProviderForThread(threadId));
      }
      owner = providerForThread(threadId);
    }
    const requested = selection?.providerId;
    if (typeof threadId === "string" && requested && requested !== owner && method !== "forkThread") {
      throw new Error(`This thread runs on ${owner ?? "Codex's default provider"}. Hand it off to a new thread to change providers.`);
    }
    if (generation !== startedAtGeneration) throw new Error("Codex runtime pool closed during routing.");
    const provider = method === "forkThread" ? requested ?? owner : owner ?? requested;
    const settings = options.resolveProviders().find(entry => entry.id === provider);
    const exactProviderModel = method === "generateStructuredObject" && params?.requireExactModel === true && requested;
    if (exactProviderModel && !settings) return { status: "unavailable", reason: "configured_helper_provider_unavailable" };
    if (restricted) {
      assertOutpostCodexProvider(provider);
      if (!settings) throw new Error(`Codex model provider ${provider} is no longer configured on this Outpost.`);
    }
    const selectedModel = selection?.model;
    if (settings?.toolDiscovery === "portable" && selectedModel && !PERSISTED_OPERATIONS.has(method)
      && !settings.modelMetadata?.some(model => model.id === selectedModel && model.supportsPortableDiscovery === true)) {
      throw new Error(`Test portable discovery for ${selectedModel} in Settings → Models and save before using it.`);
    }
    // Persisted history remains manageable when the inference server is offline.
    const client = provider && PERSISTED_OPERATIONS.has(method) && !runtimes.has(provider) ? primary : runtime(provider, selectedModel);
    // The qualifier selects the runtime. Its own model catalog contains upstream IDs.
    const result = await invoke(client, method, exactProviderModel ? [{ ...params, model: selectedModel }, ...args.slice(1)] : args);
    observe(result, client === primary ? undefined : provider);
    return result;
  };
  attach(primary);
  return new Proxy(primary, {
    get(target, property) {
      // A selection change moves every runtime's new work onto the selected
      // Codex (`app-server-generation-pool.ts`); it is applied once all have.
      if (property === "rolloverAppServer") {
        if (typeof Reflect.get(target, property, target) !== "function") return undefined;
        return async (params: { selection: number }): Promise<CodexAppServerRolloverOutcome> => {
          const outcomes = await Promise.all([primary, ...runtimes.values()].map((client) => {
            const rollover = Reflect.get(client, property, client) as
              | ((params: { selection: number }) => Promise<CodexAppServerRolloverOutcome>)
              | undefined;
            return rollover ? rollover.call(client, params) : Promise.resolve<CodexAppServerRolloverOutcome>({ kind: "current" });
          }));
          return combineCodexAppServerRolloverOutcomes(outcomes);
        };
      }
      if (typeof property !== "string" || !Object.hasOwn(ROUTES, property)
        || typeof Reflect.get(target, property, target) !== "function") return Reflect.get(target, property, target);
      const method = property as Method;
      const route = ROUTES[method];
      if (route === "provider") return providerForThread;
      if (route === "reportedProvider") return reportedProviderForThread;
      if (route === "subscribe") return (...args: unknown[]) => {
        const subscription: Subscription = { method, args, stops: new Map() };
        subscriptions.add(subscription);
        subscribe(subscription, primary);
        for (const [provider, client] of runtimes) subscribe(subscription, client, provider);
        return () => {
          subscriptions.delete(subscription);
          for (const stop of subscription.stops.values()) stop();
        };
      };
      if (route === "all") return (...args: unknown[]) => {
        const clients = [primary, ...runtimes.values()];
        if (method === "close") {
          generation += 1;
          runtimes.clear();
          owners.clear();
          for (const subscription of subscriptions) {
            for (const [client, stop] of subscription.stops) {
              if (client !== primary) { stop(); subscription.stops.delete(client); }
            }
          }
        }
        const results = clients.map((client) => invoke(client, method, args));
        if (method === "resetAppServerRestarts" || method === "invalidateThreadListings") return;
        return Promise.allSettled(results).then((settled) => {
          const failed = settled.find((result) => result.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
        });
      };
      if (route === "primary") return (...args: unknown[]) => invoke(primary, method, args);
      return (...args: unknown[]) => dispatch(method, route, args);
    },
  });
}

/** The thread a notification, request or result names, as `threadId` or `thread.id`. */
export function threadIdOf(value: unknown): string | undefined {
  const fields = record(value);
  const id = fields?.threadId ?? record(fields?.thread)?.id;
  return typeof id === "string" ? id : undefined;
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
