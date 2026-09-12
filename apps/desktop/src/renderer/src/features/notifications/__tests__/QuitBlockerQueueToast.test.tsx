import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuitBlockerQueueSnapshot } from "../../../../../shared/quit-blockers";
import { QuitBlockerQueueToast } from "../QuitBlockerQueueToast";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function snapshot(
  items: QuitBlockerQueueSnapshot["items"],
): QuitBlockerQueueSnapshot {
  return {
    inProgressThreadCount: items.filter((item) => item.kind === "turn").length,
    automationRunCount: items.filter((item) => item.kind === "automation").length,
    terminalSessionCount: items.filter((item) => item.kind === "terminal").length,
    actionRunCount: items.filter((item) => item.kind === "action").length,
    items,
  };
}

describe("QuitBlockerQueueToast", () => {
  it("keeps a known title when a refresh temporarily omits it", async () => {
    vi.useFakeTimers();
    let showQueue!: (snapshot: QuitBlockerQueueSnapshot) => void;
    const titled = snapshot([
      {
        kind: "turn",
        backend: "codex",
        threadId: "01a05891-bfb8-7bc0-affd-97354d0080b1",
        threadKey: "codex:01a05891-bfb8-7bc0-affd-97354d0080b1",
        title: "Investigate compaction cost",
      },
    ]);
    const unresolved = snapshot([
      {
        kind: "turn",
        backend: "codex",
        threadId: "01a05891-bfb8-7bc0-affd-97354d0080b1",
        threadKey: "codex:01a05891-bfb8-7bc0-affd-97354d0080b1",
      },
    ]);
    const readQuitBlockerQueue = vi.fn(async () => unresolved);

    render(
      <QuitBlockerQueueToast
        desktopApi={{
          onShowQuitBlockersRequested: (callback) => {
            showQueue = callback;
            return () => undefined;
          },
          readQuitBlockerQueue,
          revealQuitBlocker: vi.fn(async () => ({ revealed: true })),
        }}
      />,
    );

    act(() => showQueue(titled));
    expect(screen.getByText("Investigate compaction cost")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(readQuitBlockerQueue).toHaveBeenCalled();
    expect(screen.getByText("Investigate compaction cost")).toBeInTheDocument();
    expect(
      screen.queryByText("01a05891-bfb8-7bc0-affd-97354d0080b1"),
    ).not.toBeInTheDocument();
  });

  it("keeps the live queue reachable while authoritative refreshes remove resolved work", async () => {
    vi.useFakeTimers();
    let showQueue!: (snapshot: QuitBlockerQueueSnapshot) => void;
    let resolveFirstRead!: (snapshot: QuitBlockerQueueSnapshot) => void;
    const firstRead = new Promise<QuitBlockerQueueSnapshot>((resolve) => {
      resolveFirstRead = resolve;
    });
    const initial = snapshot([
      {
        kind: "turn",
        backend: "codex",
        threadId: "thread-a",
        threadKey: "codex:thread-a",
        title: "Turn A",
      },
      {
        kind: "terminal",
        backend: "codex",
        threadId: "thread-b",
        threadKey: "codex:thread-b",
        sessionId: "term-b",
        title: "Terminal B",
        target: { scope: "remote", instanceId: "peer-a" },
        detail: "Build Mac",
      },
    ]);
    const oneRemaining = snapshot([initial.items[1]]);
    const empty = snapshot([]);
    const readQuitBlockerQueue = vi.fn()
      .mockReturnValueOnce(firstRead)
      .mockResolvedValue(empty);
    const revealQuitBlocker = vi.fn(async () => ({ revealed: true }));

    render(
      <QuitBlockerQueueToast
        desktopApi={{
          onShowQuitBlockersRequested: (callback) => {
            showQueue = callback;
            return () => undefined;
          },
          readQuitBlockerQueue,
          revealQuitBlocker,
        }}
      />,
    );

    act(() => showQueue(initial));
    expect(screen.getByText("2 items are still running.")).toBeInTheDocument();
    expect(screen.getByText("Turn A")).toBeInTheDocument();
    expect(screen.getByText("Terminal B")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Terminal B"));
    expect(revealQuitBlocker).toHaveBeenCalledWith({
      kind: "terminal",
      threadKey: "codex:thread-b",
      sessionId: "term-b",
      target: { scope: "remote", instanceId: "peer-a" },
    });

    await act(async () => resolveFirstRead(oneRemaining));
    expect(screen.queryByText("Turn A")).not.toBeInTheDocument();
    expect(screen.getByText("1 item is still running.")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(screen.queryByText("Terminal B")).not.toBeInTheDocument();
    expect(screen.getByText("No running work.")).toBeInTheDocument();
    expect(
      screen.getByText("PwrAgent can quit without interrupting work."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("quit-blocker-queue")).toBeInTheDocument();
  });

  // A thread can hold up the quit with more than one shell, so the row key
  // has to carry the terminal id. Without it both rows key the same, and
  // `retainKnownTitles` — which looks a title up BY that key — hands the
  // wrong shell's name to whichever row asks first.
  it("keeps each of a thread's terminals on its own row and title", async () => {
    vi.useFakeTimers();
    const revealQuitBlocker = vi.fn(async () => ({ revealed: true }));
    let showQueue!: (next: QuitBlockerQueueSnapshot) => void;
    const terminals = [
      {
        kind: "terminal" as const,
        backend: "codex",
        threadId: "thread-a",
        threadKey: "codex:thread-a",
        sessionId: "term-1",
      },
      {
        kind: "terminal" as const,
        backend: "codex",
        threadId: "thread-a",
        threadKey: "codex:thread-a",
        sessionId: "term-2",
      },
    ];
    const titled = snapshot([
      { ...terminals[0]!, title: "Build" },
      { ...terminals[1]!, title: "Tail logs" },
    ]);
    // The refresh resolves no titles, which is the case the retention exists
    // for: both rows have to get their OWN name back.
    const readQuitBlockerQueue = vi.fn(async () => snapshot(terminals));

    render(
      <QuitBlockerQueueToast
        desktopApi={{
          onShowQuitBlockersRequested: (callback) => {
            showQueue = callback;
            return () => undefined;
          },
          readQuitBlockerQueue,
          revealQuitBlocker,
        }}
      />,
    );

    act(() => showQueue(titled));
    expect(screen.getByText("Build")).toBeInTheDocument();
    expect(screen.getByText("Tail logs")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(readQuitBlockerQueue).toHaveBeenCalled();
    expect(screen.getByText("Build")).toBeInTheDocument();
    expect(screen.getByText("Tail logs")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Tail logs"));

    expect(revealQuitBlocker).toHaveBeenCalledWith({
      kind: "terminal",
      threadKey: "codex:thread-a",
      sessionId: "term-2",
    });
  });

  it("stays hidden until a quit-dialog row hands the queue to this viewer", () => {
    const readQuitBlockerQueue = vi.fn(async () => snapshot([]));

    render(
      <QuitBlockerQueueToast
        desktopApi={{
          onShowQuitBlockersRequested: () => () => undefined,
          readQuitBlockerQueue,
          revealQuitBlocker: vi.fn(async () => ({ revealed: false })),
        }}
      />,
    );

    expect(screen.queryByTestId("quit-blocker-queue")).not.toBeInTheDocument();
    expect(readQuitBlockerQueue).not.toHaveBeenCalled();
  });
});
