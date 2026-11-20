import { setImmediate } from "node:timers/promises";
import fc from "fast-check";
import { expect, it } from "vitest";
import type {
  HandoffThreadWorkspaceRequest, HandoffThreadWorkspaceResponse, MessagingPermissionId, NavigationThreadSummary,
} from "@pwragent/shared";
import type { MessagingBindingRecord, MessagingInboundCallbackEvent, MessagingSurfaceIntent } from "@pwragent/messaging-interface";
import { PERMISSIVE_CAPABILITY_PROFILE } from "@pwragent/messaging-interface/testing";
import { handoffSuccessText, MessagingHandoffWorkflow } from "../messaging/core/messaging-handoff-workflow";

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
    actorHasPermission: () => true,
    async requirePermission() { return true; },
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

/*
 * Unlocking someone else's Git lock removes a worktree, so the messaging
 * handoff card offers Unlock and Hand Off only to an actor who holds the
 * archive permission as well as handoff, and the callback refuses an
 * approval from anyone else before it reaches the owner.
 */
const PERMISSIONS: MessagingPermissionId[] = [
  "thread.control.handoff", "thread.control.archive", "thread.control.stop", "message.reply",
];
const LOCK_REASON = "release prep, do not remove";
const worktreeThread: NavigationThreadSummary = {
  ...thread,
  linkedDirectories: [{ id: "wt", label: "Repo", kind: "worktree", path: "/repo", worktreePath: "/wt" }],
};
const worktreeValue = {
  backend: "codex", threadId: "thread", direction: "worktree-to-local",
  repositoryPath: "/repo", sourcePath: "/wt", sourceBranch: "feature",
};
const canUnlock = (held: ReadonlySet<MessagingPermissionId>) =>
  held.has("thread.control.handoff") && held.has("thread.control.archive");

function lockedWorktreeFixture(held: ReadonlySet<MessagingPermissionId>, lock: "other" | "none") {
  const f = fixture();
  const presented: MessagingSurfaceIntent[] = [];
  const requests: HandoffThreadWorkspaceRequest[] = [];
  const denied: MessagingPermissionId[] = [];
  const context: Context = {
    ...f.context,
    backend: {
      async readThreadWorktreeLock(request) {
        return lock === "other"
          ? { worktreePath: request.worktreePath, lock: { reason: "worktree-locked", worktreePath: request.worktreePath, lockReason: LOCK_REASON } }
          : { worktreePath: request.worktreePath };
      },
      async handoffThreadWorkspace(request) {
        requests.push(request);
        return {
          backend: "codex", threadId: "thread", direction: "worktree-to-local", workMode: "local",
          repositoryPath: "/repo", targetPath: "/repo", warnings: [], completedAt: 2,
          linkedDirectory: { id: "repo", label: "Repo", kind: "local", path: "/repo" },
        };
      },
    },
    async readBoundWorkspaceContext() { return { kind: "thread", thread: worktreeThread }; },
    async readBoundNavigationThread() { return worktreeThread; },
    async deliverAndStoreStatusSubmode(intent) { presented.push(intent); },
    actorHasPermission: (_event, permission) => held.has(permission),
    async requirePermission(_event, permission) {
      if (held.has(permission)) return true;
      denied.push(permission);
      return false;
    },
  };
  return { context, presented, requests, denied };
}

function callback(actionId: string, value: Record<string, unknown>): MessagingInboundCallbackEvent {
  return { ...event, id: actionId, actionId, interaction: { channel: "telegram", id: actionId }, value } as MessagingInboundCallbackEvent;
}

const heldArb = fc.subarray(PERMISSIONS).map((list) => new Set(list));

it("offers Unlock and Hand Off exactly to an actor who may hand off and archive", async () => {
  await fc.assert(fc.asyncProperty(heldArb, fc.constantFrom("other" as const, "none" as const), async (held, lock) => {
    const f = lockedWorktreeFixture(held, lock);
    await new MessagingHandoffWorkflow(f.context).presentHandoffConfirmation(binding, callback("status:handoff", worktreeValue));
    const card = f.presented[0];
    const actions = card?.kind === "confirmation" ? card.actions : [];
    const unlock = actions.find((action) => action.id === "handoff:confirm-unlock");
    expect(Boolean(unlock)).toBe(lock === "other" && canUnlock(held));
    if (unlock) expect(unlock.value).toMatchObject({ ...worktreeValue, approvedLockReason: LOCK_REASON });
    // The default never carries an approval.
    const keep = actions.find((action) => action.id === "handoff:confirm");
    expect(keep?.value).not.toHaveProperty("approvedLockReason");
    expect(keep?.label).toBe(lock === "other" ? "Hand Off, Keep Worktree" : "Confirm");
    if (lock === "other" && card?.kind === "confirmation") expect(card.body).toContain(LOCK_REASON);
  }));
});

it("refuses an unlock approval from an actor without the archive permission", async () => {
  await fc.assert(fc.asyncProperty(
    heldArb.filter((held) => held.has("thread.control.handoff")),
    fc.constantFrom("handoff:confirm-unlock", "handoff:confirm"),
    async (held, actionId) => {
      const f = lockedWorktreeFixture(held, "other");
      await new MessagingHandoffWorkflow(f.context).executeHandoff(binding,
        callback(actionId, { ...worktreeValue, approvedLockReason: LOCK_REASON }));
      if (held.has("thread.control.archive")) {
        expect(f.requests).toEqual([expect.objectContaining({ approvedLockReason: LOCK_REASON })]);
      } else {
        expect(f.requests).toEqual([]);
        expect(f.denied).toEqual(["thread.control.archive"]);
      }
    },
  ));
});

it("hands off without an approval when the actor keeps the worktree", async () => {
  const f = lockedWorktreeFixture(new Set(["thread.control.handoff"]), "other");
  await new MessagingHandoffWorkflow(f.context).executeHandoff(binding, callback("handoff:confirm", worktreeValue));
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]).not.toHaveProperty("approvedLockReason");
});

it("says once that a locked worktree was kept", () => {
  const text = handoffSuccessText({
    backend: "codex", threadId: "thread", direction: "worktree-to-local", workMode: "local",
    repositoryPath: "/repo", targetPath: "/repo", completedAt: 2,
    linkedDirectory: { id: "repo", label: "Repo", kind: "local", path: "/repo" },
    keptSourceWorktree: { reason: "worktree-locked", worktreePath: "/wt", lockReason: LOCK_REASON },
    warnings: [`Git has the previous worktree locked, so it was left on disk: ${LOCK_REASON}`],
  });
  expect(text).toContain(`The worktree was kept because Git has it locked: ${LOCK_REASON}`);
  expect(text).not.toContain("Warning: Git has");
});
