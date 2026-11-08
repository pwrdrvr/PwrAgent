import fc from "fast-check";
import { expect, it } from "vitest";
import { buildTurnStartEvent, buildTurnStartFailureEvent, ThreadTurnStartLifecycle, type TurnStartIdentity } from "../thread-turn-start-lifecycle";

const identity = fc.record({
  backend: fc.constantFrom("codex" as const, "claude" as const, "acp:grok" as const),
  threadId: fc.constantFrom("same", "same:thread", "pending:same"),
});
const identityKey = (value: TurnStartIdentity) => JSON.stringify([value.backend, value.threadId]);
const noEffects = {
  assertAvailable: () => {},
  withMutation: async <T>(_identity: TurnStartIdentity, work: () => Promise<T>) => await work(),
  assertUnlocked: async () => {},
  wake: async () => {},
};

it("keeps start and failure event identity and timestamps for generated provider identities", () => {
  fc.assert(fc.property(identity, fc.string(), fc.nat(), fc.string(), fc.boolean(), (request, turnId, now, message, errorObject) => {
    expect(buildTurnStartEvent(request, turnId, now)).toEqual({ backend: request.backend, notification: {
      method: "turn/started", params: { threadId: request.threadId, turnId,
        turn: { id: turnId, status: "in_progress", startedAt: now } },
    } });
    expect(buildTurnStartFailureEvent(request, turnId, errorObject ? new Error(message) : message, now)).toEqual({
      backend: request.backend, notification: { method: "turn/failed", params: { threadId: request.threadId, turnId,
        turn: { id: turnId, status: "failed", completedAt: now, error: { message } } } },
    });
  }));
});

// The model counts unresolved starts, including those waiting for lifecycle
// admission. Provider events, which own active turns, are not inferred here.
it("matches pending admission counts through generated overlapping completions and failures", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.record({ identity, fails: fc.boolean() }), { minLength: 1, maxLength: 18 }),
    fc.scheduler(), async (commands, scheduler) => {
      const counts = new Map<string, number>();
      const lifecycle = new ThreadTurnStartLifecycle(noEffects);
      const check = () => {
        for (const { identity } of commands) expect(lifecycle.hasPending(identity)).toBe((counts.get(identityKey(identity)) ?? 0) > 0);
      };
      const outcomes = commands.map(({ identity, fails }) => {
        const key = identityKey(identity);
        counts.set(key, (counts.get(key) ?? 0) + 1);
        const pending = lifecycle.run(identity, async () => {
          await scheduler.schedule(Promise.resolve());
          if (fails) throw new Error("provider");
          return identity;
        });
        check();
        return pending.then((value) => { expect(value).toBe(identity); }, (error: Error) => {
          expect(fails).toBe(true);
          expect(error.message).toBe("provider");
        }).finally(() => { counts.set(key, counts.get(key)! - 1); check(); });
      });
      await scheduler.waitFor(Promise.all(outcomes));
      check();
    }));
});

it("checks the current lock after admission and releases intent at each failed gate", async () => {
  await fc.assert(fc.asyncProperty(identity, fc.constantFrom("available", "mutation", "lock", "wake", "start", "none"),
    async (request, failure) => {
      const effects: string[] = [];
      let lifecycle: ThreadTurnStartLifecycle;
      const step = (name: string) => {
        effects.push(name);
        expect(lifecycle.hasPending(request)).toBe(name !== "available");
        if (name === failure) throw new Error(name);
      };
      lifecycle = new ThreadTurnStartLifecycle({
        assertAvailable: () => step("available"),
        withMutation: async (_identity, work) => { step("mutation"); return await work(); },
        assertUnlocked: async () => step("lock"),
        wake: async () => step("wake"),
      });
      const pending = lifecycle.run(request, async () => { step("start"); return 7; });
      if (failure === "none") expect(await pending).toBe(7);
      else await expect(pending).rejects.toThrow(failure);
      const sequence = ["available", "mutation", "lock", "wake", "start"];
      expect(effects).toEqual(failure === "none" ? sequence : sequence.slice(0, sequence.indexOf(failure) + 1));
      expect(lifecycle.hasPending(request)).toBe(false);
    }));
});

// The oracle is an ordered resource protocol: reserve, prepare, register
// context, announce, retain title input, then hand ownership to submit.
// Any preparation failure retires admission; only announced starts fail visibly.
it("follows the optimistic-start preparation protocol for every failure phase", async () => {
  await fc.assert(fc.asyncProperty(fc.string({ maxLength: 20 }),
    fc.constantFrom("reserve", "prepare", "announce", "remember", "register", "none"), fc.boolean(),
    async (threadId, failure, terminalFails) => {
      const effects: unknown[] = [];
      const lifecycle = new ThreadTurnStartLifecycle(noEffects);
      const context = { request: threadId };
      const pendingTurnId = `pending:${threadId}`;
      let reserved = false;
      const step = (name: string) => {
        effects.push(name);
        if (name === failure) throw new Error(name);
      };
      const pending = lifecycle.prepareCodex({
        threadId,
        reserve: (id) => { expect(id).toBe(pendingTurnId); step("reserve"); reserved = true; },
        prepare: async () => step("prepare"),
        announce: async (id) => { expect(id).toBe(pendingTurnId); step("announce"); },
        rememberInput: () => step("remember"),
        registerContext: async () => { step("register"); return context; },
        forgetContext: (value) => { expect(value).toBe(context); effects.push("forget"); },
        fail: async (id, error, announced) => {
          effects.push(["fail", id, (error as Error).message, announced]);
          if (terminalFails) throw new Error("terminal");
        },
        retire: (id) => { effects.push(["retire", id]); reserved = false; },
      });
      const sequence = ["reserve", "prepare", "register", "announce", "remember"];
      if (failure === "none") {
        expect(await pending).toEqual({ pendingTurnId, context });
        expect(effects).toEqual(sequence);
        expect(reserved).toBe(true); // Provider submission now owns the reservation.
      } else {
        await expect(pending).rejects.toThrow(failure !== "reserve" && terminalFails ? "terminal" : failure);
        const expected: unknown[] = sequence.slice(0, sequence.indexOf(failure) + 1);
        const announced = failure === "announce" || failure === "remember";
        if (announced) expected.push("forget");
        if (failure !== "reserve") expected.push(["fail", pendingTurnId, failure, announced], ["retire", pendingTurnId]);
        expect(effects).toEqual(expected);
        expect(reserved).toBe(false);
      }
    }));
});

it("retains the outer admission when a nested start finishes", async () => {
  const request = { backend: "codex" as const, threadId: "nested" };
  const lifecycle = new ThreadTurnStartLifecycle(noEffects);
  await lifecycle.run(request, async () => {
    await lifecycle.run(request, async () => {});
    expect(lifecycle.hasPending(request)).toBe(true);
  });
  expect(lifecycle.hasPending(request)).toBe(false);
});

it("observes a lock that lands while lifecycle admission is pending", async () => {
  await fc.assert(fc.asyncProperty(identity, fc.boolean(), async (request, lockLands) => {
    let admit!: () => void;
    const admission = new Promise<void>((resolve) => { admit = resolve; });
    let locked = false;
    let starts = 0;
    const lifecycle = new ThreadTurnStartLifecycle({
      ...noEffects,
      withMutation: async (_identity, work) => { await admission; return await work(); },
      assertUnlocked: async () => { if (locked) throw new Error("locked"); },
    });
    const pending = lifecycle.run(request, async () => { starts += 1; });
    expect(lifecycle.hasPending(request)).toBe(true);
    locked = lockLands;
    admit();
    if (lockLands) await expect(pending).rejects.toThrow("locked");
    else await pending;
    expect(starts).toBe(lockLands ? 0 : 1);
    expect(lifecycle.hasPending(request)).toBe(false);
  }));
});
