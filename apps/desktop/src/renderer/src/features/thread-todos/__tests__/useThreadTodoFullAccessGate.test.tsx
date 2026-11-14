import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ThreadExecutionMode, ThreadTodo } from "@pwragent/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  threadTodoRunRaisesToFullAccess,
  useThreadTodoFullAccessGate,
  withSeenExecutionMode,
} from "../useThreadTodoFullAccessGate";
import type { ThreadTodoRunOptions } from "../thread-todos-view";

afterEach(() => {
  cleanup();
});

function handoffTodo(executionMode?: ThreadExecutionMode): ThreadTodo {
  return {
    id: "todo-1",
    backend: "codex",
    threadId: "voice-manager",
    kind: "handoff",
    status: "open",
    title: "Fix the flaky test",
    action: {
      type: "start_thread",
      prompt: "Fix the flaky test.",
      ...(executionMode ? { executionMode } : {}),
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

function Host(props: {
  todo: ThreadTodo;
  options?: ThreadTodoRunOptions;
  dismissed?: boolean;
  run: () => Promise<string>;
  onSettled: (value: string) => void;
}) {
  const { fullAccessRiskDialog, gateRun } = useThreadTodoFullAccessGate({
    dismissed: props.dismissed ?? false,
    onDismiss: async () => undefined,
  });
  return (
    <>
      <button
        type="button"
        onClick={() => {
          void gateRun(props.todo, props.options, props.run).then(props.onSettled);
        }}
      >
        Start
      </button>
      {fullAccessRiskDialog}
    </>
  );
}

async function start(props: Omit<Parameters<typeof Host>[0], "run" | "onSettled">) {
  const run = vi.fn(async () => "started");
  const onSettled = vi.fn();
  render(<Host {...props} run={run} onSettled={onSettled} />);
  await act(async () => screen.getByRole("button", { name: "Start" }).click());
  return { run, onSettled };
}

describe("threadTodoRunRaisesToFullAccess", () => {
  const modes = [undefined, "default", "auto", "full-access"] as const;
  const targets = [undefined, { backend: "codex", threadId: "existing" }] as const;

  // Oracle: only a new thread the card itself names at Full Access is an
  // escalation. An inherited mode raises nothing, and a prompt sent to an
  // existing thread carries no mode at all.
  it.each(modes.flatMap((mode) => targets.map((messageTarget) => ({ mode, messageTarget }))))(
    "start_thread at $mode, messageTarget $messageTarget.threadId",
    ({ mode, messageTarget }) => {
      expect(threadTodoRunRaisesToFullAccess(
        handoffTodo(mode),
        messageTarget ? { messageTarget } : undefined,
      )).toBe(mode === "full-access" && messageTarget === undefined);
    },
  );

  it("never gates a card that starts no thread", () => {
    expect(threadTodoRunRaisesToFullAccess({
      ...handoffTodo("full-access"),
      kind: "reminder",
      action: undefined,
    })).toBe(false);
  });
});

describe("withSeenExecutionMode", () => {
  // The owner compares this with its stored card, so it must be the access
  // of the same copy the gate judged.
  it.each([
    [undefined, "inherit"],
    ["default", "default"],
    ["auto", "auto"],
    ["full-access", "full-access"],
  ] as const)("sends a %s start card as %s", (mode, seen) => {
    expect(withSeenExecutionMode(handoffTodo(mode), { workMode: "worktree" }))
      .toEqual({ workMode: "worktree", seenExecutionMode: seen });
  });

  it("adds nothing to a prompt sent to an existing thread", () => {
    const options = { messageTarget: { backend: "codex" as const, threadId: "existing" } };
    expect(withSeenExecutionMode(handoffTodo("full-access"), options)).toBe(options);
  });
});

describe("useThreadTodoFullAccessGate", () => {
  it("holds a Full Access card until the operator accepts the warning", async () => {
    const { run, onSettled } = await start({ todo: handoffTodo("full-access") });

    expect(screen.getByRole("dialog", { name: "Enable Full Access?" })).toBeVisible();
    expect(run).not.toHaveBeenCalled();

    await act(async () => {
      screen.getByRole("button", { name: "I Understand and Accept the Risks" }).click();
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith("started");
  });

  it("starts nothing when the operator cancels", async () => {
    const { run, onSettled } = await start({ todo: handoffTodo("full-access") });

    await act(async () => screen.getByRole("button", { name: "Cancel" }).click());

    expect(screen.queryByRole("dialog", { name: "Enable Full Access?" })).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("runs at once after the operator dismissed the warning on this desktop", async () => {
    const { run } = await start({ todo: handoffTodo("full-access"), dismissed: true });

    expect(screen.queryByRole("dialog", { name: "Enable Full Access?" })).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs a card below Full Access without asking", async () => {
    const { run } = await start({ todo: handoffTodo("auto") });

    expect(screen.queryByRole("dialog", { name: "Enable Full Access?" })).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
