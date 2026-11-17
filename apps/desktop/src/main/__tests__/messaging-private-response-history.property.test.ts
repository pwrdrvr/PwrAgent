import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { MessagingPrivateResponses, type PrivateResponseReceipt } from "../messaging/core/messaging-private-response-state";

type Facts = { live: boolean; pending: boolean; visible: boolean };
type Model = { turns: Map<string, Facts>; history: string[]; next: number };
type Real = { owner: MessagingPrivateResponses; receipts: Map<string, PrivateResponseReceipt> };
type Operation = "deliver" | "finish" | "retire" | "pressure";

// Oracle: the last 1,000 settled protocol sessions, ordered by when each one's
// last outstanding work settles. Admission order is irrelevant. Replayed
// terminal evidence does not create a new settlement. Live/pending sessions
// stay outside that FIFO and cannot be evicted.
function rememberSettlement(model: Model, key: string): void {
  model.history = model.history.filter(candidate => candidate !== key);
  model.history.push(key);
  if (model.history.length > 1_000) model.history.shift();
}

function pressure(model: Model, real: Real, count: number): void {
  for (let n = 0; n < count; n += 1) {
    const key = `newer-${model.next++}`;
    real.owner.register(key, { fallback: false, replyCompletion: false });
    real.owner.retire(key);
    model.turns.set(key, { live: false, pending: false, visible: false });
    rememberSettlement(model, key);
  }
}

function project(model: Model, real: Real): void {
  const retained = new Set(model.history);
  for (const [key, facts] of model.turns) {
    const present = facts.live || facts.pending || retained.has(key);
    expect(real.owner.state(key) !== undefined, `retention of ${key}`).toBe(present);
    expect(real.owner.isTerminal(key), `visible private delivery for ${key}`).toBe(present && facts.visible);
  }
}

class HistoryCommand implements fc.Command<Model, Real> {
  constructor(private readonly operation: Operation, private readonly key: string, private readonly count: number) {}

  check(model: Readonly<Model>): boolean {
    const facts = model.turns.get(this.key)!;
    if (this.operation === "deliver") return facts.pending && !facts.visible;
    if (this.operation === "finish") return facts.pending && facts.visible;
    return true; // Repeated terminals and newer independent sessions are valid.
  }

  run(model: Model, real: Real): void {
    const facts = model.turns.get(this.key)!;
    const eligible = !facts.live && !facts.pending;
    switch (this.operation) {
      case "deliver":
        real.owner.delivered(real.receipts.get(this.key));
        facts.visible = true;
        break;
      case "finish":
        real.owner.finishTool(real.receipts.get(this.key));
        facts.pending = false;
        break;
      case "retire":
        real.owner.retire(this.key);
        facts.live = false;
        break;
      case "pressure": pressure(model, real, this.count); break;
    }
    if (!eligible && !facts.live && !facts.pending) rememberSettlement(model, this.key);
    project(model, real);
  }

  toString(): string { return `${this.operation}(${this.key}, ${this.count})`; }
}

describe("private-response history protocol", () => {
  it("retains late completions in settlement order under real history pressure and replayed events", () => {
    const commands = fc.commands([fc.tuple(
      fc.constantFrom<Operation>("deliver", "finish", "retire", "pressure"),
      fc.integer({ min: 0, max: 2 }), fc.constantFrom(1, 1_000),
    ).map(([operation, id, count]) => new HistoryCommand(operation, `old-${id}`, count))], { maxCommands: 12, size: "max" });
    fc.assert(fc.property(commands, sequence => {
      const model: Model = { turns: new Map(), history: [], next: 0 };
      const real: Real = { owner: new MessagingPrivateResponses(), receipts: new Map() };
      for (let id = 0; id < 3; id += 1) {
        const key = `old-${id}`;
        real.owner.register(key, { fallback: false, replyCompletion: false });
        real.receipts.set(key, real.owner.beginTool(key)!);
        model.turns.set(key, { live: true, pending: true, visible: false });
      }
      pressure(model, real, 1_000);
      fc.modelRun(() => ({ model, real }), sequence);
    }), { numRuns: 10 });
  });

  it.each(["finish-first", "terminal-first"] as const)("retains a fresh private delivery with %s ordering after 1,000 newer settlements", order => {
    const real = new MessagingPrivateResponses();
    real.register("old", { fallback: true, replyCompletion: true });
    const receipt = real.beginTool("old");
    for (let n = 0; n < 1_000; n += 1) {
      real.register(`newer-${n}`, { fallback: false, replyCompletion: false });
      real.retire(`newer-${n}`);
    }
    if (order === "terminal-first") real.retire("old");
    real.delivered(receipt);
    real.finishTool(receipt);
    if (order === "finish-first") real.retire("old");
    expect(real.isTerminal("old"), "fresh private evidence must survive the first history trim").toBe(true);
    expect(real.state("newer-0")).toBeUndefined();
    expect(real.state("newer-1")).toBeDefined();
  });

  it("does not refresh old history when terminal evidence is replayed", () => {
    const real = new MessagingPrivateResponses();
    real.register("old", { fallback: false, replyCompletion: false });
    const receipt = real.beginTool("old");
    real.delivered(receipt);
    real.finishTool(receipt);
    real.retire("old");
    for (let n = 0; n < 999; n += 1) {
      real.register(`newer-${n}`, { fallback: false, replyCompletion: false });
      real.retire(`newer-${n}`);
    }
    real.retire("old");
    real.register("newest", { fallback: false, replyCompletion: false });
    real.retire("newest");
    expect(real.state("old")).toBeUndefined();
    expect(real.state("newer-0")).toBeDefined();
    expect(real.state("newest")).toBeDefined();
  });
});
