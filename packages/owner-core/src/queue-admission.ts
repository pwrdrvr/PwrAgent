export type QueueTerminal = { turnId: string; status?: string; errorMessage?: string };

/** Admission owns the async handoff, independently of the FIFO and its holds. */
export type QueueAdmission =
  | { phase: "idle" }
  | { phase: "starting"; attempt: symbol; kind: "start" | "steer"; terminals: ReadonlyMap<string, QueueTerminal> }
  | { phase: "acknowledged"; attempt: symbol; kind: "start" | "steer"; terminals: ReadonlyMap<string, QueueTerminal>; turnId: string; terminal?: QueueTerminal };

export type QueueAdmissionEvent =
  | { type: "begin"; attempt: symbol; kind?: "start" | "steer" }
  | { type: "terminal"; terminal: QueueTerminal }
  | { type: "acknowledge"; attempt: symbol; turnId: string }
  | { type: "settle"; attempt: symbol };

export function transitionQueueAdmission(
  current: QueueAdmission,
  event: QueueAdmissionEvent,
): QueueAdmission {
  if (event.type === "begin") {
    return current.phase === "idle"
      ? { phase: "starting", attempt: event.attempt, kind: event.kind ?? "start", terminals: new Map() }
      : current;
  }
  if (current.phase === "idle") return current;
  if (event.type === "terminal") {
    if (current.terminals.has(event.terminal.turnId)) return current;
    return {
      ...current,
      terminals: new Map([...current.terminals, [event.terminal.turnId, event.terminal]]),
      ...(current.phase === "acknowledged" && current.turnId === event.terminal.turnId
        ? { terminal: event.terminal } : {}),
    };
  }
  // A late acknowledgement/finally must never publish or release a newer attempt.
  if (current.attempt !== event.attempt) return current;
  if (event.type === "settle") return { phase: "idle" };
  if (current.phase !== "starting") return current;
  return {
    phase: "acknowledged",
    attempt: event.attempt,
    kind: current.kind,
    terminals: current.terminals,
    turnId: event.turnId,
    terminal: current.terminals.get(event.turnId),
  };
}
