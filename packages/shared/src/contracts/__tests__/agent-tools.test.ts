import { describe, expect, it } from "vitest";

import {
  AGENT_TOOL_CATALOG_IDS,
  isAgentToolCatalogId,
  normalizeAgentToolCatalogIds,
} from "../agent-tools";

describe("agent tool contracts", () => {
  it("defines the v1 agent tool catalog ids", () => {
    expect(AGENT_TOOL_CATALOG_IDS).toEqual([
      "automation_inspection",
      "thread_inspection",
    ]);
    expect(isAgentToolCatalogId("automation_inspection")).toBe(true);
    expect(isAgentToolCatalogId("thread_inspection")).toBe(true);
    expect(isAgentToolCatalogId("shell")).toBe(false);
  });

  it("normalizes catalog ids with de-duplication and defaults", () => {
    expect(
      normalizeAgentToolCatalogIds([
        "automation_inspection",
        "automation_inspection",
        "thread_inspection",
        "unknown",
      ]),
    ).toEqual(["automation_inspection", "thread_inspection"]);
    expect(
      normalizeAgentToolCatalogIds(undefined, {
        defaultValue: ["automation_inspection"],
      }),
    ).toEqual(["automation_inspection"]);
  });
});
