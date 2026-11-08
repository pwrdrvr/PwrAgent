import fc from "fast-check";
import { expect, it } from "vitest";
import { ThreadTurnStartLifecycle, type CodexTurnSubmissionHost, type TurnStartIdentity } from "../thread-turn-start-lifecycle";

function lifecycle() {
  return new ThreadTurnStartLifecycle({
    assertAvailable: () => {},
    withMutation: async (_identity, work) => await work(),
    assertUnlocked: async () => {},
    wake: async () => {},
  });
}

// The oracle is a resource protocol: notification precedes retirement,
// retirement precedes recovery, and every failed attempt discards its retry.
it("follows the submission failure protocol across generated independent port failures", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(),
    async (providerFails, notificationFails, recoveryAvailable, recoverable, recoveryFails, reportFails) => {
      const effects: string[] = [];
      const providerError = new Error("provider");
      const notificationError = new Error("notification");
      const reportError = new Error("report");
      let reserved = true;
      let retry = true;
      const host: CodexTurnSubmissionHost<string> = {
        identity: { backend: "codex", threadId: "thread" }, pendingTurnId: "pending:thread",
        submit: async () => { effects.push("submit"); if (providerFails) throw providerError; return { threadId: "thread", turnId: "real" }; },
        activeTurns: () => { throw new Error("An explicit response needs no inferred identity"); },
        fail: async (error) => { expect(error).toBe(providerError); effects.push("fail"); if (notificationFails) throw notificationError; },
        retireFailed: () => { effects.push("retire"); reserved = false; },
        discardRetry: () => { effects.push("discard"); retry = false; },
        recovery: recoveryAvailable ? {
          accepts: (error) => { expect(error).toBe(providerError); effects.push("accept"); return recoverable; },
          run: async (message) => {
            expect(message).toBe("provider"); expect(reserved).toBe(false); effects.push("recover");
            if (recoveryFails) throw "repair failed";
            return "recovered";
          },
          failed: async (details) => {
            expect(details).toEqual({ failureMessage: "provider", recoveryError: "repair failed", status: "failed", threadId: "thread", turnId: "pending:thread" });
            effects.push("report"); if (reportFails) throw reportError;
          },
        } : undefined,
      };
      const pending = lifecycle().submitCodex(host);
      const recovers = providerFails && !notificationFails && recoveryAvailable && recoverable;
      if (!providerFails) {
        expect(await pending).toEqual({ kind: "started", turn: { threadId: "thread", turnId: "real" } });
        expect(effects).toEqual(["submit"]);
        expect(reserved && retry).toBe(true); // Successful finalization owns both.
      } else {
        if (recovers && !recoveryFails) expect(await pending).toEqual({ kind: "recovered", response: "recovered" });
        else await expect(pending).rejects.toBe(notificationFails ? notificationError : recovers && reportFails ? reportError : providerError);
        expect(effects).toEqual(["submit", "fail", "retire",
          ...(!notificationFails && recoveryAvailable ? ["accept"] : []),
          ...(recovers ? ["recover", ...(recoveryFails ? ["report"] : [])] : []), "discard"]);
        expect(reserved || retry).toBe(false);
      }
    }));
});

const identityFields = {
  backend: fc.constantFrom("codex" as const, "claude" as const, "acp:grok" as const),
  threadId: fc.constantFrom("same", "same:thread", "other"),
};
const identity = fc.record(identityFields);
const turn = fc.record({ ...identityFields, turnId: fc.constantFrom("pending:same", "real-a", "real-b") });

it("uses only the provider's backend-qualified event stream to resolve incomplete responses", async () => {
  await fc.assert(fc.asyncProperty(identity, fc.boolean(), fc.array(turn, { maxLength: 20 }),
    async (request, incomplete, observed) => {
      const pendingTurnId = `pending:${request.threadId}`;
      const response = { threadId: request.threadId, turnId: incomplete ? pendingTurnId : "explicit" };
      const matching = request.backend === "codex" && incomplete
        ? observed.filter((event) => event.backend === "codex" && event.threadId === request.threadId && !event.turnId.startsWith("pending:"))[0]
        : undefined;
      const result = await lifecycle().submitCodex({
        identity: request, pendingTurnId, submit: async () => response, activeTurns: () => observed,
        fail: async () => { throw new Error("Unexpected failure"); },
        retireFailed: () => { throw new Error("An accepted start retains ownership"); },
        discardRetry: () => { throw new Error("An accepted start retains its retry"); },
      });
      expect(result).toEqual({ kind: "started", turn: matching ? { threadId: response.threadId, turnId: matching.turnId } : response });
    }));
});

it("reads provider identities after the response settles under generated interleavings", async () => {
  await fc.assert(fc.asyncProperty(fc.scheduler(), fc.array(turn, { maxLength: 12 }), async (scheduler, events) => {
    const observed: Array<TurnStartIdentity & { turnId: string }> = [];
    let delivered: typeof observed = [];
    const work = events.map(async (event) => { await scheduler.schedule(Promise.resolve()); observed.push(event); });
    const pending = lifecycle().submitCodex({
      identity: { backend: "codex", threadId: "same" }, pendingTurnId: "pending:same",
      submit: async () => { await scheduler.schedule(Promise.resolve()); delivered = [...observed]; return { threadId: "same", turnId: "pending:same" }; },
      activeTurns: () => observed,
      fail: async () => {}, retireFailed: () => {}, discardRetry: () => {},
    });
    const result = await scheduler.waitFor(pending);
    await scheduler.waitFor(Promise.all(work));
    const first = delivered.find((event) => event.backend === "codex" && event.threadId === "same" && !event.turnId.startsWith("pending:"));
    expect(result).toEqual({ kind: "started", turn: { threadId: "same", turnId: first?.turnId ?? "pending:same" } });
  }));
});

it("discards the retry even when retirement rejects", async () => {
  const discard = { calls: 0 };
  await expect(lifecycle().submitCodex({
    identity: { backend: "codex", threadId: "thread" }, pendingTurnId: "pending:thread",
    submit: async () => { throw new Error("provider"); }, activeTurns: () => [], fail: async () => {},
    retireFailed: () => { throw new Error("retirement"); }, discardRetry: () => { discard.calls += 1; },
  })).rejects.toThrow("retirement");
  expect(discard.calls).toBe(1);
});

it("hands synthetic identity to accepted provider ownership in model order", () => {
  fc.assert(fc.property(identity, fc.boolean(), fc.boolean(), fc.boolean(),
    fc.option(fc.constantFrom("default" as const, "auto" as const, "full-access" as const), { nil: undefined }),
    (request, responseIsPending, terminalObserved, reserved, executionMode) => {
      const effects: unknown[] = [];
      lifecycle().handoffCodex({
        identity: request, pendingTurnId: "pending", turn: { threadId: request.threadId, turnId: responseIsPending ? "pending" : "real" },
        terminalObserved, reserved, executionMode,
        bindReview: () => { effects.push("review"); }, activateCollaboration: () => { effects.push("collaboration"); },
        retirePending: () => { effects.push("retire"); }, activateExecutionMode: (mode) => { effects.push(["mode", mode]); },
        release: () => { effects.push("release"); },
      });
      const active = request.backend === "codex" && !terminalObserved;
      expect(effects).toEqual(["review", ...(active ? ["collaboration"] : []),
        ...(!responseIsPending || terminalObserved ? ["retire"] : []),
        ...(active && executionMode ? [["mode", executionMode]] : []), ...(reserved ? ["release"] : [])]);
    }));
});
