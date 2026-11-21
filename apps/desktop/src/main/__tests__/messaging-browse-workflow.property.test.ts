import { setImmediate } from "node:timers/promises";
import fc from "fast-check";
import { expect, it } from "vitest";
import { formatFederationPeerDisplayLabel, formatFederationPeerShortDisplayLabel } from "@pwragent/shared/contracts/federation";
import type { FederationCapability } from "@pwragent/shared/contracts/federation";
import type { NavigationQueryRequest, NavigationSnapshot } from "@pwragent/shared/contracts/navigation";
import type { MessagingChannelRef, MessagingInboundCommandEvent, MessagingSurfaceIntent } from "@pwragent/messaging-interface";
import { PERMISSIVE_CAPABILITY_PROFILE } from "@pwragent/messaging-interface/testing";
import { NavigationQueryStore } from "../app-server/navigation-query-store";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { MessagingBrowseWorkflow } from "../messaging/core/messaging-browse-workflow";
import { DesktopMessagingBackendBridge, type DesktopMessagingFederationBridge } from "../messaging/desktop-backend-bridge";

type Context = ConstructorParameters<typeof MessagingBrowseWorkflow>[0];

const channel: MessagingChannelRef = { channel: "telegram", conversation: { kind: "dm", id: "browse-conversation" } };

function command(name: "resume" | "agent"): MessagingInboundCommandEvent {
  return {
    id: "browse-command", kind: "command", receivedAt: 1_000, channel,
    actor: { platformUserId: "browse-actor" }, command: name, args: [], rawText: `/${name}`,
  };
}

function fixture(index: Pick<NavigationSnapshot, "threads" | "directories"> = { threads: [], directories: [] }) {
  const local = new NavigationQueryStore({ now: () => 1_000 });
  const peer = new NavigationQueryStore({ now: () => 1_000 });
  const requests: NavigationQueryRequest[] = [];
  const intents: MessagingSurfaceIntent[] = [];
  const effects: string[] = [];
  let sequence = 0;
  const backend: Context["backend"] = {
    async getNavigationLaunchpadConfig() {
      expect(this).toBe(backend);
      return { protocol: 2, revision: "fixture", defaults: { backend: "codex", executionMode: "default" } };
    },
    async listNavigationOwners() {
      return {
        owners: [{ label: "Local" }, { label: "Peer", target: { scope: "remote", instanceId: "browse-peer" } }],
        omitted: 0,
      };
    },
    async getNavigationQueryPage(request) {
      expect(this).toBe(backend);
      requests.push(request);
      const ownerId = request.federationTarget?.scope === "remote" ? request.federationTarget.instanceId : undefined;
      return (ownerId ? peer : local).readPage({ scopeKey: ownerId ?? "local", request, loadIndex: async () => index });
    },
  };
  const context = {
    backend,
    store: {
      async upsertBrowseSession(record) { effects.push("session"); return record; },
      async upsertPendingIntent(record) { effects.push("surface"); return record; },
      async deleteBrowseSession() { effects.push("delete-session"); },
      async deletePendingIntentsForChannel() { effects.push("delete-intents"); return []; },
    },
    capabilityProfile: PERMISSIVE_CAPABILITY_PROFILE,
    now: () => 1_000,
    pendingIntentTtlMs: 5_000,
    disposed: false,
    logger: {},
    async deliver(intent) {
      intents.push(intent);
      effects.push("deliver");
      return { channel: "telegram", outcome: "presented", deliveredAt: 1_000, surface: { channel: "telegram", id: intent.id } };
    },
    async storePendingIntent(intent) {
      effects.push("pending");
      return { id: intent.id, intent, allowedActorIds: ["browse-actor"], createdAt: 1_000, expiresAt: 6_000 };
    },
    newIntentId: (prefix) => `${prefix}:${++sequence}`,
    resolveNewThreadBackendForSession: async () => undefined,
    loadDefaultAgentBackendSummaries: async () => undefined,
    actorHasPermission: (_event, _permission): boolean => false,
    canResumeFullAccessThreads: async (): Promise<boolean> => false,
    deliverDefaultAgentCommandError: async () => { effects.push("error"); },
    clearPendingNewThreadPrompt: () => { effects.push("clear-prompt"); },
    clearPendingFullAccessNewThreadPrompt: () => { effects.push("clear-escalation"); },
  } satisfies Context;
  return { owner: new MessagingBrowseWorkflow(context), context, backend, requests, intents, effects };
}

type PickerPeer = { id: string; label: string; profileName?: string; shortLabel?: string };

async function expectPickerOwnerLabels(visible: PickerPeer[], expectedLabels: Record<string, string>, projects: boolean) {
  const f = fixture({
    threads: [{ id: "thread", source: "codex", title: "Investigate CPU profile", titleSource: "explicit",
      updatedAt: 1, linkedDirectories: [], inbox: { inInbox: false } }],
    directories: [{ key: "repo", kind: "directory", label: "Tools", threadKeys: ["codex:thread"], needsAttentionCount: 0 }],
  });
  const peers = visible.map((peer) => ({
    target: { scope: "remote" as const, instanceId: peer.id },
    label: formatFederationPeerDisplayLabel(peer),
    shortLabel: peer.shortLabel ? formatFederationPeerShortDisplayLabel(peer) : undefined,
    capabilities: ["messaging_route"] satisfies FederationCapability[],
  }));
  const federation = { connectedPeerTargets: () => peers } satisfies Pick<DesktopMessagingFederationBridge, "connectedPeerTargets">;
  const bridge = new DesktopMessagingBackendBridge({} as DesktopBackendRegistry, federation as DesktopMessagingFederationBridge);
  f.backend.listNavigationOwners = () => bridge.listNavigationOwners();
  f.context.actorHasPermission = (_event, permission) => permission === "federation.remote_control";

  await f.owner.presentResumeBrowser({ ...command("resume"), args: projects ? ["--projects"] : [] });

  const intent = f.intents.at(-1);
  const expectedKind = projects ? "project_picker" : "thread_picker";
  if (intent?.kind !== expectedKind) throw new Error(`Expected ${expectedKind}, received ${intent?.kind}`);
  const actions = intent.page.actions.filter(({ id }) => id === (projects ? "browse:select-project" : "browse:select-thread"));
  const expectedItem = projects ? "Tools (1)" : "Investigate CPU profile";
  const expectedValue = projects ? { directoryKey: "repo", label: "Tools" } : { backend: "codex", threadId: "thread" };
  // Each callback still identifies the owner of the row when several rows share a title.
  const labelsByOwner = new Map<string | undefined, string>(Object.entries(expectedLabels));
  labelsByOwner.set(undefined, "");
  expect(actions).toHaveLength(labelsByOwner.size);
  for (const [instanceId, label] of labelsByOwner) {
    const value = { ...expectedValue, ...(instanceId ? { federationInstanceId: instanceId } : {}) };
    const action = actions.find((candidate) => {
      const data = candidate.value as { federationInstanceId?: string } | undefined;
      return data?.federationInstanceId === instanceId;
    });
    expect(action?.value).toEqual(value);
    expect(action?.label.replace(/^\d+\. /, "")).toBe(label ? `[${label}] ${expectedItem}` : expectedItem);
    expect(intent.fallbackText).toContain(action!.label);
  }
}

function expectProfileLabels(shortName: string, projects: boolean) {
  return expectPickerOwnerLabels([
    { id: "main-instance", label: "Studio-MBP-M5-Max", profileName: "default", shortLabel: shortName },
    { id: "dev-instance", label: "Studio-MBP-M5-Max", profileName: "dev", shortLabel: shortName },
    { id: "older-instance", label: "Mac Mini", profileName: "default" },
  ], {
    "main-instance": shortName,
    "dev-instance": `${shortName} / dev`,
    "older-instance": "Mac Mini",
  }, projects);
}

it.each([false, true])("uses compact owner names in /resume actions and text (projects=%s)", async (projects) => {
  await fc.assert(fc.asyncProperty(fc.stringMatching(/^[A-Z]{1,8}$/), async (shortName) => {
    await expectProfileLabels(shortName, projects);
  }), { numRuns: 30 });
});

it("shows [A] for a remote default profile and [A / dev] for its sibling", async () => {
  await expectProfileLabels("A", false);
});

function expectCollidingLabels(shortName: string, hostname: string, projects: boolean) {
  return expectPickerOwnerLabels([
    { id: "hostname", label: hostname },
    { id: "studio", label: "Studio Tower", shortLabel: shortName },
    { id: "office", label: "Office Computer", shortLabel: "Studio Tower" },
    { id: "desk-one", label: "First Desk Computer", shortLabel: "Desk" },
    { id: "desk-two", label: "Second Desk Computer", shortLabel: "Desk" },
    { id: "laptop", label: "Portable MacBook", shortLabel: "Travel" },
  ], {
    hostname,
    studio: "Studio Tower",
    office: "Office Computer",
    "desk-one": "First Desk Computer",
    "desk-two": "Second Desk Computer",
    laptop: "Travel",
  }, projects);
}

it.each([false, true])("keeps colliding owner names distinct in /resume (projects=%s)", async (projects) => {
  await fc.assert(fc.asyncProperty(fc.stringMatching(/^Mini[A-Z]{0,5}$/), fc.boolean(), async (shortName, lowerCaseHost) => {
    await expectCollidingLabels(shortName, lowerCaseHost ? shortName.toLowerCase() : shortName, projects);
  }), { numRuns: 30 });
});

it("labels a machine nicknamed Mini by its full name when another machine is named Mini", async () => {
  await expectCollidingLabels("Mini", "Mini", false);
});

it("publishes only while the initiating conversation still owns the browse", async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom("resume" as const, "agent" as const),
    fc.constantFrom("same", "other", "dispose", "none"),
    async (name, action) => {
      const f = fixture();
      const ready = Promise.withResolvers<void>();
      const config = f.backend.getNavigationLaunchpadConfig!;
      f.backend.getNavigationLaunchpadConfig = async function (request) {
        await ready.promise;
        return config.call(this, request);
      };
      const event = command(name);
      const render = name === "resume" ? f.owner.presentResumeBrowser(event) : f.owner.presentAgentBrowser(event);
      if (action === "same") f.owner.cancelProgressiveBrowse(channel);
      if (action === "other") f.owner.cancelProgressiveBrowse({ ...channel, conversation: { ...channel.conversation, id: "other" } });
      if (action === "dispose") {
        f.owner.dispose();
      }
      ready.resolve();
      await render;
      await setImmediate();
      const cancelled = action === "same" || action === "dispose";
      expect(f.requests).toHaveLength(cancelled ? 0 : 1);
      expect(f.intents).toHaveLength(cancelled ? 0 : 1);
      expect(f.effects).toEqual(cancelled ? [] : ["session", "pending", "deliver", "session", "surface"]);
    },
  ), { numRuns: 30 });
});

it("queries only permitted owners and applies the Full Access filter to resume requests", async () => {
  await fc.assert(fc.asyncProperty(
    fc.boolean(), fc.boolean(), fc.constantFrom("resume" as const, "agent" as const, "default-agent" as const),
    async (remote, fullAccess, kind) => {
      const f = fixture();
      f.context.actorHasPermission = (_event, permission) => remote && permission === "federation.remote_control";
      f.context.canResumeFullAccessThreads = async () => fullAccess;
      if (kind === "default-agent") await f.owner.presentDefaultAgentAssignmentBrowser(command("agent"), "conversation");
      else if (kind === "agent") await f.owner.presentAgentBrowser(command("agent"));
      else await f.owner.presentResumeBrowser(command("resume"));

      expect(f.requests.map(request => request.federationTarget?.scope).sort()).toEqual(
        remote && kind !== "default-agent" ? ["remote", undefined] : [undefined],
      );
      expect(f.requests.map(request => request.query)).toEqual(f.requests.map(() => ({
        kind: "messaging-threads", filter: undefined, directoryKey: undefined,
        agentOnly: kind !== "resume",
        excludeFullAccess: kind !== "default-agent" && !fullAccess,
        ...(kind === "default-agent" ? { allowedBackends: ["codex"] } : {}),
      })));
    },
  ), { numRuns: 30 });
});

it("uses the store installed while the owner page was in flight", async () => {
  const f = fixture();
  const readStarted = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  const read = f.backend.getNavigationQueryPage!;
  f.backend.getNavigationQueryPage = async function (request) {
    readStarted.resolve();
    await ready.promise;
    return read.call(this, request);
  };
  const render = f.owner.presentResumeBrowser(command("resume"));
  await readStarted.promise;
  f.context.store = {
    ...f.context.store,
    async upsertBrowseSession(record) { f.effects.push("wrapped-session"); return record; },
  };
  ready.resolve();
  await render;
  expect(f.effects).toEqual(["wrapped-session", "pending", "deliver", "wrapped-session", "surface"]);
});

type OwnerModel = { id?: string; updatedAt: number[]; fails: boolean };

/**
 * Trip wire for the double-painted /resume card: one user action is one
 * delivery, that delivery already merges every responding owner, and
 * revisiting a loaded page asks no owner again.
 */
it("paints each /resume action once with every owner's rows, whatever order owners answer in", async () => {
  const ownerArbitrary = (id: string | undefined) => fc.record({
    id: fc.constant(id),
    // Large enough that four owners can exceed the pool's eight retained pages.
    updatedAt: fc.uniqueArray(fc.integer({ min: 1, max: 1_000_000 }), { maxLength: 30, size: "max" }),
    fails: id ? fc.boolean() : fc.constant(false),
  });
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 1, max: 3 }).chain((peers) => fc.tuple(
      ownerArbitrary(undefined),
      ...Array.from({ length: peers }, (_unused, index) => ownerArbitrary(`peer-${index}`)),
    )),
    fc.infiniteStream(fc.nat()),
    fc.array(fc.nat(), { maxLength: 4 }),
    fc.boolean(),
    async (models: OwnerModel[], releaseOrder, revisits, projects) => {
      // Timestamps are unique across owners so the merged order is total.
      const seen = new Set<number>();
      for (const model of models) model.updatedAt = model.updatedAt.filter((value) => !seen.has(value) && seen.add(value));
      const f = fixture();
      const stores = new Map(models.map((model) => [model.id, new NavigationQueryStore({ now: () => 1_000 })]));
      const gates: Array<() => void> = [];
      f.context.actorHasPermission = (_event, permission) => permission === "federation.remote_control";
      f.backend.listNavigationOwners = async () => ({
        owners: models.map((model) => model.id
          ? { label: model.id, target: { scope: "remote" as const, instanceId: model.id } } : { label: "Local" }),
        omitted: 0,
      });
      f.backend.getNavigationQueryPage = async (request) => {
        f.requests.push(request);
        const ownerId = request.federationTarget?.scope === "remote" ? request.federationTarget.instanceId : undefined;
        const model = models.find((candidate) => candidate.id === ownerId)!;
        // Owners answer in an arbitrary order relative to each other.
        await new Promise<void>((resolve) => gates.push(resolve));
        if (model.fails) throw new Error("Peer unreachable.");
        return stores.get(ownerId)!.readPage({ scopeKey: ownerId ?? "local", request, loadIndex: async () => ({
          directories: model.updatedAt.length ? [{ key: `${ownerId ?? "local"}-repo`, kind: "directory" as const,
            label: `${ownerId ?? "local"} repo`, needsAttentionCount: 0,
            threadKeys: model.updatedAt.map((updatedAt) => `codex:${ownerId ?? "local"}-${updatedAt}`) }] : [],
          threads: model.updatedAt.map((updatedAt) => ({ id: `${ownerId ?? "local"}-${updatedAt}`, source: "codex" as const,
            title: `Thread ${updatedAt}`, titleSource: "explicit" as const, updatedAt, linkedDirectories: [], inbox: { inInbox: false } })),
        }) });
      };
      const settle = async (action: Promise<unknown>): Promise<void> => {
        let done = false;
        void action.finally(() => { done = true; });
        let step = 0;
        while (!done) {
          await setImmediate();
          if (gates.length) gates.splice(releaseOrder.next().value % gates.length, 1)[0]!();
          if (++step > 10_000) throw new Error("The browse never settled.");
        }
        await action;
      };
      let session: Parameters<typeof f.owner.renderResumeBrowser>[0] | undefined;
      const upsert = f.context.store.upsertBrowseSession;
      f.context.store = { ...f.context.store, async upsertBrowseSession(record) { session = record; return upsert(record); } };

      const expected = models.filter((model) => !model.fails)
        .flatMap((model) => model.updatedAt.map((updatedAt) => ({ updatedAt, threadId: `${model.id ?? "local"}-${updatedAt}`, owner: model.id })))
        .sort((left, right) => right.updatedAt - left.updatedAt);
      const expectPaint = (pageIndex: number) => {
        const intent = f.intents.at(-1);
        if (intent?.kind !== "thread_picker") throw new Error(`Expected a thread picker, received ${intent?.kind}`);
        const pageSize = intent.page.pageSize;
        const rows = intent.page.actions.filter((action) => action.id === "browse:select-thread").map((action) => {
          const value = action.value as { threadId: string; federationInstanceId?: string };
          return { threadId: value.threadId, owner: value.federationInstanceId };
        });
        expect(rows).toEqual(expected.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize)
          .map(({ threadId, owner }) => ({ threadId, owner })));
        expect(intent.prompt).not.toContain("Still checking");
        return pageSize;
      };

      if (projects) {
        await settle(f.owner.presentResumeBrowser({ ...command("resume"), args: ["--projects"] }));
        expect(f.intents).toHaveLength(1);
        const intent = f.intents[0];
        if (intent?.kind !== "project_picker") throw new Error(`Expected a project picker, received ${intent?.kind}`);
        expect(intent.prompt).not.toContain("Still checking");
        const owners = intent.page.actions.filter((action) => action.id === "browse:select-project")
          .map((action) => (action.value as { federationInstanceId?: string }).federationInstanceId);
        expect(new Set(owners)).toEqual(new Set(models.filter((model) => !model.fails && model.updatedAt.length)
          .map((model) => model.id).slice(0, intent.page.pageSize)));
        return;
      }
      await settle(f.owner.presentResumeBrowser(command("resume")));
      expect(f.intents).toHaveLength(1);
      const pageSize = expectPaint(0);
      const pages = Math.max(1, Math.ceil(expected.length / pageSize));

      // Page forward through everything, then revisit pages the pool still
      // retains: it keeps the eight most recently loaded pages and restarts
      // from page one for an evicted page, by design.
      const retained = Math.min(pages, 8);
      const visits = [...Array.from({ length: pages - 1 }, (_unused, index) => index + 1),
        ...revisits.map((value) => pages - retained + (value % retained))];
      let loadedThrough = 0;
      for (const pageIndex of visits) {
        const paints = f.intents.length;
        const reads = f.requests.length;
        await settle(f.owner.renderResumeBrowser({ ...session!, pageIndex }, {} as never, command("resume")));
        expect(f.intents).toHaveLength(paints + 1);
        expectPaint(pageIndex);
        if (pageIndex <= loadedThrough) expect(f.requests).toHaveLength(reads);
        loadedThrough = Math.max(loadedThrough, pageIndex);
      }
    },
  ), { numRuns: 60 });
});
