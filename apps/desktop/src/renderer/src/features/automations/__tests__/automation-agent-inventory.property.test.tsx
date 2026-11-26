import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type {
  NavigationQueryPage,
  NavigationQueryRequest,
  NavigationRow,
} from "@pwragent/shared/contracts/navigation";
import type { DesktopApi } from "../../../lib/desktop-api";
import { AutomationEditor } from "../AutomationEditor";

afterEach(cleanup);

function agent(id: number): NavigationRow {
  return {
    id: `agent-${id}`, source: "codex", title: `Agent ${id}`, titleSource: "explicit",
    ref: { backend: "codex", threadId: `agent-${id}` }, rowRevision: "1",
    agent: { name: `Agent ${id}`, instructionLineCount: 0, instructionsTooLong: false, updatedAt: 1 },
    linkedDirectories: [], inbox: { inInbox: false }, ordinaryChildCount: 0,
    nativeSubAgentGroupPresent: false, queueCount: 0, queueState: "ready",
  };
}

function owner(rows: NavigationRow[], coverage: NavigationQueryPage["coverage"] = { state: "complete" }) {
  const read = vi.fn(async (request: NavigationQueryRequest, _consumerId?: string): Promise<NavigationQueryPage> => {
    const query = request.query;
    expect(query.kind).toBe("messaging-threads");
    if (query.kind !== "messaging-threads") throw new Error("Unexpected query");
    const matches = rows.filter((row) => (!query.agentOnly || row.agent)
      && (!query.filter || row.title.toLowerCase().includes(query.filter.toLowerCase())));
    const start = Number(request.cursor ?? 0);
    const end = Math.min(start + (request.pageSize ?? 100), matches.length);
    return {
      protocol: 2, queryKey: JSON.stringify(query), generation: "1", ownerEpoch: "1",
      countsRevision: "1", counts: { total: rows.length, active: 0, unread: 0, review: 0 },
      coverage, collectionSize: matches.length, rangeStart: start,
      entries: matches.slice(start, end).map((row, index) => ({ row, orderKey: String(start + index), placement: { kind: "root" } })),
      complete: end === matches.length, nextCursor: end < matches.length ? String(end) : undefined,
    };
  });
  const release = vi.fn(async () => undefined);
  return { read, release, api: { getNavigationQueryPage: read, releaseNavigationQuery: release } as DesktopApi };
}

function editor(api: DesktopApi, threads: NavigationRow[]) {
  return <AutomationEditor desktopApi={api} threads={threads} mode={{ kind: "create" }}
    onCancel={() => undefined} onSubmit={async () => undefined} />;
}

async function openPicker() {
  await act(async () => { fireEvent.click(screen.getByLabelText("Agent")); });
}

describe("automation Agent inventory", () => {
  // The owner is the oracle: changing the sidebar's retained page cannot
  // change membership in the Agent picker.
  it("keeps all owner Agents across arbitrary sidebar page replacements", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 8 }), fc.nat(30), async (count, offset) => {
      const rows = Array.from({ length: count }, (_, id) => agent(id));
      const { api } = owner(rows);
      try {
        const view = render(editor(api, [rows[offset % count]!]));
        await openPicker();
        const expected = rows.map((row) => row.title);
        const labels = () => within(screen.getByRole("listbox"))
          .getAllByRole("option").map((option) => option.querySelector("span span")?.textContent)
          .filter((label) => label?.startsWith("Agent "));
        expect(labels()).toEqual(expected);
        view.rerender(editor(api, [rows[(offset + 1) % count]!]));
        expect(labels()).toEqual(expected);
      } finally { cleanup(); }
    }), { numRuns: 6 });
  });

  it("finds an old Agent without visiting it in the sidebar and retains earlier pages while scrolling", async () => {
    const rows = Array.from({ length: 103 }, (_, id) => agent(id));
    const { api, read, release } = owner(rows);
    const view = render(editor(api, [rows[0]!]));
    await openPicker();
    expect(read).toHaveBeenCalledWith(expect.objectContaining({
      query: { kind: "messaging-threads", agentOnly: true, filter: "" }, pageSize: 100,
    }), expect.any(String));
    const more = screen.getByRole("button", { name: "Load more Agents" });
    const scroller = more.closest(".automation-agent-picker__results")!;
    Object.defineProperties(scroller, {
      scrollHeight: { value: 400 }, clientHeight: { value: 100 }, scrollTop: { value: 300 },
    });
    await act(async () => { fireEvent.scroll(scroller); });
    expect(screen.getByRole("option", { name: /Agent 102codex/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Agent 0codex/ })).toBeInTheDocument();
    await act(async () => { fireEvent.change(screen.getByPlaceholderText("Find an Agent"), { target: { value: "Agent 102" } }); });
    expect(read.mock.lastCall?.[0]).toMatchObject({ query: { filter: "Agent 102", agentOnly: true }, cursor: undefined });
    expect(screen.getByRole("option", { name: /Agent 102codex/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /Agent 102codex/ }));
    await openPicker();
    await act(async () => { fireEvent.change(screen.getByPlaceholderText("Find an Agent"), { target: { value: "Agent 0" } }); });
    expect(screen.getByLabelText("Agent")).toHaveTextContent("Agent 102");
    view.unmount();
    expect(release).toHaveBeenCalledWith(read.mock.lastCall?.[1]);
  });

  it("reports an owner failure and retries instead of declaring that no Agents exist", async () => {
    const { api, read } = owner([agent(1)]);
    read.mockRejectedValueOnce(new Error("Owner unavailable"));
    render(editor(api, []));
    await openPicker();
    expect(screen.getByRole("alert")).toHaveTextContent("Owner unavailable");
    expect(screen.queryByText("No Agent threads match.")).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Reload threads" })); });
    expect(screen.getByRole("option", { name: /Agent 1codex/ })).toBeInTheDocument();
  });

  it("queries off-sidebar regular threads when opening the promotion tab", async () => {
    const regular = { ...agent(2), agent: undefined };
    const { api, read } = owner([agent(1), regular]);
    render(editor(api, []));
    await openPicker();
    await act(async () => { fireEvent.click(screen.getByRole("tab", { name: "Threads" })); });
    expect(read.mock.lastCall?.[0]).toMatchObject({ query: { kind: "messaging-threads", agentOnly: false } });
    const list = screen.getByRole("listbox", { name: "Threads to promote" });
    expect(within(list).getAllByRole("option")).toHaveLength(1);
    expect(within(list).getByRole("option", { name: /Agent 2/ })).toBeInTheDocument();
  });

  it.each(["checking", "degraded"] as const)("keeps continuation available during %s coverage when the first page contains only Agents", async (state) => {
    const rows = Array.from({ length: 100 }, (_, id) => agent(id));
    const regular = { ...agent(100), agent: undefined };
    const { api, read } = owner([...rows, regular], { state });
    render(editor(api, []));
    await openPicker();
    await act(async () => { fireEvent.click(screen.getByRole("tab", { name: "Threads" })); });
    expect(within(screen.getByRole("listbox", { name: "Threads to promote" })).queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Load more threads" })); });
    expect(read.mock.lastCall?.[0].cursor).toBe("100");
    expect(screen.getByRole("option", { name: /Agent 100/ })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("keeps paging toward regular threads independently of inventory coverage", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("checking", "degraded"), fc.integer({ min: 100, max: 106 }),
      async (state, count) => {
        const rows = Array.from({ length: count }, (_, id) => agent(id));
        const regular = { ...agent(count), agent: undefined };
        const { api } = owner([...rows, regular], { state });
        try {
          render(editor(api, []));
          await openPicker();
          await act(async () => { fireEvent.click(screen.getByRole("tab", { name: "Threads" })); });
          await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Load more threads" })); });
          const list = screen.getByRole("listbox", { name: "Threads to promote" });
          expect(within(list).getAllByRole("option")).toHaveLength(1);
          expect(within(list).getByRole("option", { name: new RegExp(`Agent ${count}codex`) })).toBeInTheDocument();
        } finally { cleanup(); }
      },
    ), { numRuns: 6 });
  });
});
