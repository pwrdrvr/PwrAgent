import type {
  AutomationBacklogPolicy,
  AutomationRunStatus,
  AutomationScheduleDefinition,
  AutomationStatus,
} from "@pwragent/shared";

export function formatAutomationTimestamp(timestamp: number | undefined): string {
  if (!timestamp) {
    return "Not scheduled";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

export function formatAutomationRelative(timestamp: number | undefined): string {
  if (!timestamp) {
    return "never";
  }

  const deltaSeconds = Math.round((timestamp - Date.now()) / 1000);
  const absoluteSeconds = Math.abs(deltaSeconds);
  const suffix = deltaSeconds >= 0 ? "from now" : "ago";
  if (absoluteSeconds < 60) {
    return deltaSeconds >= 0 ? "now" : "just now";
  }
  const minutes = Math.round(absoluteSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${suffix}`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ${suffix}`;
  }
  const days = Math.round(hours / 24);
  return `${days}d ${suffix}`;
}

export function formatBacklogPolicy(policy: AutomationBacklogPolicy): string {
  return policy === "coalesce" ? "Coalesce missed runs" : "Drop missed runs";
}

export function formatAutomationStatus(status: AutomationStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function formatRunStatus(status: AutomationRunStatus): string {
  return status.replace("_", " ");
}

export function formatScheduleKind(schedule: AutomationScheduleDefinition): string {
  if (schedule.kind === "interval") {
    return "Interval";
  }
  if (schedule.kind === "weekdays") {
    return "Weekdays";
  }
  return "Weekly";
}
