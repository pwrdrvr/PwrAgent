import type { AppLogEntry, AppLogSnapshot } from "../shared/app-metadata";

const MAX_BUFFERED_LOG_ENTRIES = 5000;

type AppLogEntryListener = (entry: AppLogEntry) => void;

const entries: AppLogEntry[] = [];
const listeners = new Set<AppLogEntryListener>();
let nextSequence = 1;
let droppedEntries = 0;

export function appendAppLogEntry(entry: Omit<AppLogEntry, "sequence">): AppLogEntry {
  const stored: AppLogEntry = {
    ...entry,
    sequence: nextSequence,
  };
  nextSequence += 1;

  entries.push(stored);
  if (entries.length > MAX_BUFFERED_LOG_ENTRIES) {
    entries.shift();
    droppedEntries += 1;
  }

  for (const listener of listeners) {
    listener(stored);
  }

  return stored;
}

export function readAppLogSnapshot(): AppLogSnapshot {
  return {
    kind: "log-snapshot",
    title: "Logs",
    entries: [...entries],
    readAt: Date.now(),
    truncated: droppedEntries > 0,
  };
}

export function subscribeAppLogEntries(listener: AppLogEntryListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function _resetAppLogsForTests(): void {
  entries.splice(0, entries.length);
  listeners.clear();
  nextSequence = 1;
  droppedEntries = 0;
}
