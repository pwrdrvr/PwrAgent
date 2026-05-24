import type {
  AutomationScheduleDefinition,
  AutomationWeekday,
} from "@pwragent/shared";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MAX_DUE_WINDOWS = 1_000;

const WEEKDAY_TO_DATE_DAY: Record<AutomationWeekday, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

export type AutomationDueWindow = {
  scheduledFor: number;
};

export function computeNextAutomationRunAt(
  schedule: AutomationScheduleDefinition,
  after: number,
): number {
  switch (schedule.kind) {
    case "interval":
      return computeNextIntervalRunAt(schedule, after);
    case "weekly":
      return computeNextWeeklyRunAt(schedule.daysOfWeek, schedule.timeOfDay, after);
    case "weekdays":
      return computeNextWeeklyRunAt(
        ["monday", "tuesday", "wednesday", "thursday", "friday"],
        schedule.timeOfDay,
        after,
      );
    default:
      return assertNeverSchedule(schedule);
  }
}

export function collectDueAutomationWindows(params: {
  schedule: AutomationScheduleDefinition;
  firstDueAt: number;
  through: number;
}): AutomationDueWindow[] {
  if (params.firstDueAt > params.through) return [];
  const windows: AutomationDueWindow[] = [];
  let cursor = params.firstDueAt;
  while (cursor <= params.through && windows.length < MAX_DUE_WINDOWS) {
    windows.push({ scheduledFor: cursor });
    cursor = computeNextAutomationRunAt(params.schedule, cursor);
  }
  return windows;
}

function computeNextIntervalRunAt(
  schedule: Extract<AutomationScheduleDefinition, { kind: "interval" }>,
  after: number,
): number {
  const intervalMs = schedule.every * (schedule.unit === "minutes" ? MINUTE_MS : HOUR_MS);
  const anchorAt = schedule.anchorAt ?? after;
  if (after < anchorAt) return anchorAt;
  const elapsed = after - anchorAt;
  const completedIntervals = Math.floor(elapsed / intervalMs);
  return anchorAt + (completedIntervals + 1) * intervalMs;
}

function computeNextWeeklyRunAt(
  daysOfWeek: AutomationWeekday[],
  timeOfDay: { hour: number; minute: number },
  after: number,
): number {
  const allowedDays = new Set(daysOfWeek.map((day) => WEEKDAY_TO_DATE_DAY[day]));
  const afterDate = new Date(after);
  const startOfDay = new Date(
    afterDate.getFullYear(),
    afterDate.getMonth(),
    afterDate.getDate(),
    0,
    0,
    0,
    0,
  ).getTime();

  for (let dayOffset = 0; dayOffset <= 7; dayOffset += 1) {
    const candidateDate = new Date(startOfDay + dayOffset * DAY_MS);
    if (!allowedDays.has(candidateDate.getDay())) continue;
    candidateDate.setHours(timeOfDay.hour, timeOfDay.minute, 0, 0);
    const candidate = candidateDate.getTime();
    if (candidate > after) {
      return candidate;
    }
  }

  throw new Error("Unable to compute next automation run time.");
}

function assertNeverSchedule(schedule: never): never {
  throw new Error(`Unsupported automation schedule: ${JSON.stringify(schedule)}`);
}
