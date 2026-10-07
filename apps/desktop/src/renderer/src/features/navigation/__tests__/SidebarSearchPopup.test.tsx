import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildFederatedThreadRef,
  type FederationJumpSearchProgress,
  type FederationJumpSearchRequest,
  type NavigationThreadSummary,
  type NavigationQueryPage,
  type PrSummary,
} from "@pwragent/shared";
import { SidebarSearchPopup } from "../SidebarSearchPopup";
import { useModalDialog } from "../../../lib/useModalDialog";
import { pressEscape, pressTab, tabEscapes } from "../../../test/tab-walk";

const jumpSearchRemoteThreads = vi.fn(
  async (
    _request: FederationJumpSearchRequest,
    _onProgress?: (progress: FederationJumpSearchProgress) => void,
  ): Promise<{ results: NavigationThreadSummary[] }> => ({ results: [] }),
);
const readRendererFederationTarget = vi.fn<
  () => { scope: "remote"; instanceId: string } | undefined
>(() => undefined);

const getNavigationQueryPage = vi.fn<() => Promise<NavigationQueryPage>>();
const releaseNavigationQuery = vi.fn(async () => undefined);
const desktopApi = { jumpSearchRemoteThreads, getNavigationQueryPage, releaseNavigationQuery, platform: "darwin" };
vi.mock("../../../lib/desktop-api", () => ({ getDesktopApi: () => desktopApi }));

vi.mock("../../../lib/federation-window", () => ({
  readRendererFederationTarget: () => readRendererFederationTarget(),
  readRendererFederationLabel: () => "Windows workstation",
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
  desktopApi.platform = "darwin";
  getNavigationQueryPage.mockReset();
  getNavigationQueryPage.mockResolvedValue({ protocol: 2, queryKey: "search", generation: "generation", ownerEpoch: "owner",
    countsRevision: "counts", counts: { total: 0, active: 0, unread: 0, review: 0 }, coverage: { state: "complete" }, entries: [], complete: true });
  releaseNavigationQuery.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("SidebarSearchPopup", () => {
  it("finds an unloaded owner match and releases the query when the palette closes", async () => {
    const row = { ...localThread({ id: "off-page", title: "Agent outside the loaded page" }),
      ref: { backend: "codex" as const, threadId: "off-page" }, rowRevision: "revision", ordinaryChildCount: 0,
      nativeSubAgentGroupPresent: false, queueCount: 0, queueState: "unknown" as const };
    const empty = await getNavigationQueryPage();
    getNavigationQueryPage.mockClear();
    getNavigationQueryPage.mockResolvedValue({ ...empty, entries: [{ row, orderKey: "one", placement: { kind: "root" } }] });
    const select = vi.fn();
    const view = render(<SidebarSearchPopup threads={[]} onJumpToThread={select} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Jump to thread" }), { target: { value: "owner persona match" } });
    expect(getNavigationQueryPage).not.toHaveBeenCalled();
    await settleRemoteSearch();
    expect(screen.getByText("Agent outside the loaded page")).toBeInTheDocument();
    expect(getNavigationQueryPage).toHaveBeenCalledWith(expect.objectContaining({ inventory: "owner", pageSize: 8,
      query: { kind: "search", text: "owner persona match" } }), expect.any(String));
    fireEvent.click(screen.getByText("Agent outside the loaded page"));
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ id: "off-page" }));
    view.unmount();
    expect(releaseNavigationQuery).toHaveBeenCalled();
  });

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

    expect(jumpSearchRemoteThreads).toHaveBeenCalledWith(
      {
        query: "fix",
        limit: 8,
      },
      expect.any(Function),
    );
    expect(screen.getByText("Other instances")).toBeInTheDocument();
    expect(screen.getByText("Remote fix")).toBeInTheDocument();
    expect(screen.getByLabelText("Runs on Laptop")).toBeInTheDocument();
  });

  it("renders a fast peer result while a slower peer is still pending", async () => {
    let resolveSearch:
      | ((value: { results: NavigationThreadSummary[] }) => void)
      | undefined;
    let publishProgress:
      | ((progress: FederationJumpSearchProgress) => void)
      | undefined;
    const fast = remoteThread({ threadId: "r1", title: "Fast peer fix" });
    jumpSearchRemoteThreads.mockImplementationOnce(
      (_request, onProgress) => {
        publishProgress = onProgress;
        return new Promise((resolve) => {
          resolveSearch = resolve;
        });
      },
    );

    render(
      <SidebarSearchPopup
        threads={[]}
        onJumpToThread={vi.fn()}
        onJumpToRemoteThread={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Jump to thread" }), {
      target: { value: "fix" },
    });
    await settleRemoteSearch();

    await act(async () => {
      publishProgress?.({
        results: [fast],
        completedPeerCount: 1,
        totalPeerCount: 2,
        complete: false,
      });
      await Promise.resolve();
    });

    expect(screen.getByText("Fast peer fix")).toBeInTheDocument();
    expect(
      screen.getByText("Searching other instances… 1/2"),
    ).toBeInTheDocument();

    await act(async () => {
      publishProgress?.({
        results: [fast],
        completedPeerCount: 2,
        totalPeerCount: 2,
        complete: true,
      });
      resolveSearch?.({ results: [fast] });
      await Promise.resolve();
    });

    expect(
      screen.queryByText(/Searching other instances/),
    ).not.toBeInTheDocument();
    expect(screen.getByText("1 result")).toBeInTheDocument();
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
    let publishFirst:
      | ((progress: FederationJumpSearchProgress) => void)
      | undefined;
    jumpSearchRemoteThreads
      .mockImplementationOnce(
        (_request, onProgress) => {
          publishFirst = onProgress;
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        },
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
      publishFirst?.({
        results: [remoteThread({ threadId: "r1", title: "Stale progress" })],
        completedPeerCount: 1,
        totalPeerCount: 2,
        complete: false,
      });
      resolveFirst?.({
        results: [remoteThread({ threadId: "r1", title: "Stale hit" })],
      });
      await Promise.resolve();
    });

    expect(screen.queryByText("Stale progress")).not.toBeInTheDocument();
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

/** The sidebar's ⌘K, or the Star Map's Fly to thread button. */
function Opener(props: {
  onLayerKeyDown?: (key: string) => void;
  threads?: NavigationThreadSummary[];
}) {
  const [open, setOpen] = useState(false);
  return (
    // The Star Map hosts the palette, and its layer reads keys through the
    // React tree the palette portals out of.
    <div onKeyDown={(event) => props.onLayerKeyDown?.(event.key)}>
      <button type="button" onClick={() => setOpen(true)}>
        Jump
      </button>
      {open ? (
        <SidebarSearchPopup
          threads={props.threads ?? [localThread({})]}
          onJumpToThread={vi.fn()}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

function openFromButton(props: Parameters<typeof Opener>[0] = {}): HTMLElement {
  render(<Opener {...props} />);
  const button = screen.getByRole("button", { name: "Jump" });
  button.focus();
  act(() => button.click());
  return button;
}

/** A dialog already open when ⌘K opens the palette over it. */
function DialogBeneath(props: { onFocusIn: () => void }) {
  const ref = useModalDialog({ onClose: () => undefined });
  return (
    <div ref={ref} role="dialog" aria-label="Dialog beneath" onFocus={props.onFocusIn}>
      <button type="button">Beneath first</button>
      <button type="button">Beneath last</button>
    </div>
  );
}

describe("SidebarSearchPopup, focus", () => {
  it("returns focus to what opened it when Escape closes it", async () => {
    const button = openFromButton();
    expect(screen.getByRole("textbox", { name: "Jump to thread" })).toHaveFocus();
    pressEscape();
    expect(screen.queryByRole("dialog", { name: "Jump to thread" })).toBeNull();
    expect(button).toHaveFocus();
    await settleRemoteSearch();
  });

  it("keeps its Escape from the tree it portals out of", async () => {
    const onLayerKeyDown = vi.fn();
    openFromButton({ onLayerKeyDown });
    pressEscape();
    expect(screen.queryByRole("dialog", { name: "Jump to thread" })).toBeNull();
    expect(onLayerKeyDown).not.toHaveBeenCalledWith("Escape");
    await settleRemoteSearch();
  });

  it("keeps a 60-Tab walk inside, through the active row's PR chips", async () => {
    openFromButton({
      threads: [localThread({ id: "stacked", title: "Stacked", prs: [pr(16), pr(18)] })],
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Jump to thread" }), {
      target: { value: "Stacked" },
    });
    const dialog = screen.getByRole("dialog", { name: "Jump to thread" });
    expect(tabEscapes(dialog)).toEqual({ forward: [], backward: [] });
    await settleRemoteSearch();
  });

  it("answers Tab alone when it opens over a dialog", async () => {
    // Both would otherwise act on one keypress: the dialog beneath pulled
    // focus to its own first control, and the palette pulled it back.
    const onFocusIn = vi.fn();
    render(<DialogBeneath onFocusIn={onFocusIn} />);
    openFromButton({
      threads: [localThread({ id: "stacked", title: "Stacked", prs: [pr(16)] })],
    });
    const input = screen.getByRole("textbox", { name: "Jump to thread" });
    fireEvent.change(input, { target: { value: "Stacked" } });
    onFocusIn.mockClear();
    pressTab();
    expect(screen.getByRole("button", { name: /Open pwrdrvr\/PwrAgent#16/ })).toHaveFocus();
    pressTab();
    expect(input).toHaveFocus();
    expect(onFocusIn).not.toHaveBeenCalled();
    await settleRemoteSearch();
  });
});

describe("project destinations", () => {
  const project = { key: "directory:/repos/PwrAgnt", kind: "directory" as const, label: "PwrAgnt", path: "/repos/PwrAgnt" };

  it.each([
    ["darwin", "C:/PwrLab/repos/PwrAgent", "/Users/example/repos/PwrAgnt", "Windows"],
    ["linux", "\\\\workstation\\repos\\PwrAgent", "/home/example/repos/PwrAgnt", "Windows"],
    ["win32", "/Users/example/repos/PwrAgent", "C:/repos/PwrAgnt", "Unix"],
  ])("prefers local projects on %s and annotates foreign paths", async (platform, foreignPath, localPath, foreignPlatform) => {
    desktopApi.platform = platform;
    const foreign = { ...project, key: `directory:${foreignPath}`, label: "PwrAgent", path: foreignPath };
    const local = { ...project, key: `directory:${localPath}`, path: localPath };
    const select = vi.fn();
    render(<SidebarSearchPopup projects={[foreign, local]} threads={[]}
      onJumpToProject={select} onJumpToThread={vi.fn()} onClose={vi.fn()} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "pa" } });
    await settleRemoteSearch();
    const rows = screen.getAllByRole("option");
    expect(rows[0]).toHaveTextContent(localPath);
    expect(within(rows[1]).getByText(`Other machine · ${foreignPlatform}`)).toBeInTheDocument();
    expect(within(rows[0]).queryByText(/Other machine/)).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(select).toHaveBeenCalledWith(local);
  });

  it("keeps local projects ahead of exact foreign matches before applying the result limit", async () => {
    const foreign = Array.from({ length: 8 }, (_, index) => ({ ...project,
      key: `directory:C:/repos/${index}/PwrAgnt`, path: `C:/repos/${index}/PwrAgnt` }));
    const local = { ...project, key: "directory:/repos/PwrAgnt-tools", label: "PwrAgnt tools", path: "/repos/PwrAgnt-tools" };
    const empty = await getNavigationQueryPage();
    getNavigationQueryPage.mockResolvedValue({ ...empty, directories: foreign.map((directory) => ({ ...directory,
      counts: empty.counts, pinnedRootCount: 0, unpinnedRootCount: 0, launchpadPresent: false })) });
    render(<SidebarSearchPopup projects={[local]} threads={[]}
      onJumpToProject={vi.fn()} onJumpToThread={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "PwrAgnt" } });
    await settleRemoteSearch();
    expect(screen.getAllByRole("option")).toHaveLength(8);
    expect(screen.getAllByRole("option")[0]).toHaveTextContent(local.path);
  });

  it("labels project destinations with their known owner in a federation viewer", async () => {
    readRendererFederationTarget.mockReturnValue({ scope: "remote", instanceId: "windows-peer" });
    const destination = { ...project, key: "directory:C:/repos/PwrAgent", path: "C:/repos/PwrAgent" };
    render(<SidebarSearchPopup projects={[destination]} threads={[]}
      onJumpToProject={vi.fn()} onJumpToThread={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "pa" } });
    await settleRemoteSearch();
    expect(screen.getByLabelText("Runs on Windows workstation")).toBeInTheDocument();
    expect(screen.queryByText(/Other machine/)).not.toBeInTheDocument();
  });

  it.each([
    ["PwrSuiteLab", "PWS"], ["PwrAgent", "pa"], ["PwrSnap", "Ps"], ["trading-system", "ts"],
  ])("opens the loaded project %s by initials %s", async (name, query) => {
    const destination = { ...project, label: name, path: `/repos/${name}` };
    const select = vi.fn();
    render(<SidebarSearchPopup projects={[destination]} threads={[]}
      onJumpToProject={select} onJumpToThread={vi.fn()} onClose={vi.fn()} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: query } });
    await settleRemoteSearch();
    expect(screen.getAllByRole("option")[0]).toHaveTextContent(name);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(select).toHaveBeenCalledWith(destination);
  });

  it("keeps an unloaded owner project when its initials match a mixed-case query", async () => {
    const destination = { ...project, label: "PwrSuiteLab", path: "/repos/PwrSuiteLab" };
    getNavigationQueryPage.mockResolvedValue({ protocol: 2, queryKey: "projects", generation: "generation", ownerEpoch: "owner",
      countsRevision: "counts", counts: { total: 0, active: 0, unread: 0, review: 0 }, coverage: { state: "complete" },
      entries: [], directories: [{ ...destination, counts: { total: 0, active: 0, unread: 0, review: 0 },
        pinnedRootCount: 0, unpinnedRootCount: 0, launchpadPresent: false }], complete: true });
    render(<SidebarSearchPopup projects={[]} threads={[]}
      onJumpToProject={vi.fn()} onJumpToThread={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "PwS" } });
    await settleRemoteSearch();
    expect(screen.getAllByRole("option")[0]).toHaveTextContent("PwrSuiteLab");
  });

  it("ranks a case-insensitive exact project before prefix projects and thread metadata, and Enter opens it", async () => {
    const onJumpToProject = vi.fn();
    const onJumpToThread = vi.fn();
    const onClose = vi.fn();
    render(<SidebarSearchPopup
      projects={[{ ...project, key: "other", label: "PwrAgnt tools", path: "/repos/tools" }, project]}
      threads={[localThread({ title: "PwrAgnt thread" })]}
      onJumpToProject={onJumpToProject} onJumpToThread={onJumpToThread} onClose={onClose}
    />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "  pwragnt  " } });
    await settleRemoteSearch();
    expect(screen.getAllByRole("option")[0]).toHaveTextContent("PwrAgnt/repos/PwrAgntProject");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onJumpToProject).toHaveBeenCalledWith(project);
    expect(onJumpToThread).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("finds an owner project absent from loaded sidebar rows and keeps thread keyboard navigation", async () => {
    getNavigationQueryPage.mockResolvedValue({ protocol: 2, queryKey: "projects", generation: "generation", ownerEpoch: "owner",
      countsRevision: "counts", counts: { total: 0, active: 0, unread: 0, review: 0 }, coverage: { state: "complete" },
      entries: [], directories: [{ ...project, counts: { total: 0, active: 0, unread: 0, review: 0 },
        pinnedRootCount: 0, unpinnedRootCount: 0, launchpadPresent: false }], complete: true });
    const thread = localThread({ title: "PwrAgnt thread" });
    const onJumpToThread = vi.fn();
    render(<SidebarSearchPopup projects={[]} threads={[thread]}
      onJumpToProject={vi.fn()} onJumpToThread={onJumpToThread} onClose={vi.fn()} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "PwrAgnt" } });
    await settleRemoteSearch();
    expect(screen.getAllByRole("option")[0]).toHaveTextContent("Project");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onJumpToThread).toHaveBeenCalledWith(thread);
  });
});

describe("project mentions", () => {
  const inProject = (id: string, title: string, label: string, updatedAt: number) => localThread({
    id, title, updatedAt, linkedDirectories: [{ id, kind: "local", label, path: `/repos/${label}` }],
  });

  it("scopes threads to an @project mention and offers no project rows", async () => {
    const busy = Array.from({ length: 10 }, (_, index) =>
      inProject(`busy-${index}`, `MCP gateway ${index}`, "media-services", 100 + index));
    const quiet = inProject("quiet", "MCP config", "pinecone-api", 1);
    const onJumpToThread = vi.fn();
    render(<SidebarSearchPopup
      projects={[{ key: "directory:/repos/pinecone-api", kind: "directory", label: "pinecone-api", path: "/repos/pinecone-api" }]}
      threads={[...busy, quiet]}
      onJumpToProject={vi.fn()} onJumpToThread={onJumpToThread} onClose={vi.fn()} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "@pinecone-api mcp" } });
    await settleRemoteSearch();
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option")).toHaveTextContent("MCP config");
    expect(getNavigationQueryPage).not.toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.objectContaining({ kind: "directory-index" }) }), expect.any(String));
    expect(getNavigationQueryPage).toHaveBeenCalledWith(expect.objectContaining({
      query: { kind: "search", text: "@pinecone-api mcp" } }), expect.any(String));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onJumpToThread).toHaveBeenCalledWith(quiet);
  });

  it("lists a project's threads once a bare in:@project mention is complete", async () => {
    render(<SidebarSearchPopup threads={[
      inProject("a", "Alpha", "pinecone-api", 2), inProject("b", "Beta", "media-services", 3),
    ]} onJumpToThread={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "in:@pine " } });
    await settleRemoteSearch();
    expect(screen.getAllByRole("option").map((row) => row.textContent)).toEqual([expect.stringContaining("Alpha")]);
  });

  const directories = [
    { key: "directory:/repos/pinecone-api", kind: "directory" as const, label: "pinecone-api", path: "/repos/pinecone-api" },
    { key: "directory:/repos/media-services", kind: "directory" as const, label: "media-services", path: "/repos/media-services" },
  ];

  it.each([["Enter"], ["Tab"]])("suggests projects for a partial mention and %s completes it", async (key) => {
    const onJumpToProject = vi.fn();
    render(<SidebarSearchPopup projects={directories}
      threads={[inProject("a", "MCP config", "pinecone-api", 2), inProject("b", "MCP gateway", "media-services", 3)]}
      onJumpToProject={onJumpToProject} onJumpToThread={vi.fn()} onClose={vi.fn()} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "mcp in:@pin" } });
    await settleRemoteSearch();
    expect(screen.getByRole("listbox", { name: "Projects" })).toBeInTheDocument();
    expect(screen.getAllByRole("option").map((row) => row.textContent)).toEqual([expect.stringContaining("pinecone-api")]);
    expect(screen.getByText("↵ narrow to project")).toBeInTheDocument();
    fireEvent.keyDown(input, { key });
    expect(input.value).toBe("mcp in:@pinecone-api ");
    expect(input.selectionStart).toBe(input.value.length);
    expect(onJumpToProject).not.toHaveBeenCalled();
    await settleRemoteSearch();
    expect(screen.getAllByRole("option").map((row) => row.textContent)).toEqual([expect.stringContaining("MCP config")]);
  });

  it("lists every project for a bare @ and says when none match", async () => {
    render(<SidebarSearchPopup projects={directories} threads={[]} onJumpToThread={vi.fn()} onClose={vi.fn()} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "@" } });
    await settleRemoteSearch();
    expect(screen.getAllByRole("option")).toHaveLength(2);
    fireEvent.change(input, { target: { value: "@zzz" } });
    await settleRemoteSearch();
    expect(screen.getByText("No matching projects")).toBeInTheDocument();
  });
});
