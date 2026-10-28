const absoluteDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

const fullDateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/**
 * A thread's age as the sidebar row prints it: "now", "42m", "8h", "6d", then
 * an absolute "Aug 16" past a week. The ⌘K palette prints the same label, so
 * both surfaces read from this one function.
 */
export function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) {
    return "now";
  }

  const deltaMinutes = Math.max(
    0,
    Math.round((Date.now() - timestamp) / (1000 * 60))
  );

  if (deltaMinutes < 1) {
    return "now";
  }
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m`;
  }

  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) {
    return `${deltaHours}h`;
  }

  const deltaDays = Math.round(deltaHours / 24);
  if (deltaDays < 7) {
    return `${deltaDays}d`;
  }

  return absoluteDateFormatter.format(timestamp);
}

/** The full date and time, with the year that "Aug 16" leaves out. */
export function formatFullTimestamp(timestamp: number): string {
  return fullDateTimeFormatter.format(timestamp);
}
