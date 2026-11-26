import type { AppServerSkillSummary } from "@pwragent/shared/contracts/normalized-app-server";

export type ComposerSlashCommand = {
  aliases?: readonly string[];
  /** The arguments the command takes, drawn after it in the menu and draft. */
  argumentHint?: string;
  /** A provider command the draft draws as a chip when it starts with it. */
  chip?: boolean;
  description?: string;
  name: string;
  /** Hide this client action while the compact composer holds attachments. */
  requiresNoAttachments?: boolean;
  skill?: AppServerSkillSummary;
  sourceLabel: string;
};

export function normalizeSlashCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "");
}

export type ProviderCompactCommandLike = {
  readonly aliases?: readonly string[];
  readonly backend?: string;
  readonly name: string;
};

/**
 * Find the advertised provider command that triggers compaction via
 * `compactThread` (Codex or an ACP backend advertising `compact` by name or
 * alias). Claude runs `/compact` itself when sent as a prompt.
 */
export function findComposerCompactCommand<T extends ProviderCompactCommandLike>(
  providerCommands: readonly T[] | undefined,
  threadSource: string | undefined,
): T | undefined {
  return providerCommands?.find((command) => {
    if (command.backend === "claude") {
      return false;
    }
    if (threadSource && command.backend && command.backend !== threadSource) {
      return false;
    }
    const normalized = normalizeSlashCommandName(command.name).toLowerCase();
    if (normalized === "compact") {
      return true;
    }
    return (command.aliases ?? []).some(
      (alias) => normalizeSlashCommandName(alias).toLowerCase() === "compact",
    );
  });
}

/** True when a trimmed draft invokes the resolved compact command with no arguments. */
export function isComposerCompactDraft(
  draft: string,
  compactCommand: ProviderCompactCommandLike | undefined,
): boolean {
  if (!compactCommand) {
    return false;
  }
  const trimmed = draft.trim().toLowerCase();
  const canonical = `/${normalizeSlashCommandName(compactCommand.name).toLowerCase()}`;
  if (trimmed === canonical) {
    return true;
  }
  return (compactCommand.aliases ?? []).some(
    (alias) => trimmed === `/${normalizeSlashCommandName(alias).toLowerCase()}`,
  );
}

/** True when a slash-menu suggestion corresponds to the resolved compact command. */
export function isComposerCompactSuggestion(
  suggestion: { readonly aliases?: readonly string[]; readonly label: string },
  compactCommand: ProviderCompactCommandLike | undefined,
): boolean {
  if (!compactCommand) {
    return false;
  }
  const normalizedLabel = normalizeSlashCommandName(suggestion.label).toLowerCase();
  const canonical = normalizeSlashCommandName(compactCommand.name).toLowerCase();
  if (normalizedLabel === canonical || normalizedLabel === "compact") {
    return true;
  }
  return (suggestion.aliases ?? []).some(
    (alias) => normalizeSlashCommandName(alias).toLowerCase() === "compact",
  );
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
