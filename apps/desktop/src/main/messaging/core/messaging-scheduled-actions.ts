import type { ScheduledThreadAction } from "@pwragent/shared";

export type ParsedMessagingSchedule =
  | { ok: true; scheduledFor: number; text: string }
  | { ok: false; error: string };

export function parseMessagingSchedule(
  args: readonly string[],
  now = Date.now(),
): ParsedMessagingSchedule {
  const [when, ...messageParts] = args;
  const text = messageParts.join(" ").trim();
  if (!when || !text) {
    return {
      ok: false,
      error: "Use /schedule <10m|2h|1d|ISO time> <message>.",
    };
  }
  const relative = /^(\d+)(m|h|d)$/i.exec(when);
  const scheduledFor = relative
    ? now + Number(relative[1]) * durationUnitMs(relative[2]!.toLowerCase())
    : Date.parse(when);
  if (!Number.isFinite(scheduledFor) || scheduledFor <= now) {
    return {
      ok: false,
      error: "Choose a future time such as 10m, 2h, 1d, or an ISO timestamp.",
    };
  }
  return { ok: true, scheduledFor, text };
}

export function scheduledActionDisplayId(actionId: string): string {
  return actionId.replace(/^scheduled-action:/, "").slice(0, 8);
}

export function resolveScheduledAction(
  actions: readonly ScheduledThreadAction[],
  candidateId: string | undefined,
):
  | { ok: true; action: ScheduledThreadAction }
  | { ok: false; error: string } {
  const normalized = candidateId?.trim().toLowerCase();
  if (!normalized) {
    return { ok: false, error: "Include the scheduled message ID." };
  }
  const matches = actions.filter((action) => {
    const id = action.id.toLowerCase();
    const displayId = scheduledActionDisplayId(action.id).toLowerCase();
    return id === normalized || displayId.startsWith(normalized);
  });
  if (matches.length === 0) {
    return { ok: false, error: "That scheduled message was not found." };
  }
  if (matches.length > 1) {
    return { ok: false, error: "That ID is ambiguous. Use more characters." };
  }
  return { ok: true, action: matches[0]! };
}

function durationUnitMs(unit: string): number {
  if (unit === "m") return 60_000;
  if (unit === "h") return 60 * 60_000;
  return 24 * 60 * 60_000;
}
