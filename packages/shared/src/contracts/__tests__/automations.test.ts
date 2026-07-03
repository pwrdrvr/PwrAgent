import { describe, expect, it } from "vitest";

import {
  AUTOMATION_INBOUND_TEXT_MATCH_MODES,
  AUTOMATION_RUN_TRIGGERS,
  DEFAULT_AUTOMATION_BACKLOG_POLICY,
  DEFAULT_AUTOMATION_MAX_RUNS_PER_HOUR,
  formatAutomationScheduleSummary,
  resolveAutomationRunsPerHour,
  validateAutomationScheduleDefinition,
  type AutomationScheduleDefinition,
} from "../automations";

describe("automation contracts", () => {
  it("resolves the inbound run-rate, clamping fractional rates to at least 1/hour", () => {
    // undefined inherits the default; null is unlimited.
    expect(resolveAutomationRunsPerHour(undefined)).toBe(
      DEFAULT_AUTOMATION_MAX_RUNS_PER_HOUR,
    );
    expect(resolveAutomationRunsPerHour(null)).toBeNull();
    expect(resolveAutomationRunsPerHour(45)).toBe(45);
    // Zero / negative / non-finite are unlimited.
    expect(resolveAutomationRunsPerHour(0)).toBeNull();
    expect(resolveAutomationRunsPerHour(-5)).toBeNull();
    expect(resolveAutomationRunsPerHour(Number.NaN)).toBeNull();
    // A positive fraction must NOT floor to 0 (a 0-capacity bucket blocks every
    // run); it clamps up to 1/hour, the most restrictive real cap.
    expect(resolveAutomationRunsPerHour(0.5)).toBe(1);
    expect(resolveAutomationRunsPerHour(0.01)).toBe(1);
  });

  it("defaults backlog handling to coalescing missed windows", () => {
    expect(DEFAULT_AUTOMATION_BACKLOG_POLICY).toBe("coalesce");
  });

  it("includes inbound message runs and literal v1 text match modes", () => {
    expect(AUTOMATION_RUN_TRIGGERS).toContain("inbound_message");
    expect(AUTOMATION_INBOUND_TEXT_MATCH_MODES).toEqual(["contains", "equals"]);
  });

  it("formats and validates interval schedule definitions", () => {
    const schedule: AutomationScheduleDefinition = {
      kind: "interval",
      every: 5,
      unit: "minutes",
    };

    expect(validateAutomationScheduleDefinition(schedule)).toEqual({ ok: true });
    expect(formatAutomationScheduleSummary(schedule)).toBe("every 5 minutes");
    expect(
      formatAutomationScheduleSummary({
        kind: "interval",
        every: 1,
        unit: "hours",
      }),
    ).toBe("hourly");
  });

  it("formats and validates weekly calendar schedule definitions", () => {
    const schedule: AutomationScheduleDefinition = {
      kind: "weekly",
      daysOfWeek: ["friday"],
      timeOfDay: {
        hour: 16,
        minute: 0,
      },
    };

    expect(validateAutomationScheduleDefinition(schedule)).toEqual({ ok: true });
    expect(formatAutomationScheduleSummary(schedule)).toBe("Fridays at 4 PM");
    expect(
      formatAutomationScheduleSummary({
        kind: "weekly",
        daysOfWeek: ["monday", "wednesday"],
        timeOfDay: {
          hour: 9,
          minute: 30,
        },
      }),
    ).toBe("Mondays and Wednesdays at 9:30 AM");
  });

  it("formats and validates weekday schedule definitions", () => {
    const schedule: AutomationScheduleDefinition = {
      kind: "weekdays",
      timeOfDay: {
        hour: 9,
        minute: 0,
      },
    };

    expect(validateAutomationScheduleDefinition(schedule)).toEqual({ ok: true });
    expect(formatAutomationScheduleSummary(schedule)).toBe("weekdays at 9 AM");
  });

  it("rejects invalid schedule boundaries", () => {
    expect(
      validateAutomationScheduleDefinition({
        kind: "interval",
        every: 0,
        unit: "minutes",
      }),
    ).toEqual({
      ok: false,
      error: "Interval schedules must run every whole number greater than zero.",
    });
    expect(
      validateAutomationScheduleDefinition({
        kind: "weekly",
        daysOfWeek: [],
        timeOfDay: {
          hour: 9,
          minute: 0,
        },
      }),
    ).toEqual({
      ok: false,
      error: "Weekly schedules must include at least one day.",
    });
    expect(
      validateAutomationScheduleDefinition({
        kind: "weekdays",
        timeOfDay: {
          hour: 24,
          minute: 0,
        },
      }),
    ).toEqual({
      ok: false,
      error: "Schedule hour must be a whole number from 0 through 23.",
    });
  });

  it("does not represent raw cron as a v1 schedule definition", () => {
    const _cronSchedule: AutomationScheduleDefinition = {
      // @ts-expect-error raw cron is intentionally outside the v1 schedule model.
      kind: "cron",
      expression: "*/5 * * * *",
    };

    expect(true).toBe(true);
  });
});
