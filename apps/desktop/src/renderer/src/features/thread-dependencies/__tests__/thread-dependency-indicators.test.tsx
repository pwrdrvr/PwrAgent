import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, NavigationThreadSummary, ThreadDependency } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { ThreadMetaChips } from "../../navigation/ThreadMetaChips";
import {
  ThreadDependencyIndicatorsContext,
  summarizeThreadDependencies,
  useThreadDependencyIndicators,
  type ThreadDependencyIndicator,
} from "../useThreadDependencyIndicators";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const waiting: ThreadDependency = {
  id: "waiting-1", backend: "codex", threadId: "consumer", status: "waiting",
  conditions: [
    { backend: "codex", threadId: "schema", when: "pr_attached", title: "Split settings schema" },
    { backend: "codex", threadId: "schema", when: "pr_merged", title: "Split settings schema" },
  ],
  evidence: [
    { condition: { backend: "codex", threadId: "schema", when: "pr_attached" }, state: "satisfied", reason: "PR attached", observedAt: 2 },
    { condition: { backend: "codex", threadId: "schema", when: "pr_merged" }, state: "waiting", reason: "Waiting for merge", observedAt: 2 },
  ],
  mode: "all", onFailure: "notify", createdAt: 1, updatedAt: 2,
};
const thread: NavigationThreadSummary = {
  id: "consumer", source: "codex", title: "Retarget docs branch", titleSource: "explicit",
  linkedDirectories: [], inbox: { inInbox: false },
};

describe("summarizeThreadDependencies", () => {
  it("shows one registration's progress and names every prerequisite in the tooltip", () => {
    const indicator = summarizeThreadDependencies([waiting]).get("codex:consumer");
    expect(indicator).toEqual({
      count: 1,
      alert: false,
      label: "1 of 2",
      tooltip: "Continue after all of:\n✓ Split settings schema has a reviewable PR\n○ Split settings schema is merged",
    });
  });

  it("labels each single-registration state, and counts several", () => {
    const one = (patch: Partial<ThreadDependency>) =>
      summarizeThreadDependencies([{ ...waiting, ...patch }]).get("codex:consumer")?.label;
    expect(one({ mode: "any" })).toBe("Any of 2");
    expect(one({ conditions: [waiting.conditions[0]!], evidence: [] })).toBe("Waiting");
    expect(one({ status: "ready", outcome: "success" })).toBe("Ready");
    // A failed prerequisite resumes only to report it; the chip must not read as success.
    expect(one({
      status: "ready", outcome: "failure",
      evidence: [{ ...waiting.evidence[1]!, state: "failed", reason: "PR closed without merging" }],
    })).toBe("Failed");
    expect(one({
      status: "ready", outcome: "failure", onFailure: "wait",
      evidence: [{ ...waiting.evidence[1]!, state: "failed", reason: "CI failed" }],
    })).toBe("CI repair");
    expect(one({ status: "dispatching" })).toBe("Continuing");
    expect(summarizeThreadDependencies([waiting, { ...waiting, id: "waiting-2", createdAt: 3 }]).get("codex:consumer"))
      .toMatchObject({ count: 2, label: "2 waiting" });
  });

  it("raises an uncertain delivery over every other state and leaves finished ones out", () => {
    const indicators = summarizeThreadDependencies([
      waiting,
      { ...waiting, id: "uncertain", status: "dispatching", error: "Delivery was interrupted", createdAt: 3 },
      { ...waiting, id: "done", threadId: "finished", status: "delivered" },
      { ...waiting, id: "gone", threadId: "cancelled", status: "cancelled" },
    ]);
    expect(indicators.get("codex:consumer")).toMatchObject({ count: 2, alert: true, label: "Check delivery" });
    expect(indicators.get("codex:consumer")!.tooltip).toContain("Delivery needs review.");
    expect(indicators.has("codex:finished")).toBe(false);
    expect(indicators.has("codex:cancelled")).toBe(false);
  });
});

describe("useThreadDependencyIndicators", () => {
  function Probe(props: { api: DesktopApi }) {
    const indicators = useThreadDependencyIndicators(props.api);
    return <output>{indicators.get("codex:consumer")?.label ?? "none"}</output>;
  }

  it("lists active registrations once, then refreshes once per burst of updates", async () => {
    vi.useFakeTimers();
    let listener: ((event: AgentEvent) => void) | undefined;
    let current: ThreadDependency[] = [waiting];
    const manage = vi.fn(async () => ({ dependencies: current }));
    const api = {
      manageThreadDependencies: manage,
      onAgentEvent: (callback: (event: AgentEvent) => void) => { listener = callback; return () => { listener = undefined; }; },
    } as unknown as DesktopApi;
    render(<Probe api={api} />);
    await act(async () => {});
    expect(manage).toHaveBeenCalledWith({ action: "active" });
    expect(screen.getByRole("status")).toHaveTextContent("1 of 2");

    current = [];
    const update = { backend: "codex", notification: { method: "thread/dependencies/updated", params: { threadId: "consumer", dependencyId: "waiting-1" } } } as AgentEvent;
    act(() => {
      listener!(update);
      listener!(update);
      listener!({ backend: "codex", notification: { method: "turn/started", params: {} } } as unknown as AgentEvent);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(manage).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent("none");
  });

  it("keeps the same list when an update changes no chip", async () => {
    vi.useFakeTimers();
    let listener: ((event: AgentEvent) => void) | undefined;
    const seen: unknown[] = [];
    function Identity(props: { api: DesktopApi }) {
      const indicators = useThreadDependencyIndicators(props.api);
      if (seen.at(-1) !== indicators) seen.push(indicators);
      return null;
    }
    const manage = vi.fn(async () => ({ dependencies: [{ ...waiting, updatedAt: manage.mock.calls.length }] }));
    const api = {
      manageThreadDependencies: manage,
      onAgentEvent: (callback: (event: AgentEvent) => void) => { listener = callback; return () => undefined; },
    } as unknown as DesktopApi;
    render(<Identity api={api} />);
    await act(async () => {});
    expect(seen).toHaveLength(2);
    act(() => listener!({ backend: "codex", notification: { method: "thread/dependencies/updated", params: { threadId: "consumer", dependencyId: "waiting-1" } } } as AgentEvent));
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(manage).toHaveBeenCalledTimes(2);
    expect(seen).toHaveLength(2);
  });

  it("keeps the last list when a refresh fails", async () => {
    vi.useFakeTimers();
    let listener: ((event: AgentEvent) => void) | undefined;
    const manage = vi.fn()
      .mockResolvedValueOnce({ dependencies: [waiting] })
      .mockRejectedValueOnce(new Error("offline"));
    const api = {
      manageThreadDependencies: manage,
      onAgentEvent: (callback: (event: AgentEvent) => void) => { listener = callback; return () => undefined; },
    } as unknown as DesktopApi;
    render(<Probe api={api} />);
    await act(async () => {});
    act(() => listener!({ backend: "codex", notification: { method: "thread/dependencies/updated", params: { threadId: "consumer", dependencyId: "waiting-1" } } } as AgentEvent));
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(manage).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent("1 of 2");
  });
});

describe("sidebar dependency chip", () => {
  const indicator: ThreadDependencyIndicator = { count: 1, alert: false, label: "1 of 2", tooltip: "Continue after all of:" };

  function renderChips(value: { indicator?: ThreadDependencyIndicator; open?: (thread: NavigationThreadSummary) => void }, subject = thread) {
    const onRowClick = vi.fn();
    render(
      <ThreadDependencyIndicatorsContext.Provider value={{
        byThreadKey: new Map(value.indicator ? [["codex:consumer", value.indicator]] : []),
        ...(value.open ? { open: value.open } : {}),
      }}>
        <div onClick={onRowClick}>
          <ThreadMetaChips thread={subject} />
        </div>
      </ThreadDependencyIndicatorsContext.Provider>,
    );
    return { onRowClick };
  }

  it("opens Continue After from the chip without selecting the row", () => {
    const open = vi.fn();
    const { onRowClick } = renderChips({ indicator, open });
    const chip = screen.getByRole("button", { name: "Continue after: 1 of 2" });
    expect(chip).toHaveTextContent("1 of 2");
    expect(chip).not.toHaveClass("is-alert");
    fireEvent.click(chip);
    expect(open).toHaveBeenCalledWith(thread);
    expect(onRowClick).not.toHaveBeenCalled();
    fireEvent.keyDown(chip, { key: "Enter" });
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("is a plain marker where no dialog can open, and red only for an uncertain delivery", () => {
    renderChips({ indicator: { ...indicator, alert: true, label: "Check delivery" } });
    const chip = screen.getByRole("img", { name: "Continue after: Check delivery" });
    expect(chip).toHaveClass("is-alert");
    expect(chip).not.toHaveAttribute("tabindex");
  });

  it("draws nothing for a thread without registrations or for a peer's thread", () => {
    renderChips({ indicator }, {
      ...thread,
      federation: {
        ref: { backend: "codex", target: { scope: "remote", instanceId: "peer" }, threadId: "consumer" },
        instanceLabel: "Laptop", peerStatus: "connected", capabilities: [],
      },
    } as NavigationThreadSummary);
    expect(screen.queryByRole("img", { name: /Continue after/ })).toBeNull();
    cleanup();
    renderChips({});
    expect(screen.queryByRole("img", { name: /Continue after/ })).toBeNull();
  });
});
