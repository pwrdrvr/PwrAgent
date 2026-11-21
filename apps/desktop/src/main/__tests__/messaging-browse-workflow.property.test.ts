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

async function expectPickerOwnerLabels(shortName: string, projects: boolean) {
  const f = fixture({
    threads: [{ id: "thread", source: "codex", title: "Investigate CPU profile", titleSource: "explicit",
      updatedAt: 1, linkedDirectories: [], inbox: { inInbox: false } }],
    directories: [{ key: "repo", kind: "directory", label: "Tools", threadKeys: ["codex:thread"], needsAttentionCount: 0 }],
  });
  const visible = [
    { id: "main-instance", label: "Studio-MBP-M5-Max", profileName: "default", shortLabel: shortName },
    { id: "dev-instance", label: "Studio-MBP-M5-Max", profileName: "dev", shortLabel: shortName },
    { id: "older-instance", label: "Mac Mini", profileName: "default" },
  ];
  const peers = visible.map((peer) => ({
    target: { scope: "remote" as const, instanceId: peer.id },
    label: formatFederationPeerDisplayLabel(peer, visible),
    shortLabel: peer.shortLabel ? formatFederationPeerShortDisplayLabel(peer, visible) : undefined,
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
  // Only the display name varies by alias availability. Each callback still identifies the owner of the row.
  const labelsByOwner = new Map([
    ["main-instance", `[${shortName} / default] ${expectedItem}`],
    ["dev-instance", `[${shortName} / dev] ${expectedItem}`],
    ["older-instance", `[Mac Mini] ${expectedItem}`],
    [undefined, expectedItem],
  ]);
  expect(actions).toHaveLength(labelsByOwner.size);
  for (const [instanceId, label] of labelsByOwner) {
    const value = { ...expectedValue, ...(instanceId ? { federationInstanceId: instanceId } : {}) };
    const action = actions.find((candidate) => {
      const data = candidate.value as { federationInstanceId?: string } | undefined;
      return data?.federationInstanceId === instanceId;
    });
    expect(action?.value).toEqual(value);
    expect(action?.label.replace(/^\d+\. /, "")).toBe(label);
    expect(intent.fallbackText).toContain(action!.label);
  }
}

it.each([false, true])("uses compact owner names in /resume actions and text (projects=%s)", async (projects) => {
  await fc.assert(fc.asyncProperty(fc.stringMatching(/^[A-Z]{1,8}$/), async (shortName) => {
    await expectPickerOwnerLabels(shortName, projects);
  }), { numRuns: 30 });
});

it("shows [A / default] for a remote default profile when the machine also has a dev profile", async () => {
  await expectPickerOwnerLabels("A", false);
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
