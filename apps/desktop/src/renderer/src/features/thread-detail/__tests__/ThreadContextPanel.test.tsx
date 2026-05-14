import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendSummary, NavigationThreadSummary } from "@pwragent/shared";
import { ThreadContextPanel } from "../ThreadContextPanel";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const baseThread: NavigationThreadSummary = {
  id: "thread-1",
  title: "Thread",
  titleSource: "explicit",
  source: "codex",
  linkedDirectories: [],
  inbox: {
    inInbox: false,
  },
};

const baseBackend: BackendSummary = {
  kind: "codex",
  label: "OpenAI",
  available: true,
  account: {
    type: "chatgpt",
    email: "user@example.com",
    planType: "pro",
    requiresOpenaiAuth: false,
  },
  methods: ["thread/list", "thread/read"],
  capabilities: {
    listThreads: true,
    createThread: true,
    resumeThread: true,
    renameThread: true,
    readThread: true,
    startTurn: true,
    interruptTurn: true,
    steerTurn: true,
    transcriptPagination: true,
    toolUse: true,
    approvalRequests: true,
    multiDirectoryThreads: true,
  },
  executionModes: [
    {
      mode: "default",
      label: "Default",
      available: true,
      isDefault: true,
    },
  ],
  rateLimits: [
    {
      name: "5h limit",
      usedPercent: 7,
      windowMinutes: 300,
    },
    {
      name: "Weekly limit",
      usedPercent: 12,
      windowMinutes: 10_080,
    },
    {
      name: "gpt-5.3-codex-spark 5h limit",
      limitId: "gpt-5.3-codex-spark",
      usedPercent: 0,
      windowMinutes: 300,
    },
    {
      name: "gpt-5.3-codex-spark Weekly limit",
      limitId: "gpt-5.3-codex-spark",
      usedPercent: 0,
      windowMinutes: 10_080,
    },
  ],
};

describe("ThreadContextPanel", () => {
  it("keeps the hover rail open when a transient leave is still inside the opened rail", () => {
    vi.useFakeTimers();
    render(
      <ThreadContextPanel backends={[baseBackend]} pinned={false} thread={baseThread} />
    );

    const rail = screen.getByLabelText("Thread context");
    vi.spyOn(rail, "getBoundingClientRect").mockReturnValue({
      bottom: 800,
      height: 800,
      left: 620,
      right: 1000,
      top: 0,
      width: 380,
      x: 620,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.mouseEnter(rail, { clientX: 980, clientY: 120 });
    expect(screen.getByText("Auto-hide")).toBeInTheDocument();

    fireEvent.mouseLeave(rail, { clientX: 980, clientY: 120 });
    act(() => {
      vi.advanceTimersByTime(301);
    });

    expect(screen.getByText("Auto-hide")).toBeInTheDocument();
  });

  it("hides the hover rail after the mouse leaves the opened rail", () => {
    vi.useFakeTimers();
    render(
      <ThreadContextPanel backends={[baseBackend]} pinned={false} thread={baseThread} />
    );

    const rail = screen.getByLabelText("Thread context");
    vi.spyOn(rail, "getBoundingClientRect").mockReturnValue({
      bottom: 800,
      height: 800,
      left: 620,
      right: 1000,
      top: 0,
      width: 380,
      x: 620,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.mouseEnter(rail, { clientX: 980, clientY: 120 });
    expect(screen.getByText("Auto-hide")).toBeInTheDocument();

    fireEvent.mouseLeave(rail, { clientX: 600, clientY: 120 });
    act(() => {
      vi.advanceTimersByTime(301);
    });

    expect(screen.queryByText("Auto-hide")).not.toBeInTheDocument();
  });

  it("shows path tooltips on linked directory labels and kind badges", () => {
    render(
      <ThreadContextPanel
        backends={[baseBackend]}
        pinned
        thread={{
          ...baseThread,
          linkedDirectories: [
            {
              id: "worktree-dir",
              kind: "worktree",
              label: "PwrAgent",
              path: "/Users/huntharo/github/PwrAgent",
              worktreePath:
                "/Users/huntharo/github/PwrAgent/.worktrees/launchpad-pwragent-main-molpnvyk",
            },
            {
              id: "local-dir",
              kind: "local",
              label: "LocalOnly",
              path: "/Users/huntharo/github/PwrAgent",
            },
          ],
        }}
      />
    );

    fireEvent.mouseEnter(screen.getByLabelText("Path for PwrAgent"));
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "/Users/huntharo/github/PwrAgent"
    );

    fireEvent.mouseLeave(screen.getByLabelText("Path for PwrAgent"));
    fireEvent.mouseEnter(screen.getByLabelText("Path for worktree PwrAgent"));
    expect(screen.getByRole("tooltip")).toHaveTextContent("/Users/huntharo/github");
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "launchpad-pwragent-main-molpnvyk"
    );

    fireEvent.mouseLeave(screen.getByLabelText("Path for worktree PwrAgent"));
    fireEvent.mouseEnter(screen.getByLabelText("Path for local LocalOnly"));
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "/Users/huntharo/github/PwrAgent"
    );
  });

  it("hides unused Spark rate limits on non-Spark threads", () => {
    render(<ThreadContextPanel backends={[baseBackend]} pinned thread={baseThread} />);

    expect(screen.getByText(/5h limit: 93% left/)).toBeInTheDocument();
    expect(screen.getByText(/Weekly limit: 88% left/)).toBeInTheDocument();
    expect(screen.queryByText(/Spark 5h limit/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Spark Weekly limit/)).not.toBeInTheDocument();
  });

  it("labels Spark rate limits when the current thread uses Spark", () => {
    render(
      <ThreadContextPanel
        backends={[baseBackend]}
        pinned
        thread={{
          ...baseThread,
          model: "gpt-5.3-codex-spark",
        }}
      />
    );

    expect(screen.getByText(/Spark 5h limit: 100% left/)).toBeInTheDocument();
    expect(screen.getByText(/Spark Weekly limit: 100% left/)).toBeInTheDocument();
  });

  it("labels Spark rate limits when Spark has usage", () => {
    render(
      <ThreadContextPanel
        backends={[
          {
            ...baseBackend,
            rateLimits: baseBackend.rateLimits?.map((limit) =>
              limit.limitId === "gpt-5.3-codex-spark" && limit.windowMinutes === 300
                ? { ...limit, usedPercent: 2 }
                : limit
            ),
          },
        ]}
        pinned
        thread={baseThread}
      />
    );

    expect(screen.getByText(/Spark 5h limit: 98% left/)).toBeInTheDocument();
    expect(screen.getByText(/Spark Weekly limit: 100% left/)).toBeInTheDocument();
  });
});
