import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, FederationPeerShutdown, ReadFederationHealthResponse } from "@pwragent/shared";
import { FederationShutdownNotices } from "../FederationShutdownNotices";

afterEach(() => { cleanup(); vi.useRealTimers(); });

const peer: FederationPeerShutdown = {
  instanceId: "gateway", label: "Test gateway", shutdownId: "one", revision: 1,
  state: "scheduled", reason: "quit", deadlineAt: 10_000,
};

describe("Federation shutdown notices", () => {
  it("counts down locally, follows pause and cancellation, and unsubscribes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let emit!: (event: AgentEvent) => void;
    const unsubscribe = vi.fn();
    const read = vi.fn(async () => ({ health: { shutdownNotices: [peer] } } as ReadFederationHealthResponse));
    const changed = vi.fn();
    const { unmount } = render(<FederationShutdownNotices desktopApi={{
      readFederationHealth: read,
      onAgentEvent: (listener) => { emit = listener; return unsubscribe; },
    }} onNoticeChanged={changed} />);
    await act(async () => {});
    expect(changed).toHaveBeenLastCalledWith("gateway", expect.objectContaining({ message: expect.stringContaining("10 seconds") }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(changed).toHaveBeenLastCalledWith("gateway", expect.objectContaining({ message: expect.stringContaining("9 seconds") }));
    act(() => emit({ backend: "codex", notification: { method: "federation/shutdown/changed", params: { notices: [{ ...peer, deadlineAt: null }] } } }));
    expect(changed).toHaveBeenLastCalledWith("gateway", expect.objectContaining({ message: expect.stringContaining("paused") }));
    act(() => emit({ backend: "codex", notification: { method: "federation/shutdown/changed", params: { notices: [] } } }));
    expect(changed).toHaveBeenLastCalledWith("gateway", undefined);
    expect(read).toHaveBeenCalledTimes(1);
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not resurrect an event-cleared notice from a late snapshot or a dismissed notice on the next tick", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let emit!: (event: AgentEvent) => void;
    let finish!: (value: ReadFederationHealthResponse) => void;
    const changed = vi.fn();
    render(<FederationShutdownNotices desktopApi={{
      readFederationHealth: () => new Promise((resolve) => { finish = resolve; }),
      onAgentEvent: (listener) => { emit = listener; return () => {}; },
    }} onNoticeChanged={changed} />);
    const send = (notices: FederationPeerShutdown[]) => emit({ backend: "codex", notification: { method: "federation/shutdown/changed", params: { notices } } });
    act(() => send([]));
    await act(async () => finish({ health: { shutdownNotices: [peer] } } as ReadFederationHealthResponse));
    expect(changed).not.toHaveBeenCalled();
    act(() => send([peer]));
    act(() => changed.mock.lastCall?.[1].onDismiss());
    changed.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(changed.mock.calls.some(([, notice]) => notice !== undefined)).toBe(false);
  });
});
