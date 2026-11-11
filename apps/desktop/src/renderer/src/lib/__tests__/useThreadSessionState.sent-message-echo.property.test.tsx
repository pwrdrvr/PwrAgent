import { act, renderHook } from "@testing-library/react";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import {
  qualifyThreadUrlsInText,
  type AgentEvent,
  type AppServerReadThreadResponse,
  type AppServerThreadEntry,
  type AppServerThreadMessageEntry,
  type FederationInstanceId,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import type { DesktopApi } from "../desktop-api";
import { useThreadSessionState } from "../useThreadSessionState";

// Rule: for any sent message, once the owner's copy has arrived and the send
// has learned its turn, the transcript holds exactly one copy of it, whatever
// the send path did to its text on the way. Until the owner's copy arrives,
// the pending copy is the only one.
//
// The send path really does rewrite: a federation viewer stamps its own
// instance id onto every bare thread link (`qualifyThreadLinks` in the
// federation backend bridge). Text was the pending copy's only identity, so
// that send showed twice. The model applies the same shared rewrite, plus an
// arbitrary one, so the property does not depend on one link shape.

const THREAD_ID = "sent-echo-thread";
const SENT_TURN = "turn-sent";
const OWNER_MESSAGE_ID = "owner-user-message";
const VIEWER_INSTANCE = "pwr_viewer-instance" as FederationInstanceId;
const CHIP = "[Owner Core](pwragent://thread/2ef4ae7c-1cf3-4ca1-ac07-7f6743d6341a?backend=claude)";

type Rewrite = "none" | "qualify-links" | "replace";
type Step = "bind" | "live" | "snapshot";
type Scenario = {
  sentText: string;
  rewrite: Rewrite;
  replacement: string;
  steps: Step[];
  turnStarted: boolean;
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

function ownerText(scenario: Scenario): string {
  switch (scenario.rewrite) {
    case "none": return scenario.sentText;
    case "qualify-links": return qualifyThreadUrlsInText(scenario.sentText, VIEWER_INSTANCE);
    case "replace": return scenario.replacement;
  }
}

function ownerResponse(echo: AppServerThreadMessageEntry | undefined): AppServerReadThreadResponse {
  const entries = echo ? [...history, echo] : [...history];
  return {
    backend: "codex", threadId: THREAD_ID, fetchedAt: 2_000,
    threadStatus: echo ? "active" : "idle",
    replay: {
      entries,
      messages: entries.flatMap((row) => row.type === "message" ? [row] : []),
      pagination: { supportsPagination: false, hasPreviousPage: false },
    },
  };
}

async function mount() {
  let echo: AppServerThreadMessageEntry | undefined;
  let emit: (event: AgentEvent) => void = () => {
    throw new Error("missing subscription");
  };
  const desktopApi: DesktopApi = {
    onAgentEvent: (listener) => {
      emit = listener;
      return () => undefined;
    },
    readThread: vi.fn(() => Promise.resolve(ownerResponse(echo))),
  };
  const thread: NavigationThreadSummary = {
    id: THREAD_ID, title: "Peer thread", titleSource: "explicit", summary: "Fixture",
    source: "codex", linkedDirectories: [], inbox: { inInbox: false }, updatedAt: 1,
  };
  const hook = renderHook(() => useThreadSessionState({ desktopApi, thread }));
  await act(async () => {});
  expect(hook.result.current.loading).toBe(false);
  return {
    ...hook,
    publish(text: string) {
      echo = {
        type: "message", id: OWNER_MESSAGE_ID, role: "user", text,
        createdAt: 2_000, turn: { id: SENT_TURN, status: "in_progress" },
      };
    },
    emit(method: string, params: Record<string, unknown>) {
      emit({
        backend: "codex",
        notification: { method, params: { threadId: THREAD_ID, ...params } } as AgentEvent["notification"],
      });
    },
  };
}

function sentCopies(entries: readonly AppServerThreadEntry[]): AppServerThreadMessageEntry[] {
  return entries.filter((row): row is AppServerThreadMessageEntry =>
    row.type === "message" && row.role === "user" && row.id !== "earlier-user"
  );
}

async function runScenario(scenario: Scenario) {
  const real = await mount();
  const echoText = ownerText(scenario);
  let optimisticId = "";
  await act(async () => {
    optimisticId = real.result.current.addOptimisticUserMessage(scenario.sentText);
  });
  expect(sentCopies(real.result.current.entries)).toHaveLength(1);

  let bound = false;
  let published = false;
  for (const step of scenario.steps) {
    await act(async () => {
      switch (step) {
        case "bind":
          // What Composer does once startTurn resolves with a started turn.
          real.result.current.bindOptimisticUserMessageToTurn(optimisticId, SENT_TURN);
          real.result.current.setActiveTurnId(SENT_TURN);
          bound = true;
          break;
        case "live": {
          real.publish(echoText);
          published = true;
          if (scenario.turnStarted) {
            real.emit("turn/started", { turn: { id: SENT_TURN, status: "inProgress" } });
          }
          const item = {
            id: OWNER_MESSAGE_ID, type: "userMessage",
            content: [{ type: "text", text: echoText }],
          };
          real.emit("item/started", { turnId: SENT_TURN, item });
          real.emit("item/completed", { turnId: SENT_TURN, item });
          break;
        }
        case "snapshot":
          real.publish(echoText);
          published = true;
          await real.result.current.reload();
          break;
      }
    });
    const copies = sentCopies(real.result.current.entries);
    if (!published) {
      expect(copies, `${step}: before the owner's copy`).toHaveLength(1);
    } else if (bound) {
      expect(copies.map((row) => row.id), `${step}: after echo and bind`).toEqual([OWNER_MESSAGE_ID]);
    }
  }
  real.unmount();
}

const sentTextArbitrary = fc.tuple(
  fc.boolean(),
  fc.constantFrom("try that one", "look here", "ship it", "x"),
).map(([chip, words]) => chip ? `${CHIP} ${words}` : words);

const stepsArbitrary = fc.record({ live: fc.boolean(), snapshot: fc.boolean() })
  .filter(({ live, snapshot }) => live || snapshot)
  .chain(({ live, snapshot }) => {
    const steps: Step[] = ["bind", ...(live ? ["live" as const] : []), ...(snapshot ? ["snapshot" as const] : [])];
    return fc.shuffledSubarray(steps, { minLength: steps.length, maxLength: steps.length });
  });

it("keeps exactly one copy of a sent message whatever the send path does to its text", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        sentText: sentTextArbitrary,
        rewrite: fc.constantFrom<Rewrite>("none", "qualify-links", "replace"),
        replacement: fc.constantFrom("owner recorded this", "", "try that one!"),
        steps: stepsArbitrary,
        turnStarted: fc.boolean(),
      }).filter((scenario) => ownerText(scenario).trim().length > 0),
      runScenario,
    ),
    { numRuns: 120 },
  );
});

it.each<{ name: string; scenario: Scenario }>([
  {
    name: "a federated send whose thread chip gained the viewer's instance id",
    scenario: {
      sentText: `${CHIP} try that one`, rewrite: "qualify-links", replacement: "",
      steps: ["bind", "live", "snapshot"], turnStarted: true,
    },
  },
  {
    name: "a federated echo that arrives before startTurn resolves",
    scenario: {
      sentText: `${CHIP} try that one`, rewrite: "qualify-links", replacement: "",
      steps: ["live", "bind"], turnStarted: false,
    },
  },
  {
    name: "a plain local send with an unchanged echo",
    scenario: {
      sentText: `${CHIP} try that one`, rewrite: "none", replacement: "",
      steps: ["bind", "live", "snapshot"], turnStarted: true,
    },
  },
  {
    name: "a plain local send reconciled by a snapshot alone",
    scenario: {
      sentText: "ship it", rewrite: "none", replacement: "",
      steps: ["snapshot", "bind"], turnStarted: false,
    },
  },
])("keeps one copy for $name", async ({ scenario }) => {
  await runScenario(scenario);
});

it("leaves an unbound pending copy alone when a different turn's user message arrives", async () => {
  // A bound send claims only its own turn's user message. Before the bind,
  // a rewritten echo cannot be told from someone else's message, so the
  // pending copy must stay rather than vanish on a guess.
  const real = await mount();
  await act(async () => {
    real.result.current.addOptimisticUserMessage(`${CHIP} try that one`);
  });
  await act(async () => {
    const item = {
      id: "someone-else", type: "userMessage",
      content: [{ type: "text", text: "a message from another surface" }],
    };
    real.emit("item/completed", { turnId: "turn-other", item });
  });
  expect(sentCopies(real.result.current.entries).map((row) => row.text)).toEqual(
    expect.arrayContaining([`${CHIP} try that one`]),
  );
  real.unmount();
});
