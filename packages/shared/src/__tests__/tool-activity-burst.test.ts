import { describe, expect, it } from "vitest";
import {
  coalesceToolActivityBurst,
  TOOL_DETAILS_UNAVAILABLE_LABEL,
} from "../tool-activity-burst";

describe("coalesceToolActivityBurst", () => {
  it("groups repeated labels without losing the original items", () => {
    const items = [
      { id: "one", label: "Read config.toml", status: "completed" },
      { id: "two", label: "Read config.toml", status: "completed" },
      { id: "three", label: "Searched messaging", status: "completed" },
    ];

    expect(coalesceToolActivityBurst(items)).toEqual([
      { count: 2, items: items.slice(0, 2), label: "Read config.toml" },
      { count: 1, items: [items[2]], label: "Searched messaging" },
    ]);
  });

  it("keeps failed retries separate from successful calls", () => {
    const groups = coalesceToolActivityBurst([
      { label: "Ran focused tests", status: "completed" },
      { label: "Ran focused tests", status: "failed" },
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.items[0]?.status)).toEqual([
      "completed",
      "failed",
    ]);
  });

  it("replaces sparse provider placeholders with an explicit diagnostic", () => {
    expect(coalesceToolActivityBurst([
      { label: "tool", status: "completed" },
      { label: "", status: "completed" },
    ])).toEqual([
      {
        count: 2,
        items: [
          { label: "tool", status: "completed" },
          { label: "", status: "completed" },
        ],
        label: TOOL_DETAILS_UNAVAILABLE_LABEL,
      },
    ]);
  });
});
