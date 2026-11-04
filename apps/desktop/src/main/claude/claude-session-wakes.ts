import type { HookCallbackMatcher, HookEvent, SessionCronSummary } from "@anthropic-ai/claude-agent-sdk";
import type { AppServerBackendWake } from "@pwragent/shared";

/**
 * A wake Claude Code scheduled inside its own session: a dynamic /loop
 * wake-up (`ScheduleWakeup`) or a session cron (`CronCreate`). Both live in
 * the CLI process's memory and end with it. A `CronCreate` result with
 * `durable: true` went to the project's `.claude/scheduled_tasks.json`
 * instead. Any Claude session in that folder can run it, so it is not tracked
 * here; docs/claude-provider.md says why. When durable jobs are off for the
 * account, the CLI answers `durable: false` and the job is a session cron.
 */
export type ClaudeSessionWake = AppServerBackendWake & {
  /** When this process first saw the wake; held in memory only. */
  firstSeenAt: number;
};

/**
 * A one-shot fire normally starts a turn whose Stop hook drops it. Past its
 * time by this much, it no longer holds the session open.
 */
const ONE_SHOT_OVERDUE_MS = 60 * 60_000;

/**
 * The CLI expires a recurring job after seven days by default. A one-shot
 * wake with no fire time stops holding the session after as long.
 */
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** The CLI clips `session_crons` prompts with an in-string `… [+N chars]` marker. */
const CLIPPED_PROMPT_MARKER = /… \[\+\d+ chars\]$/;

/** A `ScheduleWakeup` result whose cron id the CLI does not report. */
type PendingLoopWakeup = { prompt: string; scheduledFor: number; reason?: string; seenAt: number };

/**
 * Tracks the wakes one Claude process will start on its own. The Stop hook's
 * `session_crons` is the CLI's authoritative set at each turn's end; tool
 * results between Stop hooks add what a turn scheduled or deleted and carry
 * the fire times the set leaves out.
 */
export class ClaudeSessionWakeTracker {
  private readonly wakes = new Map<string, ClaudeSessionWake>();
  private loopWakeups: PendingLoopWakeup[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  /** The Stop hook's set. Undefined means a CLI that does not report one. */
  replace(crons: readonly SessionCronSummary[] | undefined): void {
    if (!crons) return;
    const now = this.now();
    const unclaimed = [...this.loopWakeups];
    const next = new Map<string, ClaudeSessionWake>();
    for (const cron of crons) {
      const known = this.wakes.get(cron.id);
      const claimed = known ? -1 : cron.recurring ? -1 : unclaimed.findIndex((wakeup) => samePrompt(wakeup.prompt, cron.prompt));
      const wakeup = claimed >= 0 ? unclaimed.splice(claimed, 1)[0] : undefined;
      const fireAt = known?.nextFireAt ?? wakeup?.scheduledFor
        ?? (cron.recurring ? undefined : oneShotFireTime(cron.schedule, now));
      next.set(cron.id, {
        id: cron.id,
        // Only a recorded ScheduleWakeup is a /loop wake-up.
        origin: known?.origin ?? (wakeup ? "loop_wakeup" : "cron"),
        schedule: cron.schedule,
        recurring: cron.recurring,
        // The set clips long prompts; a tool's input has the whole text.
        prompt: known?.prompt ?? wakeup?.prompt ?? cron.prompt,
        ...(known?.humanSchedule ? { humanSchedule: known.humanSchedule } : {}),
        ...(known?.reason ?? wakeup?.reason ? { reason: known?.reason ?? wakeup?.reason } : {}),
        ...(fireAt !== undefined ? { nextFireAt: fireAt } : {}),
        firstSeenAt: known?.firstSeenAt ?? wakeup?.seenAt ?? now,
      });
    }
    this.wakes.clear();
    for (const [id, wake] of next) this.wakes.set(id, wake);
    this.loopWakeups = [];
  }

  /** A `ScheduleWakeup`, `CronCreate` or `CronDelete` result. */
  applyToolResult(toolName: string, input: unknown, response: unknown): void {
    const fields = record(input);
    const output = record(response);
    if (!fields || !output) return;
    if (toolName === "ScheduleWakeup") {
      if (output.stopped === true) {
        // stop:true cancels pending loop wake-ups, never a recurring cron.
        for (const [id, wake] of this.wakes) if (wake.origin === "loop_wakeup") this.wakes.delete(id);
        this.loopWakeups = [];
        return;
      }
      if (typeof fields.prompt !== "string" || typeof output.scheduledFor !== "number") return;
      this.loopWakeups.push({
        prompt: fields.prompt,
        scheduledFor: output.scheduledFor,
        ...(typeof fields.reason === "string" && fields.reason.trim() ? { reason: fields.reason } : {}),
        seenAt: this.now(),
      });
    } else if (toolName === "CronCreate") {
      if (typeof output.id !== "string" || typeof fields.cron !== "string" || typeof fields.prompt !== "string") return;
      if (output.durable === true) return;
      const now = this.now();
      const recurring = typeof output.recurring === "boolean" ? output.recurring : fields.recurring !== false;
      const fireAt = typeof output.nextFireAt === "number" ? output.nextFireAt
        : recurring ? undefined : oneShotFireTime(fields.cron, now);
      this.wakes.set(output.id, {
        id: output.id,
        origin: "cron",
        schedule: fields.cron,
        recurring,
        prompt: fields.prompt,
        ...(typeof output.humanSchedule === "string" && output.humanSchedule.trim() ? { humanSchedule: output.humanSchedule } : {}),
        ...(fireAt !== undefined ? { nextFireAt: fireAt } : {}),
        firstSeenAt: now,
      });
    } else if (toolName === "CronDelete") {
      if (typeof output.id === "string") this.wakes.delete(output.id);
    }
  }

  /**
   * Wakes still to come, soonest known time first. Drops one that should
   * have fired long ago, so a missed Stop hook cannot hold a process forever.
   */
  pending(): AppServerBackendWake[] {
    const now = this.prune();
    const rows: AppServerBackendWake[] = [...this.wakes.values()].map(({ firstSeenAt, nextFireAt, ...wake }) => ({
      ...wake,
      // A recurring job's first fire time goes stale once it passes.
      ...(nextFireAt !== undefined && !(wake.recurring && nextFireAt <= now) ? { nextFireAt } : {}),
      createdAt: firstSeenAt,
    }));
    for (const wakeup of this.loopWakeups) {
      rows.push({
        // The CLI reports this wake-up's id at the turn's Stop hook.
        id: `wakeup-${wakeup.scheduledFor}`,
        origin: "loop_wakeup",
        schedule: "",
        recurring: false,
        prompt: wakeup.prompt,
        ...(wakeup.reason ? { reason: wakeup.reason } : {}),
        nextFireAt: wakeup.scheduledFor,
        createdAt: wakeup.seenAt,
      });
    }
    return rows.sort((left, right) => (left.nextFireAt ?? Infinity) - (right.nextFireAt ?? Infinity)
      || (left.createdAt ?? 0) - (right.createdAt ?? 0));
  }

  /** Whether any wake is still to come; cheaper than `pending()`. */
  hasPending(): boolean {
    this.prune();
    return this.wakes.size > 0 || this.loopWakeups.length > 0;
  }

  /** Drop wakes that no longer hold the session; returns the time it used. */
  private prune(): number {
    const now = this.now();
    for (const [id, wake] of this.wakes) if (this.expiresAt(wake) <= now) this.wakes.delete(id);
    this.loopWakeups = this.loopWakeups.filter((wakeup) => wakeup.scheduledFor + ONE_SHOT_OVERDUE_MS > now);
    return now;
  }

  /** The soonest time a tracked wake stops holding the session open. */
  nextExpiry(): number | undefined {
    const times = [
      ...[...this.wakes.values()].map((wake) => this.expiresAt(wake)),
      ...this.loopWakeups.map((wakeup) => wakeup.scheduledFor + ONE_SHOT_OVERDUE_MS),
    ];
    return times.length ? Math.min(...times) : undefined;
  }

  private expiresAt(wake: ClaudeSessionWake): number {
    if (wake.recurring || wake.nextFireAt === undefined) return wake.firstSeenAt + MAX_AGE_MS;
    return wake.nextFireAt + ONE_SHOT_OVERDUE_MS;
  }
}

/**
 * A one-shot cron pins its minute, hour, day and month. Its next local match,
 * counting one that passed within the overdue window, or undefined.
 */
function oneShotFireTime(schedule: string, now: number): number | undefined {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5 || fields[4] !== "*" || !fields.slice(0, 4).every((field) => /^\d+$/.test(field))) return undefined;
  const [minute, hour, day, month] = fields.slice(0, 4).map(Number) as [number, number, number, number];
  const year = new Date(now).getFullYear();
  for (const candidate of [year, year + 1]) {
    const at = new Date(candidate, month - 1, day, hour, minute);
    // Date rolls an impossible day, such as 31 4, into the next month.
    if (at.getMonth() !== month - 1 || at.getDate() !== day || at.getHours() !== hour || at.getMinutes() !== minute) continue;
    if (at.getTime() > now - ONE_SHOT_OVERDUE_MS) return at.getTime();
  }
  return undefined;
}

/** Whether a clipped `session_crons` prompt is the start of a tool's prompt. */
function samePrompt(full: string, reported: string): boolean {
  if (full === reported) return true;
  const clipped = reported.replace(CLIPPED_PROMPT_MARKER, "");
  return clipped !== reported && full.startsWith(clipped);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** The tools that schedule or cancel a session wake. */
const CLAUDE_WAKE_TOOLS = "ScheduleWakeup|CronCreate|CronDelete";

/**
 * Hooks that report the session's wakes: each wake tool's result, and the
 * Stop hook's `session_crons` at every turn's end. They change nothing.
 */
export function claudeSessionWakeHooks(handlers: {
  toolResult: (toolName: string, input: unknown, response: unknown) => void;
  turnEnded: (crons: readonly SessionCronSummary[] | undefined) => void;
}): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    PostToolUse: [{
      matcher: CLAUDE_WAKE_TOOLS,
      hooks: [async (input) => {
        if (input.hook_event_name === "PostToolUse") {
          handlers.toolResult(input.tool_name, input.tool_input, input.tool_response);
        }
        return {};
      }],
    }],
    Stop: [{
      hooks: [async (input) => {
        if (input.hook_event_name === "Stop") handlers.turnEnded(input.session_crons);
        return {};
      }],
    }],
  };
}
