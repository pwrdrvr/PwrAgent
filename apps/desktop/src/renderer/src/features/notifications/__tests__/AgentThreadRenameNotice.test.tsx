import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RENAME_THREAD_EXPECTED_NAME_MISMATCH, type AgentEvent } from "@pwragent/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentThreadRenameNotice } from "../AgentThreadRenameNotice";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renameEvent(overrides: Record<string, unknown> = {}, instanceId?: string): AgentEvent {
  return {
    backend: "codex",
    ...(instanceId ? { federationTarget: { scope: "remote" as const, instanceId } } : {}),
    notification: {
      method: "thread/name/updated",
      params: {
        threadId: "01a11111-1111-7111-8111-111111111111",
        threadName: "Investigate rename feedback",
        previousThreadName: "Original title",
        renameOrigin: "agent_tool",
        ...overrides,
      },
    },
  };
}

function setup(renameThread = vi.fn(async () => ({ backend: "codex" as const, threadId: "thread", renamedAt: 1 }))) {
  let emit!: (event: AgentEvent) => void;
  const unsubscribe = vi.fn();
  const onOpenThread = vi.fn();
  const view = render(<AgentThreadRenameNotice desktopApi={{
    onAgentEvent: (listener) => { emit = listener; return unsubscribe; },
    renameThread,
  }} onOpenThread={onOpenThread} />);
  return { emit, renameThread, unsubscribe, onOpenThread, ...view };
}

describe("AgentThreadRenameNotice", () => {
  it("names the agent and the old title, and undoes the correct owning thread", async () => {
    const { emit, renameThread, onOpenThread } = setup();
    act(() => emit(renameEvent({}, "peer-one")));
    expect(screen.getByText("The agent renamed it from “Original title”.")).toBeInTheDocument();
    // The chip, not the message, carries the new title.
    expect(screen.getAllByText(/Investigate rename feedback/)).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveAttribute("data-tone", "neutral");
    fireEvent.click(screen.getByRole("button", { name: "Open thread Investigate rename feedback" }));
    expect(onOpenThread).toHaveBeenCalledWith(expect.objectContaining({ instanceId: "peer-one" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Undo" })));
    expect(renameThread).toHaveBeenCalledExactlyOnceWith({
      backend: "codex", threadId: "01a11111-1111-7111-8111-111111111111",
      federationTarget: { scope: "remote", instanceId: "peer-one" },
      name: "Original title", expectedName: "Investigate rename feedback",
    });
    expect(screen.queryByText("Thread renamed")).not.toBeInTheDocument();
  });

  it("ignores ordinary title updates, no-op renames, and duplicate provider echoes", () => {
    const { emit } = setup();
    act(() => emit(renameEvent({ renameOrigin: undefined })));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    act(() => emit(renameEvent({ previousThreadName: "Investigate rename feedback" })));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    act(() => emit(renameEvent()));
    act(() => emit(renameEvent({ renameOrigin: undefined })));
    expect(screen.getAllByText("Thread renamed")).toHaveLength(1);
  });

  it("clears Undo after a later rename, while separating backend and instance identities", () => {
    const { emit, renameThread } = setup();
    act(() => emit(renameEvent()));
    act(() => emit(renameEvent({ renameOrigin: undefined, threadName: "Different peer's title" }, "peer-one")));
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    act(() => emit({ ...renameEvent({ renameOrigin: undefined, threadName: "Different backend's title" }), backend: "acp:kimi" }));
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    act(() => emit(renameEvent({ renameOrigin: undefined, threadName: "User's later title" })));
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    expect(renameThread).not.toHaveBeenCalled();
  });

  it("shows Undo progress without a countdown until the result arrives", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const renameThread = vi.fn(() => new Promise<{ backend: "codex"; threadId: string; renamedAt: number }>((resolve) => {
      finish = () => resolve({ backend: "codex", threadId: "thread", renamedAt: 1 });
    }));
    const { emit, container } = setup(renameThread);
    act(() => emit(renameEvent()));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByText("Restoring the previous title")).toBeInTheDocument();
    expect(container.querySelector(".status-dot--blink")).not.toBeNull();
    expect(container.querySelector(".app-notice-toast__timer")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(screen.getByText("Restoring the previous title")).toBeInTheDocument();
    await act(async () => finish());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("reports failed Undo without Electron's IPC wrapper, prevents duplicate clicks, and permits a retry", async () => {
    let fail!: (error: Error) => void;
    const renameThread = vi.fn().mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }))
      .mockResolvedValue({ backend: "codex", threadId: "thread", renamedAt: 1 });
    const { emit } = setup(renameThread);
    act(() => emit(renameEvent()));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(renameThread).toHaveBeenCalledTimes(1);
    await act(async () => fail(new Error("Error invoking remote method 'app-server:renameThread': Error: Owner unavailable")));
    expect(screen.getByText("Rename not undone")).toBeInTheDocument();
    expect(screen.getByText("Owner unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Restoring the previous title")).not.toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Undo" })));
    expect(renameThread).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("drops Undo when the title changed again, since every retry would be refused", async () => {
    const renameThread = vi.fn(async () => {
      throw new Error(`Error invoking remote method 'app-server:renameThread': Error: ${RENAME_THREAD_EXPECTED_NAME_MISMATCH}`);
    });
    const { emit } = setup(renameThread);
    act(() => emit(renameEvent()));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Undo" })));
    expect(screen.getByText("Rename not undone")).toBeInTheDocument();
    expect(screen.getByText("The title was changed again after the agent renamed it, so PwrAgent left it as it is.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAttribute("data-tone", "error");
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open thread Investigate rename feedback" })).toBeInTheDocument();
  });

  it("does not replace a newer notice with an older Undo failure", async () => {
    let fail!: (error: Error) => void;
    const { emit } = setup(vi.fn(() => new Promise((_resolve, reject) => { fail = reject; })));
    act(() => emit(renameEvent()));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    act(() => emit(renameEvent({ threadName: "Newer title" })));
    await act(async () => fail(new Error("Stale failure")));
    expect(screen.getByText("Thread renamed")).toBeInTheDocument();
    expect(screen.queryByText("Stale failure")).not.toBeInTheDocument();
  });

  it("omits Undo for an unknown previous title and dismisses automatically", async () => {
    vi.useFakeTimers();
    const { emit, unmount, unsubscribe } = setup();
    act(() => emit(renameEvent({ previousThreadName: undefined })));
    expect(screen.getByText("The agent renamed it.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
