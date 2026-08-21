export type ComposerSlashCommand = {
  aliases?: readonly string[];
  description?: string;
  name: string;
  /** Hide this client action while the compact composer holds attachments. */
  requiresNoAttachments?: boolean;
  sourceLabel: string;
};

export function normalizeSlashCommandName(name: string): string {
  return name.startsWith("/") ? name.slice(1) : name;
}

export function findSlashCommandTrigger(
  text: string,
  caret: number,
): {
  end: number;
  query: string;
  start: number;
} | undefined {
  const prefix = text.slice(0, caret);
  if (/\s$/.test(prefix)) {
    return undefined;
  }
  const match = /^\/([^\r\n]*)$/.exec(prefix);
  if (!match) {
    return undefined;
  }

  return {
    start: 0,
    end: caret,
    query: match[1] ?? "",
  };
}

export function filterSlashCommandCandidates(
  commands: readonly ComposerSlashCommand[],
  query: string,
): ComposerSlashCommand[] {
  const typed = `/${query}`.toLowerCase();
  const normalizedQuery = query.toLowerCase();
  return commands.filter((command) => {
    const name = normalizeSlashCommandName(command.name);
    return (
      `/${name}`.toLowerCase().startsWith(typed)
      || (command.aliases ?? []).some((alias) =>
        `/${normalizeSlashCommandName(alias)}`.toLowerCase().startsWith(typed)
      )
      || Boolean(
        normalizedQuery
        && command.description?.toLowerCase().includes(normalizedQuery),
      )
    );
  });
}

export function slashCommandMatchesText(
  command: ComposerSlashCommand,
  text: string,
): boolean {
  const normalizedText = text.toLowerCase();
  const commandName = `/${normalizeSlashCommandName(command.name)}`;
  return (
    commandName.toLowerCase() === normalizedText
    || (command.aliases ?? []).some(
      (alias) =>
        `/${normalizeSlashCommandName(alias)}`.toLowerCase() === normalizedText,
    )
  );
}
