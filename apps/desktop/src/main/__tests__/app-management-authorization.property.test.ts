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
