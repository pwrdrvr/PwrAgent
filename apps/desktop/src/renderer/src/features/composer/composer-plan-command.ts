/**
 * `/plan <message>` sends one turn in Plan mode: the agent plans the work
 * before changing anything. It replaced the composer's Plan toggle, which was
 * never persisted and reset on every send, so a one-turn command behaves the
 * same way.
 *
 * Codex takes it as the turn's collaboration mode and Claude as its plan
 * permission mode. An ACP provider with a native Plan mode offers it as an
 * access level instead.
 */
const PLAN_COMMAND_BACKENDS: ReadonlySet<string> = new Set(["codex", "claude"]);

export function supportsPlanCommand(backend: string | undefined): boolean {
  return backend !== undefined && PLAN_COMMAND_BACKENDS.has(backend);
}

/**
 * The message a `/plan` draft sends, or undefined for any other draft.
 * `/planning` is not the command: it must stand alone or be followed by
 * whitespace.
 */
export function parsePlanCommand(draft: string): { prompt: string } | undefined {
  const match = /^\/plan(?:\s+([\s\S]*))?$/i.exec(draft.trimStart());
  return match ? { prompt: (match[1] ?? "").trim() } : undefined;
}
