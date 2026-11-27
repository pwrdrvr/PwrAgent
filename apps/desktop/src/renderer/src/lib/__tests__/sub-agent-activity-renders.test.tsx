import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { DesktopApi } from "../desktop-api";
import { resetSubAgentActivityStore, useSubAgentActivities } from "../sub-agent-activity";

afterEach(() => {
  cleanup();
  resetSubAgentActivityStore();
});

/**
 * Work budget: a sub-agent's line changes once per tool call it makes, so one
 * thread's line must re-render only that thread's readers. Every mounted tray
 * shares the store; a broadcast re-render would cost trays × tool calls.
 */
it("re-renders only the thread whose activity changed, once per real change", () => {
  let deliver: ((event: AgentEvent) => void) | undefined;
  const desktopApi = { onAgentEvent: (callback: (event: AgentEvent) => void) => {
    deliver = callback;
    return () => undefined;
  } } as unknown as DesktopApi;
  const renders = new Map<string, number>();
  function Reader(props: { threadKey: string }) {
    const activities = useSubAgentActivities(desktopApi, props.threadKey);
    renders.set(props.threadKey, (renders.get(props.threadKey) ?? 0) + 1);
    return <span>{[...activities.values()].join("|")}</span>;
  }
  const threads = Array.from({ length: 20 }, (_, index) => `claude:thread-${index}`);
  render(<>{threads.map((key) => <Reader key={key} threadKey={key} />)}</>);
  const mounted = new Map(renders);
  const publish = (activity: string) => act(() => {
    deliver?.({ backend: "claude", notification: { method: "thread/subAgentActivity/updated",
      params: { threadId: "thread-0", activities: [{ monitorId: "claude-native:a", activity }] } } });
  });
  for (let call = 0; call < 50; call += 1) {
    publish(`Running step ${call}`);
    publish(`Running step ${call}`); // Redelivered: no change, no render.
  }
  expect(renders.get("claude:thread-0")! - mounted.get("claude:thread-0")!).toBe(50);
  for (const key of threads.slice(1)) expect(renders.get(key)).toBe(mounted.get(key));
});

it("keeps one event subscription when the desktop bridge object changes", () => {
  const live = new Set<string>();
  const api = (name: string) => ({ onAgentEvent: () => {
    live.add(name);
    return () => live.delete(name);
  } }) as unknown as DesktopApi;
  function Reader(props: { desktopApi: DesktopApi }) {
    useSubAgentActivities(props.desktopApi, "claude:t1");
    return null;
  }
  const first = api("first");
  const { rerender } = render(<Reader desktopApi={first} />);
  rerender(<Reader desktopApi={api("second")} />);
  expect([...live]).toEqual(["second"]);
  resetSubAgentActivityStore();
  expect([...live]).toEqual([]);
});
