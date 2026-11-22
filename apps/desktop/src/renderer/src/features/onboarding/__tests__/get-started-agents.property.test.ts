import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import type { DesktopSettingsSnapshot } from "@pwragent/shared/contracts/settings";
import {
  canStartWithAgents,
  claudeAgentState,
  codexAgentState,
  getStartedAgentAction,
  type CodexSignInState,
  type GetStartedAgentState,
} from "../get-started-agents";

const arbState: fc.Arbitrary<GetStartedAgentState> = fc.oneof(
  fc.constant({ kind: "checking" } as const),
  fc.constant({ kind: "not-installed" } as const),
  fc.constant({ kind: "off" } as const),
  fc.record({ kind: fc.constant("needs-sign-in" as const) }),
  fc.record({ kind: fc.constant("ready" as const) }),
  fc.record({ kind: fc.constant("error" as const), detail: fc.string() }),
);

const arbSignIn: fc.Arbitrary<CodexSignInState> = fc.oneof(
  fc.constant({ kind: "unknown" } as const),
  fc.constant({ kind: "checking" } as const),
  fc.constant({ kind: "starting" } as const),
  fc.record({ kind: fc.constant("waiting" as const) }),
  fc.record({ kind: fc.constant("signed-in" as const) }),
  fc.record({ kind: fc.constant("signed-out" as const), cancelled: fc.boolean() }),
  fc.record({ kind: fc.constant("error" as const), detail: fc.string() }),
);

function snapshot(codexInstalled: boolean): DesktopSettingsSnapshot {
  return {
    models: {
      codex: {
        discovery: {
          candidates: codexInstalled
            ? [{ command: "/usr/local/bin/codex", executable: true, selected: true, version: "1.0.0" }]
            : [],
        },
      },
    },
  } as unknown as DesktopSettingsSnapshot;
}

describe("Get started agent rules", () => {
  it("lets Start through exactly when at least one agent is ready", () => {
    fc.assert(
      fc.property(fc.array(arbState, { maxLength: 8 }), (states) => {
        expect(canStartWithAgents(states)).toBe(states.some((state) => state.kind === "ready"));
      }),
    );
  });

  it("offers a ready or still-checking agent no next step, and every other agent exactly one", () => {
    fc.assert(
      fc.property(arbState, (state) => {
        const action = getStartedAgentAction(state);
        if (state.kind === "ready" || state.kind === "checking") {
          expect(action).toBe("none");
        } else {
          expect(action).not.toBe("none");
        }
      }),
    );
  });

  it("never calls Codex ready without an installed Codex", () => {
    fc.assert(
      fc.property(arbSignIn, fc.boolean(), fc.boolean(), (signIn, discovering, separateLogin) => {
        const state = codexAgentState({ snapshot: snapshot(false), discovering, signIn, separateLogin });
        expect(state.kind).not.toBe("ready");
        expect(state.kind).toBe(discovering ? "checking" : "not-installed");
      }),
    );
  });

  it("calls an installed Codex ready only when signed in here, or when a separate login comes later", () => {
    fc.assert(
      fc.property(arbSignIn, fc.boolean(), (signIn, separateLogin) => {
        const state = codexAgentState({ snapshot: snapshot(true), discovering: false, signIn, separateLogin });
        expect(state.kind === "ready").toBe(separateLogin || signIn.kind === "signed-in");
      }),
    );
  });

  it("calls Claude Code ready only when it is installed, checked, and signed in", () => {
    const arbClaude = fc.record({
      present: fc.boolean(),
      loaded: fc.boolean(),
      discoveryPending: fc.boolean(),
      executable: fc.option(fc.constant("/usr/local/bin/claude"), { nil: undefined }),
      authStatus: fc.constantFrom("signed-in", "sign-in-required", "session-expired", "unknown") as fc.Arbitrary<
        NonNullable<BackendSummary["claude"]>["authStatus"]
      >,
    });
    fc.assert(
      fc.property(arbClaude, (claude) => {
        const backend = claude.present
          ? ({
              kind: "claude",
              label: "Claude Code",
              available: true,
              ...(claude.discoveryPending ? { discoveryPending: true } : {}),
              claude: {
                ...(claude.executable ? { executable: claude.executable } : {}),
                authStatus: claude.authStatus,
              },
            } as BackendSummary)
          : undefined;
        const state = claudeAgentState(backend, claude.loaded);
        expect(state.kind === "ready").toBe(
          claude.present
            && !claude.discoveryPending
            && Boolean(claude.executable)
            && claude.authStatus === "signed-in",
        );
        if (!claude.present) {
          expect(state.kind).toBe(claude.loaded ? "not-installed" : "checking");
        }
      }),
    );
  });
});
