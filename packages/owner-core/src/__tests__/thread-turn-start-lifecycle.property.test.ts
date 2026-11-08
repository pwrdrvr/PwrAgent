import fc from "fast-check";
import { expect, it } from "vitest";
import { buildTurnStartEvent, buildTurnStartFailureEvent, ThreadTurnStartLifecycle, type AcpTurnStartFinalizationStage, type TurnStartIdentity } from "../thread-turn-start-lifecycle";

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

const acpFinalization = ["origin", "review-contexts", "pdf", "title", "context", "persist-origin", "attachments",
  "forget-context", "dispose-origin", "release"] as const;
const acpPreparation = ["reserve", "prepare", "register", "begin-origin", "submit"] as const;

// The provider owns acceptance and session-close timing. Preparation owns
// grants only until invocation, including when a live session refuses a turn.
it("preserves Claude outcomes and one-shot grant ownership across independent host failures", async () => {
  const stages = ["origin", "persist-origin", "dispose-origin", "revoke-connections"] as const;
  await fc.assert(fc.asyncProperty(fc.constantFrom("none", "prepare", "begin-origin", "submit"),
    fc.subarray([...stages]), fc.constantFrom("submit", "persist", "later"), fc.boolean(),
    async (rejection, failures, closeAt, reportingFails) => {
      const lifecycle = new ThreadTurnStartLifecycle(noEffects);
      const effects: string[] = [];
      const reports: string[] = [];
      const origin = {};
      const accepted = { threadId: "claude:thread", turnId: "provider:turn" };
      const refused = new Error(rejection);
      let close: (() => void) | undefined;
      const step = (name: string) => {
        effects.push(name);
        if (name === rejection) throw refused;
        if (failures.includes(name as typeof stages[number])) throw new Error(name);
      };
      const pending = lifecycle.startClaude({
        prepare: async () => { step("prepare"); },
        beginOrigin: () => { step("begin-origin"); return origin; },
        submit: async (release) => {
          close = release;
          if (closeAt === "submit") { close(); close(); }
          step("submit");
          return accepted;
        },
        bindOrigin: (value, turn) => { expect(value).toBe(origin); expect(turn).toBe(accepted); step("origin"); },
        persistOrigin: async (value) => {
          expect(value).toBe(origin);
          if (closeAt === "persist") { close!(); close!(); }
          step("persist-origin");
        },
        disposeOrigin: (value) => {
          expect(value).toBe(["none", "submit"].includes(rejection) ? origin : undefined);
          step("dispose-origin");
        },
        revokeConnections: () => { step("revoke-connections"); },
        failed: (stage, error, turn) => {
          expect((error as Error).message).toBe(stage);
          expect(turn).toBe(effects.includes("origin") ? accepted : undefined);
          reports.push(stage);
          if (reportingFails) throw new Error("reporting");
        },
      });
      if (rejection === "none") expect(await pending).toBe(accepted);
      else await expect(pending).rejects.toBe(refused);
      const preparation = ["prepare", "begin-origin", "submit"];
      const expected = rejection === "none"
        ? [...preparation, "origin", "persist-origin", "dispose-origin"]
        : [...preparation.slice(0, preparation.indexOf(rejection) + 1), "dispose-origin"];
      expect(effects.filter((effect) => effect !== "revoke-connections")).toEqual(expected);
      const submitted = effects.includes("submit");
      const alreadyClosed = !submitted || closeAt === "submit" || (rejection === "none" && closeAt === "persist");
      expect(effects.filter((effect) => effect === "revoke-connections")).toHaveLength(alreadyClosed ? 1 : 0);
      close?.(); close?.();
      expect(effects.filter((effect) => effect === "revoke-connections")).toHaveLength(1);
      expect(reports).toEqual(effects.filter((effect) => failures.includes(effect as typeof stages[number])));
    }));
});

it("keeps overlapping Claude session releases independent of start completion and identity collisions", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.record({ identity, refuses: fc.boolean() }), { minLength: 2, maxLength: 8 }),
    fc.scheduler(), async (commands, scheduler) => {
      const lifecycle = new ThreadTurnStartLifecycle(noEffects);
      const releases: Array<() => void> = [];
      const grants = commands.map(() => ({ held: true }));
      const disposed = new Set<object>();
      const runs = commands.map((command, index) => {
        const grant = grants[index];
        const accepted = { ...command.identity, turnId: `${index}` };
        return lifecycle.run(command.identity, () => lifecycle.startClaude({
          prepare: async () => { await scheduler.schedule(Promise.resolve()); },
          beginOrigin: () => grant,
          submit: async (release) => {
            releases[index] = release;
            await scheduler.schedule(Promise.resolve());
            if (command.refuses) throw new Error("Provider refused");
            return accepted;
          },
          bindOrigin: (origin, turn) => { expect(origin).toBe(grant); expect(turn).toBe(accepted); },
          persistOrigin: async () => { await scheduler.schedule(Promise.resolve()); },
          disposeOrigin: (origin) => { expect(origin).toBe(grant); disposed.add(grant); },
          revokeConnections: () => { expect(grant.held).toBe(true); grant.held = false; },
          failed: (_stage, error) => { throw error; },
        })).then((turn) => {
          expect(command.refuses).toBe(false); expect(turn).toBe(accepted);
        }, (error: Error) => {
          expect(command.refuses).toBe(true); expect(error.message).toBe("Provider refused");
        });
      });
      await scheduler.waitFor(Promise.all(runs));
      expect(disposed.size).toBe(commands.length);
      expect(grants.every((grant) => grant.held)).toBe(true);
      for (const command of commands) expect(lifecycle.hasPending(command.identity)).toBe(false);
      // Provider sessions can close in any order, after successful or refused
      // starts; neither another start nor its origin disposal owns these grants.
      await scheduler.waitFor(Promise.all(releases.map(async (release, index) => {
        await scheduler.schedule(Promise.resolve());
        release(); release();
        expect(grants[index].held).toBe(false);
      })));
      expect(grants.every((grant) => !grant.held)).toBe(true);
    }));
});

// The provider's return value is the outcome oracle. Host metadata failures
// cannot change it; preparation/submission failures never run accepted effects.
it("preserves the ACP provider outcome and ordered resource protocol across independent host failures", async () => {
  await fc.assert(fc.asyncProperty(identity, fc.string(), fc.constantFrom("none", ...acpPreparation),
    fc.subarray([...acpFinalization]), fc.boolean(), async (request, turnId, rejection, failures, reportingFails) => {
      const lifecycle = new ThreadTurnStartLifecycle(noEffects);
      const context = { identity: request };
      const origin = { identity: request };
      const accepted = { ...request, turnId };
      const refused = new Error(rejection);
      const effects: string[] = [];
      const reports: AcpTurnStartFinalizationStage[] = [];
      let reserved = false;
      const step = (name: string) => {
        effects.push(name);
        if (name === rejection) throw refused;
        if (failures.includes(name as AcpTurnStartFinalizationStage)) throw new Error(name);
      };
      const pending = lifecycle.startAcp({
        reserve: () => { step("reserve"); reserved = true; },
        prepare: async () => { step("prepare"); },
        registerContext: async () => { step("register"); return context; },
        beginOrigin: () => { step("begin-origin"); return origin; },
        submit: async () => { step("submit"); return accepted; },
        bindOrigin: (value, turn) => { expect(value).toBe(origin); expect(turn).toBe(accepted); step("origin"); },
        consumeReviewContexts: async () => { step("review-contexts"); },
        bindPdf: (turn) => { expect(turn).toBe(accepted); step("pdf"); },
        scheduleTitle: (turn) => { expect(turn).toBe(accepted); step("title"); },
        bindContext: (value, turn) => { expect(value).toBe(context); expect(turn).toBe(accepted); step("context"); },
        persistOrigin: async (value) => { expect(value).toBe(origin); step("persist-origin"); },
        retainAttachments: async (turn) => { expect(turn).toBe(accepted); step("attachments"); },
        forgetContext: (value) => {
          expect(value).toBe(["none", "begin-origin", "submit"].includes(rejection) ? context : undefined);
          step("forget-context");
        },
        disposeOrigin: (value) => {
          expect(value).toBe(["none", "submit"].includes(rejection) ? origin : undefined);
          step("dispose-origin");
        },
        release: () => { reserved = false; step("release"); },
        failed: (stage, error, turn) => {
          expect((error as Error).message).toBe(stage);
          expect(turn).toBe(rejection === "none" ? accepted : undefined);
          reports.push(stage);
          if (reportingFails) throw new Error("reporting");
        },
      });
      if (rejection === "none") expect(await pending).toBe(accepted);
      else await expect(pending).rejects.toBe(refused);
      const expected: string[] = rejection === "none"
        ? [...acpPreparation, ...acpFinalization]
        : [...acpPreparation.slice(0, acpPreparation.indexOf(rejection) + 1),
            ...(rejection === "reserve" ? [] : acpFinalization.slice(-3))];
      expect(effects).toEqual(expected);
      expect(reports).toEqual(expected.filter((name) => failures.includes(name as AcpTurnStartFinalizationStage)));
      expect(reserved).toBe(false);
    }));
});

it("keeps overlapping ACP starts and provider terminals qualified by their captured identity", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.record({ identity, terminal: fc.boolean() }), { minLength: 2, maxLength: 8 }),
    fc.scheduler(), async (commands, scheduler) => {
      const lifecycle = new ThreadTurnStartLifecycle(noEffects);
      const active = new Set<object>();
      const reservations = new Set<object>();
      const failures: unknown[] = [];
      const turns = commands.map((command, index) => ({ ...command.identity, turnId: `${index}` }));
      const pending = commands.map(({ identity: request, terminal }, index) => {
        const turn = turns[index];
        return lifecycle.run(request, () => lifecycle.startAcp({
          reserve: () => { reservations.add(turn); },
          prepare: async () => { await scheduler.schedule(Promise.resolve()); },
          registerContext: async () => turn,
          beginOrigin: () => turn,
          submit: async () => { active.add(turn); return turn; },
          bindOrigin: (origin, accepted) => { expect(origin).toBe(turn); expect(accepted).toBe(turn); },
          consumeReviewContexts: async () => {
            await scheduler.schedule(Promise.resolve());
            if (terminal) active.delete(turn);
          },
          bindPdf: () => {}, scheduleTitle: () => {}, bindContext: () => {},
          persistOrigin: async () => {}, retainAttachments: async () => {},
          forgetContext: (context) => { expect(context).toBe(turn); },
          disposeOrigin: (origin) => { expect(origin).toBe(turn); },
          release: () => { reservations.delete(turn); },
          failed: (_stage, error) => { failures.push(error); },
        })).then((accepted) => {
          expect(accepted).toBe(turn);
          expect(active.has(turn)).toBe(!terminal);
          expect(reservations.has(turn)).toBe(false);
        });
      });
      await scheduler.waitFor(Promise.all(pending));
      for (const { identity: request } of commands) expect(lifecycle.hasPending(request)).toBe(false);
      expect(reservations.size).toBe(0);
      expect(failures).toEqual([]);
    }));
});

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
