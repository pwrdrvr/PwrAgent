import { describe, expect, it } from "vitest";
import {
  collectDueAutomationWindows,
  computeNextAutomationRunAt,
} from "../automations/automation-schedule";

describe("automation schedule calculations", () => {
  it("computes interval occurrences from an anchor", () => {
    const schedule = {
      kind: "interval" as const,
      every: 5,
      unit: "minutes" as const,
      anchorAt: 0,
    };

    expect(computeNextAutomationRunAt(schedule, 0)).toBe(5 * 60 * 1000);
    expect(computeNextAutomationRunAt(schedule, 7 * 60 * 1000)).toBe(10 * 60 * 1000);
    expect(
      collectDueAutomationWindows({
        schedule,
        firstDueAt: 5 * 60 * 1000,
        through: 15 * 60 * 1000,
      }),
    ).toEqual([
      { scheduledFor: 5 * 60 * 1000 },
      { scheduledFor: 10 * 60 * 1000 },
      { scheduledFor: 15 * 60 * 1000 },
    ]);
  });

  it("computes weekly and weekday wall-clock occurrences", () => {
    const fridayMorning = new Date(2026, 4, 15, 8, 0, 0, 0).getTime();
    const fridayAtFour = new Date(2026, 4, 15, 16, 0, 0, 0).getTime();
    const mondayAtNine = new Date(2026, 4, 18, 9, 0, 0, 0).getTime();

    expect(
      computeNextAutomationRunAt(
        {
          kind: "weekly",
          daysOfWeek: ["friday"],
          timeOfDay: { hour: 16, minute: 0 },
        },
        fridayMorning,
      ),
    ).toBe(fridayAtFour);
    expect(
      computeNextAutomationRunAt(
        {
          kind: "weekdays",
          timeOfDay: { hour: 9, minute: 0 },
        },
        fridayAtFour,
      ),
    ).toBe(mondayAtNine);
  });
});
