import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { AppServerThreadEntry } from "@pwragent/shared/contracts/normalized-app-server";
import type { DesktopApi } from "../../../lib/desktop-api";
import { Profiler, useLayoutEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useThreadSessionState } from "../../../lib/useThreadSessionState";
import { TranscriptList } from "../TranscriptList";
import { record } from "./scaling-audit-results";

interface LiveThreadWork {
  indicatorVisits: number;
  retentionVisits: number;
  projections: number;
  projectionRows: number;
  backgroundProjections: number;
  commits: number;
  ownerReads: number;
}

declare global {
  var liveThreadWork: LiveThreadWork | undefined;
}

const deliveryState = vi.hoisted(() => ({ backgroundOnly: false }));

vi.mock("../transcript-render-items", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../transcript-render-items")>();
  const buildTranscriptRenderItems: typeof actual.buildTranscriptRenderItems = (input) => {
    const work = globalThis.liveThreadWork;
    if (work) {
      work.projections++;
      work.projectionRows += input.entries.length;
      if (deliveryState.backgroundOnly) work.backgroundProjections++;
    }
    return actual.buildTranscriptRenderItems(input);
  };
  return { ...actual, buildTranscriptRenderItems };
});

afterEach(() => {
  globalThis.liveThreadWork = undefined;
  cleanup();
  vi.useRealTimers();
});

type LiveNotification = Extract<AgentEvent["notification"], { method:
  "turn/started" | "item/started" | "item/completed" | "item/commandExecution/outputDelta" | "item/agentMessage/delta"
}>;

const rounds = 4;
const eventsPerRound = 9;
const scenarios = [1, 10, 20].flatMap((n) => [8, 64].flatMap((history) =>
  ["individual", "burst"].map((delivery) => ({ n, history, delivery }))));

function threadWorkload(index: number, history: number) {
  const id = "worker-" + index;
  const turnId = "turn-" + id;
  const thread: NavigationThreadSummary = { id, title: id, source: "codex", titleSource: "explicit", updatedAt: 1000,
    inbox: { inInbox: false }, linkedDirectories: [] };
  const entries: AppServerThreadEntry[] = Array.from({ length: history }, (_, i) => ({
    id: id + "-history-" + i, type: "message", role: i % 2 ? "assistant" : "user", text: "Fixture history " + i,
  }));
  const ids = { threadId: id, turnId };
  const event = (notification: LiveNotification) => ({ backend: "codex" as const, notification });
  const start = event({ method: "turn/started", params: { ...ids, turn: { id: turnId, status: "inProgress" } } });
  const sequence: ReturnType<typeof event>[] = [];
  const tools: [string, string][] = [];
  const replies: string[] = [];
  for (let round = 0; round < rounds; round++) {
    // Item IDs are deliberately reused between threads. Only their contents identify the owner.
    const tool = {
      type: "commandExecution", id: "call-" + round,
      command: (round % 2 ? "inspect " : "list ") + id + "/" + round,
    };
    const output = [0, 1, 2].map((chunk) => id + "/result-" + round + "/" + chunk + (chunk === 2 ? "" : "\n"));
    const parts = ["Observed ", id + "/answer-" + round, ". Continuing."];
    const message = { id: "reply-" + round, type: "agentMessage", text: parts.join("") };
    const started = { ...tool, status: "inProgress" };
    sequence.push(event({ method: "item/started", params: { ...ids, item: started } }));
    for (const delta of output) {
      sequence.push(event({ method: "item/commandExecution/outputDelta", params: { ...ids, itemId: tool.id, delta } }));
    }
    // Some completions provide canonical output. Others rely entirely on accumulated deltas.
    const completed = { ...tool, status: "completed", exitCode: 0, ...(round % 2 ? {} : { aggregatedOutput: output.join("") }) };
    sequence.push(event({ method: "item/completed", params: { ...ids, item: completed } }));
    for (const delta of parts) {
      sequence.push(event({ method: "item/agentMessage/delta", params: { ...ids, itemId: message.id, delta } }));
    }
    sequence.push(event({ method: "item/completed", params: { ...ids, item: message } }));
    tools.push([tool.id, output.join("")]);
    replies.push(message.text);
  }
  return { thread, entries, start, sequence, tools, replies };
}

it.each(scenarios)("streams $n concurrent turns over $history prior entries ($delivery)", async ({ n, history, delivery }) => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
  vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
  const lanes = Array.from({ length: n }, (_, i) => threadWorkload(i, history));
  const byId = new Map(lanes.map((lane) => [lane.thread.id, lane]));
  let ownerReads = 0;
  const listeners = new Set<(event: AgentEvent) => void>();
  const desktopApi: DesktopApi = {
    onAgentEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async readThread({ threadId }) {
      ownerReads++;
      return { backend: "codex", threadId, fetchedAt: Date.now(), replay: {
        entries: byId.get(threadId)!.entries, messages: [], pagination: { supportsPagination: false, hasPreviousPage: false },
      } };
    },
  };
  type Lane = typeof lanes[number];
  type Event = Lane["sequence"][number];
  let selected!: ReturnType<typeof useThreadSessionState>;
  function Window({ lane }: { lane: Lane }) {
    const session = useThreadSessionState({ desktopApi, thread: lane.thread });
    useLayoutEffect(() => { selected = session; });
    return <TranscriptList threadId={lane.thread.id} parentThreadBackend="codex" activeTurnId={session.activeTurnId}
      entries={session.entries} pendingAssistantMessage={session.pendingAssistantMessage}
      loading={session.loading} loadingMore={session.loadingMore} onLoadOlder={session.loadOlder} />;
  }
  const commits = () => { if (globalThis.liveThreadWork) globalThis.liveThreadWork.commits++; };
  const view = (lane: Lane) => <Profiler id="thread-window" onRender={commits}><Window lane={lane} /></Profiler>;
  const window = render(view(lanes[0]));
  const open = async (lane: Lane) => {
    await act(async () => { window.rerender(view(lane)); });
    expect(selected.response?.threadId).toBe(lane.thread.id);
  };
  const dispatch = (event: AgentEvent) => { for (const listener of listeners) listener(event); };
  // One real session cache and one visible transcript, as in a desktop window.
  for (const lane of lanes) {
    await open(lane);
    act(() => dispatch(lane.start));
  }
  await open(lanes[0]);
  expect(Object.keys(selected.thinkingThreadKeys)).toHaveLength(n);
  const thinking = selected.thinkingThreadKeys;
  const approvals = selected.approvalRequestThreadKeys;
  const inputs = selected.inputRequestThreadKeys;
  const work: LiveThreadWork = { indicatorVisits: 0, retentionVisits: 0, projections: 0, projectionRows: 0, backgroundProjections: 0, commits: 0, ownerReads: 0 };
  const readsBeforeStreaming = ownerReads;
  let events = 0;
  let batches = 0;
  const send = (batch: Event[]) => {
    batches++;
    globalThis.liveThreadWork = work;
    deliveryState.backgroundOnly = batch.every((event) => event.notification.params.threadId !== lanes[0].thread.id);
    try {
      act(() => { for (const event of batch) dispatch(event); });
    } finally {
      globalThis.liveThreadWork = undefined;
    }
    expect(selected.thinkingThreadKeys).toBe(thinking);
    expect(selected.approvalRequestThreadKeys).toBe(approvals);
    expect(selected.inputRequestThreadKeys).toBe(inputs);
    events += batch.length;
  };
  const details = () => selected.entries.flatMap((entry) => entry.type === "activity" ? entry.details ?? [] : []);
  const steps = lanes[0].sequence.length;
  // Stagger the turns so one thread can start its next tool while another streams prose.
  for (let tick = 0; tick < steps + Math.min(n - 1, 4); tick++) {
    const wave = lanes.flatMap((lane, index) => lane.sequence[tick - index % 5] ?? []);
    if (delivery === "burst") send(wave);
    else for (const event of wave) send([event]);
    if (tick < steps && tick % eventsPerRound === 0) {
      const toggle = [...window.container.querySelectorAll(".transcript-activity__toggle")].at(-1);
      if (!toggle) throw new Error("Missing focused tool disclosure");
      if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
    }
    if (tick < steps && tick % eventsPerRound === 3) {
      const round = Math.floor(tick / eventsPerRound);
      const [id, output] = lanes[0].tools[round];
      expect(details().find((detail) => detail.id === id)?.command?.output).toBe(output);
      expect(window.container.textContent).toContain(output.trimEnd());
    }
    if (tick < steps && tick % eventsPerRound === 7) {
      expect(selected.pendingAssistantMessage?.text).toBe(lanes[0].replies[Math.floor(tick / eventsPerRound)]);
    }
    if (tick < steps && tick % eventsPerRound === 8) {
      expect(window.container.textContent).toContain(lanes[0].replies[Math.floor(tick / eventsPerRound)]);
    }
    // A fixed virtual cadence makes preview and frame callbacks reproducible.
    globalThis.liveThreadWork = work;
    deliveryState.backgroundOnly = false;
    try {
      act(() => { vi.advanceTimersByTime(16); });
    } finally {
      globalThis.liveThreadWork = undefined;
    }
  }
  expect(events).toBe(n * rounds * eventsPerRound);
  // Read back every warm thread through normal selection. Verify no lost chunks,
  // cross-thread contamination or reordered calls/replies after interleaving.
  for (const lane of lanes) {
    await open(lane);
    const transcript = selected.entries.flatMap((entry): string[][] => {
      if (entry.type === "activity") return entry.details.map((detail) => [detail.id, detail.command?.output ?? ""]);
      if (entry.type === "message" && entry.id.startsWith("reply-")) return [[entry.id, entry.text]];
      return [];
    });
    expect(transcript).toEqual(lane.tools.flatMap((tool, i) => [tool, ["reply-" + i, lane.replies[i]]]));
  }
  work.ownerReads = ownerReads - readsBeforeStreaming;
  // Keep the merged audit replayable on its original full-scan implementation.
  // For keyed updates, each event may visit only its own session in either path.
  const keyed = process.env.AUDIT_KEYED_SESSIONS === "1";
  const budgets: LiveThreadWork = {
    retentionVisits: keyed ? events : n * events,
    indicatorVisits: keyed ? events : 3 * n * batches,
    backgroundProjections: 0,
    projections: steps,
    projectionRows: steps * (history + rounds * 2 + 1),
    commits: batches + rounds * 8,
    ownerReads: 0,
  };
  record({ kind: "live-threads", n, history, delivery, events, batches, budgets, ...work });
  expect(work.retentionVisits).toBeGreaterThan(0);
  expect(work.indicatorVisits).toBeGreaterThan(0);
  for (const key of Object.keys(budgets) as (keyof LiveThreadWork)[]) {
    expect(work[key], key).toBeLessThanOrEqual(budgets[key]);
  }
});
