import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AppServerBackendKind, NavigationThreadSummary, ThreadTodo } from "@pwragent/shared";
import { addressableTodoDestinations, todoDestination } from "../todo-destination-addressing";

// Oracle: the machine that owns each thread. A row names its owner relative
// to this window, a card names its owner the same way, and the card's owner
// delivers a target to `target.instanceId`, or to itself when there is none
// (`ThreadTodoService.run`, which also refuses the card's own thread there).
// Every destination the picker offers must reach the thread it showed.

const THIS_MACHINE = "this-machine";
const PEERS = ["lab", "win"] as const;
const MACHINES = [THIS_MACHINE, ...PEERS] as const;
type Machine = (typeof MACHINES)[number];
const LABELS: Record<Machine, string> = { [THIS_MACHINE]: "studio", lab: "lab-mini", win: "win-lab / dev" };
// Few ids and backends, so a row often shares the card's thread id on
// another machine, which is a different thread.
const backend = fc.constantFrom<AppServerBackendKind>("codex", "claude");
const threadId = fc.constantFrom("a", "b", "c");

type GeneratedRow = { owner: Machine; source: AppServerBackendKind; id: string };

const world = fc.record({
  // This window knows its own machine id only once federation reports it.
  thisMachineId: fc.option(fc.constant("mac"), { nil: undefined }),
  cardOwner: fc.constantFrom(...MACHINES),
  card: fc.record({ backend, threadId }),
  rows: fc.array(fc.record({ owner: fc.constantFrom(...MACHINES), source: backend, id: threadId }), { maxLength: 8 }),
});

function summary(row: GeneratedRow): NavigationThreadSummary {
  const thread: Partial<NavigationThreadSummary> = {
    id: row.id, title: `${row.owner}/${row.source}/${row.id}`, titleSource: "explicit", source: row.source,
    linkedDirectories: [], updatedAt: 1,
    ...(row.owner === THIS_MACHINE ? {} : { federation: {
      ref: { backend: row.source, threadId: row.id, target: { scope: "remote", instanceId: row.owner } },
      instanceLabel: LABELS[row.owner],
    } }),
  };
  return thread as NavigationThreadSummary;
}

function todo(owner: Machine, card: { backend: AppServerBackendKind; threadId: string }): ThreadTodo {
  return {
    id: "card", backend: card.backend, threadId: card.threadId, kind: "handoff", status: "open",
    title: "Hand off", createdAt: 0, updatedAt: 0,
    action: { type: "start_thread", prompt: "Continue" },
    ...(owner === THIS_MACHINE ? {} : { federationTarget: { scope: "remote", instanceId: owner } }),
  } as ThreadTodo;
}

/** A machine's id as other machines address it; this one's may be unknown. */
function machineId(machine: Machine, thisMachineId: string | undefined): string | undefined {
  return machine === THIS_MACHINE ? thisMachineId : machine;
}

/** The machine an id names; this machine answers only to its known id. */
function machineNamed(id: string, thisMachineId: string | undefined): Machine | undefined {
  return id === thisMachineId ? THIS_MACHINE : MACHINES.find((machine) => machine !== THIS_MACHINE && machine === id);
}

describe("to-do destination addressing", () => {
  it("delivers every offered destination to the machine and thread the row showed", () => {
    fc.assert(fc.property(world, ({ thisMachineId, cardOwner, card, rows }) => {
      const localMachine = { ...(thisMachineId ? { instanceId: thisMachineId } : {}), label: LABELS[THIS_MACHINE] };
      for (const row of rows) {
        const target = todoDestination(summary(row), todo(cardOwner, card), localMachine);
        if (!target) continue;
        const deliveredTo = target.instanceId === undefined ? cardOwner : machineNamed(target.instanceId, thisMachineId);
        expect(deliveredTo).toBe(row.owner);
        expect([target.backend, target.threadId]).toEqual([row.source, row.id]);
        // The label names the thread's machine, whoever owns the card.
        expect(target.instanceLabel).toBe(LABELS[row.owner]);
        // The owner never refuses an offered destination as the card's own thread.
        expect(!target.instanceId && target.backend === card.backend && target.threadId === card.threadId).toBe(false);
      }
    }));
  });

  it("withholds only the card's own thread and threads the card's owner cannot name", () => {
    fc.assert(fc.property(world, ({ thisMachineId, cardOwner, card, rows }) => {
      const localMachine = { ...(thisMachineId ? { instanceId: thisMachineId } : {}), label: LABELS[THIS_MACHINE] };
      const offered = addressableTodoDestinations(rows.map(summary), todo(cardOwner, card), localMachine);
      const expected = rows.filter((row) => {
        const ownThread = row.owner === cardOwner && row.source === card.backend && row.id === card.threadId;
        // A peer's card reaches this machine's threads only by this machine's id.
        const unnamed = row.owner !== cardOwner && machineId(row.owner, thisMachineId) === undefined;
        return !ownThread && !unnamed;
      });
      expect(offered.map(({ thread }) => thread.title)).toEqual(expected.map((row) => summary(row).title));
    }));
  });

  // The shrunk shape of the rule's hardest case, kept as a named example.
  it("names this machine for a peer's card once the window knows its id", () => {
    const row: GeneratedRow = { owner: THIS_MACHINE, source: "codex", id: "a" };
    const card = todo("lab", { backend: "codex", threadId: "a" });
    expect(todoDestination(summary(row), card, { label: "studio" })).toBeUndefined();
    expect(todoDestination(summary(row), card, { instanceId: "mac", label: "studio" }))
      .toMatchObject({ backend: "codex", threadId: "a", instanceId: "mac", instanceLabel: "studio" });
  });
});
