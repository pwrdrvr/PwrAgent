import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@pwragent/shared";
import { compareStep, describeBaselineChange, diffShapes, shapeOf, type OwnerStepRecord } from "./helpers/owner-conformance";

const record = (overrides: Partial<OwnerStepRecord>): OwnerStepRecord => ({
  step: "rename it", method: "backend.renameThread", response: {}, values: {}, events: [], ...overrides,
});
const event = (method: string, params: Record<string, unknown>) =>
  ({ backend: "codex", notification: { method, params } }) as unknown as AgentEvent;

describe("owner conformance comparison", () => {
  it("compares structure, not data, and merges array elements", () => {
    expect(shapeOf({ id: "a", rows: [{ title: "x" }, { title: "y", pinned: true }], gone: undefined }))
      .toEqual({ id: "string", rows: [{ pinned: "boolean", title: "string" }] });
    expect(diffShapes(shapeOf({ rows: [] }), shapeOf({ rows: [] }))).toEqual([]);
    expect(diffShapes(shapeOf({ rows: [] }), shapeOf({ rows: [{ title: "x" }] })))
      .toEqual(["$.rows: desktop empty array, outpost array"]);
    expect(diffShapes(shapeOf({ seenAt: 1 }), shapeOf({ seenAt: "1", extra: null }))).toEqual([
      "$.extra: desktop missing, outpost null",
      "$.seenAt: desktop number, outpost string",
    ]);
  });

  it("names the owner method and step on every difference", () => {
    const differences = compareStep(
      record({ response: { renamedAt: 1 }, values: { titleSource: "explicit" },
        events: [event("thread/name/updated", { threadId: "t", threadName: "Name" })] }),
      record({ response: { title: "Name" }, values: { titleSource: "derived" },
        events: [event("thread/name/updated", { threadId: "t", threadName: "Name", titleSource: "explicit" }),
          event("navigation/invalidated", { threadId: "t" })] }),
    );
    expect(differences).toEqual([
      "backend.renameThread [rename it] response $.renamedAt: desktop number, outpost missing",
      "backend.renameThread [rename it] response $.title: desktop missing, outpost string",
      "backend.renameThread [rename it] value titleSource: desktop \"explicit\", outpost \"derived\"",
      "backend.renameThread [rename it] event navigation/invalidated: outpost sends it, desktop does not",
      "backend.renameThread [rename it] event thread/name/updated params $.titleSource: desktop missing, outpost string",
    ]);
  });

  it("fails on a new difference and on a fixed one, and passes on the baseline", () => {
    const baseline = { sharedMethods: ["backend.renameThread"], differences: ["backend.renameThread [rename it] value a: desktop 1, outpost 2"] };
    expect(describeBaselineChange(baseline, baseline)).toBeUndefined();
    const change = describeBaselineChange(baseline, { sharedMethods: ["backend.renameThread", "backend.readThread"],
      differences: ["backend.readThread [read it] value b: desktop 1, outpost 2"] });
    expect(change).toContain("new shared method: backend.readThread");
    expect(change).toContain("new difference: backend.readThread [read it] value b: desktop 1, outpost 2");
    expect(change).toContain("fixed difference: backend.renameThread [rename it] value a: desktop 1, outpost 2");
    expect(change).toContain("UPDATE_OWNER_CONFORMANCE=1");
  });
});
