import { act, renderHook } from "@testing-library/react";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { type AgentEvent } from "@pwragent/shared/contracts/agent";
import {
  type AppServerReadThreadResponse,
  type AppServerThreadEntry,
  type AppServerThreadMessageEntry,
} from "@pwragent/shared/contracts/normalized-app-server";
import { type NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { DesktopApi } from "../desktop-api";
import { useThreadSessionState } from "../useThreadSessionState";

// Rule: a steer joins the turn it steers. For any sent prompt and any steers
// delivered into its turn, the turn's user rows read [prompt, ...steers] in
// the order the owner accepted them, at every step: the prompt never
// disappears and no steer takes its place.
//
// Oracle: the owner's replay of the same turn, which records the prompt as
// `user:<turnId>` and each accepted steer after it. ACP owners before #4413
// published no live user item for the prompt itself, so the pending copy was
// still waiting when the first steer's item landed. A steer is in the sent
// turn but is not the send, so it must not claim that pending copy.
//
// The owner can also start a turn this window holds no pending copy of: a
// steer that missed its turn and started the next one, or a queued release.
// Its prompt then shows live only through the owner's copy.

const THREAD_ID = "steer-echo-thread";
const SENT_TURN = "pending:steer-echo-thread:1000";
const PROMPT_ID = `user:${SENT_TURN}`;

type Backend = "acp" | "codex";
type Step = { kind: "steer"; text: string } | { kind: "assistant"; text: string } | { kind: "snapshot" };
type Scenario = {
  backend: Backend;
  prompt: string;
  /** The owner publishes the prompt's own user item; ACP owners before #4413 did not. */
  promptEcho: boolean;
  /** That item reaches the window before startTurn's response binds the send. */
  echoBeforeBind: boolean;
  /** This window sent the prompt, so it holds a pending copy. */
  sentHere: boolean;
  steps: Step[];
};

const history: AppServerThreadEntry[] = [
  {
    type: "message", id: "earlier-user", role: "user", text: "an earlier question",
    createdAt: 1_000, turn: { id: "turn-earlier", status: "completed" },
  },
  {
    type: "message", id: "earlier-answer", role: "assistant", text: "an earlier answer",
    phase: "final", createdAt: 1_500, turn: { id: "turn-earlier", status: "completed" },
  },
];

function steerId(index: number): string {
  return `user:${SENT_TURN}:steer:queued-turn-${index}`;
}

function ownerResponse(
  backend: AppServerReadThreadResponse["backend"],
  owned: AppServerThreadEntry[],
): AppServerReadThreadResponse {
  const entries = [...history, ...owned];
  return {
    backend, threadId: THREAD_ID, fetchedAt: 2_000,
    threadStatus: owned.length > 0 ? "active" : "idle",
    replay: {
      entries,
      messages: entries.flatMap((row) => row.type === "message" ? [row] : []),
      pagination: { supportsPagination: false, hasPreviousPage: false },
    },
  };
}

async function mount(backend: Backend) {
  // What the owner has recorded for the sent turn, in acceptance order.
  const owned: AppServerThreadEntry[] = [];
  const source = backend === "acp" ? "acp:antigravity" : "codex";
  let emit: (event: AgentEvent) => void = () => {
    throw new Error("missing subscription");
  };
  const desktopApi: DesktopApi = {
    onAgentEvent: (listener) => {
      emit = listener;
      return () => undefined;
    },
    readThread: vi.fn(() => Promise.resolve(ownerResponse(source, owned))),
  };
  const thread: NavigationThreadSummary = {
    id: THREAD_ID, title: "Steered thread", titleSource: "explicit", summary: "Fixture",
    source, linkedDirectories: [], inbox: { inInbox: false }, updatedAt: 1,
  };
  const hook = renderHook(() => useThreadSessionState({ desktopApi, thread }));
  await act(async () => {});
  expect(hook.result.current.loading).toBe(false);
  return {
    ...hook,
    owned,
    emit(method: string, params: Record<string, unknown>) {
      emit({
        backend: source,
        notification: { method, params: { threadId: THREAD_ID, ...params } } as AgentEvent["notification"],
      });
    },
  };
}

function turnUserTexts(entries: readonly AppServerThreadEntry[]): string[] {
  return entries
    .filter((row): row is AppServerThreadMessageEntry =>
      row.type === "message" && row.role === "user" && row.id !== "earlier-user")
    .map((row) => row.text);
}

async function runScenario(scenario: Scenario) {
  const real = await mount(scenario.backend);
  const turn = { id: SENT_TURN, status: "in_progress" as const };
  const expected = [scenario.prompt];
  // One clock: the owner records the prompt when it is sent and accepts
  // each steer after that.
  let createdAt = Date.now();
  real.owned.push({
    type: "message", id: PROMPT_ID, role: "user", text: scenario.prompt, createdAt, turn,
  });

  await act(async () => {
    const optimisticId = scenario.sentHere
      ? real.result.current.addOptimisticUserMessage(scenario.prompt)
      : undefined;
    real.emit("turn/started", { turn: { id: SENT_TURN, status: "inProgress" } });
    const echo = () => {
      if (!scenario.promptEcho) return;
      const item = { id: PROMPT_ID, type: "userMessage", text: scenario.prompt };
      // Codex reports the item starting and completing; the ACP owner
      // publishes only its completion once the agent accepts the prompt.
      if (scenario.backend === "codex") real.emit("item/started", { turnId: SENT_TURN, item });
      real.emit("item/completed", { turnId: SENT_TURN, item });
    };
    if (scenario.echoBeforeBind) echo();
    if (optimisticId) {
      // What Composer does once startTurn resolves with the started turn.
      real.result.current.bindOptimisticUserMessageToTurn(optimisticId, SENT_TURN);
    }
    real.result.current.setActiveTurnId(SENT_TURN);
    if (!scenario.echoBeforeBind) echo();
  });
  expect(turnUserTexts(real.result.current.entries), "after the send").toEqual(expected);

  let steers = 0;
  let replies = 0;
  for (const step of scenario.steps) {
    createdAt += 100;
    await act(async () => {
      switch (step.kind) {
        case "steer": {
          const id = steerId(steers++);
          real.owned.push({ type: "message", id, role: "user", text: step.text, createdAt, turn });
          expected.push(step.text);
          // The shape the ACP adapter publishes once the provider accepts
          // the steer; Codex reports its steers as plain user items.
          real.emit("item/completed", {
            turnId: SENT_TURN,
            item: {
              id, type: "userMessage", text: step.text, createdAt,
              ...(scenario.backend === "acp" ? { steered: true } : {}),
            },
          });
          break;
        }
        case "assistant": {
          const itemId = `assistant:${SENT_TURN}:${replies++}`;
          real.owned.push({
            type: "message", id: itemId, role: "assistant", text: step.text, phase: "commentary", createdAt, turn,
          });
          real.emit("item/agentMessage/delta", {
            turnId: SENT_TURN, itemId, delta: step.text, phase: "commentary",
          });
          break;
        }
        case "snapshot":
          await real.result.current.reload();
          break;
      }
    });
    expect(turnUserTexts(real.result.current.entries), `after ${step.kind}`).toEqual(expected);
  }
  real.unmount();
}

const promptArbitrary = fc.constantFrom(
  "I started Dev instance. Proceed with the cohort.",
  "ship it",
  "x",
);

// A steer may repeat the prompt's words: the operator can steer with
// "continue" after sending "continue", and the steer still only joins the turn.
const stepArbitrary = (prompt: string) => fc.oneof(
  fc.constantFrom(prompt, "I exited the Dev instance", "stop and rebase", "ship it now", "y")
    .map((text): Step => ({ kind: "steer", text })),
  fc.constantFrom("Reading files", "Checking the build")
    .map((text): Step => ({ kind: "assistant", text })),
  fc.constant<Step>({ kind: "snapshot" }),
);

it("keeps the sent prompt above every steer delivered into its turn", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        backend: fc.constantFrom<Backend>("acp", "codex"),
        prompt: promptArbitrary,
        promptEcho: fc.boolean(),
        echoBeforeBind: fc.boolean(),
        sentHere: fc.boolean(),
      })
        // Codex always echoes the prompt. A turn this window did not send
        // shows its prompt live only through that echo.
        .filter((s) => (s.backend === "acp" || s.promptEcho) && (s.sentHere || s.promptEcho))
        .chain((setup) => fc.record({
          steps: fc.array(stepArbitrary(setup.prompt), { minLength: 1, maxLength: 5 })
            .filter((steps) => steps.some((step) => step.kind === "steer")),
        }).map(({ steps }): Scenario => ({ ...setup, steps }))),
      runScenario,
    ),
    { numRuns: 80 },
  );
});

it("shows the prompt of a turn the owner started from a late steer", async () => {
  // The live sequence from an Antigravity thread: a steer sent as the turn
  // ended started the next turn. The window held no pending copy, the owner
  // published none, and the replies drew under no prompt until a reload.
  await runScenario({
    backend: "acp",
    prompt: "Is that thread on the M4 Mini also fixing that?",
    promptEcho: true,
    echoBeforeBind: false,
    sentHere: false,
    steps: [
      { kind: "assistant", text: "Reading files" },
      { kind: "steer", text: "stop and rebase" },
    ],
  });
});

it("keeps an Antigravity prompt when the steer repeats its words", async () => {
  await runScenario({
    backend: "acp",
    prompt: "ship it",
    promptEcho: false,
    echoBeforeBind: false,
    sentHere: true,
    steps: [
      { kind: "steer", text: "ship it" },
      { kind: "assistant", text: "Reading files" },
      { kind: "snapshot" },
    ],
  });
});

it("keeps an Antigravity prompt when a steer lands between two replies", async () => {
  // The live sequence from an Antigravity thread: the prompt vanished and the
  // steer drew in its slot at the top of the turn until the window reloaded.
  await runScenario({
    backend: "acp",
    prompt: "I started Dev instance. Proceed with the cohort.",
    promptEcho: false,
    echoBeforeBind: false,
    sentHere: true,
    steps: [
      { kind: "assistant", text: "Reading files" },
      { kind: "steer", text: "I exited the Dev instance" },
      { kind: "assistant", text: "Checking the build" },
      { kind: "snapshot" },
    ],
  });
});
