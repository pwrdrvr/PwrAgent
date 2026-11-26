import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadTodo } from "@pwragent/shared/contracts/thread-todos";
import { ThreadTodoCard } from "../ThreadTodoCard";

afterEach(() => cleanup());

function proposal(label?: string): ThreadTodo {
  return {
    id: "rule",
    backend: "codex",
    threadId: "thread-a",
    kind: "reminder",
    status: "open",
    title: "Leave taken-over PRs to their maintainers",
    detail: "CONTRIBUTING.md says maintainers label a PR takeover:* when they take it over.",
    action: { type: "add_forge_hands_off_rule", repository: "upstream/canvas", ...(label ? { label } : {}) },
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("hands-off rule proposal card", () => {
  it("shows the exact rule the click saves and adds it only on that click", () => {
    const onRun = vi.fn();
    render(<ThreadTodoCard todo={proposal("takeover:*")} running={false} now={0}
      onRun={onRun} onStartReview={vi.fn()} onResolve={vi.fn()} onSetItemChecked={vi.fn()} />);
    expect(screen.getByText("upstream/canvas")).toBeInTheDocument();
    expect(screen.getByText("takeover:*")).toBeInTheDocument();
    expect(onRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun.mock.calls[0]?.[0]).toMatchObject({ id: "rule" });
  });

  it("says a rule without a label covers every PR into the repository", () => {
    render(<ThreadTodoCard todo={proposal()} running={false} now={0}
      onRun={vi.fn()} onStartReview={vi.fn()} onResolve={vi.fn()} onSetItemChecked={vi.fn()} />);
    expect(screen.getByText("Any PR")).toBeInTheDocument();
  });
});
