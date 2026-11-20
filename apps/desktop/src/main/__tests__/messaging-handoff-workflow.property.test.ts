import { setImmediate } from "node:timers/promises";
import fc from "fast-check";
import { expect, it } from "vitest";
import type { HandoffThreadWorkspaceResponse } from "@pwragent/shared/contracts/normalized-app-server";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { MessagingBindingRecord, MessagingInboundCallbackEvent } from "@pwragent/messaging-interface";
import { PERMISSIVE_CAPABILITY_PROFILE } from "@pwragent/messaging-interface/testing";
import { MessagingHandoffWorkflow } from "../messaging/core/messaging-handoff-workflow";

type Context = ConstructorParameters<typeof MessagingHandoffWorkflow>[0];
const binding: MessagingBindingRecord = {
  id: "bound", backend: "codex", threadId: "thread", authorizedActorIds: ["actor"],
  channel: { channel: "telegram", conversation: { id: "conversation", kind: "dm" } },
  createdAt: 1, updatedAt: 1,
};
const thread: NavigationThreadSummary = {
  id: "thread", source: "codex", title: "Fixture", titleSource: "explicit", gitBranch: "feature",
  linkedDirectories: [{ id: "repo", label: "Repo", kind: "local", path: "/repo" }], inbox: { inInbox: false },
};
const event = {
  id: "confirm", kind: "callback", channel: binding.channel, actor: { platformUserId: "actor" },
  receivedAt: 1, interaction: { channel: "telegram", id: "confirm" }, actionId: "handoff:confirm",
  value: {
    backend: "codex", threadId: "thread", direction: "local-to-worktree", strategy: "detached-changes",
    repositoryPath: "/repo", sourcePath: "/repo", sourceBranch: "feature",
  },
} satisfies MessagingInboundCallbackEvent;

function fixture() {
  const effects: string[] = [];
  const started = Promise.withResolvers<void>();
  const handoff = Promise.withResolvers<HandoffThreadWorkspaceResponse>();
  const context: Context = {
    backend: {
      async handoffThreadWorkspace(request) {
        expect(this).toBe(context.backend);
        expect(request).toMatchObject(event.value);
        effects.push("request");
        started.resolve();
        return handoff.promise;
      },
    },
    store: {
      async getBinding() { effects.push("binding"); return binding; },
      async findActivePendingIntentForChannel() {
        effects.push("pending");
        return {
          id: "handoff", createdAt: 1, expiresAt: 10, allowedActorIds: ["actor"],
          intent: { id: "handoff", kind: "dismiss", createdAt: 1, targetSurface: { channel: "telegram", id: "confirm" } },
        };
      },
      async deletePendingIntent(id) { effects.push(`delete:${id}`); },
    },
    queryPool: {
      async read() { throw new Error("Confirmation does not page projects"); },
      release() {},
    },
    capabilityProfile: PERMISSIVE_CAPABILITY_PROFILE,
    now: () => 1,
    newIntentId: (prefix) => prefix,
    getActiveTurn: () => undefined,
    async readBoundWorkspaceContext() { effects.push("workspace"); return { kind: "thread", thread }; },
    async readBoundNavigationThread() { effects.push("refresh"); return thread; },
    async deliver(intent) {
      effects.push(intent.audit?.action?.split(".")[1] ?? intent.kind);
      return { channel: "telegram", deliveredAt: 1, outcome: "presented" };
    },
    async deliverAndStoreStatusSubmode() {},
    async updateBindingAfterHandoff(record) { effects.push("update"); return record; },
    async renderBindingStatus(record) { effects.push("render"); return record; },
  };
  return { context, effects, started, handoff };
}

it("rejects active turns and stale confirmations before invoking migration", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("working", "waiting", "revoked", "unauthorized", "changed-branch"), async state => {
    const f = fixture();
    const active = state === "working" || state === "waiting";
    const context: Context = {
      ...f.context,
      getActiveTurn: () => active ? { turnId: "turn", status: state, updatedAt: 1 } : undefined,
      store: {
        ...f.context.store,
        async getBinding() {
          f.effects.push("binding");
          if (state === "revoked") return { ...binding, revokedAt: 2 };
          if (state === "unauthorized") return { ...binding, authorizedActorIds: ["someone-else"] };
          return binding;
        },
      },
      async readBoundWorkspaceContext() {
        f.effects.push("workspace");
        return { kind: "thread", thread: { ...thread, gitBranch: "replacement" } };
      },
      backend: {
        async handoffThreadWorkspace() { f.effects.push("unexpected-request"); throw new Error("Forbidden migration"); },
      },
    };
    await new MessagingHandoffWorkflow(context).executeHandoff(binding, event);
    expect(f.effects).toEqual(active ? ["unavailable"] : ["binding", ...(state === "changed-branch" ? ["workspace"] : []), "unavailable"]);
  }));
});

it("settles status and binding effects only after migration acceptance", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), async accepted => {
    const f = fixture();
    const action = new MessagingHandoffWorkflow(f.context).executeHandoff(binding, event);
    await Promise.race([f.started.promise, action]);
    await setImmediate();
    const before = [...f.effects];
    if (accepted) {
      f.handoff.resolve({
        backend: "codex", threadId: "thread", direction: "local-to-worktree", workMode: "worktree",
        repositoryPath: "/repo", targetPath: "/worktree", warnings: [], completedAt: 2,
        linkedDirectory: { id: "worktree", label: "Repo", kind: "worktree", path: "/repo", worktreePath: "/worktree" },
      });
    } else {
      f.handoff.reject(new Error("Migration failed"));
    }
    await action;
    expect(before).toEqual(["binding", "workspace", "running", "request"]);
    expect(f.effects.slice(before.length)).toEqual(accepted
      ? ["pending", "delete:handoff", "refresh", "update", "completed", "render"] : ["failed"]);
  }), { numRuns: 20 });
});
