import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AppServerBackendKind, NavigationThreadSummary } from "@pwragent/shared";
import { dependencyThread, dependencyThreadCandidates, type WaitingThread } from "../dependency-condition";

// Oracle: the machine that owns each thread. A row names its owner relative
// to this window, and so does the waiting thread. The wait's owner stores the
// dependency and reads a condition without `target` as its own thread and
// `target: remote` as the machine with that id, the way the owner matches
// dependents and peers mark them done.
// Every thread the search offers must be the one the owner will find, never
// the waiting thread, and every other thread this window can name is offered.

const THIS_MACHINE = "this-machine";
const PEERS = ["lab", "win"] as const;
const MACHINES = [THIS_MACHINE, ...PEERS] as const;
type Machine = (typeof MACHINES)[number];
// Few ids and backends, so a row often shares the waiting thread's id on
// another machine, which is a different thread.
const backend = fc.constantFrom<AppServerBackendKind>("codex", "claude");
const threadId = fc.constantFrom("a", "b", "c");
type GeneratedRow = { owner: Machine; source: AppServerBackendKind; id: string };

const world = fc.record({
  // This window knows its own machine id only once federation reports it.
  thisMachineId: fc.option(fc.constant("mac"), { nil: undefined }),
  waitingOwner: fc.constantFrom(...MACHINES),
  waiting: fc.record({ backend, threadId }),
  rows: fc.array(fc.record({ owner: fc.constantFrom(...MACHINES), source: backend, id: threadId }), { maxLength: 8 }),
});

function summary(row: GeneratedRow): NavigationThreadSummary {
  const thread: Partial<NavigationThreadSummary> = {
    id: row.id, title: `${row.owner}/${row.source}/${row.id}`, titleSource: "explicit", source: row.source,
    linkedDirectories: [], updatedAt: 1,
    ...(row.owner === THIS_MACHINE ? {} : { federation: {
      ref: { backend: row.source, threadId: row.id, target: { scope: "remote", instanceId: row.owner } },
      instanceLabel: row.owner,
    } }),
  };
  return thread as NavigationThreadSummary;
}

function waitingThread(owner: Machine, waiting: { backend: AppServerBackendKind; threadId: string }): WaitingThread {
  return { ...waiting, ...(owner === THIS_MACHINE ? {} : { owner: { scope: "remote", instanceId: owner } }) };
}

/** The machine an id names; this machine answers only to its known id. */
function machineNamed(id: string, thisMachineId: string | undefined): Machine | undefined {
  return id === thisMachineId ? THIS_MACHINE : MACHINES.find((machine) => machine !== THIS_MACHINE && machine === id);
}

describe("Continue After prerequisite addressing", () => {
  it("records a thread the waiting thread's owner finds, and never the waiting thread itself", () => {
    fc.assert(fc.property(world, ({ thisMachineId, waitingOwner, waiting, rows }) => {
      const wait = waitingThread(waitingOwner, waiting);
      for (const row of rows) {
        const dependency = dependencyThread(summary(row), wait, thisMachineId);
        const isSelf = row.owner === waitingOwner && row.source === waiting.backend && row.id === waiting.threadId;
        // This window cannot name a thread here to a peer without its own id.
        const nameable = !(row.owner === THIS_MACHINE && waitingOwner !== THIS_MACHINE && thisMachineId === undefined);
        if (isSelf || !nameable) {
          expect(dependency).toBeUndefined();
          continue;
        }
        expect(dependency).toBeDefined();
        const found = dependency!.target ? machineNamed(dependency!.target.instanceId, thisMachineId) : waitingOwner;
        expect({ machine: found, backend: dependency!.backend, threadId: dependency!.threadId })
          .toEqual({ machine: row.owner, backend: row.source, threadId: row.id });
      }
    }));
  });

  it("offers exactly the rows it can record, in search order", () => {
    fc.assert(fc.property(world, ({ thisMachineId, waitingOwner, waiting, rows }) => {
      const wait = waitingThread(waitingOwner, waiting);
      const threads = rows.map(summary);
      const offered = dependencyThreadCandidates(threads, wait, thisMachineId);
      expect(offered.map((candidate) => candidate.thread))
        .toEqual(threads.filter((thread) => dependencyThread(thread, wait, thisMachineId)));
    }));
  });
});
