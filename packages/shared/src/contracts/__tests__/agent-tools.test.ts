import { describe, expect, it } from "vitest";

import {
  AGENT_TOOL_CATALOG_IDS,
  PWRAGENT_TOOL_NAMESPACE,
  isAgentToolCatalogId,
  normalizeAgentToolCatalogIds,
} from "../agent-tools";

describe("agent tool contracts", () => {
  it("defines the unified PwrAgent dynamic tool namespace", () => {
    expect(PWRAGENT_TOOL_NAMESPACE).toBe("pwragent");
  });

  it("defines the v1 agent tool catalog ids", () => {
    expect(AGENT_TOOL_CATALOG_IDS).toEqual([
      "automation_inspection",
      "app_management",
      "thread_inspection",
      "messaging_context",
      "thread_orchestration",
    ]);
    expect(isAgentToolCatalogId("automation_inspection")).toBe(true);
    expect(isAgentToolCatalogId("app_management")).toBe(true);
    expect(isAgentToolCatalogId("thread_inspection")).toBe(true);
    expect(isAgentToolCatalogId("messaging_context")).toBe(true);
    expect(isAgentToolCatalogId("thread_orchestration")).toBe(true);
    expect(isAgentToolCatalogId("shell")).toBe(false);
  });

  it("normalizes catalog ids with de-duplication and defaults", () => {
    expect(
      normalizeAgentToolCatalogIds([
        "automation_inspection",
        "automation_inspection",
        "app_management",
        "thread_inspection",
        "messaging_context",
        "thread_orchestration",
        "unknown",
      ]),
    ).toEqual([
      "automation_inspection",
      "app_management",
      "thread_inspection",
      "messaging_context",
      "thread_orchestration",
    ]);
    expect(
      normalizeAgentToolCatalogIds(undefined, {
        defaultValue: ["automation_inspection"],
      }),
    ).toEqual(["automation_inspection"]);
  });
});
