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

  it("prioritizes and describes the exact PR when a thread has several PRs", async () => {
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
});
