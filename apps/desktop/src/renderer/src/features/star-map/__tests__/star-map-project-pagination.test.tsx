import "./foreground-fixture";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { classifyDirectory, type AgentEvent, type NavigationQueryRequest, type NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { navigationQueryFixture } from "../../../test/navigation-query-fixture";
import { StarMapScreen } from "../StarMapScreen";

afterEach(() => window.localStorage.clear());

it.each(["local", "remote"])("renders 15 complete project clouds and three independent card pages for %s", async (owner) => {
  window.localStorage.setItem("pwragent.starMap.viewPreferences", JSON.stringify({ layout: "orbit" }));
  // Project 0 outruns one click's block, so a second click continues an
  // already-continued range. Every other project fits in one.
  const threads: NavigationThreadSummary[] = Array.from({ length: 15 }, (_, project) =>
    Array.from({ length: project === 0 ? 123 : 23 }, (_, card) => ({
      id: `p${project}-c${card}`, source: "codex" as const, title: `Project ${project} card ${card}`,
      titleSource: "derived" as const, inbox: { inInbox: false }, updatedAt: 1000 - card,
      linkedDirectories: [{ id: `d${project}`, kind: "local" as const, path: `/repos/project-${project}`, label: `project-${project}` }],
    }))).flat();
  const directories = Array.from({ length: 15 }, (_, index) => classifyDirectory(threads.find((thread) =>
    thread.linkedDirectories[0]!.label === `project-${index}`)!.linkedDirectories[0]!));
  let expired = false;
  const read = vi.fn(async (request: NavigationQueryRequest) => {
    if (request.query.kind === "star-map" && request.query.projectKey === directories[0]!.key && request.cursor && !expired) {
      expired = true;
      throw new Error("[navigation_cursor_expired] Project cursor evicted");
    }
    const remote = request.federationTarget?.scope === "remote";
    return navigationQueryFixture(request, remote === (owner === "remote") ? { threads, directories } : {});
  });
  const api = {
    getNavigationQueryPage: read,
    releaseNavigationQuery: vi.fn().mockResolvedValue(undefined),
    readFederationHealth: vi.fn(async () => ({ health: {
      enabled: true, role: "client", status: "connected", instanceId: "local", localLabel: "Local",
      peers: owner === "remote" ? [{ id: "remote", label: "Remote", role: "client", status: "connected",
        capabilities: ["thread_navigation"], navigationQueryProtocol: 2 }] : [],
    } })),
    onAgentEvent: vi.fn(() => () => undefined),
  } as unknown as DesktopApi;
  const view = render(<StarMapScreen desktopApi={api} sessionKeys={{}} localInstanceLabel="Local"
    onOpenLocalThread={() => undefined} onFocusLocalInstance={() => undefined} />);
  await waitFor(() => expect(view.container.querySelectorAll(".star-map__cluster-label")).toHaveLength(15));
  await waitFor(() => expect(view.container.querySelectorAll('button[aria-label^="Load more project-"]')).toHaveLength(15));
  expect(read.mock.calls.filter(([request]) => request.query.kind === "star-map" && request.query.projectKey).length).toBe(15);
  const before = read.mock.calls.length;
  fireEvent.click(view.container.querySelector('button[aria-label="Load more project-0 threads"]')!);
  await waitFor(() => expect(view.container.querySelectorAll('[data-thread-key$="p0-c109"]')).toHaveLength(1));
  fireEvent.click(view.container.querySelector('button[aria-label="Load more project-0 threads"]')!);
  await waitFor(() => expect(view.container.querySelectorAll('[data-thread-key$="p0-c122"]')).toHaveLength(1));
  expect(view.container.querySelector('button[aria-label="Load more project-0 threads"]')).toBeNull();
  expect(view.container.querySelectorAll('[data-thread-key$="p0-c0"]')).toHaveLength(1);
  expect(expired).toBe(true);
  // A click asks for its block; only the rebaseline after the evicted cursor
  // falls back to the demand page size that paces a first paint.
  expect(read.mock.calls.slice(before).every(([request]) => request.query.kind === "star-map"
    && request.query.projectKey === directories[0]!.key
    && request.pageSize === (request.cursor ? 100 : 10))).toBe(true);
  expect(view.container.querySelectorAll(".star-map__cluster-label")).toHaveLength(15);
  view.unmount();
});

it.each(["orbit", "projects"].flatMap((layout) => ["local", "remote"].map((owner) => [layout, owner])))(
  "restarts a removed project anchor in %s for %s after the final page", async (layout, owner) => {
    window.localStorage.setItem("pwragent.starMap.viewPreferences", JSON.stringify({ layout }));
    let threads: NavigationThreadSummary[] = Array.from({ length: 13 }, (_, card) => ({
      id: `c${card}`, source: "codex", title: `Card ${card}`, titleSource: "derived", inbox: { inInbox: false }, updatedAt: 1000 - card,
      linkedDirectories: [{ id: "d", kind: "local", path: "/repos/project", label: "project" }],
    }));
    const directories = [classifyDirectory(threads[0]!.linkedDirectories[0]!)];
    let removed = false;
    const listeners = new Set<(event: AgentEvent) => void>();
    const read = vi.fn(async (request: NavigationQueryRequest) => {
      if (removed && request.query.kind === "star-map" && request.anchor?.kind === "thread"
        && request.anchor.ref.threadId === "c0") throw new Error("[navigation_anchor_missing] Removed card");
      return navigationQueryFixture(request,
        (request.federationTarget?.scope === "remote") === (owner === "remote") ? { threads, directories } : {});
    });
    const api = { getNavigationQueryPage: read, releaseNavigationQuery: vi.fn().mockResolvedValue(undefined),
      readFederationHealth: vi.fn(async () => ({ health: { enabled: true, role: "client", status: "connected",
        instanceId: "local", localLabel: "Local", peers: owner === "remote" ? [{ id: "remote", label: "Remote",
          role: "client", status: "connected", capabilities: ["thread_navigation"], navigationQueryProtocol: 2 }] : [] } })),
      onAgentEvent: (listener: (event: AgentEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    } as unknown as DesktopApi;
    const view = render(<StarMapScreen desktopApi={api} sessionKeys={{}} localInstanceLabel="Local"
      onOpenLocalThread={() => undefined} onFocusLocalInstance={() => undefined} />);
    const loadLabel = layout === "orbit" ? "Load more project threads" : "Load more threads from instances in project";
    fireEvent.click(await view.findByRole("button", { name: loadLabel }));
    await waitFor(() => expect(view.queryByRole("button", { name: loadLabel })).toBeNull());
    removed = true;
    threads = threads.slice(1);
    act(() => { for (const listener of listeners) listener({ backend: "codex",
      ...(owner === "remote" ? { federationTarget: { scope: "remote", instanceId: "remote" } } : {}),
      notification: { method: "thread/status/changed", params: { threadId: "c0", status: { type: "idle" } } } }); });
    const restart = await view.findByRole("button", { name: "Restart project threads" });
    const before = read.mock.calls.length;
    fireEvent.click(restart);
    await waitFor(() => expect(view.queryByRole("button", { name: "Restart project threads" })).toBeNull());
    const restarted = read.mock.calls.slice(before).map(([request]) => request).filter((request) => request.query.kind === "star-map");
    expect(restarted).toHaveLength(1);
    expect(restarted[0]!.anchor).toBeUndefined();
    expect(restarted[0]!.cursor).toBeUndefined();
    // `findByRole`, not `getByRole`: the restart clears the anchor and refetches,
    // and the two halves of that land in separate commits. Waiting for the
    // Restart button to disappear says the refetch started, not that its first
    // page arrived, so a synchronous get here was asserting on whichever commit
    // happened to be first.
    expect(await view.findByRole("button", { name: loadLabel })).toBeTruthy();
    view.unmount();
  },
);

it("marks a refreshing Load more chip busy without taking it out of the tab order", async () => {
  // A project refresh sets `loading` for well under a tenth of a second —
  // measured at 88ms on a Windows CI runner. While the chip carried the
  // native `disabled` property for that window, a real engine blurred it:
  // focus moved to `body` the moment the attribute landed and clearing it
  // brought focus back nowhere. That cost a keyboard operator their place
  // among hundreds of cards, and on CI it made
  // `star-map-project-pagination.spec.ts` fail 12 times in 60 Windows
  // attempts with `toBeFocused` reporting a bare "inactive".
  //
  // This test pins the CAUSE, not the symptom: jsdom does not implement
  // blur-on-disable, so `document.activeElement` survives the native
  // property here and asserting on it alone would pass against the
  // regression. What actually distinguishes them is that the chip is never
  // given the native property in the first place, which is the last
  // assertion in the busy block. The blur itself is a real-engine behavior
  // and is covered by the e2e spec named above.
  window.localStorage.setItem("pwragent.starMap.viewPreferences", JSON.stringify({ layout: "orbit" }));
  const threads: NavigationThreadSummary[] = Array.from({ length: 2 }, (_, project) =>
    Array.from({ length: 23 }, (_, card) => ({
      id: `p${project}-c${card}`, source: "codex" as const, title: `Project ${project} card ${card}`,
      titleSource: "derived" as const, inbox: { inInbox: false }, updatedAt: 1000 - card,
      linkedDirectories: [{ id: `d${project}`, kind: "local" as const, path: `/repos/project-${project}`, label: `project-${project}` }],
    }))).flat();
  const directories = Array.from({ length: 2 }, (_, index) => classifyDirectory(threads[index * 23]!.linkedDirectories[0]!));
  // Held open so the refresh's `loading` window is observable rather than a
  // race against a promise that resolves in the same microtask. A refresh
  // fans out across every project resource, so the gate has to hold and
  // release all of them, not just the last one to arrive.
  let blockReads = false;
  const heldReads: Array<() => void> = [];
  const read = vi.fn(async (request: NavigationQueryRequest) => {
    if (blockReads) await new Promise<void>((resolve) => heldReads.push(resolve));
    return navigationQueryFixture(request, { threads, directories });
  });
  // Several hooks on this screen subscribe; keeping only the last listener
  // silently delivered the event to the wrong one.
  const listeners: Array<(event: AgentEvent) => void> = [];
  const api = {
    getNavigationQueryPage: read,
    releaseNavigationQuery: vi.fn().mockResolvedValue(undefined),
    readFederationHealth: vi.fn(async () => ({ health: {
      enabled: true, role: "client", status: "connected", instanceId: "local", localLabel: "Local", peers: [],
    } })),
    onAgentEvent: vi.fn((listener: (event: AgentEvent) => void) => {
      listeners.push(listener);
      return () => { listeners.splice(listeners.indexOf(listener), 1); };
    }),
  } as unknown as DesktopApi;
  const view = render(<StarMapScreen desktopApi={api} sessionKeys={{}} localInstanceLabel="Local"
    onOpenLocalThread={() => undefined} onFocusLocalInstance={() => undefined} />);
  // Unmounted in a `finally`: a failing assertion below would otherwise leave
  // the screen mounted, and `useStarMapProjectPages` keeps a 60s refresh
  // interval alive, so one real failure turns into unrelated noise in the
  // tests that follow it in this file.
  try {
    const selector = 'button[aria-label="Load more project-0 threads"]';
    await waitFor(() => expect(view.container.querySelector(selector)).not.toBeNull());
    const chip = view.container.querySelector<HTMLButtonElement>(selector)!;
    chip.focus();
    expect(document.activeElement).toBe(chip);

    blockReads = true;
    act(() => {
      for (const listener of [...listeners]) {
        listener({ backend: "codex", notification: { method: "thread/status/changed", params: { threadId: "p0-c0" } } } as unknown as AgentEvent);
      }
    });
    // Read the busy state through BOTH spellings, so this waits for the same
    // moment whichever one the chip uses. Asserting `aria-disabled` here
    // instead would make the regression fail on a missing attribute before it
    // ever reached the focus check — passing for the wrong reason is how the
    // `toBeEditable` barrier in the e2e suite went vacuous for four CI rounds.
    const busy = () => {
      const node = view.container.querySelector<HTMLButtonElement>(selector);
      return node?.getAttribute("aria-disabled") === "true" || node?.hasAttribute("disabled") === true;
    };
    // The debounce inside `useStarMapProjectPages` batches the refresh.
    await waitFor(() => expect(busy()).toBe(true));
    // The whole point: busy, still the same node, still holding focus.
    expect(view.container.querySelector(selector)).toBe(chip);
    expect(document.activeElement).toBe(chip);
    // And busy the accessible way, so the chip stays reachable by keyboard.
    expect(chip.getAttribute("aria-disabled")).toBe("true");
    expect(chip.hasAttribute("disabled")).toBe(false);

    await act(async () => {
      blockReads = false;
      for (const release of heldReads.splice(0)) release();
      await Promise.resolve();
    });
    await waitFor(() => expect(busy()).toBe(false));
    expect(document.activeElement).toBe(chip);
  } finally {
    view.unmount();
  }
});
