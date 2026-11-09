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
};
type Model = { ledger: Item[]; turn: number; active?: number; optimistic?: Item };
type Read = { response: AppServerReadThreadResponse; resolve: (value: AppServerReadThreadResponse) => void };
type Real = Awaited<ReturnType<typeof mount>>;
type Operation = "start" | "item" | "redeliver" | "complete" | "send" | "read" | "resolve" | "older" | "compact" | "synthetic";
const key = (item: Item) => `turn-${item.turn}/item-${item.sequence}`;
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
    type: "message", id: key(item), role: item.role, text: key(item),
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
  let emit: (event: AgentEvent) => void = () => { throw new Error("missing subscription"); };
  let first = true;
  const desktopApi: DesktopApi = {
    onAgentEvent: (listener) => { emit = listener; return () => undefined; },
    readThread: vi.fn(({ before }) => {
      const snapshot = response(model, before === undefined ? undefined : Number(before));
      if (first) { first = false; return Promise.resolve(snapshot); }
      return new Promise<AppServerReadThreadResponse>((resolve) => reads.push({ response: snapshot, resolve }));
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
  return { ...hook, reads, trace: [] as string[], emit: (method: string, params: Record<string, unknown>) => emit({
    backend: "codex", notification: { method, params: { threadId: "ledger-thread", ...params } } as AgentEvent["notification"],
  }) };
}

function assertLedger(model: Model, real: Real, rows = real.result.current.entries) {
  expect(new Set(Array.from(rows, (row) => row.id)).size, real.trace.join(" → ")).toBe(rows.length);
  const ledger = [...model.ledger, ...(model.optimistic ? [model.optimistic] : [])];
  const positions = new Map(ledger.map((item, index) => [key(item), index]));
  // Text is the logical key, so an optimistic id and its acknowledged provider
  // id cannot hide a duplicate. All generated messages have distinct text.
  const keys = logicalKeys(rows);
  expect(new Set(keys).size, real.trace.join(" → ")).toBe(keys.length);
  const ranks = keys.map((id) => {
    expect(positions.has(id), `unknown provider item ${id}`).toBe(true);
    return positions.get(id)!;
  });
  expect(ranks, real.trace.join(" → ")).toEqual([...ranks].sort((a, b) => a - b));
  expect(real.result.current.activeTurnId).toBe(model.active === undefined ? undefined : `turn-${model.active}`);
}

function logicalKeys(rows: AppServerThreadEntry[]): string[] {
  return Array.from(rows).flatMap((row) => row.type === "message" ? [row.text]
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
          model.optimistic = { turn: model.turn + 1, sequence: 0, role: "user", time: NOW };
          real.result.current.addOptimisticUserMessage(key(model.optimistic));
          break;
        }
        case "start": {
          model.active = ++model.turn;
          real.emit("turn/started", { turn: turnMetadata(model.turn, model.active) });
          if (model.optimistic) {
            const item = model.optimistic;
            model.ledger.push(item);
            model.optimistic = undefined;
            real.emit("item/completed", { turnId: `turn-${item.turn}`, item: {
              id: key(item), type: "userMessage", content: [{ type: "inputText", text: key(item) }],
            } });
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
        case "compact": { real.emit("thread/compacted", {}); break; }
        case "synthetic": break;
      }
    });
    assertLedger(model, real);
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

it("renders a subsequence of the provider ledger after every command and the whole ledger at quiescence", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
  try {
    const command = fc.tuple(fc.constantFrom<Operation>(
      "start", "item", "item", "redeliver", "complete", "send", "read", "resolve", "older", "compact", "synthetic",
    ), fc.integer({ min: 0, max: 2 }), fc.boolean()).map(([op, time, reverse]) => new LedgerCommand(op, time, reverse));
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 2 }), fc.boolean(),
      fc.commands([command], { maxCommands: 24, size: "+2" }), async (time, reverse, commands) => {
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
    }), { numRuns: 25 });
  } finally { clock.mockRestore(); }
});
