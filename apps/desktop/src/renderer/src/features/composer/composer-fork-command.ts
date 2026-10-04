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

const FORK_WORKTREE_FLAG = "--wt";
const FORK_NO_HISTORY_FLAG = "--no-history";
const FORK_WORKTREE_VALUES = ["same", "new"] as const;

type ForkDraftHint = {
  /** Literal text that finishes the token under the caret; may be empty. */
  completion: string;
  /** Everything drawn after the caret, starting with the completion. */
  hint: string;
};

/**
 * Muted text drawn after the caret while a `/fork` draft is being written:
 * the parameters still available, completing a partially typed flag or value.
 * Returns undefined when the draft is not a fork command, is complete, or
 * has an argument the parser would reject.
 */
export function forkCommandHint(text: string): string | undefined {
  return describeForkDraft(text)?.hint;
}

/**
 * The part of the hint that Tab, Right Arrow, or Space accepts: the rest of a
 * uniquely prefixed flag or worktree value. Bracketed parameters and the
 * `same|new` placeholder are guidance, not text, so they never complete.
 */
export function forkCommandCompletion(text: string): string | undefined {
  return describeForkDraft(text)?.completion || undefined;
}

function describeForkDraft(text: string): ForkDraftHint | undefined {
  const match = /^\/fork(?=\s|$)/i.exec(text);
  if (!match || /[\r\n]/.test(text)) {
    return undefined;
  }

  const rest = text.slice(match[0].length);
  const tokens = rest.split(/[ \t]+/).filter(Boolean);
  const endsWithSpace = rest.length > 0 && /[ \t]$/.test(rest);
  const partial = endsWithSpace ? undefined : tokens.pop();
  let worktree: "unset" | "pending" | "set" = "unset";
  let noHistory = false;
  for (const token of tokens) {
    if (worktree === "pending") {
      if (!(FORK_WORKTREE_VALUES as readonly string[]).includes(token)) return undefined;
      worktree = "set";
    } else if (token === FORK_WORKTREE_FLAG && worktree === "unset") {
      worktree = "pending";
    } else if (token === FORK_NO_HISTORY_FLAG && !noHistory) {
      noHistory = true;
    } else {
      return undefined;
    }
  }

  const remaining = (): string[] => [
    ...(worktree === "unset" ? [`[${FORK_WORKTREE_FLAG} same|new]`] : []),
    ...(noHistory ? [] : [`[${FORK_NO_HISTORY_FLAG}]`]),
  ];
  const describe = (completion: string, parts: string[]): ForkDraftHint | undefined => {
    const hint = [completion, ...parts].join(" ");
    return hint.trim() ? { completion, hint } : undefined;
  };

  if (partial === undefined) {
    const parts = worktree === "pending" ? ["same|new", ...remaining()] : remaining();
    if (parts.length === 0) return undefined;
    // Bare "/fork" has no separator yet, so the hint supplies it.
    return { completion: "", hint: `${rest.length === 0 ? " " : ""}${parts.join(" ")}` };
  }

  if (worktree === "pending") {
    const values = FORK_WORKTREE_VALUES.filter((value) => value.startsWith(partial));
    if (values.length !== 1) return undefined;
    worktree = "set";
    return describe(values[0]!.slice(partial.length), remaining());
  }

  const flags = [
    ...(worktree === "unset" ? [FORK_WORKTREE_FLAG] : []),
    ...(noHistory ? [] : [FORK_NO_HISTORY_FLAG]),
  ].filter((flag) => flag.startsWith(partial));
  if (flags.length !== 1) return undefined;
  const flag = flags[0]!;
  if (flag === FORK_WORKTREE_FLAG) {
    worktree = "pending";
    return describe(flag.slice(partial.length), ["same|new", ...remaining()]);
  }
  noHistory = true;
  return describe(flag.slice(partial.length), remaining());
}
