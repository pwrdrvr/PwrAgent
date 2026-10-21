import type { SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import type { AppServerAvailableCommandSummary } from "@pwragent/shared";

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
  const byName = new Map<string, SlashCommand>();
  for (const command of commands) {
    if (!command.name || command.name.startsWith("__") || terminalCommands.has(command.name)) continue;
    const current = byName.get(command.name);
    if (!current || (command.builtin && !current.builtin)) byName.set(command.name, command);
  }
  return [...byName.values()].map((command) => ({
    name: command.name,
    ...(command.description ? { description: command.description } : {}),
    ...(command.aliases?.length ? { aliases: command.aliases } : {}),
    backend: "claude" as const,
    scope: "session" as const,
    source: "provider" as const,
  }));
}
