import type {
  AppServerAvailableCommandSummary,
  AppServerTurnInputItem,
} from "@pwragent/shared/contracts/normalized-app-server";

const ACP_COMPACT_COMMAND_PATTERN = /^\/compact(?:\s|$)/i;

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
 * True when text begins with `/compact` (bare or followed by whitespace and
 * optional focus instructions). Antigravity and other ACP agents only trigger
 * compaction when `/compact` is the leading text with nothing prepended.
 */
export function isAcpCompactCommandText(text: string): boolean {
  return ACP_COMPACT_COMMAND_PATTERN.test(text.trimStart());
}

/** True when a normalized turn input list starts with an ACP `/compact` command. */
export function isAcpCompactTurnInput(
  input: readonly AppServerTurnInputItem[],
): boolean {
  const first = input[0];
  return first?.type === "text" && isAcpCompactCommandText(first.text);
}

/** True when ACP wire prompt blocks start with a `/compact` command block. */
export function isAcpCompactPromptBlocks(
  prompt: ReadonlyArray<{ readonly type: string; readonly text?: string }>,
): boolean {
  const first = prompt[0];
  return first?.type === "text" && typeof first.text === "string" && isAcpCompactCommandText(first.text);
}
