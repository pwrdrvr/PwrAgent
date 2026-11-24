import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
  BackendAcpRuntimeCapabilities,
  BackendAcpRuntimeConfigOption,
  BackendSummary,
} from "../contracts/backend";
import type {
  AppServerBackendKind,
  ThreadExecutionMode,
} from "../contracts/normalized-app-server";
import {
  formatAntigravityAccessStateLabel,
  launchpadPatchForProviderAccessOption,
  normalizeAntigravityAccessTarget,
  planAntigravityAccessTransition,
  resolveProviderAccessControl,
  sameAntigravityAccessState,
  type AntigravityAccessState,
} from "../provider-access-mode";
import { resolveThreadTodoStartAccess } from "../thread-todo-access";

const BACKEND_KINDS: readonly AppServerBackendKind[] = [
  "codex",
  "claude",
  "acp:antigravity",
  "acp:kimi",
  "acp:grok",
  "acp:qwen",
  "acp:gemini",
];

const MODE_IDS = ["default", "accept-edits", "auto", "auto-edit", "plan", "yolo", "full-access"] as const;

const modeIdsArb = fc.uniqueArray(fc.constantFrom(...MODE_IDS), { maxLength: 6 });

const configOptionArb: fc.Arbitrary<BackendAcpRuntimeConfigOption> = fc.record({
  id: fc.constantFrom("permission_mode", "mode", "approval", "model"),
  category: fc.constantFrom("mode", "model", undefined),
  values: modeIdsArb,
}).map(({ id, category, values }) => ({
  id,
  label: id,
  type: "select",
  ...(category ? { category } : {}),
  values: values.map((value) => ({ value, label: value })),
}) as BackendAcpRuntimeConfigOption);

const runtimeArb: fc.Arbitrary<BackendAcpRuntimeCapabilities | undefined> = fc.option(
  fc.record({
    configOptions: fc.option(
      fc.uniqueArray(configOptionArb, { selector: (option) => option.id, maxLength: 3 }),
      { nil: undefined },
    ),
    sessionModes: fc.option(modeIdsArb, { nil: undefined }),
  }).map(({ configOptions, sessionModes }) => ({
    schemaVersion: 1,
    status: "discovered",
    ...(configOptions ? { configOptions } : {}),
    ...(sessionModes
      ? { modes: { availableModes: sessionModes.map((id) => ({ id, label: id })) } }
      : {}),
  }) as unknown as BackendAcpRuntimeCapabilities),
  { nil: undefined },
);

const backendArb = fc.record({
  kind: fc.constantFrom(...BACKEND_KINDS),
  executionModes: fc.subarray<ThreadExecutionMode>(["default", "auto", "full-access"]),
  runtime: runtimeArb,
}).map(({ kind, executionModes, runtime }) => ({
  kind,
  label: kind,
  available: true,
  executionModes: executionModes.map((mode) => ({
    mode,
    label: mode === "auto" ? "Auto" : mode === "full-access" ? "Full Access" : "Default Access",
    available: true,
    ...(mode === "default" ? { isDefault: true } : {}),
  })),
  ...(kind.startsWith("acp:")
    ? {
        acp: {
          registryId: kind.slice(4),
          distributionKinds: ["local"],
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          ...(runtime ? { runtime } : {}),
        },
      }
    : {}),
}) as unknown as BackendSummary);

describe("resolveProviderAccessControl properties", () => {
  it("always produces unique option values, never exposes native yolo on Antigravity, and round-trips every launchpad selection", () => {
    fc.assert(
      fc.property(backendArb, fc.nat(), (backend, pickIndex) => {
        const control = resolveProviderAccessControl({ backend });
        if (!control) {
          return;
        }
        const values = control.options.map((option) => option.value);
        expect(new Set(values).size).toBe(values.length);

        if (backend.kind === "acp:antigravity" && backend.executionModes.length > 0) {
          expect(control.options.some((option) => option.kind === "acp" && option.value === "yolo")).toBe(false);
          expect(control.options.filter((option) => option.value === "default").length).toBeLessThanOrEqual(1);
        }

        const picked = control.options[pickIndex % control.options.length]!;
        const patch = launchpadPatchForProviderAccessOption({
          option: picked,
          currentAcpRuntime: { currentModeId: "plan", configValues: { mode: "plan" } },
        });
        const after = resolveProviderAccessControl({
          backend,
          state: {
            executionMode: patch.executionMode,
            acpRuntime: patch.acpRuntime,
          },
        });
        expect(after?.value).toBe(picked.value);
        expect(after?.selectedOption?.value).toBe(picked.value);
      }),
      { numRuns: 500 },
    );
  });

  it("matches resolveThreadTodoStartAccess option sets for every provider", () => {
    fc.assert(
      fc.property(backendArb, (backend) => {
        const control = resolveProviderAccessControl({ backend });
        const card = resolveThreadTodoStartAccess({
          card: {},
          sourceBackend: backend.kind,
          sourceExecutionMode: "default",
          destination: backend,
          destinationBackend: backend.kind,
        });
        const controlIds = control?.options.map((option) => option.value) ?? [];
        const cardIds = card.options.map((option) => option.kind === "mode" ? option.mode : option.id);
        expect(controlIds).toEqual(cardIds);
      }),
      { numRuns: 500 },
    );
  });
});

describe("Antigravity explicit access state machine model", () => {
  type State = {
    applied: AntigravityAccessState;
    queued?: AntigravityAccessState;
    turnActive: boolean;
  };

  type Command =
    | { type: "select"; executionMode: ThreadExecutionMode; nativeMode?: string }
    | { type: "start_turn" }
    | { type: "finish_turn" }
    | { type: "cancel_queue" };

  const commandArb: fc.Arbitrary<Command> = fc.oneof(
    fc.record({
      type: fc.constant("select" as const),
      executionMode: fc.constantFrom<ThreadExecutionMode>("default", "full-access"),
      nativeMode: fc.option(fc.constantFrom("default", "accept-edits", "auto", "plan", "yolo"), { nil: undefined }),
    }),
    fc.constant({ type: "start_turn" as const }),
    fc.constant({ type: "finish_turn" as const }),
    fc.constant({ type: "cancel_queue" as const }),
  );

  it("maintains canonical invariants across every arbitrary sequence of selections and turns", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<"default" | "full-access">("default", "full-access"),
        fc.constantFrom("default", "accept-edits", "auto", "plan"),
        fc.array(commandArb, { maxLength: 40, size: "max" }),
        (initialExec, initialNative, commands) => {
          const state: State = {
            applied: normalizeAntigravityAccessTarget({
              executionMode: initialExec,
              nativeMode: initialNative,
            }),
            turnActive: false,
          };

          const assertInvariants = () => {
            // Full Access NEVER carries a non-default native mode such as Plan.
            if (state.applied.executionMode === "full-access") {
              expect(state.applied.nativeMode).toBe("default");
            }
            if (state.queued?.executionMode === "full-access") {
              expect(state.queued.nativeMode).toBe("default");
            }
            // A queued transition is never identical to applied state.
            if (state.queued) {
              expect(sameAntigravityAccessState(state.queued, state.applied)).toBe(false);
            }
            // Label is always non-empty and canonical.
            expect(formatAntigravityAccessStateLabel(state.applied).length).toBeGreaterThan(0);
          };

          assertInvariants();
          for (const command of commands) {
            switch (command.type) {
              case "select": {
                const action = planAntigravityAccessTransition({
                  applied: state.applied,
                  queued: state.queued,
                  turnActive: state.turnActive,
                  requested: {
                    executionMode: command.executionMode,
                    nativeMode: command.nativeMode,
                  },
                });
                switch (action.type) {
                  case "noop":
                    break;
                  case "cancel_queue":
                    expect(state.queued).toBeDefined();
                    state.queued = undefined;
                    break;
                  case "queue":
                    expect(state.turnActive).toBe(true);
                    state.queued = action.target;
                    break;
                  case "move_process":
                    expect(state.turnActive).toBe(false);
                    expect(action.target.executionMode).not.toBe(state.applied.executionMode);
                    state.applied = action.target;
                    state.queued = undefined;
                    break;
                  case "set_native_mode":
                    expect(state.turnActive).toBe(false);
                    expect(action.target.executionMode).toBe("default");
                    expect(state.applied.executionMode).toBe("default");
                    expect(action.target.nativeMode).not.toBe(state.applied.nativeMode);
                    state.applied = action.target;
                    state.queued = undefined;
                    break;
                }
                break;
              }
              case "start_turn":
                if (!state.turnActive) {
                  state.turnActive = true;
                }
                break;
              case "finish_turn":
                if (state.turnActive) {
                  state.turnActive = false;
                  if (state.queued) {
                    state.applied = state.queued;
                    state.queued = undefined;
                  }
                }
                break;
              case "cancel_queue":
                state.queued = undefined;
                break;
            }
            assertInvariants();
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
