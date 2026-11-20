import { setImmediate } from "node:timers/promises";
import fc from "fast-check";
import { expect, it } from "vitest";
import type { NavigationQueryRequest } from "@pwragent/shared/contracts/navigation";
import type { MessagingChannelRef, MessagingInboundCommandEvent, MessagingSurfaceIntent } from "@pwragent/messaging-interface";
import { PERMISSIVE_CAPABILITY_PROFILE } from "@pwragent/messaging-interface/testing";
import { NavigationQueryStore } from "../app-server/navigation-query-store";
import { MessagingBrowseWorkflow } from "../messaging/core/messaging-browse-workflow";

type Context = ConstructorParameters<typeof MessagingBrowseWorkflow>[0];

const channel: MessagingChannelRef = { channel: "telegram", conversation: { kind: "dm", id: "browse-conversation" } };

function command(name: "resume" | "agent"): MessagingInboundCommandEvent {
  return {
    id: "browse-command", kind: "command", receivedAt: 1_000, channel,
    actor: { platformUserId: "browse-actor" }, command: name, args: [], rawText: `/${name}`,
  };
}

function fixture() {
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
      const store = request.federationTarget ? peer : local;
      return store.readPage({ scopeKey: "browse", request, loadIndex: async () => ({ threads: [], directories: [] }) });
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
