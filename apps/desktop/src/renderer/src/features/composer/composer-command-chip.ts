import type { ComposerCommandChip } from "./ComposerInputTypes";

/** A provider command the draft may start with. */
export type ComposerChipCommand = {
  aliases?: readonly string[];
  argumentHint?: string;
  description?: string;
  name: string;
};

export type ComposerLeadingCommand = {
  command: ComposerChipCommand;
  /** Everything after the command text. */
  rest: string;
  /** The leading `/name` exactly as the draft spells it. */
  text: string;
};

function bareName(name: string): string {
  return (name.startsWith("/") ? name.slice(1) : name).toLowerCase();
}

/**
 * The command a draft starts with: `/name` or one of its aliases at offset 0,
 * followed by whitespace or the end of the draft. Claude reads a command only
 * from the start of the prompt, so a `/name` anywhere else is plain text.
 */
export function findLeadingCommand(
  draft: string,
  commands: readonly ComposerChipCommand[],
): ComposerLeadingCommand | undefined {
  const match = /^\/([^\s/]+)(?=\s|$)/.exec(draft);
  if (!match) {
    return undefined;
  }
  const typed = match[1]!.toLowerCase();
  const command =
    commands.find((candidate) => bareName(candidate.name) === typed)
    ?? commands.find((candidate) =>
      (candidate.aliases ?? []).some((alias) => bareName(alias) === typed)
    );
  if (!command) {
    return undefined;
  }
  return { command, rest: draft.slice(match[0].length), text: match[0] };
}

/**
 * The muted text drawn after a command that has no arguments yet, such as
 * `[low|medium|high] [--fix]` after `/code-review `. The hint leaves once any
 * argument is typed, as it does in Claude Code's own prompt.
 */
export function leadingCommandArgumentHint(
  leading: ComposerLeadingCommand | undefined,
): string | undefined {
  const hint = leading?.command.argumentHint?.trim();
  if (!leading || !hint) {
    return undefined;
  }
  if (leading.rest === "") {
    return ` ${hint}`;
  }
  return /^[ \t]+$/.test(leading.rest) ? hint : undefined;
}

/** The usage line and description the chip shows on hover. */
export function buildCommandChipTooltip(
  command: ComposerChipCommand,
): string | undefined {
  const name = command.name.startsWith("/") ? command.name.slice(1) : command.name;
  const hint = command.argumentHint?.trim();
  const usage = `/${name}${hint ? ` ${hint}` : ""}`;
  const description = command.description?.trim();
  return description ? `${usage}\n${description}` : usage;
}

export function buildLeadingCommandChip(
  leading: ComposerLeadingCommand | undefined,
): ComposerCommandChip | undefined {
  return leading
    ? { text: leading.text, tooltip: buildCommandChipTooltip(leading.command) }
    : undefined;
}
