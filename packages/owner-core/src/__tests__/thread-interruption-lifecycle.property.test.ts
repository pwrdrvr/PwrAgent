import fc from "fast-check";
import { expect, it } from "vitest";
import {
  ThreadInterruptionLifecycle,
  type ThreadInterruptionLifecycleHost,
  type ThreadInterruptionTarget,
} from "../thread-interruption-lifecycle";

const targetFields = {
  threadId: fc.constantFrom("same", "same:thread"),
  turnId: fc.constantFrom("same", "same:turn"),
};
const identity = fc.record({ ...targetFields,
  backend: fc.constantFrom("codex" as const, "claude" as const, "acp:grok" as const, "acp:gemini" as const),
});
const reviewer = fc.record({ ...targetFields,
  backend: fc.constantFrom("codex" as const, "acp:grok" as const, "acp:gemini" as const),
});
const key = (target: ThreadInterruptionTarget) => JSON.stringify([target.backend, target.threadId, target.turnId]);
const result = { threadId: "provider-thread", turnId: "provider-turn" };

// The oracle is the owner's review relation, never the visible parent's
// provider. Only a successful ordinary Codex interrupt retires mode identities;
// a review stays owned until its terminal event, even after a successful cancel.
it("follows review ownership and effect ordering across generated lifecycle commands", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.record({
    action: fc.constantFrom("review", "terminal", "interrupt"),
    request: identity, review: reviewer, alias: fc.boolean(), fails: fc.boolean(),
  }), { minLength: 1, maxLength: 40 }), async (commands) => {
    const reviews = new Map<string, ThreadInterruptionTarget>();
    const effects: unknown[] = [];
    let alias = false;
    let fails = false;
    const execute = async () => { if (fails) throw new Error("provider"); return result; };
    const host: ThreadInterruptionLifecycleHost = {
      cancelTools: (target) => { effects.push(["cancel", target]); },
      findReview: (target) => { effects.push(["lookup", target]); return reviews.get(key(target)); },
      readCodexInterruptTurnId: (target) => {
        effects.push(["alias", target]);
        return alias ? "provider-alias" : undefined;
      },
      interruptClaude: async (target) => { effects.push(["claude", target]); return await execute(); },
      interruptAcp: async (target, serialized) => {
        effects.push(["acp", target, serialized]);
        return { backend: target.backend, ...await execute() };
      },
      interruptCodex: async (target, routing) => {
        effects.push(["codex", target, routing]);
        return await execute();
      },
      retireCodexTurn: (target, value) => { effects.push(["retire", target, value]); },
      reviewInterrupted: (parent, review) => { effects.push(["reviewed", parent, review]); },
    };
    const lifecycle = new ThreadInterruptionLifecycle(host);
    for (const command of commands) {
      const { request } = command;
      if (command.action === "review") { reviews.set(key(request), command.review); continue; }
      if (command.action === "terminal") { reviews.delete(key(request)); continue; }
      alias = command.alias;
      fails = command.fails;
      effects.length = 0;
      const review = reviews.get(key(request));
      const recipient = review ?? request;
      const expected: unknown[] = [["cancel", request], ["lookup", request]];
      const provider = recipient.backend.split(":")[0];
      const deliveries: Record<string, unknown[]> = {
        claude: [["claude", recipient]],
        acp: [["acp", recipient, Boolean(review)]],
        codex: [["alias", recipient], ["codex", {
          ...recipient, turnId: alias ? "provider-alias" : recipient.turnId,
        }, { review: Boolean(review), requestedTurnId: recipient.turnId }]],
      };
      expected.push(...deliveries[provider]);
      if (fails) await expect(lifecycle.interruptTurn(request)).rejects.toThrow("provider");
      else {
        if (review) expected.push(["reviewed", request, review]);
        else if (provider === "codex") expected.push(["retire", request, result]);
        expect(await lifecycle.interruptTurn(request)).toEqual(review ? request : { backend: request.backend, ...result });
      }
      expect(effects).toEqual(expected);
    }
  }));
});

it("keeps each admitted target through generated asynchronous ownership changes", async () => {
  await fc.assert(fc.asyncProperty(identity, reviewer, reviewer, fc.scheduler(), async (request, first, second, scheduler) => {
    let current = first;
    const delivered: ThreadInterruptionTarget[] = [];
    const completed: ThreadInterruptionTarget[] = [];
    const execute = async (target: ThreadInterruptionTarget) => {
      delivered.push(target);
      await scheduler.schedule(Promise.resolve());
      return target;
    };
    const lifecycle = new ThreadInterruptionLifecycle({
      cancelTools: () => {}, findReview: () => current,
      readCodexInterruptTurnId: () => undefined,
      interruptClaude: execute, interruptAcp: execute, interruptCodex: execute,
      retireCodexTurn: () => { throw new Error("A review cannot retire before a terminal event"); },
      reviewInterrupted: (_parent, review) => { completed.push(review); },
    });
    const pending = lifecycle.interruptTurn(request);
    current = second;
    const next = lifecycle.interruptTurn(request);
    expect(delivered).toEqual([first, second]);
    expect(completed).toEqual([]);
    await scheduler.waitAll();
    expect(await Promise.all([pending, next])).toEqual([request, request]);
    expect(completed).toHaveLength(2);
    expect(completed).toEqual(expect.arrayContaining([first, second]));
  }));
});

it("stops before provider effects when cancellation or ownership lookup fails", async () => {
  await fc.assert(fc.asyncProperty(identity, fc.boolean(), async (request, cancelFails) => {
    let lookups = 0;
    const forbidden = () => { throw new Error("Unexpected provider effect"); };
    const lifecycle = new ThreadInterruptionLifecycle({
      cancelTools: () => { if (cancelFails) throw new Error("cancel"); },
      findReview: () => { lookups += 1; throw new Error("lookup"); },
      readCodexInterruptTurnId: forbidden, interruptClaude: forbidden,
      interruptAcp: forbidden, interruptCodex: forbidden,
      retireCodexTurn: forbidden, reviewInterrupted: forbidden,
    });
    await expect(lifecycle.interruptTurn(request)).rejects.toThrow(cancelFails ? "cancel" : "lookup");
    expect(lookups).toBe(cancelFails ? 0 : 1);
  }));
});
