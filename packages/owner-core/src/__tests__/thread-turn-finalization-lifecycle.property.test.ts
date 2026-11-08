import fc from "fast-check";
import { expect, it } from "vitest";
import { ThreadTurnStartLifecycle, type CodexTurnFinalizationStage, type TurnStartIdentity } from "../thread-turn-start-lifecycle";

const lifecycle = () => new ThreadTurnStartLifecycle({
  assertAvailable: () => {},
  withMutation: async <T>(_identity: TurnStartIdentity, work: () => Promise<T>) => await work(),
  assertUnlocked: async () => {},
  wake: async () => {},
});
const stages: CodexTurnFinalizationStage[] = [
  "origin", "retry", "pdf", "context", "persist-origin", "dispose-origin", "review", "collaboration",
  "retire-pending", "execution-ownership", "release", "model", "execution", "attachments", "replay", "forget-title-input", "title",
];
const identity = fc.record({
  backend: fc.constantFrom("codex" as const, "claude" as const, "acp:grok" as const),
  threadId: fc.constantFrom("same", "same:thread", "pending:same"),
});
const optional = <T>(arbitrary: fc.Arbitrary<T>) => fc.option(arbitrary, { nil: undefined });

// Oracle: acceptance is a provider fact. Each independent host effect is
// attempted once in protocol order, and its failure only reports that stage.
it("preserves accepted responses and finalization order for generated failures and settings", async () => {
  await fc.assert(fc.asyncProperty(identity, fc.subarray(stages), fc.boolean(), fc.boolean(), fc.boolean(),
    optional(fc.constantFrom("default" as const, "auto" as const, "full-access" as const)),
    fc.record({ model: optional(fc.string()), reasoningEffort: optional(fc.string()),
      serviceTier: optional(fc.string()), fastMode: optional(fc.boolean()) }),
    fc.boolean(), async (request, failures, terminal, pending, reserved, executionMode, settings, reportingFails) => {
      const effects: CodexTurnFinalizationStage[] = [];
      const reports: CodexTurnFinalizationStage[] = [];
      const pendingTurnId = `pending:${request.threadId}`;
      const turn = { threadId: "provider-thread", turnId: pending ? pendingTurnId : "provider-turn" };
      let observedTerminal = false;
      const step = (stage: CodexTurnFinalizationStage) => {
        effects.push(stage);
        if (failures.includes(stage)) throw new Error(stage);
      };
      const response = await lifecycle().finalizeCodex({
        identity: request, turn, settings, executionMode,
        bindOrigin: () => step("origin"), bindRetry: () => step("retry"),
        bindPdf: () => step("pdf"), bindContext: () => step("context"),
        persistOrigin: async () => { await Promise.resolve(); observedTerminal = terminal; step("persist-origin"); },
        disposeOrigin: () => step("dispose-origin"),
        handoff: { identity: request, turn, pendingTurnId, reserved, get terminalObserved() { return observedTerminal; }, executionMode,
          bindReview: () => step("review"), activateCollaboration: () => step("collaboration"),
          retirePending: () => step("retire-pending"), activateExecutionMode: () => step("execution-ownership"),
          release: () => step("release"),
        },
        persistModel: async () => step("model"), persistExecutionMode: async () => step("execution"),
        retainAttachments: async () => step("attachments"), scheduleReplay: () => step("replay"),
        forgetTitleInput: () => step("forget-title-input"), scheduleTitle: () => step("title"),
        failed: (stage, error) => {
          expect((error as Error).message).toBe(stage);
          reports.push(stage);
          if (reportingFails) throw new Error("reporting");
        },
      });
      const active = request.backend === "codex" && !terminal;
      const expected: CodexTurnFinalizationStage[] = [
        "origin", "retry", "pdf", "context", "persist-origin", "dispose-origin", "review",
        ...(active ? ["collaboration" as const] : []),
        ...(!pending || terminal ? ["retire-pending" as const] : []),
        ...(active && executionMode ? ["execution-ownership" as const] : []),
        ...(reserved ? ["release" as const] : []),
        ...(Object.values(settings).some((value) => value !== undefined) ? ["model" as const] : []),
        ...(request.backend === "codex" && executionMode ? ["execution" as const] : []),
        "attachments", "replay", ...(!request.backend.startsWith("acp:") ? ["forget-title-input" as const, "title" as const] : []),
      ];
      expect(effects).toEqual(expected);
      expect(reports).toEqual(expected.filter((stage) => failures.includes(stage)));
      expect(response).toEqual({ backend: request.backend, ...turn });
    }));
});

// The provider owns terminal state. Generated async schedules place terminals
// before or after handover while other accepted turns share thread id text.
it("never reactivates a provider-terminal turn across concurrent finalization interleavings", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.record({ identity, originFails: fc.boolean() }), { minLength: 1, maxLength: 8 }),
    fc.scheduler(), async (commands, scheduler) => {
      const core = lifecycle();
      const terminals = new Set<number>();
      const active = new Set<number>();
      const pending = new Set(commands.map((_command, i) => i));
      const released = new Set<number>();
      const outcomes = commands.map(({ identity: request, originFails }, i) => {
        const turn = { threadId: request.threadId, turnId: `provider:${i}` };
        const terminal = scheduler.schedule(Promise.resolve(), `terminal:${i}`).then(() => {
          terminals.add(i);
          active.delete(i);
        });
        const finalized = core.finalizeCodex({
          identity: request, turn, settings: {},
          bindOrigin: () => {}, bindRetry: () => {}, bindPdf: () => {}, bindContext: () => {},
          persistOrigin: async () => {
            await scheduler.schedule(Promise.resolve(), `origin:${i}`);
            if (originFails) throw new Error("origin");
          },
          disposeOrigin: () => {},
          handoff: { identity: request, turn, pendingTurnId: `pending:${request.threadId}`,
            reserved: true, get terminalObserved() { return terminals.has(i); }, executionMode: "auto",
            bindReview: () => {}, activateCollaboration: () => {},
            retirePending: () => { pending.delete(i); },
            activateExecutionMode: () => {
              expect(terminals.has(i)).toBe(false);
              active.add(i);
            },
            release: () => { released.add(i); },
          },
          persistModel: async () => {}, persistExecutionMode: async () => {}, retainAttachments: async () => {},
          scheduleReplay: () => {}, forgetTitleInput: () => {}, scheduleTitle: () => {}, failed: () => {},
        }).then((response) => { expect(response).toEqual({ backend: request.backend, ...turn }); });
        return Promise.all([terminal, finalized]);
      });
      await scheduler.waitFor(Promise.all(outcomes));
      expect(active.size).toBe(0);
      expect(pending.size).toBe(0);
      expect(released.size).toBe(commands.length);
    }));
});

it("keeps synchronous identity binding ahead of the first persistence yield", async () => {
  const effects: string[] = [];
  const request = { backend: "codex" as const, threadId: "source" };
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const pending = lifecycle().finalizeCodex({
    identity: request, turn: { threadId: "provider-thread", turnId: "real" }, settings: { fastMode: false },
    bindOrigin: () => { effects.push("origin"); }, bindRetry: () => { effects.push("retry"); },
    bindPdf: () => { effects.push("pdf"); }, bindContext: () => { effects.push("context"); },
    persistOrigin: async () => { effects.push("persist"); await blocked; }, disposeOrigin: () => {},
    handoff: { identity: request, turn: { threadId: "provider-thread", turnId: "real" }, pendingTurnId: "pending:source",
      terminalObserved: false, reserved: true, bindReview: () => {}, activateCollaboration: () => {}, retirePending: () => {},
      activateExecutionMode: () => {}, release: () => {},
    },
    persistModel: async () => { effects.push("model"); }, persistExecutionMode: async () => {},
    retainAttachments: async () => {}, scheduleReplay: () => {}, forgetTitleInput: () => {}, scheduleTitle: () => {}, failed: () => {},
  });
  expect(effects).toEqual(["origin", "retry", "pdf", "context", "persist"]);
  release();
  await pending;
  expect(effects.at(-1)).toBe("model");
});
