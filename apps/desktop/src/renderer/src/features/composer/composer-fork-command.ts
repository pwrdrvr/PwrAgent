export type ComposerForkCommand = {
  error?: string;
  noHistory: boolean;
  worktree: "same" | "new";
};

export const FORK_COMMAND_USAGE = "/fork [--wt same|new] [--no-history]";

export function parseForkCommand(text: string): ComposerForkCommand | undefined {
  const trimmed = text.trim();
  if (!/^\/fork(?:\s|$)/i.test(trimmed)) {
    return undefined;
  }

  const command: ComposerForkCommand = { noHistory: false, worktree: "same" };
  const invalid = (): ComposerForkCommand => ({
    ...command,
    error: `Use ${FORK_COMMAND_USAGE}.`,
  });
  if (/[\r\n]/.test(trimmed)) {
    return invalid();
  }

  const args = trimmed.split(/\s+/).slice(1);
  let hasWorktree = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--no-history" && !command.noHistory) {
      command.noHistory = true;
    } else if (args[index] === "--wt" && !hasWorktree) {
      const value = args[++index];
      if (value !== "same" && value !== "new") {
        return invalid();
      }
      command.worktree = value;
      hasWorktree = true;
    } else {
      return invalid();
    }
  }
  return command;
}
