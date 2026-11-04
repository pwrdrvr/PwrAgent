import type { HookCallbackMatcher, HookEvent, UserPromptSubmitHookInput } from "@anthropic-ai/claude-agent-sdk";

/**
 * A turn Claude Code starts inside its own process, without a desktop
 * message: its answer to a finished background task (`task_notification`),
 * a dynamic /loop wake-up, or a session cron's fire.
 */
export type ClaudeSelfStartedTurnSource = "task_notification" | "loop_wakeup" | "cron";

export type ClaudeSelfStartedTurn = {
  prompt: string;
  source: ClaudeSelfStartedTurnSource;
};

/** The reason a blocked prompt reports in Claude's own transcript. */
export const CLAUDE_SELF_STARTED_TURN_HELD_REASON =
  "PwrAgent holds this turn while the thread is locked and sends it when the thread is unlocked.";

/**
 * Whether a submitted prompt is one Claude started on its own, and from
 * what. `source` names the author on CLIs that report it; `system` also
 * covers a task notification Claude folds into a running turn, so only a
 * prompt with no desktop turn to join counts. A CLI that omits `source`
 * starts its own prompts only when no desktop turn is open, because every
 * desktop message opens its turn before its prompt is written.
 */
export function claudeSelfStartedTurn(
  input: Pick<UserPromptSubmitHookInput, "prompt" | "source">,
  desktopTurnOpen: boolean,
): ClaudeSelfStartedTurn | undefined {
  if (desktopTurnOpen || !input.prompt.trim()) return undefined;
  switch (input.source) {
    case "loop_wakeup":
      return { prompt: input.prompt, source: "loop_wakeup" };
    case "schedule_wakeup":
      return { prompt: input.prompt, source: "cron" };
    case "system":
    case undefined:
      return { prompt: input.prompt, source: "task_notification" };
    default:
      // The operator's own message, or a host event PwrAgent does not send.
      return undefined;
  }
}

/**
 * The hook that lets PwrAgent hold a turn Claude starts on its own.
 * `hold` returns true once it has kept the prompt to send later; the hook
 * then blocks it, and the CLI drops it without running the model. A false
 * or failed `hold` lets the turn run, so a prompt is never lost.
 */
export function claudeSelfStartedTurnHooks(
  hold: (input: UserPromptSubmitHookInput) => Promise<boolean>,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    UserPromptSubmit: [{
      hooks: [async (input) => {
        if (input.hook_event_name !== "UserPromptSubmit") return {};
        let held = false;
        try {
          held = await hold(input);
        } catch {
          held = false;
        }
        return held
          ? {
              decision: "block" as const,
              reason: CLAUDE_SELF_STARTED_TURN_HELD_REASON,
              hookSpecificOutput: { hookEventName: "UserPromptSubmit" as const, suppressOriginalPrompt: true },
            }
          : {};
      }],
    }],
  };
}
