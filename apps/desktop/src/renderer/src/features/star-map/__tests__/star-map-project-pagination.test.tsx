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
  const threads: NavigationThreadSummary[] = Array.from({ length: 15 }, (_, project) =>
    Array.from({ length: 23 }, (_, card) => ({
      id: `p${project}-c${card}`, source: "codex" as const, title: `Project ${project} card ${card}`,
      titleSource: "derived" as const, inbox: { inInbox: false }, updatedAt: 1000 - card,
      linkedDirectories: [{ id: `d${project}`, kind: "local" as const, path: `/repos/project-${project}`, label: `project-${project}` }],
    }))).flat();
  const directories = Array.from({ length: 15 }, (_, index) => classifyDirectory(threads[index * 23]!.linkedDirectories[0]!));
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
  await waitFor(() => expect(view.container.querySelectorAll('[data-thread-key$="p0-c19"]')).toHaveLength(1));
  fireEvent.click(view.container.querySelector('button[aria-label="Load more project-0 threads"]')!);
  await waitFor(() => expect(view.container.querySelectorAll('[data-thread-key$="p0-c22"]')).toHaveLength(1));
  expect(view.container.querySelector('button[aria-label="Load more project-0 threads"]')).toBeNull();
  expect(view.container.querySelectorAll('[data-thread-key$="p0-c0"]')).toHaveLength(1);
  expect(expired).toBe(true);
  expect(read.mock.calls.slice(before).every(([request]) => request.query.kind === "star-map"
    && request.query.projectKey === directories[0]!.key && request.pageSize === 10)).toBe(true);
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
    expect(view.getByRole("button", { name: loadLabel })).toBeTruthy();
    view.unmount();
  },
);
