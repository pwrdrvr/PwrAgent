import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { ClaudeSessionWakeTracker, claudeSessionWakeHooks } from "../claude/claude-session-wakes";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function tracker(start = 1_000_000) {
  let now = start;
  const wakes = new ClaudeSessionWakeTracker(() => now);
  return { wakes, advance: (ms: number) => { now += ms; }, now: () => now };
}

describe("ClaudeSessionWakeTracker", () => {
  it("keeps a /loop wake-up's time and reason, and takes its id from the Stop hook", () => {
    const { wakes, now } = tracker();
    wakes.applyToolResult("ScheduleWakeup",
      { delaySeconds: 600, reason: "The deploy takes about ten minutes.", prompt: "/loop check the deploy" },
      { scheduledFor: now() + 10 * MINUTE, clampedDelaySeconds: 600, wasClamped: false });
    // Before the turn ends the CLI has not said the wake-up's id.
    expect(wakes.pending()).toEqual([expect.objectContaining({
      origin: "loop_wakeup", prompt: "/loop check the deploy", nextFireAt: now() + 10 * MINUTE,
    })]);

    wakes.replace([{ id: "a1b2c3d4", schedule: "5 14 3 11 *", recurring: false, prompt: "/loop check the deploy" }]);
    expect(wakes.pending()).toEqual([{
      id: "a1b2c3d4", origin: "loop_wakeup", schedule: "5 14 3 11 *", recurring: false,
      prompt: "/loop check the deploy", reason: "The deploy takes about ten minutes.",
      nextFireAt: now() + 10 * MINUTE, createdAt: now(),
    }]);
  });

  it("matches a long prompt the Stop hook clipped", () => {
    const { wakes, now } = tracker();
    const prompt = `/loop ${"watch the canary ".repeat(100)}`;
    wakes.applyToolResult("ScheduleWakeup", { prompt, delaySeconds: 60, reason: "Soon." }, { scheduledFor: now() + MINUTE });
    wakes.replace([{ id: "c1", schedule: "1 0 1 1 *", recurring: false, prompt: `${prompt.slice(0, 1000)}… [+${prompt.length - 1000} chars]` }]);
    expect(wakes.pending()).toEqual([expect.objectContaining({ id: "c1", prompt, nextFireAt: now() + MINUTE, reason: "Soon." })]);
  });

  it("keeps a session cron's schedule wording, and drops its first fire time once it passes", () => {
    const { wakes, advance, now } = tracker();
    wakes.applyToolResult("CronCreate", { cron: "*/5 * * * *", prompt: "Check CI" },
      { id: "e5f6a7b8", humanSchedule: "Every 5 minutes", recurring: true, nextFireAt: now() + 5 * MINUTE });
    wakes.replace([{ id: "e5f6a7b8", schedule: "*/5 * * * *", recurring: true, prompt: "Check CI" }]);
    expect(wakes.pending()).toEqual([{
      id: "e5f6a7b8", origin: "cron", schedule: "*/5 * * * *", humanSchedule: "Every 5 minutes", recurring: true,
      prompt: "Check CI", nextFireAt: now() + 5 * MINUTE, createdAt: now(),
    }]);
    advance(6 * MINUTE);
    expect(wakes.pending()[0]).not.toHaveProperty("nextFireAt");
  });

  it("leaves out a durable cron, which Claude keeps in the project, not this session", () => {
    const { wakes } = tracker();
    wakes.applyToolResult("CronCreate", { cron: "0 9 * * 1-5", prompt: "Standup notes", durable: true },
      { id: "d1", humanSchedule: "Weekdays at 9am", recurring: true, durable: true });
    expect(wakes.pending()).toEqual([]);
  });

  it("follows deletes and a loop's stop between Stop hooks", () => {
    const { wakes, now } = tracker();
    wakes.applyToolResult("ScheduleWakeup", { prompt: "/loop", delaySeconds: 60, reason: "Soon." }, { scheduledFor: now() + MINUTE });
    wakes.replace([
      { id: "loop", schedule: "5 14 3 11 *", recurring: false, prompt: "/loop" },
      { id: "cron", schedule: "*/5 * * * *", recurring: true, prompt: "Check CI" },
      { id: "other", schedule: "0 * * * *", recurring: true, prompt: "Hourly" },
    ]);
    wakes.applyToolResult("CronDelete", { id: "other" }, { id: "other" });
    // stop:true ends pending wake-ups, never a recurring cron.
    wakes.applyToolResult("ScheduleWakeup", { stop: true }, { scheduledFor: now(), clampedDelaySeconds: 0, wasClamped: false, stopped: true, cancelledWakeups: 1 });
    expect(wakes.pending().map((wake) => wake.id)).toEqual(["cron"]);
  });

  it("takes the Stop hook's set as the truth, and ignores a CLI that reports none", () => {
    const { wakes, now } = tracker();
    wakes.applyToolResult("ScheduleWakeup", { prompt: "/loop", delaySeconds: 60, reason: "Soon." }, { scheduledFor: now() + MINUTE });
    wakes.replace(undefined);
    expect(wakes.pending()).toHaveLength(1);
    wakes.replace([]);
    expect(wakes.pending()).toEqual([]);
  });

  it("stops counting a wake that should have fired long ago, so it cannot hold the session forever", () => {
    const { wakes, advance, now } = tracker();
    wakes.applyToolResult("ScheduleWakeup", { prompt: "/loop", delaySeconds: 60, reason: "Soon." }, { scheduledFor: now() + MINUTE });
    wakes.replace([
      { id: "loop", schedule: "5 14 3 11 *", recurring: false, prompt: "/loop" },
      { id: "cron", schedule: "*/5 * * * *", recurring: true, prompt: "Check CI" },
      // A one-shot whose time cannot be read from its schedule.
      { id: "untimed", schedule: "*/30 9 * * 1", recurring: false, prompt: "Remind me" },
    ]);
    expect(wakes.hasPending()).toBe(true);
    expect(wakes.nextExpiry()).toBe(now() + MINUTE + 60 * MINUTE);
    advance(62 * MINUTE);
    expect(wakes.pending().map((wake) => wake.id)).toEqual(["cron", "untimed"]);
    // Claude expires a recurring job after seven days, and an untimed one-shot holds no longer.
    expect(wakes.nextExpiry()).toBe(now() - 62 * MINUTE + 7 * DAY);
    advance(7 * DAY);
    expect(wakes.pending()).toEqual([]);
    expect(wakes.hasPending()).toBe(false);
    expect(wakes.nextExpiry()).toBeUndefined();
  });

  it("reads a one-shot's fire time from its pinned schedule, and calls an unrecorded one a reminder", () => {
    const start = new Date(2026, 10, 3, 12, 0).getTime();
    const { wakes } = tracker(start);
    wakes.replace([
      { id: "remind", schedule: "30 14 3 11 *", recurring: false, prompt: "Check the deploy" },
      // 31 April does not exist, so there is no time to read.
      { id: "never", schedule: "0 9 31 4 *", recurring: false, prompt: "Never" },
    ]);
    expect(wakes.pending()).toEqual([
      expect.objectContaining({ id: "remind", origin: "cron", nextFireAt: new Date(2026, 10, 3, 14, 30).getTime() }),
      expect.not.objectContaining({ nextFireAt: expect.anything() }),
    ]);
    // A loop's stop leaves a reminder alone.
    wakes.applyToolResult("ScheduleWakeup", { stop: true }, { scheduledFor: start, clampedDelaySeconds: 0, wasClamped: false, stopped: true });
    expect(wakes.pending().map((wake) => wake.id)).toEqual(["remind", "never"]);
  });
});

describe("claudeSessionWakeHooks", () => {
  it("reports each wake tool's result and every turn's session_crons, and changes nothing", async () => {
    const toolResult = vi.fn();
    const turnEnded = vi.fn();
    const hooks = claudeSessionWakeHooks({ toolResult, turnEnded });
    expect(hooks.PostToolUse?.map((matcher) => matcher.matcher)).toEqual(["ScheduleWakeup|CronCreate|CronDelete"]);
    const signal = new AbortController().signal;
    await expect(hooks.PostToolUse![0]!.hooks[0]!({
      hook_event_name: "PostToolUse", tool_name: "CronDelete", tool_input: { id: "c1" }, tool_response: { id: "c1" }, tool_use_id: "t1",
    } as unknown as HookInput, "t1", { signal })).resolves.toEqual({});
    expect(toolResult).toHaveBeenCalledWith("CronDelete", { id: "c1" }, { id: "c1" });
    const crons = [{ id: "c2", schedule: "*/5 * * * *", recurring: true, prompt: "Check CI" }];
    await expect(hooks.Stop![0]!.hooks[0]!({
      hook_event_name: "Stop", stop_hook_active: false, session_crons: crons,
    } as unknown as HookInput, undefined, { signal })).resolves.toEqual({});
    expect(turnEnded).toHaveBeenCalledWith(crons);
  });
});
