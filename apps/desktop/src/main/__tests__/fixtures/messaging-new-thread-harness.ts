import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import type {
  NavigationDirectorySummary,
  NavigationLaunchpadDraft,
} from "@pwragent/shared/contracts/navigation";
import type { MessagingJsonValue, MessagingSurfaceIntent } from "@pwragent/messaging-interface";
import type { MessagingBackendBridge } from "../../messaging/core/messaging-adapter";
import { NavigationQueryStore } from "../../app-server/navigation-query-store";
import { messagingInboundHarness } from "./messaging-inbound-harness";

// The actual controller, query owner and SQLite store handle the protocol.
// Only provider transport and backend API responses use contrived data.
export async function messagingNewThreadHarness(options: { channel?: "telegram" | "discord"; maxActions?: number; branches?: number; clock?: () => number; dbPath?: string } = {}) {
  const real = await messagingInboundHarness({ ...options, route: "unbound" });
  const requests: Array<Parameters<NonNullable<MessagingBackendBridge["materializeDirectoryLaunchpad"]>>[0]> = [];
  const sticky: Array<Parameters<NonNullable<MessagingBackendBridge["updateDirectoryLaunchpad"]>>[0]> = [];
  const trace: string[] = [];
  const controls = { providers: ["codex", "claude"] as AppServerBackendKind[], unavailable: undefined as AppServerBackendKind | undefined,
    failDiscovery: false, failSticky: false, failCreate: false };
  const hooks: { create?: () => Promise<void>; deliver?: (intent: MessagingSurfaceIntent) => Promise<void> } = {};
  const branches = Array.from({ length: options.branches ?? 3 }, (_, index) => index === 0 ? "main" : `fixture-${index}`);
  const directory: NavigationDirectorySummary = { key: "fixture-project", kind: "directory", label: "Fixture project", path: "/fixture/project",
    threadKeys: [], needsAttentionCount: 0, gitStatus: { currentBranch: "main", defaultBranch: "main", branches, baseBranches: ["main"] } };
  const launchpad: NavigationLaunchpadDraft = { directoryKey: directory.key, directoryKind: directory.kind, directoryLabel: directory.label,
    directoryPath: directory.path, backend: "codex", executionMode: "default", workMode: "local", prompt: "", createdAt: 1_000, updatedAt: 1_000 };
  const query = new NavigationQueryStore();
  const summary = (kind: AppServerBackendKind): BackendSummary => ({ kind, label: kind, available: controls.unavailable !== kind,
    methods: [], capabilities: { listThreads: true, createThread: true, resumeThread: true, renameThread: true, readThread: true,
      startTurn: true, interruptTurn: true, steerTurn: true, transcriptPagination: false, toolUse: true, approvalRequests: true, multiDirectoryThreads: true },
    executionModes: [{ mode: "default", label: "Default", available: true, isDefault: true },
      { mode: "auto", label: "Auto", available: true }, { mode: "full-access", label: "Full Access", available: true }],
    launchpadOptions: { models: [0, 1].map(index => ({ id: `${kind}-${index}`, label: `${kind} model ${index}`, supportsReasoning: true,
      supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "low" })), reasoningEfforts: ["low", "high"], supportsFastMode: kind === "codex" },
  });
  const backend: MessagingBackendBridge = {
    ...real.backend,
    listBackends: async function () { if (this !== backend) throw new Error("Fixture list receiver lost");
      if (controls.failDiscovery) throw new Error("Fixture discovery failed");
      return { fetchedAt: 1_000, backends: controls.providers.map(summary) }; },
    getNavigationQueryPage: request => query.readPage({ request, scopeKey: "new-thread-fixture", loadIndex: async () => ({ threads: [], directories: [directory] }) }),
    getNavigationLaunchpadConfig: async request => ({ protocol: 2, revision: "fixture", defaults: { backend: "codex", executionMode: "default" },
      directoryKey: request.directoryKey, ...(request.directoryKey ? { launchpad, directoryGitStatus: directory.gitStatus } : {}) }),
    ensureDirectoryLaunchpad: async request => ({ defaults: { backend: "codex", executionMode: "default" },
      launchpad: { ...launchpad, backend: request.preferredBackend ?? launchpad.backend } }),
    updateDirectoryLaunchpad: async function (request) {
      if (this !== backend) throw new Error("Fixture sticky receiver lost");
      sticky.push(request); trace.push("sticky:issued");
      if (controls.failSticky) throw new Error("Fixture sticky unavailable");
      // This fixture deliberately returns stable desktop defaults. Pending
      // choices must survive through the durable browse session itself.
      return { defaults: { backend: "codex", executionMode: "default" }, launchpad };
    },
    materializeDirectoryLaunchpad: async function (request) {
      if (this !== backend) throw new Error("Fixture create receiver lost");
      requests.push(request); trace.push("create:issued"); await hooks.create?.();
      if (controls.failCreate) { trace.push("create:failed"); throw new Error("Fixture creation refused"); }
      trace.push("create:accepted");
      return { backend: request.launchpad?.backend ?? "codex", threadId: "fixture-created", turnId: "fixture-created-turn",
        executionMode: request.launchpad?.executionMode ?? "default", workMode: request.launchpad?.workMode ?? "local" };
    },
  };
  real.controllerOptions.backend = backend;
  real.controllerOptions.store = new Proxy(real.store, { get(target, property) {
    if (property === "upsertBinding") return async (...args: Parameters<typeof target.upsertBinding>) => {
      trace.push("binding:write"); return target.upsertBinding(...args);
    };
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const deliver = real.controllerOptions.adapter.deliver.bind(real.controllerOptions.adapter);
  real.controllerOptions.adapter.deliver = async intent => { await hooks.deliver?.(intent); trace.push(`deliver:${intent.kind}`); return deliver(intent); };
  const session = () => real.store.findActiveBrowseSessionForChannel({ channel: real.channel, actorId: "fixture-actor", now: 1_000 });
  const click = async (actionId: string, value?: MessagingJsonValue) => real.controller.handleInboundEvent({ ...real.event(), kind: "callback", actionId, value,
    sourceSurface: (await session())?.surface, interaction: { channel: real.channel.channel, id: "fixture-interaction" } });
  const command = (command = "new", args: string[] = []) => real.controller.handleInboundEvent({ ...real.event(), kind: "command", command, args, rawText: `/${command} ${args.join(" ")}` });
  const latest = () => real.deliveries.at(-1)!;
  const choose = async (actionId: string, field: string, value: string) => {
    const intent = latest();
    if (!("actions" in intent) || !intent.actions) throw new Error("Fixture expected a choice surface");
    const action = intent.actions.find(action => action.id === actionId && action.value && typeof action.value === "object"
      && !Array.isArray(action.value) && action.value[field] === value);
    if (!action) throw new Error(`Fixture expected offered choice ${actionId}:${value}`);
    await click(action.id, action.value);
  };
  return { ...real, backend, controls, hooks, requests, sticky, trace, session, command, click, choose, latest, branches, directory,
    open: async () => { await command(); await click("browse:select-project", { directoryKey: directory.key, path: directory.path!, label: directory.label }); },
    send: (text = "Fixture first prompt") => real.controller.handleInboundEvent(real.event(text)),
  };
}
