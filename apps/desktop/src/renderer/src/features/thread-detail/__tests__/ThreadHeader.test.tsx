import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { ThreadHeader } from "../ThreadHeader";

afterEach(() => {
  cleanup();
});

const thread: NavigationThreadSummary = {
  id: "thread-1",
  title: "AI API Rate Limiting",
  titleSource: "explicit",
  source: "codex",
  executionMode: "default",
  updatedAt: Date.now(),
  linkedDirectories: [],
  inbox: {
    inInbox: true,
  },
};

describe("ThreadHeader", () => {
  it("renders the project breadcrumb and reveals the selected row from title click", () => {
    const onRevealSelectedThreadInList = vi.fn();

    render(
      <ThreadHeader
        projectLabel="PwrSnap"
        thread={thread}
        onRevealSelectedThreadInList={onRevealSelectedThreadInList}
      />,
    );

    expect(screen.getByText("PwrSnap")).toHaveClass("thread-header__eyebrow");
    expect(
      screen.getByRole("heading", { level: 2, name: "AI API Rate Limiting" }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Show selected thread in thread list",
      }),
    );

    expect(onRevealSelectedThreadInList).toHaveBeenCalledOnce();
  });

  it("leaves the project label as text when the thread list has no such project", () => {
    render(<ThreadHeader projectLabel="PwrSnap" thread={thread} />);

    expect(screen.getByText("PwrSnap").tagName).toBe("SPAN");
    expect(
      screen.queryByRole("button", { name: "New thread in PwrSnap" }),
    ).not.toBeInTheDocument();
  });

  it("links the project label to the project in Directories", () => {
    const onReveal = vi.fn();

    render(
      <ThreadHeader
        projectLabel="PwrSnap"
        project={{ directoryKey: "directory:/repo", onReveal, onCreateThread: vi.fn() }}
        thread={thread}
      />,
    );

    const link = screen.getByRole("button", { name: "Show PwrSnap in Directories" });
    expect(link).toHaveTextContent("PwrSnap");
    // The eyebrow span keeps the breadcrumb's trim and baseline.
    expect(link.parentElement).toHaveClass("thread-header__eyebrow");
    fireEvent.click(link);

    expect(onReveal).toHaveBeenCalledOnce();
  });

  it("starts a thread in the project from the caret's menu", () => {
    const onCreateThread = vi.fn();

    render(
      <ThreadHeader
        projectLabel="PwrSnap"
        project={{ directoryKey: "directory:/repo", onReveal: vi.fn(), onCreateThread }}
        thread={thread}
      />,
    );

    const caret = screen.getByRole("button", { name: "New thread in PwrSnap" });
    expect(caret).toHaveAttribute("aria-haspopup", "menu");
    expect(caret).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.click(caret);
    expect(caret).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("menu", { name: "New thread in PwrSnap" });
    // No machines enrolled, so no machine section.
    expect(screen.queryByText("New chat on")).not.toBeInTheDocument();

    fireEvent.click(within(menu).getByRole("menuitem", { name: "New chat in PwrSnap" }));
    expect(onCreateThread).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes the caret's menu when the project changes under a same label", () => {
    const view = render(
      <ThreadHeader
        projectLabel="api"
        project={{ directoryKey: "directory:/work/a/api", onReveal: vi.fn(), onCreateThread: vi.fn() }}
        thread={thread}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "New thread in api" }));
    expect(screen.getByRole("menu", { name: "New thread in api" })).toBeInTheDocument();

    const onCreateThread = vi.fn();
    view.rerender(
      <ThreadHeader
        projectLabel="api"
        project={{ directoryKey: "directory:/work/b/api", onReveal: vi.fn(), onCreateThread }}
        thread={thread}
      />,
    );

    // A menu opened for one checkout must not start a thread in another.
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(onCreateThread).not.toHaveBeenCalled();
  });

  it("offers the project on other machines and closes on Escape", () => {
    const onCreateRemote = vi.fn();
    const directory = { kind: "directory" as const, label: "PwrSnap", path: "/repo" };

    render(
      <ThreadHeader
        projectLabel="PwrSnap"
        project={{
          directoryKey: "directory:/repo",
          onReveal: vi.fn(),
          onCreateThread: vi.fn(),
          federation: {
            directory,
            targets: [
              { instanceId: "peer-1", label: "studio-mini", availability: "available" },
              { instanceId: "peer-2", label: "build-box", availability: "offline" },
            ],
            onCreateThread: onCreateRemote,
          },
        }}
        thread={thread}
      />,
    );

    const caret = screen.getByRole("button", { name: "New thread in PwrSnap" });
    fireEvent.click(caret);
    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("New chat on")).toBeInTheDocument();

    // An offline machine is listed but refuses the click.
    fireEvent.click(within(menu).getByRole("menuitem", { name: /build-box/ }));
    expect(onCreateRemote).not.toHaveBeenCalled();

    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(caret).toHaveFocus();

    fireEvent.click(caret);
    fireEvent.click(
      within(screen.getByRole("menu")).getByRole("menuitem", { name: /studio-mini/ }),
    );
    expect(onCreateRemote).toHaveBeenCalledWith("peer-1");
  });

  it("shows the Agent marker when the selected thread has persona metadata", () => {
    render(
      <ThreadHeader
        thread={{
          ...thread,
          agent: {
            name: "Inbox Triage",
            instructions: "Keep updates concise.",
            instructionLineCount: 1,
            instructionsTooLong: false,
            updatedAt: 1_000,
          },
        }}
      />,
    );

    const chip = screen.getByText("Agent: Inbox Triage");
    expect(chip).toHaveClass("chip--mode");
    expect(chip).toHaveAttribute("title", "Inbox Triage, 1 instruction line");
  });

  it("shows the approval CTA beside the thread title", () => {
    render(
      <ThreadHeader
        hasApprovalRequest
        thread={thread}
      />,
    );

    expect(screen.getByText("Waiting for approval", { exact: true })).toHaveClass(
      "thread-row__chip--approval",
    );
  });

  it("renders the terminal toggle as an icon-only affordance with a tooltip", () => {
    render(
      <ThreadHeader
        thread={thread}
        layout={{
          railOpen: true,
          sidebarOpen: true,
          terminalOpen: false,
          onToggleRail: vi.fn(),
          onToggleSidebar: vi.fn(),
          onToggleTerminal: vi.fn(),
        }}
      />,
    );

    const toggle = screen.getByRole("button", { name: "Open integrated terminal" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveTextContent("");
  });

  it("opens Grok conversation rewind from the header control", () => {
    const onOpen = vi.fn();
    render(
      <ThreadHeader
        rewind={{ onOpen }}
        thread={{ ...thread, source: "acp:grok" }}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Rewind Grok conversation" }),
    );

    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("opens Grok workflow budgets from the header control", () => {
    const onOpen = vi.fn();
    render(
      <ThreadHeader
        thread={{ ...thread, source: "acp:grok" }}
        workflowBudget={{ onOpen }}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Configure Grok workflow budgets" }),
    );

    expect(onOpen).toHaveBeenCalledOnce();
  });
});
