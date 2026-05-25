import { describe, expect, it } from "vitest";

import {
  AUTOMATION_INSPECTION_OPERATION_NAMES,
  DEFAULT_AUTOMATION_INSPECTION_EVENT_LIMIT,
  DEFAULT_AUTOMATION_INSPECTION_RUN_LIMIT,
  DEFAULT_AUTOMATION_INSPECTION_TEXT_LIMIT_CHARS,
  MAX_AUTOMATION_INSPECTION_EVENT_LIMIT,
  MAX_AUTOMATION_INSPECTION_RUN_LIMIT,
  MAX_AUTOMATION_INSPECTION_TEXT_LIMIT_CHARS,
  isAutomationInspectionOperationName,
  normalizeAutomationInspectionEventLimit,
  normalizeAutomationInspectionRunLimit,
  normalizeAutomationInspectionTextLimitChars,
} from "../automation-tools";

describe("automation tool contracts", () => {
  it("defines the read-only inspection operation catalog", () => {
    expect(AUTOMATION_INSPECTION_OPERATION_NAMES).toEqual([
      "list_automations",
      "summarize_automation_status",
      "list_automation_runs",
      "get_automation_run",
      "get_automation_run_artifact",
    ]);
    expect(isAutomationInspectionOperationName("get_automation_run")).toBe(true);
    expect(isAutomationInspectionOperationName("pause_automation")).toBe(false);
  });

  it("normalizes run list limits to bounded whole numbers", () => {
    expect(normalizeAutomationInspectionRunLimit(undefined)).toBe(
      DEFAULT_AUTOMATION_INSPECTION_RUN_LIMIT,
    );
    expect(normalizeAutomationInspectionRunLimit(0)).toBe(1);
    expect(normalizeAutomationInspectionRunLimit(3.9)).toBe(3);
    expect(normalizeAutomationInspectionRunLimit(10_000)).toBe(
      MAX_AUTOMATION_INSPECTION_RUN_LIMIT,
    );
  });

  it("normalizes artifact event limits separately from text limits", () => {
    expect(normalizeAutomationInspectionEventLimit("nope")).toBe(
      DEFAULT_AUTOMATION_INSPECTION_EVENT_LIMIT,
    );
    expect(normalizeAutomationInspectionEventLimit(10_000)).toBe(
      MAX_AUTOMATION_INSPECTION_EVENT_LIMIT,
    );
    expect(normalizeAutomationInspectionTextLimitChars(undefined)).toBe(
      DEFAULT_AUTOMATION_INSPECTION_TEXT_LIMIT_CHARS,
    );
    expect(normalizeAutomationInspectionTextLimitChars(1_000_000)).toBe(
      MAX_AUTOMATION_INSPECTION_TEXT_LIMIT_CHARS,
    );
  });
});
