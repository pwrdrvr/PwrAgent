import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildFederatedThreadRef,
  type NavigationThreadSummary,
  type PrSummary,
} from "@pwragent/shared";
import { SidebarSearchPopup } from "../SidebarSearchPopup";

const jumpSearchRemoteThreads = vi.fn(
  async (): Promise<{ results: NavigationThreadSummary[] }> => ({
    results: [],
  }),
);
const readRendererFederationTarget = vi.fn<
  () => { scope: "remote"; instanceId: string } | undefined
>(() => undefined);

vi.mock("../../../lib/desktop-api", () => ({
  getDesktopApi: () => ({ jumpSearchRemoteThreads }),
}));

vi.mock("../../../lib/federation-window", () => ({
  readRendererFederationTarget: () => readRendererFederationTarget(),
}));

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

function remoteThread(params: {
  threadId: string;
  title: string;
  instanceId?: string;
  label?: string;
}): NavigationThreadSummary {
  const instanceId = params.instanceId ?? "peer-laptop";
  return {
    id: params.threadId,
    title: params.title,
    titleSource: "derived",
    source: "codex",
    inbox: { inInbox: false },
    linkedDirectories: [],
    federation: {
      ref: buildFederatedThreadRef({
        backend: "codex",
        instanceId,
        threadId: params.threadId,
      }),
      instanceLabel: params.label ?? "Laptop",
      peerStatus: "connected",
      capabilities: [],
    },
  } as NavigationThreadSummary;
}

async function settleRemoteSearch(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(250);
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  jumpSearchRemoteThreads.mockClear();
  jumpSearchRemoteThreads.mockResolvedValue({ results: [] });
  readRendererFederationTarget.mockReturnValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("SidebarSearchPopup", () => {
  it("finds Agent threads by role and marks the result", async () => {
    const threads: NavigationThreadSummary[] = [
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
    ];

    render(
      <SidebarSearchPopup
        threads={threads}
        onJumpToThread={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Jump to thread" }), {
      target: { value: "Agent" },
    });

    expect(screen.getByText("Housekeeping")).toBeInTheDocument();
    expect(screen.getByLabelText("Agent thread")).toHaveTextContent("Agent");
    await settleRemoteSearch();
  });

  it("appends debounced remote results below local hits with an instance chip", async () => {
    jumpSearchRemoteThreads.mockResolvedValue({
      results: [remoteThread({ threadId: "r1", title: "Remote fix" })],
    });

    render(
      <SidebarSearchPopup
        threads={[localThread({ title: "Local fix" })]}
        onJumpToThread={vi.fn()}
        onJumpToRemoteThread={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Jump to thread" }), {
      target: { value: "fix" },
    });

    // Local hits render instantly; the peer query hasn't fired yet.
    expect(screen.getByText("Local fix")).toBeInTheDocument();
    expect(jumpSearchRemoteThreads).not.toHaveBeenCalled();
    expect(screen.getByText("Searching other instances…")).toBeInTheDocument();

    await settleRemoteSearch();

    expect(jumpSearchRemoteThreads).toHaveBeenCalledWith({
      query: "fix",
      limit: 8,
    });
    expect(screen.getByText("Other instances")).toBeInTheDocument();
    expect(screen.getByText("Remote fix")).toBeInTheDocument();
    expect(screen.getByLabelText("Runs on Laptop")).toBeInTheDocument();
  });

  it("prioritizes exact PRs and describes numeric substring matches", async () => {
    const exact = localThread({
      id: "exact",
      title: "Stacked PRs",
      prs: [pr(44, "PwrGit"), pr(49, "PwrGit")],
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
    expect(rows[0]).toHaveTextContent("#49");
    expect(rows[1]).toHaveTextContent("Newer substring");
    expect(rows[1]).toHaveTextContent("#349");
    await settleRemoteSearch();
  });

  it("renders every PR and moves an exact match into the visible pair", async () => {
    render(
      <SidebarSearchPopup
        threads={[
          localThread({
            id: "stacked",
            title: "Stacked pull requests",
            prs: [
              pr(16, "PwrSuiteLab"),
              pr(18, "PwrSuiteLab"),
              pr(21, "PwrSuiteLab"),
            ],
          }),
        ]}
        onJumpToThread={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Jump to thread" }), {
      target: { value: "18" },
    });

    const chips = Array.from(document.querySelectorAll("[data-pr-chip]"));
    expect(chips).toHaveLength(3);
    expect(chips.map((chip) => chip.textContent)).toEqual(["#18", "#16", "#21"]);
    expect(document.querySelector(".jump-palette__row-prs")).toHaveAttribute(
      "data-overflow",
      "true",
    );

    const strip = screen.getByLabelText("Pull requests");
    Object.defineProperties(strip, {
      clientWidth: { configurable: true, value: 126 },
      scrollWidth: { configurable: true, value: 260 },
      scrollLeft: { configurable: true, value: 0, writable: true },
    });
    fireEvent.wheel(strip, { cancelable: true, deltaY: 40 });
    expect(strip.scrollLeft).toBe(40);
    await settleRemoteSearch();
  });

  it("resets a retained PR strip when the query moves an exact match first", async () => {
    render(
      <SidebarSearchPopup
        threads={[
          localThread({
            id: "stacked",
            title: "Stacked pull requests",
            prs: [pr(16), pr(18), pr(21)],
          }),
        ]}
        onJumpToThread={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Jump to thread" });
    fireEvent.change(input, { target: { value: "Stacked" } });
    const strip = screen.getByLabelText("Pull requests");
    Object.defineProperty(strip, "scrollLeft", {
      configurable: true,
      value: 40,
      writable: true,
    });

    fireEvent.change(input, { target: { value: "18" } });

    const chips = Array.from(document.querySelectorAll("[data-pr-chip]"));
    expect(chips.map((chip) => chip.textContent)).toEqual(["#18", "#16", "#21"]);
    expect(strip.scrollLeft).toBe(0);
    await settleRemoteSearch();
  });

  it("tabs through the active row PR chips and activates one without jumping", async () => {
    const onJumpToThread = vi.fn();
    const onClose = vi.fn();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(
      <SidebarSearchPopup
        threads={[
          localThread({
            id: "stacked",
            title: "Stacked pull requests",
            prs: [pr(16), pr(18)],
          }),
        ]}
        onJumpToThread={onJumpToThread}
        onClose={onClose}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Jump to thread" });
    fireEvent.change(input, { target: { value: "Stacked" } });
    const chips = screen.getAllByRole("button", {
      name: /Open pwrdrvr\/PwrAgent#/,
    });
    const firstChip = chips[0]!;
    const secondChip = chips[1]!;

    fireEvent.keyDown(input, { key: "Tab" });
    expect(firstChip).toHaveFocus();
    fireEvent.keyDown(firstChip, { key: "Tab" });
    expect(secondChip).toHaveFocus();
    fireEvent.keyDown(secondChip, { key: "Tab" });
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(secondChip).toHaveFocus();

    fireEvent.keyDown(secondChip, { key: "Enter" });
    expect(open).toHaveBeenCalledWith(
      "https://github.com/pwrdrvr/PwrAgent/pull/18",
      "_blank",
      "noopener,noreferrer",
    );
    expect(onJumpToThread).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    await settleRemoteSearch();
  });

  it("arrows from local into remote rows and Enter selects the remote thread", async () => {
    const onJumpToThread = vi.fn();
    const onJumpToRemoteThread = vi.fn();
    jumpSearchRemoteThreads.mockResolvedValue({
      results: [remoteThread({ threadId: "r1", title: "Remote fix" })],
    });

    render(
      <SidebarSearchPopup
        threads={[localThread({ title: "Local fix" })]}
        onJumpToThread={onJumpToThread}
        onJumpToRemoteThread={onJumpToRemoteThread}
        onClose={vi.fn()}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Jump to thread" });
    fireEvent.change(input, { target: { value: "fix" } });
    await settleRemoteSearch();

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onJumpToThread).not.toHaveBeenCalled();
    expect(onJumpToRemoteThread).toHaveBeenCalledTimes(1);
    expect(onJumpToRemoteThread.mock.calls[0][0].id).toBe("r1");
  });

  it("keeps a remote result when its backend and id collide locally", async () => {
    jumpSearchRemoteThreads.mockResolvedValue({
      results: [remoteThread({ threadId: "shared", title: "Remote fix" })],
    });

    render(
      <SidebarSearchPopup
        threads={[localThread({ id: "shared", title: "Local fix" })]}
        onJumpToThread={vi.fn()}
        onJumpToRemoteThread={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Jump to thread" }), {
      target: { value: "fix" },
    });
    await settleRemoteSearch();

    expect(screen.getByText("Local fix")).toBeInTheDocument();
    expect(screen.getByText("Remote fix")).toBeInTheDocument();
    expect(screen.getByText("Other instances")).toBeInTheDocument();
  });

  it("hides remote hits that are already pinned into the local list", async () => {
    const pinnedLocally = remoteThread({ threadId: "r1", title: "Remote fix" });
    jumpSearchRemoteThreads.mockResolvedValue({ results: [pinnedLocally] });

    render(
      <SidebarSearchPopup
        threads={[pinnedLocally]}
        onJumpToThread={vi.fn()}
        onJumpToRemoteThread={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Jump to thread" }), {
      target: { value: "fix" },
    });
    await settleRemoteSearch();

    // One row total: the local (pinned) one. No duplicate remote section row.
    expect(screen.getAllByText("Remote fix")).toHaveLength(1);
    expect(screen.queryByText("Other instances")).not.toBeInTheDocument();
  });

  it("drops stale remote responses from an earlier query", async () => {
    let resolveFirst:
      | ((value: { results: NavigationThreadSummary[] }) => void)
      | undefined;
    jumpSearchRemoteThreads
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({
        results: [remoteThread({ threadId: "r2", title: "Second query hit" })],
      });

    render(
      <SidebarSearchPopup
        threads={[]}
        onJumpToThread={vi.fn()}
        onJumpToRemoteThread={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Jump to thread" });
    fireEvent.change(input, { target: { value: "first" } });
    await settleRemoteSearch();
    fireEvent.change(input, { target: { value: "second" } });
    await settleRemoteSearch();

    await act(async () => {
      resolveFirst?.({
        results: [remoteThread({ threadId: "r1", title: "Stale hit" })],
      });
      await Promise.resolve();
    });

    expect(screen.queryByText("Stale hit")).not.toBeInTheDocument();
    expect(screen.getByText("Second query hit")).toBeInTheDocument();
  });

  it("does not query peers from a federation window", async () => {
    readRendererFederationTarget.mockReturnValue({
      scope: "remote",
      instanceId: "peer-laptop",
    });

    render(
      <SidebarSearchPopup
        threads={[localThread({ title: "Local fix" })]}
        onJumpToThread={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Jump to thread" }), {
      target: { value: "fix" },
    });
    await settleRemoteSearch();

    expect(jumpSearchRemoteThreads).not.toHaveBeenCalled();
    expect(
      screen.queryByText("Searching other instances…"),
    ).not.toBeInTheDocument();
  });

  it("portals a modal dialog out of whatever mounted it", async () => {
    // The sidebar is a container-query element — a containing block for fixed
    // descendants — and ⌘B hides it with `display: none`. A palette left
    // inside it would center on the rail and vanish with it.
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
    await settleRemoteSearch();
  });

  it("closes on a scrim press but not on a press inside the panel", async () => {
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
    await settleRemoteSearch();
  });

  it("publishes the arrowed-to row through aria-activedescendant", async () => {
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

    const rows = screen.getAllByRole("option");
    expect(input).toHaveAttribute("aria-activedescendant", rows[0]?.id);

    fireEvent.keyDown(input, { key: "ArrowDown" });

    expect(input).toHaveAttribute("aria-activedescendant", rows[1]?.id);
    await settleRemoteSearch();
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(
      <SidebarSearchPopup
        threads={[localThread({})]}
        onJumpToThread={vi.fn()}
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Jump to thread" }), {
      key: "Escape",
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    await settleRemoteSearch();
  });

  it("still steers from the keyboard after a press on the panel's chrome", async () => {
    // Pressing non-focusable chrome (the footer legend, the padding around the
    // field) moves focus to <body> in Chromium. A handler bound to the input
    // alone would leave Escape, ↑↓, and typing all dead from here.
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

    const dialog = screen.getByRole("dialog", { name: "Jump to thread" });
    // jsdom doesn't implement the focus-move-on-mousedown default, so assert
    // the suppression itself rather than an activeElement it hands us free.
    // fireEvent returns false once a handler called preventDefault.
    expect(fireEvent.mouseDown(screen.getByText("↑↓ navigate"))).toBe(false);

    // Dispatched on the dialog, not the field: a handler bound to the input
    // would never see these.
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    fireEvent.keyDown(dialog, { key: "Enter" });

    expect(onJumpToThread).toHaveBeenCalledTimes(1);
    expect(onJumpToThread.mock.calls[0][0].id).toBe("two");
    await settleRemoteSearch();
  });

  it("moves one row per arrow press, not two", async () => {
    // The handler moved from the field to the panel; leaving a copy on both
    // would double-count every keystroke as it bubbled.
    const onJumpToThread = vi.fn();
    render(
      <SidebarSearchPopup
        threads={[
          localThread({ id: "one", title: "First fix" }),
          localThread({ id: "two", title: "Second fix" }),
          localThread({ id: "three", title: "Third fix" }),
        ]}
        onJumpToThread={onJumpToThread}
        onClose={vi.fn()}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Jump to thread" });
    fireEvent.change(input, { target: { value: "fix" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onJumpToThread.mock.calls[0][0].id).toBe("two");
    await settleRemoteSearch();
  });

  it("keeps Tab inside the modal instead of walking into the dimmed app", async () => {
    render(
      <SidebarSearchPopup
        threads={[localThread({})]}
        onJumpToThread={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Jump to thread" });
    const tab = fireEvent.keyDown(input, { key: "Tab" });

    // fireEvent returns false once a handler called preventDefault.
    expect(tab).toBe(false);
    await settleRemoteSearch();
  });

  it("counts local and remote hits together in the footer", async () => {
    jumpSearchRemoteThreads.mockResolvedValue({
      results: [remoteThread({ threadId: "r1", title: "Remote fix" })],
    });

    render(
      <SidebarSearchPopup
        threads={[localThread({ title: "Local fix" })]}
        onJumpToThread={vi.fn()}
        onJumpToRemoteThread={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Jump to thread" }), {
      target: { value: "fix" },
    });
    await settleRemoteSearch();

    expect(screen.getByText("2 results")).toBeInTheDocument();
  });

  it("counts a lone hit in the singular", async () => {
    render(
      <SidebarSearchPopup
        threads={[localThread({ title: "Local fix" })]}
        onJumpToThread={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Jump to thread" }), {
      target: { value: "fix" },
    });

    expect(screen.getByText("1 result")).toBeInTheDocument();
    await settleRemoteSearch();
  });
});
