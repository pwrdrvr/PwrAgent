import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { OpenAIDecisionsService } from "../openai-decisions/openai-decisions-service";
import { OpenAIDecisionStore } from "../storage/openai-decision-store";
import { openInMemoryStateDb } from "./sqlite-test-utils";

// Synthetic keys only. No request leaves the test: nothing here invokes.
const JEV_TARGET = { endpoint: "https://jev.test", model: "jev-latest", apiKey: "sk-test-jev-profile-0123456789" };
const THREADS = [
  { backend: "codex", threadId: "thread-a" },
  { backend: "codex", threadId: "thread-b" },
  { backend: "claude", threadId: "thread-a" },
];
const NAMES = ["triage", "severity", "owner_present", "diff_risk"];

type Op =
  | { kind: "register"; thread: number; name: number; scope: "profile" | "thread" }
  | { kind: "settings-delete"; target: number }
  | { kind: "agent-delete"; thread: number; target: number }
  | { kind: "settings-delete-unknown" };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant("register" as const),
    thread: fc.nat(THREADS.length - 1),
    name: fc.nat(NAMES.length - 1),
    scope: fc.constantFrom("profile" as const, "thread" as const),
  }),
  fc.record({ kind: fc.constant("settings-delete" as const), target: fc.nat(20) }),
  fc.record({ kind: fc.constant("agent-delete" as const), thread: fc.nat(THREADS.length - 1), target: fc.nat(20) }),
  fc.constant({ kind: "settings-delete-unknown" as const }),
);

type ModelDecision = { decisionId: string; name: string; scope: "profile" | "thread"; owner?: string };

function makeService() {
  const db = openInMemoryStateDb();
  let next = 0;
  const service = new OpenAIDecisionsService({
    store: new OpenAIDecisionStore(db),
    readApiKey: async () => undefined,
    readSystemOneTarget: async (provider) => provider === "jev" ? JEV_TARGET : undefined,
    readAccountSettings: () => ({}),
    profileId: () => "test-profile",
    recordUsageLines: async () => undefined,
    newDecisionId: () => `decision-${(next += 1)}`,
    fetch: async () => { throw new Error("no requests in this test"); },
  });
  return { db, service };
}

const ownerKey = (thread: { backend: string; threadId: string }) => `${thread.backend}:${thread.threadId}`;

describe("Settings → AI Providers → Decisions", () => {
  // Rule: Settings lists exactly the active profile-scope decisions, by
  // name, whoever registered them, and its Delete removes only one of
  // those: a thread's own decision is never listed and never deleted from
  // Settings, and a decision an agent deleted first is "not_found".
  // Oracle: a model of the active decisions, updated by each operation's
  // reported outcome.
  it("lists and deletes only active profile decisions, whatever order agents and the operator act in", async () => {
    await fc.assert(fc.asyncProperty(fc.array(opArb, { maxLength: 30 }), async (ops) => {
      const { db, service } = makeService();
      try {
        const active = new Map<string, ModelDecision>();
        const everRegistered: string[] = [];
        for (const op of ops) {
          if (op.kind === "register") {
            const thread = THREADS[op.thread]!;
            const name = NAMES[op.name]!;
            try {
              const result = await service.register(thread, {
                name,
                scope: op.scope,
                provider: "jev",
                instructions: "Is it relevant?",
                question: { type: "predicate", name: "relevant" },
                inputSchema: { type: "string" },
              }) as { decisionId: string };
              active.set(result.decisionId, {
                decisionId: result.decisionId,
                name,
                scope: op.scope,
                ...(op.scope === "thread" ? { owner: ownerKey(thread) } : {}),
              });
              everRegistered.push(result.decisionId);
            } catch {
              // A taken name is the registry's rule, not this one's.
            }
          } else if (op.kind === "settings-delete") {
            const decisionId = everRegistered[op.target % Math.max(1, everRegistered.length)];
            if (decisionId === undefined) continue;
            const before = active.get(decisionId);
            const result = service.deleteProfileDecision(decisionId);
            if (before?.scope === "profile") {
              expect(result).toEqual({ outcome: "deleted" });
              active.delete(decisionId);
            } else {
              // Gone already, or a thread's own decision: nothing changes.
              expect(result).toEqual({ outcome: "not_found" });
            }
          } else if (op.kind === "agent-delete") {
            const thread = THREADS[op.thread]!;
            const decisionId = everRegistered[op.target % Math.max(1, everRegistered.length)];
            if (decisionId === undefined) continue;
            const before = active.get(decisionId);
            const visible = before !== undefined
              && (before.scope === "profile" || before.owner === ownerKey(thread));
            try {
              service.delete(thread, { decisionId });
              expect(visible).toBe(true);
              active.delete(decisionId);
            } catch {
              expect(visible).toBe(false);
            }
          } else {
            expect(service.deleteProfileDecision("decision-never")).toEqual({ outcome: "not_found" });
          }

          const expected = [...active.values()]
            .filter((decision) => decision.scope === "profile")
            .sort((left, right) => left.name.localeCompare(right.name));
          const listed = service.profileDecisions();
          expect(listed.map((decision) => decision.decisionId)).toEqual(expected.map((decision) => decision.decisionId));
          expect(listed.every((decision) => decision.scope === "profile")).toBe(true);
          // A thread's own decisions are untouched by anything Settings does.
          for (const thread of THREADS) {
            const own = (await service.railSnapshot(thread)).decisions
              .filter((decision) => decision.scope === "thread")
              .map((decision) => decision.decisionId)
              .sort();
            const expectedOwn = [...active.values()]
              .filter((decision) => decision.scope === "thread" && decision.owner === ownerKey(thread))
              .map((decision) => decision.decisionId)
              .sort();
            expect(own).toEqual(expectedOwn);
          }
        }
      } finally {
        db.close();
      }
    }), { numRuns: 60 });
  });

  it("shows a profile decision's version, provider state and registration time, and frees its name on delete", async () => {
    const { db, service } = makeService();
    try {
      await service.register(THREADS[0]!, {
        name: "triage",
        scope: "profile",
        provider: "jev",
        instructions: "Is it relevant?",
        question: { type: "predicate", name: "relevant" },
        inputSchema: { type: "object", properties: { title: { type: "string" } } },
      });
      const [listed] = service.profileDecisions();
      expect(listed).toMatchObject({
        name: "triage",
        version: 1,
        scope: "profile",
        provider: "jev",
        providerDisabled: false,
        questions: [{ type: "predicate", name: "relevant" }],
        inputSchema: { type: "object", properties: { title: { type: "string" } } },
      });
      expect(typeof listed!.createdAt).toBe("number");

      // The confirm dialog promises an agent can register the name again.
      expect(service.deleteProfileDecision(listed!.decisionId)).toEqual({ outcome: "deleted" });
      expect(service.profileDecisions()).toEqual([]);
      await service.register(THREADS[1]!, {
        name: "triage",
        scope: "profile",
        provider: "jev",
        instructions: "Is it relevant?",
        question: { type: "predicate", name: "relevant" },
        inputSchema: { type: "string" },
      });
      expect(service.profileDecisions().map((decision) => decision.name)).toEqual(["triage"]);
    } finally {
      db.close();
    }
  });
});
