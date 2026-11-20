import fc from "fast-check";
import { expect, it } from "vitest";
import { projectResearchRun, researchEventPage, type ResearchEvent } from "@pwragent/shared/research";
import { researchActivityRows, researchMapBranches } from "../research-view-model";
import { harnessRun, harnessRunView } from "./research-harness-fixture";

it("retains source lifecycle and observation events in reverse order within the activity bound", () => {
  fc.assert(fc.property(fc.array(fc.boolean(), { minLength: 101, maxLength: 130, size: "max" }), (kinds) => {
    const run = harnessRun();
    const { provenance, ...template } = run.events[3]!;
    const events: ResearchEvent[] = kinds.map((observation, index) => ({ ...template, seq: index + 2, at: 1000 + index,
      ...(observation ? { provenance: { ...provenance!, seq: index + 1, at: 1000 + index } } : {}),
      data: observation ? { type: "harness_observation", event: "fixture", text: `source-${index}` }
        : { type: "harness", state: { ...run.harness!, note: `source-${index}` } },
    }));
    const expected = events.slice(-100).reverse().map((event) => ({ seq: event.seq,
      text: event.data.type === "harness" ? event.data.state.note : event.data.type === "harness_observation" ? event.data.text : "unreachable" }));
    const projected = projectResearchRun(run.id, [run.events[0]!, ...events]);
    expect(researchActivityRows(harnessRunView(projected), researchEventPage(projected, { limit: 100 }).events).map(({ seq, text }) => ({ seq, text }))).toEqual(expected);
  }), { numRuns: 30 });
});

it("maps only admitted source members, never reserved native worker slots", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 8 }).chain((slots) => fc.tuple(fc.constant(slots), fc.integer({ min: 0, max: slots }))), ([slots, members]) => {
    const fixture = harnessRun();
    const created = fixture.events[0]!;
    if (created.data.type !== "created") throw new Error("Expected a created fixture run");
    const run = projectResearchRun(fixture.id, [{ ...created, data: { ...created.data,
      approaches: Array.from({ length: slots }, (_, index) => ({ ...fixture.approaches[0]!, id: `a${index + 1}`, state: index < members ? "ended" : "stopped" })),
      harness: { ...fixture.harness!, members: Array.from({ length: members }, (_, index) => `m${index + 1}`) },
    } }]);
    expect(researchMapBranches(harnessRunView(run)).map((branch) => branch.approach.id)).toEqual(run.approaches.slice(0, members).map((approach) => approach.id));
  }));
});

it("keeps source item provenance through delta synchronization without copying the journal", () => {
  fc.assert(fc.property(fc.nat(), (value) => {
    const run = harnessRun();
    const expected: Record<string, unknown> = {};
    run.harness!.members = [`m${value}`];
    for (const event of run.events) {
      if (!event.provenance) continue;
      event.provenance = { ...event.provenance, member: `m${value}`, digest: value.toString(16).padStart(64, "0") };
      if (event.data.type === "finding") expected[event.data.finding.id] = event.provenance;
      if (event.data.type === "submission") expected[event.data.submission.id] = event.provenance;
    }
    const board = harnessRunView(projectResearchRun(run.id, run.events));
    expect(Object.fromEntries([...board.items].filter(([, item]) => item.provenance).map(([id, item]) => [id, item.provenance]))).toEqual(expected);
    expect(Object.hasOwn(board, "events")).toBe(false);
    expect(board.items.size).toBe(run.items.length);
  }));
});
