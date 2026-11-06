import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { MessagingPermissionId } from "@pwragent/shared";
import type { MessagingInboundEvent, MessagingSurfaceIntent } from "@pwragent/messaging-interface";
import { PERMISSIVE_CAPABILITY_PROFILE } from "@pwragent/messaging-interface/testing";
import type { MessagingBackendBridge } from "../messaging/core/messaging-adapter";
import { MessagingController } from "../messaging/core/messaging-controller";
import { SqliteMessagingStore } from "../state/messaging-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";

describe("messaging Claude recovery permission model", () => {
  it("uses current reply permission and the bound local Claude target on every invocation", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.record({
      reply: fc.boolean(),
      callback: fc.boolean(),
      target: fc.constantFrom("local", "remote", "codex", "rebound"),
    }), { minLength: 1, maxLength: 8 }), async (operations) => {
      const db = openInMemoryStateDb();
      const store = new SqliteMessagingStore(db);
      const channel = { channel: "telegram" as const, conversation: { id: "fixture-chat", kind: "dm" as const } };
      const permissions = new Set<MessagingPermissionId>(["thread.status.view"]);
      const recover = vi.fn(async () => ({ threadId: "fixture-thread" }));
      const delivered: MessagingSurfaceIntent[] = [];
      const controller = new MessagingController({
        channel: "telegram", authorizedActorIds: ["fixture-actor"], store,
        adapter: {
          capabilityProfile: PERMISSIVE_CAPABILITY_PROFILE,
          deliver: async (intent) => {
            delivered.push(intent);
            return { channel: "telegram", deliveredAt: 1, outcome: "presented" };
          },
        },
        backend: { continueClaudeThreadInNewSession: recover } as unknown as MessagingBackendBridge,
        rbacPolicy: {
          isEnforcing: () => true,
          resolve: () => ({ permissions, roleIds: ["fixture-role"], matchedSubjects: [], rejected: false }),
        },
      });
      try {
        // The initial permitted invocation keeps the property from passing
        // vacuously when the command or callback has no implementation.
        for (const [index, operation] of [{ reply: true, callback: true, target: "local" }, ...operations].entries()) {
          if (operation.reply) permissions.add("message.reply");
          else permissions.delete("message.reply");
          const backend = operation.target === "codex" ? "codex" as const : "claude" as const;
          await store.upsertBinding({
            id: "fixture-binding", backend, threadId: operation.target === "rebound" ? "another-thread" : "fixture-thread",
            channel, authorizedActorIds: ["fixture-actor"], createdAt: 1, updatedAt: 1,
            ...(operation.target === "remote" ? { federatedThread: {
              target: { scope: "remote" as const, instanceId: "fixture-peer" }, backend: "claude" as const, threadId: "fixture-thread",
            } } : { federatedThread: undefined }),
          });
          const base = { id: `event-${index}`, actor: { platformUserId: "fixture-actor" }, channel, receivedAt: index + 1 };
          const event: MessagingInboundEvent = operation.callback
            ? { ...base, kind: "callback", interaction: { channel: "telegram", id: `click-${index}` },
                actionId: "claude:continue-session", value: { bindingId: "fixture-binding", threadId: "fixture-thread" } }
            : { ...base, kind: "command", command: "continue", args: [], rawText: "/continue" };
          recover.mockClear();
          delivered.length = 0;
          await controller.handleInboundEvent(event);
          const allowed = operation.reply && operation.target !== "remote" && operation.target !== "codex"
            && (!operation.callback || operation.target !== "rebound");
          expect(recover).toHaveBeenCalledTimes(allowed ? 1 : 0);
          if (allowed) expect(recover).toHaveBeenCalledWith({
            threadId: operation.target === "rebound" ? "another-thread" : "fixture-thread",
          });
          else expect(delivered.at(-1)).toMatchObject({ kind: "error" });
        }
      } finally {
        await controller.dispose();
        db.close();
      }
    }), { numRuns: 25 });
  });
});
