import { parseCodexProviderModelId, type CodexModelProviderSettings } from "@pwragent/shared";
import type { CodexAppServerClient } from "./client";

type Route = "primary" | "thread" | "threadId" | "model" | "subscribe" | "all" | "provider";
// Exhaustive: adding a public client operation requires choosing its runtime ownership.
const ROUTES: Record<keyof CodexAppServerClient, Route> = {
  close: "all",
  getAppServerRestartStatus: "primary",
  onAppServerRestartStatusChanged: "primary",
  onAppServerUnexpectedExit: "subscribe",
  restartAppServer: "all",
  resetAppServerRestarts: "all",
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
  readCodexHome: "primary",
  trustProject: "primary",
  invalidateThreadListings: "all",
  listThreads: "primary",
  listNativeSubAgentThreads: "primary",
  listThreadsForMigration: "primary",
  readArchiveCleanupThreadSummary: "threadId",
  listArchiveCleanupThreadsPage: "primary",
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
  readThreadPricingSnapshot: "threadId",
  readThreadTurn: "thread",
  readThreadActivity: "thread",
  readThreadName: "threadId",
  readThreadSummary: "threadId",
  listBackgroundTerminals: "threadId",
  terminateBackgroundTerminal: "threadId",
  readThread: "thread",
  readThreadModelSettings: "thread",
  exportThreadForHandoff: "threadId",
  prepareFreshNativeVoiceThread: "thread",
  refreshThreadTools: "thread",
  resumeNativeVoiceThread: "thread",
  injectThreadItems: "thread",
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

type Method = keyof CodexAppServerClient;
type Callback = (...args: unknown[]) => unknown;
type Subscription = { method: Method; args: unknown[]; stops: Map<CodexAppServerClient, () => void> };
const READ_ONLY = new Set<Method>([
  "readArchiveCleanupThreadSummary", "readThreadPricingSnapshot", "readThreadTurn", "readThreadActivity",
  "readThreadName", "readThreadSummary", "readThread", "readThreadModelSettings", "exportThreadForHandoff",
  "listBackgroundTerminals",
]);

/** Independent clients own their processes, caches, turn state, recovery and RPC IDs. */
export function createProviderRuntimeClient(
  primary: CodexAppServerClient,
  options: {
    resolveProviders: () => readonly CodexModelProviderSettings[];
    create: (provider: CodexModelProviderSettings) => CodexAppServerClient;
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
  const observe = (value: unknown, runtimeProvider?: string): void => {
    const fields = record(value);
    if (!fields) return;
    const thread = record(fields.thread);
    const id = typeof fields.threadId === "string" ? fields.threadId : thread?.id;
    if (typeof id === "string") owners.set(id, runtimeProvider ?? providerForThread(id));
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
    }] : subscription.method === "onAppServerUnexpectedExit" ? [() => {
      const affected = new Set([...owners].filter(([, owner]) =>
        provider ? owner === provider : !owner || !runtimes.has(owner)).map(([id]) => id));
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
  const runtime = (providerId: string | undefined): CodexAppServerClient => {
    // Settings changes defer shutdown while turns are active; their owner stays live.
    const existing = providerId ? runtimes.get(providerId) : undefined;
    if (existing) return existing;
    const provider = options.resolveProviders().find((entry) => entry.id === providerId);
    if (provider?.compatibility !== "bonsai") return primary;
    const client = options.create(provider);
    runtimes.set(provider.id, client);
    attach(client, provider.id);
    for (const subscription of subscriptions) subscribe(subscription, client, provider.id);
    return client;
  };
  const dispatch = async (method: Method, route: Route, args: unknown[]): Promise<unknown> => {
    const startedAtGeneration = generation;
    const params = record(args[0]);
    const threadId = route === "threadId" ? args[0] : params?.threadId;
    let owner: string | undefined;
    if (typeof threadId === "string") {
      if (!owners.has(threadId)) {
        await primary.readThreadSummary(threadId);
        owners.set(threadId, primary.modelProviderForThread(threadId));
      }
      owner = providerForThread(threadId);
    }
    const requested = typeof params?.model === "string" ? parseCodexProviderModelId(params.model).providerId : undefined;
    if (typeof threadId === "string" && requested && requested !== owner && method !== "forkThread") {
      throw new Error(`This thread runs on ${owner ?? "Codex's default provider"}. Hand it off to a new thread to change providers.`);
    }
    if (generation !== startedAtGeneration) throw new Error("Codex runtime pool closed during routing.");
    const provider = method === "forkThread" ? requested ?? owner : owner ?? requested;
    // Persisted history remains readable when the local inference server is offline.
    const client = provider && READ_ONLY.has(method) && !runtimes.has(provider) ? primary : runtime(provider);
    const result = await invoke(client, method, args);
    observe(result, client === primary ? undefined : provider);
    return result;
  };
  attach(primary);
  return new Proxy(primary, {
    get(target, property) {
      if (typeof property !== "string" || !Object.hasOwn(ROUTES, property)
        || typeof Reflect.get(target, property, target) !== "function") return Reflect.get(target, property, target);
      const method = property as Method;
      const route = ROUTES[method];
      if (route === "provider") return providerForThread;
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

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
