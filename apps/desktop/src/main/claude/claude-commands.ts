import type { SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import type { AppServerAvailableCommandSummary } from "@pwragent/shared/contracts/normalized-app-server";

/**
 * Commands whose UI belongs to Claude Code's terminal. A live turn's `init`
 * message names them in `terminal_slash_commands` and replaces this list; it
 * only covers a probe made before any turn has run. Observed from Claude Code
 * 2.1.305.
 */
export const CLAUDE_TERMINAL_COMMANDS_SEED: readonly string[] = [
  "doctor", "color", "focus", "reload-plugins",
];

/**
 * Map the SDK's command list to the composer's `/` menu entries.
 *
 * Hides terminal-only commands and internal `__` names. When two rows share a
 * name, the built-in row is the one `/name` runs, so it is the one shown.
 */
export function claudeCommandSummaries(
  commands: readonly SlashCommand[],
  terminalCommands: ReadonlySet<string>,
): AppServerAvailableCommandSummary[] {
  return selectClaudeCommandRows(commands, terminalCommands).map(claudeCommandSummary);
}

/** The rows `claudeCommandSummaries` shows: the one `/name` runs, per name. */
export function selectClaudeCommandRows(
  commands: readonly SlashCommand[],
  terminalCommands: ReadonlySet<string>,
): SlashCommand[] {
  const byName = new Map<string, SlashCommand>();
  for (const command of commands) {
    if (!command.name || command.name.startsWith("__") || terminalCommands.has(command.name)) continue;
    const current = byName.get(command.name);
    if (!current || (command.builtin && !current.builtin)) byName.set(command.name, command);
  }
  return [...byName.values()];
}

export function claudeCommandSummary(command: SlashCommand): AppServerAvailableCommandSummary {
  return {
    name: command.name,
    ...(command.description ? { description: command.description } : {}),
    ...(command.aliases?.length ? { aliases: command.aliases } : {}),
    ...(command.argumentHint?.trim() ? { argumentHint: command.argumentHint.trim() } : {}),
    backend: "claude" as const,
    scope: "session" as const,
    source: "provider" as const,
  };
}

function normalizeClaudeCommandName(name: string): string {
  return (name.startsWith("/") ? name.slice(1) : name).toLowerCase();
}

/**
 * Whether observed Claude slash commands allow `/compact`.
 * Returns true when no command list has been observed yet so cold sessions
 * can compact without spawning an extra probe process; returns false once
 * `compact` is marked terminal-only or omitted from an observed list.
 */
export function isClaudeCompactCommandAvailable(
  commands: readonly AppServerAvailableCommandSummary[] | undefined,
  terminalCommands: ReadonlySet<string>,
): boolean {
  for (const terminal of terminalCommands) {
    if (normalizeClaudeCommandName(terminal) === "compact") return false;
  }
  if (!commands) return true;
  return commands.some((command) =>
    normalizeClaudeCommandName(command.name) === "compact"
    || (command.aliases?.some((alias) => normalizeClaudeCommandName(alias) === "compact") ?? false),
  );
}
