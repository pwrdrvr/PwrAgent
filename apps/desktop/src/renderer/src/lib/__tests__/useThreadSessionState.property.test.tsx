import { act, renderHook } from "@testing-library/react";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type {
  AgentEvent,
  AppServerReadThreadResponse,
  AppServerThreadEntry,
  NavigationThreadSummary,
} from "@pwragent/shared";
import type { DesktopApi } from "../desktop-api";
import { useThreadSessionState } from "../useThreadSessionState";
import { injectPermissionTransitions } from "../../features/thread-detail/permission-transition-entries";

const NOW = 50_123;
type Item = {
  turn: number;
  sequence: number;
  time?: number;
  role: "user" | "assistant";
  tool?: boolean;
  phase?: "commentary" | "final";
  // A user message's text, when it repeats an earlier message's.
  text?: string;
};
type Model = {
  ledger: Item[];
  turn: number;
  active?: number;
  optimistic?: Item;
  optimisticId?: string;
  // Repeated text held by a send that no start has bound to its turn.
  unboundText?: string;
};
type Read = {
  response: AppServerReadThreadResponse;
  resolve: (value: AppServerReadThreadResponse) => void;
  issued: number;
  newest: boolean;
};
// Reads are numbered as they are issued. A row seen on the live stream may
// leave the transcript only once a newest-page read issued after it settles.
type Visibility = { issued: number; settled: number; live: Map<string, number> };
type Real = Awaited<ReturnType<typeof mount>>;
type Operation = "start" | "item" | "redeliver" | "complete" | "send" | "read" | "resolve" | "older" | "compact" | "synthetic";
const key = (item: Item) => `turn-${item.turn}/item-${item.sequence}`;
const textOf = (item: Item) => item.text ?? key(item);
const PROVIDER_ID = /^turn-\d+\/item-\d+$/;
// The ledger item each optimistic id was sent as. Text cannot identify a
// send, because sends may repeat an earlier message's text.
const sentKeys = new Map<string, string>();
const turnMetadata = (turn: number, active?: number) => ({
  id: `turn-${turn}`, status: active === turn ? "in_progress" as const : "completed" as const,
  startedAt: turn > 2 ? 50_000 : 1_000 * (turn + 1),
  ...(active === turn ? {} : { completedAt: turn > 2 ? 50_000 : 1_000 * (turn + 1) + 500 }),
});

function entry(item: Item, active?: number): AppServerThreadEntry {
  if (item.tool) {
    return {
      type: "activity", id: `activity-${key(item)}`, summary: "Used 1 tool", createdAt: item.time,
      details: [{ id: key(item), kind: "command", label: `echo ${key(item)}`, status: "completed" }],
      turn: turnMetadata(item.turn, active),
    };
  }
  return {
    type: "message", id: key(item), role: item.role, text: textOf(item),
    ...(item.role === "assistant" ? { phase: item.phase ?? "commentary" } : {}), createdAt: item.time,
    turn: turnMetadata(item.turn, active),
  };
}

// The provider's ledger owns sequence. Reads may restamp rows but cannot
// establish a different order for items already observed on the live stream.
function response(model: Model, before?: number): AppServerReadThreadResponse {
  const end = before ?? model.ledger.length;
  // thread/read's limit counts turns, not items. Pagination cursors always
  // fall between turns; a live snapshot may contain an unfinished last turn.
  const turns = [...new Set(model.ledger.slice(0, end).map((item) => item.turn))];
  const firstTurn = turns[Math.max(0, turns.length - 2)];
  const start = Math.max(0, model.ledger.findIndex((item) => item.turn === firstTurn));
  const entries: AppServerThreadEntry[] = [];
  for (const item of model.ledger.slice(start, end)) {
    const row = entry(item, model.active);
    const last = entries[entries.length - 1];
    // Provider replay coalesces adjacent tools into one activity bucket, as
    // does the live reducer. Do not fabricate one transcript row per detail.
    if (row.type === "activity" && last?.type === "activity" && last.turn?.id === row.turn?.id) {
      last.details.push(...row.details);
    } else {
      entries.push(row);
    }
  }
  return {
    backend: "codex", threadId: "ledger-thread", fetchedAt: NOW,
    threadStatus: model.active === undefined ? "idle" : "active",
    replay: {
      entries,
      messages: entries.flatMap((row) => row.type === "message" ? [row] : []),
      pagination: { supportsPagination: true, hasPreviousPage: start > 0,
        ...(start > 0 ? { previousCursor: String(start) } : {}) },
    },
  };
}

async function mount(model: Model) {
  const reads: Read[] = [];
  sentKeys.clear();
  const visibility: Visibility = { issued: 0, settled: 0, live: new Map() };
  let emit: (event: AgentEvent) => void = () => { throw new Error("missing subscription"); };
  let first = true;
  const desktopApi: DesktopApi = {
    onAgentEvent: (listener) => { emit = listener; return () => undefined; },
    readThread: vi.fn(({ before }) => {
      const snapshot = response(model, before === undefined ? undefined : Number(before));
      const issued = ++visibility.issued;
      if (first) { first = false; visibility.settled = issued; return Promise.resolve(snapshot); }
      return new Promise<AppServerReadThreadResponse>((resolve) => reads.push({
        response: snapshot, issued, newest: before === undefined,
        resolve: (value) => {
          if (before === undefined) visibility.settled = Math.max(visibility.settled, issued);
          resolve(value);
        },
      }));
    }),
  };
  const thread: NavigationThreadSummary = {
    id: "ledger-thread", title: "Provider ledger", titleSource: "explicit", summary: "Fixture",
    source: "codex", linkedDirectories: [], inbox: { inInbox: false }, updatedAt: 1,
  };
  const hook = renderHook(() => useThreadSessionState({ desktopApi, thread, initialHistoryLimit: 2 }));
  // Async act flushes passive effects as well as the read's promise. No findBy
  // polling or real sleeps: the model supplies every asynchronous boundary.
  await act(async () => {});
  expect(hook.result.current.loading).toBe(false);
  return { ...hook, reads, visibility, trace: [] as string[], emit: (method: string, params: Record<string, unknown>) => emit({
    backend: "codex", notification: { method, params: { threadId: "ledger-thread", ...params } } as AgentEvent["notification"],
  }) };
}

function assertLedger(model: Model, real: Real, rows = real.result.current.entries) {
  expect(new Set(Array.from(rows, (row) => row.id)).size, real.trace.join(" → ")).toBe(rows.length);
  const ledger = [...model.ledger, ...(model.optimistic ? [model.optimistic] : [])];
  const positions = new Map(ledger.map((item, index) => [key(item), index]));
  // A send's optimistic id resolves to its ledger item, so an optimistic row
  // and its acknowledged provider row cannot hide a duplicate.
  const keys = logicalKeys(rows);
  expect(new Set(keys).size, real.trace.join(" → ")).toBe(keys.length);
  const ranks = keys.map((id) => {
    expect(positions.has(id), `unknown provider item ${id}`).toBe(true);
    return positions.get(id)!;
  });
  expect(ranks, real.trace.join(" → ")).toEqual([...ranks].sort((a, b) => a - b));
  expect(real.result.current.activeTurnId).toBe(model.active === undefined ? undefined : `turn-${model.active}`);
}

function assertLiveRowsVisible(real: Real) {
  const rendered = new Set(logicalKeys(real.result.current.entries));
  for (const [id, issuedBefore] of real.visibility.live) {
    if (real.visibility.settled > issuedBefore) {
      real.visibility.live.delete(id);
      continue;
    }
    // No read issued after this row was observed has settled, so no page can
    // have covered its turn. Hiding it now loses it until a later read lands.
    expect(rendered.has(id), `${id} hidden before a read covered it: ${real.trace.join(" → ")}`).toBe(true);
  }
}

function logicalKeys(rows: AppServerThreadEntry[]): string[] {
  return Array.from(rows).flatMap((row) => row.type === "message"
    ? [sentKeys.get(row.id) ?? (PROVIDER_ID.test(row.id) ? row.id : row.text)]
    : row.type === "activity" ? row.details.map((detail) => detail.id) : []);
}

class LedgerCommand implements fc.AsyncCommand<Model, Real> {
  constructor(readonly operation: Operation, readonly clock = 0, readonly reverse = false) {}
  check(model: Readonly<Model>) {
    switch (this.operation) {
      case "start": return model.active === undefined;
      case "send": return model.active === undefined && !model.optimistic;
      case "item": return model.active !== undefined;
      case "redeliver": return model.active !== undefined && model.ledger.some((item) =>
        item.turn === model.active && !item.tool && item.role === "assistant"
      );
      case "complete": return model.active !== undefined && model.ledger.some((item) => item.turn === model.active);
      case "compact": return model.active === undefined && !model.optimistic;
      default: return true;
    }
  }
  async run(model: Model, real: Real) {
    real.trace.push(this.toString());
    await act(async () => {
      switch (this.operation) {
        case "send": {
          // reverse repeats the first message's text, as when "continue" is
          // sent again. Only the send's turn can tell the two apart. The app
          // binds a send once startTurn resolves, so two unbound sends never
          // share a text for long: text alone could not tell them apart.
          const repeated = textOf(model.ledger[0]!);
          model.optimistic = { turn: model.turn + 1, sequence: 0, role: "user", time: NOW,
            ...(this.reverse && model.unboundText !== repeated ? { text: repeated } : {}) };
          model.optimisticId = real.result.current.addOptimisticUserMessage(textOf(model.optimistic));
          if (model.optimisticId) sentKeys.set(model.optimisticId, key(model.optimistic));
          break;
        }
        case "start": {
          model.active = ++model.turn;
          real.emit("turn/started", { turn: turnMetadata(model.turn, model.active) });
          if (model.optimistic) {
            const item = model.optimistic;
            model.ledger.push(item);
            model.optimistic = undefined;
            // startTurn can resolve before the owner echoes the sent message,
            // which binds the pending copy to the turn it opened.
            if (this.reverse && model.optimisticId) {
              real.result.current.bindOptimisticUserMessageToTurn(model.optimisticId, `turn-${item.turn}`);
            } else if (item.text) {
              model.unboundText = item.text;
            }
            // The owner's echo of the sent message. A window can miss it, for
            // example while unfocused, so clock 0 models a missed echo.
            if (this.clock !== 0) {
              real.emit("item/completed", { turnId: `turn-${item.turn}`, item: {
                id: key(item), type: "userMessage", content: [{ type: "text", text: textOf(item) }],
              } });
            }
          }
          break;
        }
        case "item": {
          const item: Item = {
            turn: model.active!, sequence: model.ledger.filter((row) => row.turn === model.active).length,
            role: "assistant", time: this.clock === 0 ? undefined : this.clock === 1 ? NOW : 50_000,
            tool: this.reverse,
          };
          model.ledger.push(item);
          real.visibility.live.set(key(item), real.visibility.issued);
          if (item.tool) {
            const tool = { id: key(item), type: "commandExecution", command: `echo ${key(item)}`,
              status: "completed", exitCode: 0 };
            real.emit("item/started", { turnId: `turn-${item.turn}`, item: { ...tool, status: "inProgress" } });
            real.emit("item/completed", { turnId: `turn-${item.turn}`, item: tool });
          } else {
            real.emit("item/agentMessage/delta", {
              turnId: `turn-${item.turn}`, itemId: key(item), delta: key(item), phase: "commentary",
            });
            real.emit("item/completed", { turnId: `turn-${item.turn}`, item: {
              id: key(item), type: "agentMessage", text: key(item), phase: "commentary", createdAt: item.time,
            } });
          }
          break;
        }
        case "complete": {
          const turn = model.active!;
          model.active = undefined;
          real.emit("turn/completed", { turnId: `turn-${turn}`, turn: turnMetadata(turn) });
          break;
        }
        case "redeliver": {
          const item = model.ledger.find((row) => row.turn === model.active && !row.tool && row.role === "assistant")!;
          real.emit("item/completed", { turnId: `turn-${item.turn}`, item: {
            id: key(item), type: "agentMessage", text: key(item), phase: "commentary",
          } });
          break;
        }
        case "read": { void real.result.current.reload(); break; }
        case "resolve": {
          const read = this.reverse ? real.reads.pop() : real.reads.shift();
          if (read) {
            if (this.reverse) {
              // Only permute known items within a turn. Unobserved historical
              // items retain the provider order because there is no live witness.
              const entries = read.response.replay.entries;
              const groups = Map.groupBy(entries, (row) => row.turn?.id);
              read.response.replay.entries = [...groups.values()].flatMap((group) =>
                group.every((row) => model.ledger.some((item) => key(item) === row.id && item.turn > 2))
                  ? [...group].reverse() : group
              );
            }
            read.resolve(read.response);
          }
          break;
        }
        case "older": { void real.result.current.loadOlder(); break; }
        case "compact": {
          // Compaction replaces the transcript as a whole, and shows it again
          // only once its own read lands. That is not a pruned live row.
          real.visibility.live.clear();
          real.emit("thread/compacted", {});
          break;
        }
        case "synthetic": break;
      }
    });
    assertLedger(model, real);
    assertLiveRowsVisible(real);
    if (this.operation === "synthetic") {
      const rows = real.result.current.entries;
      const injected = injectPermissionTransitions(rows, [{
        id: "model-permission", occurredAt: this.clock === 0 ? 0 : NOW,
        fromExecutionMode: "default", toExecutionMode: "full-access", status: "applied",
      }]);
      assertLedger(model, real, injected);
      expect(injected.filter((row) => row.type === "message")).toEqual(Array.from(rows).filter((row) => row.type === "message"));
    }
  }
  toString() { return `${this.operation}(clock=${this.clock},reverse=${this.reverse})`; }
}

async function drain(model: Model, real: Real) {
  // A resolved read may trigger a follow-up read. Bound the loop so a broken
  // retry lifecycle fails here instead of exhausting the renderer timeout.
  for (let count = 0; real.reads.length; count++) {
    expect(count).toBeLessThan(64);
    await act(async () => {
      const read = real.reads.shift()!;
      real.trace.push(`drain(${logicalKeys(read.response.replay.entries).join(",")})`);
      read.resolve(read.response);
    });
    assertLedger(model, real);
    assertLiveRowsVisible(real);
  }
}

function initialModel(): Model {
  return { turn: 2, ledger: [
    { turn: 0, sequence: 0, role: "user", time: 1 },
    { turn: 0, sequence: 1, role: "assistant" },
    { turn: 1, sequence: 0, role: "user", time: 1 },
    { turn: 1, sequence: 1, role: "assistant", time: 1 },
    { turn: 2, sequence: 0, role: "user" },
    { turn: 2, sequence: 1, role: "assistant", time: 1 },
  ] };
}

function openingCommands(time = 0, reverse = false) {
  return [
    new LedgerCommand("older"), new LedgerCommand("resolve"),
    new LedgerCommand("send"), new LedgerCommand("start"),
    new LedgerCommand("item", time), new LedgerCommand("item", time, true),
    new LedgerCommand("item", time), new LedgerCommand("read"),
    new LedgerCommand("item", time), new LedgerCommand("item", time, true),
    new LedgerCommand("resolve", time, reverse),
    new LedgerCommand("redeliver"),
    new LedgerCommand("complete"), new LedgerCommand("resolve", time, reverse),
    new LedgerCommand("compact"), new LedgerCommand("resolve"),
  ];
}

it.each([
  { name: "compaction followed by a reordered read", commands: [
    new LedgerCommand("start"), new LedgerCommand("item"), new LedgerCommand("item"),
    new LedgerCommand("complete"), new LedgerCommand("compact"), new LedgerCommand("resolve", 0, true),
  ] },
  { name: "an older page arriving during a later turn", commands: [
    new LedgerCommand("read"), new LedgerCommand("start"), new LedgerCommand("item", 0, true),
    new LedgerCommand("older"), new LedgerCommand("complete"), new LedgerCommand("start"),
  ] },
  { name: "an outstanding compaction read and message redelivery", commands: [
    new LedgerCommand("compact"), new LedgerCommand("start"), new LedgerCommand("item"),
    new LedgerCommand("resolve"), new LedgerCommand("item"), new LedgerCommand("redeliver"),
  ] },
  { name: "a pre-item read followed by untimed message redelivery after a tool", commands: [
    new LedgerCommand("start"), new LedgerCommand("read"), new LedgerCommand("item"),
    new LedgerCommand("item", 0, true), new LedgerCommand("resolve"), new LedgerCommand("redeliver"),
  ] },
  { name: "an acknowledged empty turn and message redelivery", commands: [
    new LedgerCommand("send"), new LedgerCommand("start"), new LedgerCommand("complete"),
    new LedgerCommand("start"), new LedgerCommand("item"), new LedgerCommand("resolve"),
    new LedgerCommand("item"), new LedgerCommand("redeliver"),
  ] },
  { name: "an optimistic send follows a completed tool turn", commands: [
    new LedgerCommand("start"), new LedgerCommand("item"), new LedgerCommand("item", 0, true),
    new LedgerCommand("complete"), new LedgerCommand("send"), new LedgerCommand("start"),
    new LedgerCommand("complete"),
  ] },
])("retains provider order after $name", async ({ commands }) => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
  const model = initialModel();
  const real = await mount(model);
  try {
    await fc.asyncModelRun(() => ({ model, real }), openingCommands());
    await fc.asyncModelRun(() => ({ model, real }), commands);
    if (model.active !== undefined) {
      await new LedgerCommand("item").run(model, real);
      await new LedgerCommand("complete").run(model, real);
    }
    await drain(model, real);
    await new LedgerCommand("read").run(model, real);
    await drain(model, real);
    for (let page = 0; real.result.current.response?.replay.pagination.hasPreviousPage; page++) {
      expect(page).toBeLessThan(20);
      await new LedgerCommand("older").run(model, real);
      await drain(model, real);
    }
    assertLedger(model, real);
  } finally { real.unmount(); clock.mockRestore(); }
});

it("keeps completed live tool turns before subsequent acknowledged sends for generated clocks", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
  try {
    await fc.assert(fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 1, maxLength: 5 }),
      async (clocks) => {
        const model = initialModel();
        const real = await mount(model);
        try {
          await fc.asyncModelRun(() => ({ model, real }), openingCommands());
          for (const time of clocks) {
            await fc.asyncModelRun(() => ({ model, real }), [
              new LedgerCommand("start"), new LedgerCommand("item", time), new LedgerCommand("item", time, true),
              new LedgerCommand("complete"), new LedgerCommand("send"), new LedgerCommand("start"),
              new LedgerCommand("complete"),
            ]);
          }
          await drain(model, real);
        } finally { real.unmount(); }
      }), { numRuns: 25 });
  } finally { clock.mockRestore(); }
});

it("keeps a completed message's live sequence when a tied command row precedes it", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
  const model: Model = { turn: 0, ledger: [] };
  const real = await mount(model);
  try {
    await fc.asyncModelRun(() => ({ model, real }), [
      new LedgerCommand("start"), new LedgerCommand("item"),
      new LedgerCommand("item", 0, true), new LedgerCommand("item"),
      new LedgerCommand("redeliver"),
    ]);
  } finally { real.unmount(); clock.mockRestore(); }
});

it("keeps a hydrated message before later live tools when its completion is redelivered", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
  const model: Model = { turn: 0, ledger: [] };
  const real = await mount(model);
  try {
    await fc.asyncModelRun(() => ({ model, real }), [
      new LedgerCommand("start"), new LedgerCommand("item"), new LedgerCommand("read"),
      new LedgerCommand("item", 0, true), new LedgerCommand("resolve"), new LedgerCommand("redeliver"),
    ]);
    expect(logicalKeys(real.result.current.entries)).toEqual(model.ledger.map(key));
  } finally { real.unmount(); clock.mockRestore(); }
});

it("retains the cursor bridge when a newest-page read lands before an older page", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
  const model = initialModel();
  const real = await mount(model);
  try {
    await fc.asyncModelRun(() => ({ model, real }), [
      new LedgerCommand("start"), new LedgerCommand("item"), new LedgerCommand("complete"),
    ]);
    await drain(model, real);
    await fc.asyncModelRun(() => ({ model, real }), [
      new LedgerCommand("start"), new LedgerCommand("item"), new LedgerCommand("read"),
      new LedgerCommand("older"), new LedgerCommand("complete"),
    ]);
    await drain(model, real);
    expect(logicalKeys(real.result.current.entries)).toEqual(model.ledger.map(key));
  } finally { real.unmount(); clock.mockRestore(); }
});

it("acknowledges only the completed prefix of a growing live tool bucket", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
  const model: Model = { turn: 0, ledger: [] };
  const real = await mount(model);
  try {
    await fc.asyncModelRun(() => ({ model, real }), [
      new LedgerCommand("start"), new LedgerCommand("item", 0, true),
      new LedgerCommand("read"), new LedgerCommand("item", 0, true),
      new LedgerCommand("resolve"),
    ]);
    expect(logicalKeys(real.result.current.entries)).toEqual(model.ledger.map(key));
  } finally { real.unmount(); clock.mockRestore(); }
});

it("invalidates outstanding snapshots and page cursors when compaction resets history", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
  const model = initialModel();
  const real = await mount(model);
  try {
    await fc.asyncModelRun(() => ({ model, real }), [
      new LedgerCommand("start"), new LedgerCommand("item"), new LedgerCommand("complete"),
    ]);
    await drain(model, real);
    await fc.asyncModelRun(() => ({ model, real }), [
      new LedgerCommand("start"), new LedgerCommand("item"), new LedgerCommand("complete"),
      new LedgerCommand("older"), new LedgerCommand("compact"),
      new LedgerCommand("start"), new LedgerCommand("item"), new LedgerCommand("complete"),
    ]);
    await drain(model, real);
    await new LedgerCommand("read").run(model, real);
    await drain(model, real);
    for (let page = 0; real.result.current.response?.replay.pagination.hasPreviousPage; page++) {
      expect(page).toBeLessThan(20);
      await new LedgerCommand("older").run(model, real);
      await drain(model, real);
    }
    expect(logicalKeys(real.result.current.entries)).toEqual(model.ledger.map(key));
  } finally { real.unmount(); clock.mockRestore(); }
});

it("keeps the observed ledger through arbitrary same-turn hydration permutations", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
  try {
    await fc.assert(fc.asyncProperty(
      fc.shuffledSubarray([0, 1, 2, 3], { minLength: 4, maxLength: 4 }),
      async (permutation) => {
        const model: Model = { turn: 0, ledger: [] };
        const real = await mount(model);
        try {
          await new LedgerCommand("start").run(model, real);
          await act(async () => {
            for (let sequence = 0; sequence < 4; sequence++) {
              const item: Item = { turn: 1, sequence, role: sequence === 0 ? "user" : "assistant",
                tool: sequence === 2, time: NOW + sequence,
                phase: sequence === 3 ? "final" : "commentary" };
              model.ledger.push(item);
              real.result.current.upsertLiveTranscriptEntry(entry(item, model.active));
            }
          });
          assertLedger(model, real);
          await new LedgerCommand("complete").run(model, real);
          const read = real.reads.shift()!;
          read.response.replay.entries = permutation.map((index) => read.response.replay.entries[index]!);
          real.trace.push(`hydrate(${permutation.join(",")})`);
          await act(async () => read.resolve(read.response));
          assertLedger(model, real);
          expect(logicalKeys(real.result.current.entries)).toEqual(model.ledger.map(key));
        } finally { real.unmount(); }
      },
    ), { numRuns: 25 });
  } finally { clock.mockRestore(); }
});

async function runToQuiescence(time: number, reverse: boolean, commands: Iterable<fc.AsyncCommand<Model, Real>>) {
  const model = initialModel();
  const real = await mount(model);
  try {
    assertLedger(model, real);
    // Every run visits the live/read race; random commands then explore
    // other interleavings. This also keeps coverage useful at 25 runs.
    await fc.asyncModelRun(() => ({ model, real }), openingCommands(time, reverse));
    await fc.asyncModelRun(() => ({ model, real }), commands);
    // A send is acknowledged before starting the next provider turn.
    if (model.optimistic) {
      await new LedgerCommand("start").run(model, real);
    }
    if (model.active !== undefined) {
      await new LedgerCommand("item", time).run(model, real);
      await new LedgerCommand("complete").run(model, real);
    }
    await drain(model, real);
    await new LedgerCommand("read").run(model, real);
    await drain(model, real);
    for (let page = 0; real.result.current.response?.replay.pagination.hasPreviousPage; page++) {
      expect(page).toBeLessThan(20);
      await new LedgerCommand("older").run(model, real);
      await drain(model, real);
    }
    assertLedger(model, real);
    expect(logicalKeys(real.result.current.entries), real.trace.join(" → ")).toEqual(model.ledger.map(key));
  } finally {
    real.unmount();
  }
}

// fast-check seed -1865083612, path "1:0:7:6:15:13:12:12:14:14:14:17".
it("keeps retained older turns above a newest page that matches none of their rows", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
  try {
    await runToQuiescence(0, false, [
      new LedgerCommand("start"), new LedgerCommand("item", 0, true), new LedgerCommand("complete"),
      new LedgerCommand("start"), new LedgerCommand("item", 0, true), new LedgerCommand("read"),
    ]);
  } finally { clock.mockRestore(); }
});

// fast-check seed 1712167680, path "768:4:3:11:14:16:18:14:14:18:19:19:19".
it("keeps a compacted tool turn above the next acknowledged send", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
  try {
    await runToQuiescence(0, false, [
      new LedgerCommand("start"), new LedgerCommand("item", 0, true), new LedgerCommand("complete"),
      new LedgerCommand("compact"), new LedgerCommand("send"), new LedgerCommand("start"),
      new LedgerCommand("complete"),
    ]);
  } finally { clock.mockRestore(); }
});

// fast-check seed -1395544634, path "3114:0:21:17:18:20:20:20:24".
it("keeps a lagging page of finished tool turns between older and newer retained turns", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
  try {
    await runToQuiescence(0, false, [
      new LedgerCommand("start"), new LedgerCommand("item", 0, true), new LedgerCommand("complete"),
      new LedgerCommand("start"), new LedgerCommand("item", 0, true), new LedgerCommand("complete"),
      new LedgerCommand("read"), new LedgerCommand("start"),
    ]);
  } finally { clock.mockRestore(); }
});

// fast-check seed -2084235983, path "2926:0:0:4:17:7:21:23:25:25:26:27:27:27:27:28:28".
it("keeps a pruned live tool turn reachable when a newest page skips past it", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
  try {
    await runToQuiescence(0, false, [
      new LedgerCommand("start"), new LedgerCommand("read"), new LedgerCommand("item", 0, true),
      new LedgerCommand("complete"), new LedgerCommand("start"), new LedgerCommand("item"),
      new LedgerCommand("complete"), new LedgerCommand("start"), new LedgerCommand("older"),
    ]);
  } finally { clock.mockRestore(); }
});

// fast-check seed 1573059296, path "4505:0:9:11:15:29:30:27:25:25:31:31:31:33:33".
it("keeps a pruned live tool turn reachable across an acknowledged send and a newest page", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
  try {
    await runToQuiescence(0, false, [
      new LedgerCommand("start"), new LedgerCommand("item", 0, true), new LedgerCommand("complete"),
      new LedgerCommand("start"), new LedgerCommand("item"), new LedgerCommand("complete"),
      new LedgerCommand("send"), new LedgerCommand("start"), new LedgerCommand("read"), new LedgerCommand("older"),
    ]);
  } finally { clock.mockRestore(); }
});

it("keeps a completed tool-only turn visible until a read issued after it lands", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
  const model = initialModel();
  const real = await mount(model);
  try {
    await fc.asyncModelRun(() => ({ model, real }), openingCommands());
    // The resolved compaction read predates turn 4, so it cannot settle it.
    await fc.asyncModelRun(() => ({ model, real }), [
      new LedgerCommand("compact"), new LedgerCommand("resolve"), new LedgerCommand("start"),
      new LedgerCommand("item", 0, true), new LedgerCommand("complete"),
    ]);
    expect(logicalKeys(real.result.current.entries)).toContain("turn-4/item-0");
    await drain(model, real);
    expect(logicalKeys(real.result.current.entries)).toContain("turn-4/item-0");
  } finally { real.unmount(); clock.mockRestore(); }
});

// fast-check seed -1311098151, path "2259:4:3:11:13:22:22:23:23:24:25:25:26:26:27:27:27:27".
// The bound case binds turn 4's send before its echo, as when startTurn
// resolves first; the unbound one never binds it.
it.each([{ bound: false }, { bound: true }])(
  "keeps one row for a sent message when an older page returns its turn (bound: $bound)",
  async ({ bound }) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
    try {
      await runToQuiescence(0, false, [
        new LedgerCommand("send"), new LedgerCommand("read"), new LedgerCommand("start", 0, bound),
        new LedgerCommand("complete"), new LedgerCommand("send"), new LedgerCommand("start"),
        new LedgerCommand("older"), new LedgerCommand("complete"), new LedgerCommand("start"),
      ]);
    } finally { clock.mockRestore(); }
  },
);

// fast-check seed -1987347380, path "1611:0:10:16:18:7:24:24:22:23:23:24:24:24:25:27:27:27:27:28".
it("keeps a send whose echo was missed above a tool-only turn it preceded", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
  try {
    await runToQuiescence(0, false, [
      new LedgerCommand("send"), new LedgerCommand("read"), new LedgerCommand("start"), new LedgerCommand("complete"),
      new LedgerCommand("start"), new LedgerCommand("item", 0, true), new LedgerCommand("complete"),
      new LedgerCommand("start"), new LedgerCommand("older"),
    ]);
  } finally { clock.mockRestore(); }
});

// The missed-echo send repeats turn 0's text. An older page holding turn 0
// must not hand that row's identity to the send.
it("keeps a repeated send whose echo was missed out of an older turn's row", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
  try {
    await runToQuiescence(0, false, [
      new LedgerCommand("send", 0, true), new LedgerCommand("read"), new LedgerCommand("start"),
      new LedgerCommand("complete"), new LedgerCommand("start"), new LedgerCommand("item", 0, true),
      new LedgerCommand("complete"), new LedgerCommand("start"), new LedgerCommand("older"),
      new LedgerCommand("older"), new LedgerCommand("older"),
    ]);
  } finally { clock.mockRestore(); }
});

// fast-check seed -452598666, path "683:0:0:10:10:9:12:13:14:14". The
// pending send repeats the bound one's text. The bound send's turn, not that
// text, identifies its owner copy, which keeps the send's live place.
it("keeps a bound send in its place when a pending send repeats its text", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
  try {
    await runToQuiescence(0, false, [
      new LedgerCommand("send", 0, true), new LedgerCommand("start", 0, true), new LedgerCommand("item"),
      new LedgerCommand("complete"), new LedgerCommand("send", 0, true), new LedgerCommand("resolve", 0, true),
    ]);
  } finally { clock.mockRestore(); }
});

it("renders a subsequence of the provider ledger after every command and the whole ledger at quiescence", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
  try {
    const command = fc.tuple(fc.constantFrom<Operation>(
      "start", "item", "item", "redeliver", "complete", "send", "read", "resolve", "older", "compact", "synthetic",
    ), fc.integer({ min: 0, max: 2 }), fc.boolean()).map(([op, time, reverse]) => new LedgerCommand(op, time, reverse));
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 2 }), fc.boolean(),
      fc.commands([command], { maxCommands: 24, size: "+2" }),
      (time, reverse, commands) => runToQuiescence(time, reverse, commands)), { numRuns: 25 });
  } finally { clock.mockRestore(); }
});
