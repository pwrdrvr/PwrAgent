import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { BUILT_IN_ROLES, type AppServerThreadMessageOrigin } from "@pwragent/shared";
import { authorizeAppManagement } from "../agent-tools/app-management-authorization";

const source: AppServerThreadMessageOrigin = { kind: "messaging", causalMessagingSource: { ownerId: "profile", requestId: "actor-request" } };

it("requires both persisted Agent identity and the canonical lifecycle grant on every backend", async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom(...BUILT_IN_ROLES), fc.boolean(), fc.boolean(), fc.boolean(),
    fc.constantFrom("codex" as const, "claude" as const, "acp:grok" as const),
    async (role, agent, admitted, retained, backend) => {
      const actor = vi.fn(async () => admitted && role.permissions.includes("tools.instance_lifecycle")
        && role.permissions.includes("tools.instance_management"));
      const ports = { isActive: () => true, isToolAllowed: () => true, isAgent: async () => agent,
        readOrigin: async () => retained ? source : undefined, authorizeActor: actor };
      const context = { backend, threadId: "agent", turnId: "turn" };
      const expected = agent && admitted && retained && role.id === "admin";
      expect(await authorizeAppManagement(ports, context)).toBe(expected);
      expect(await authorizeAppManagement(ports, context, true)).toBe(expected);
      if (!agent || !retained) expect(actor).not.toHaveBeenCalled();
    },
  ), { numRuns: 100 });
});

it("fails closed on missing identity, ambiguous sources, containment and Agent revocation during authorization", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("identity", "ambiguous", "contained", "demoted", "actor-error", "inactive"), async (failure) => {
    let agent = true;
    const ports = {
      isActive: () => failure !== "inactive", isToolAllowed: () => failure !== "contained", isAgent: async () => agent,
      readOrigin: async () => ({ ...source, causalMessagingAmbiguous: failure === "ambiguous" }),
      authorizeActor: async () => {
        if (failure === "demoted") agent = false;
        if (failure === "actor-error") throw new Error("Messaging owner unavailable");
        return true;
      },
    };
    expect(await authorizeAppManagement(ports, failure === "identity" ? {} : { backend: "codex", threadId: "agent", turnId: "turn" })).toBe(false);
  }));
});

it("does not transfer an earlier actor's authority when a steer changes the causal source during authorization", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("changed", "missing", "ambiguous"), async (change) => {
    let current: AppServerThreadMessageOrigin | undefined = source;
    const ports = { isActive: () => true, isToolAllowed: () => true, isAgent: async () => true,
      readOrigin: async () => current, authorizeActor: async () => {
        current = change === "missing" ? undefined : change === "ambiguous"
          ? { ...source, causalMessagingAmbiguous: true }
          : { ...source, causalMessagingSource: { ownerId: "profile", requestId: "other-actor" } };
        return true;
      } };
    expect(await authorizeAppManagement(ports, { backend: "codex", threadId: "manager", turnId: "turn" })).toBe(false);
  }));
});

it("accepted operations outlive turn completion without bypassing Agent or actor revocation (generated)", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), async (agent, grant) => {
    const ports = { allowCompleted: true, isActive: () => false, isToolAllowed: () => true,
      isAgent: async () => agent, readOrigin: async () => source, authorizeActor: async () => grant };
    const context = { backend: "codex" as const, threadId: "manager", turnId: "completed-turn" };
    expect(await authorizeAppManagement(ports, context)).toBe(agent && grant);
    expect(await authorizeAppManagement({ ...ports, allowCompleted: false }, context)).toBe(false);
  }));
});
