import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type NavigationThreadSummary,
  type PrSummary,
} from "@pwragent/shared";
import { SidebarSearchPopup } from "../SidebarSearchPopup";

function localThread(
  partial: Partial<NavigationThreadSummary>,
): NavigationThreadSummary {
  return {
    id: "local-1",
    title: "Local thread",
    titleSource: "explicit",
    source: "codex",
    inbox: { inInbox: true },
    linkedDirectories: [],
    ...partial,
  } as NavigationThreadSummary;
}

function pr(number: number, repo = "PwrAgent"): PrSummary {
  return {
    provider: "github.com",
    org: "pwrdrvr",
    repo,
    number,
    state: "pending",
    url: `https://github.com/pwrdrvr/${repo}/pull/${number}`,
  };
}

afterEach(() => {
  cleanup();
});

describe("SidebarSearchPopup", () => {
  it("finds local Agent threads by metadata and marks the result", () => {
    render(
      <SidebarSearchPopup
        threads={[
          localThread({
            id: "agent-1",
            title: "Housekeeping",
            agent: {
              name: "Jeeves",
              instructions: "Help people decide what to do next.",
              instructionLineCount: 1,
              instructionsTooLong: false,
              updatedAt: 1_000,
            },
          }),
        ]}
        onJumpToThread={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Jump to thread" }), {
      target: { value: "Agent Jeeves" },
    });

    expect(screen.getByText("Housekeeping")).toBeInTheDocument();
    expect(screen.getByLabelText("Agent thread")).toHaveTextContent("Agent");
  });

  it("prioritizes exact PRs and describes numeric substring matches", () => {
    const exact = localThread({
      id: "exact",
      title: "Stacked PRs",
      agent: {
        name: "Release Agent",
        instructionLineCount: 0,
        instructionsTooLong: false,
        updatedAt: 1_000,
      },
      prs: [pr(44, "PwrGit"), pr(49, "PwrGit")],
      gitBranch: "agent/backports/preserve-identifying-leaf",
      linkedDirectories: [
        {
          id: "pwr-git",
          label: "PwrGit",
          path: "/src/PwrGit",
          kind: "local",
        },
      ],
    });
    const substring = localThread({
      id: "substring",
      title: "Newer substring",
      prs: [pr(349)],
    });

    render(
      <SidebarSearchPopup
        threads={[substring, exact]}
        onJumpToThread={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Jump to thread" }), {
      target: { value: "49" },
    });

    const rows = screen.getAllByRole("option");
    expect(rows[0]).toHaveTextContent("Stacked PRs");
    expect(rows[0]).toHaveTextContent("Agent");
    expect(rows[0]).toHaveTextContent("#49");
    expect(rows[0]).toHaveTextContent("agent/backports/preserve-identifying-leaf");
    expect(rows[0]).toHaveTextContent("PwrGit");
    expect(rows[1]).toHaveTextContent("Newer substring");
    expect(rows[1]).toHaveTextContent("#349");
  });

  it("portals a modal dialog out of whatever mounted it", () => {
    render(
      <aside className="sidebar">
        <SidebarSearchPopup
          threads={[localThread({})]}
          onJumpToThread={vi.fn()}
          onClose={vi.fn()}
        />
      </aside>,
    );

    const dialog = screen.getByRole("dialog", { name: "Jump to thread" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog.closest(".sidebar")).toBeNull();
  });

  it("closes on a scrim press but not on a press inside the panel", () => {
    const onClose = vi.fn();
    render(
      <SidebarSearchPopup
        threads={[localThread({})]}
        onJumpToThread={vi.fn()}
        onClose={onClose}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Jump to thread" });
    fireEvent.pointerDown(dialog);
    expect(onClose).not.toHaveBeenCalled();

    const scrim = dialog.parentElement;
    expect(scrim).not.toBeNull();
    fireEvent.pointerDown(scrim as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("conditionally publishes list ownership and the active row", () => {
    render(
      <SidebarSearchPopup
        threads={[
          localThread({ id: "one", title: "First fix" }),
          localThread({ id: "two", title: "Second fix" }),
        ]}
        onJumpToThread={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Jump to thread" });
    expect(input).not.toHaveAttribute("aria-controls");
    expect(input).not.toHaveAttribute("aria-activedescendant");

    fireEvent.change(input, { target: { value: "fix" } });
    const list = screen.getByRole("listbox", { name: "Threads" });
    const rows = screen.getAllByRole("option");
    expect(input).toHaveAttribute("aria-controls", list.id);
    expect(input).toHaveAttribute("aria-activedescendant", rows[0]?.id);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", rows[1]?.id);

    fireEvent.change(input, { target: { value: "missing" } });
    expect(input).not.toHaveAttribute("aria-controls");
    expect(input).not.toHaveAttribute("aria-activedescendant");
  });

  it("handles Escape, arrows, Enter, and Tab on the dialog", () => {
    const onClose = vi.fn();
    const onJumpToThread = vi.fn();
    render(
      <SidebarSearchPopup
        threads={[
          localThread({ id: "one", title: "First fix" }),
          localThread({ id: "two", title: "Second fix" }),
        ]}
        onJumpToThread={onJumpToThread}
        onClose={onClose}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Jump to thread" });
    const dialog = screen.getByRole("dialog", { name: "Jump to thread" });
    fireEvent.change(input, { target: { value: "fix" } });

    expect(fireEvent.keyDown(input, { key: "Tab" })).toBe(false);
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(onJumpToThread.mock.calls[0][0].id).toBe("two");

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("keeps keyboard focus after chrome presses without breaking row clicks", () => {
    const onJumpToThread = vi.fn();
    render(
      <SidebarSearchPopup
        threads={[
          localThread({ id: "one", title: "First fix" }),
          localThread({ id: "two", title: "Second fix" }),
        ]}
        onJumpToThread={onJumpToThread}
        onClose={vi.fn()}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Jump to thread" });
    fireEvent.change(input, { target: { value: "fix" } });
    expect(fireEvent.mouseDown(screen.getByText("↑↓ navigate"))).toBe(false);
    expect(input).toHaveFocus();

    fireEvent.click(screen.getAllByRole("option")[1]!.querySelector("button")!);
    expect(onJumpToThread.mock.calls[0][0].id).toBe("two");
  });

  it("scrolls the keyboard-active row into view", () => {
    const scrollIntoView = vi.fn();
    const original = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollIntoView",
    );
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    try {
      render(
        <SidebarSearchPopup
          threads={[
            localThread({ id: "one", title: "First fix" }),
            localThread({ id: "two", title: "Second fix" }),
          ]}
          onJumpToThread={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      const input = screen.getByRole("textbox", { name: "Jump to thread" });
      fireEvent.change(input, { target: { value: "fix" } });
      fireEvent.keyDown(input, { key: "ArrowDown" });

      expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" });
    } finally {
      if (original) {
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollIntoView",
          original,
        );
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
      }
    }
  });

  it("shows local result counts for singular, plural, and empty matches", () => {
    render(
      <SidebarSearchPopup
        threads={[
          localThread({ id: "one", title: "First fix" }),
          localThread({ id: "two", title: "Second fix" }),
        ]}
        onJumpToThread={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Jump to thread" });
    fireEvent.change(input, { target: { value: "First" } });
    expect(screen.getByText("1 result")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "fix" } });
    expect(screen.getByText("2 results")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "missing" } });
    expect(screen.getByText("0 results")).toBeInTheDocument();
    expect(screen.getByText("No threads match")).toBeInTheDocument();
  });
});
