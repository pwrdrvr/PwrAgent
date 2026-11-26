import type {
  AppServerAvailableCommandSummary,
  AppServerTurnInputItem,
} from "@pwragent/shared/contracts/normalized-app-server";

const LEADING_SLASH_COMMAND_PATTERN = /^\/([^\s/]+)(?:\s|$)/i;

/** Strip leading slashes and outer whitespace from an advertised ACP command name. */
export function normalizeAcpCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "");
}

/**
 * Find the advertised ACP slash command that triggers context compaction
 * (named `compact` or carrying a `compact` alias), if the agent offers one.
 */
export function findAdvertisedAcpCompactCommand(
  commands: readonly AppServerAvailableCommandSummary[] | undefined,
): AppServerAvailableCommandSummary | undefined {
  return commands?.find((command) => {
    const normalized = normalizeAcpCommandName(command.name).toLowerCase();
    if (normalized === "compact") {
      return true;
    }
    return (command.aliases ?? []).some(
      (alias) => normalizeAcpCommandName(alias).toLowerCase() === "compact",
    );
  });
}

/** Format an advertised ACP command into its leading slash-command prompt text. */
export function formatAcpCompactCommandPrompt(
  command: AppServerAvailableCommandSummary,
): string {
  return `/${normalizeAcpCommandName(command.name)}`;
}

/**
 * Lowercased slash-command trigger names (without leading `/`) that invoke
 * compaction for an ACP session: always `"compact"`, plus the canonical name
 * and aliases of any advertised compact command (e.g. `summarize` when aliased
 * to `compact`).
 */
export function acpCompactCommandTriggerNames(
  commands?: readonly AppServerAvailableCommandSummary[],
): Set<string> {
  const names = new Set<string>(["compact"]);
  const advertised = findAdvertisedAcpCompactCommand(commands);
  if (!advertised) {
    return names;
  }
  const canonical = normalizeAcpCommandName(advertised.name).toLowerCase();
  if (canonical) {
    names.add(canonical);
  }
  for (const alias of advertised.aliases ?? []) {
    const normalizedAlias = normalizeAcpCommandName(alias).toLowerCase();
    if (normalizedAlias) {
      names.add(normalizedAlias);
    }
  }
  return names;
}

/**
 * True when text begins with `/compact` or the session's advertised compact
 * command name/alias (bare or followed by whitespace and optional focus
 * instructions). ACP agents such as Antigravity only trigger compaction when
 * the command is the leading text with nothing prepended.
 */
export function isAcpCompactCommandText(
  text: string,
  commands?: readonly AppServerAvailableCommandSummary[],
): boolean {
  const match = LEADING_SLASH_COMMAND_PATTERN.exec(text.trimStart());
  if (!match?.[1]) {
    return false;
  }
  return acpCompactCommandTriggerNames(commands).has(match[1].toLowerCase());
}

/** True when a normalized turn input list starts with an ACP compact command. */
export function isAcpCompactTurnInput(
  input: readonly AppServerTurnInputItem[],
  commands?: readonly AppServerAvailableCommandSummary[],
): boolean {
  const first = input[0];
  return first?.type === "text" && isAcpCompactCommandText(first.text, commands);
}

/** True when ACP wire prompt blocks start with a compact command block. */
export function isAcpCompactPromptBlocks(
  prompt: ReadonlyArray<{ readonly type: string; readonly text?: string }>,
  commands?: readonly AppServerAvailableCommandSummary[],
): boolean {
  const first = prompt[0];
  return (
    first?.type === "text"
    && typeof first.text === "string"
    && isAcpCompactCommandText(first.text, commands)
  );
}
