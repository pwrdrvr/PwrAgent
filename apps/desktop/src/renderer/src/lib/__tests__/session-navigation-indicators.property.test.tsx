import "@testing-library/jest-dom/vitest";
import fc from "fast-check";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { DesktopApi } from "../desktop-api";
import { useThreadSessionState } from "../useThreadSessionState";
import { ThreadRow } from "../../features/navigation/ThreadRow";
import { memoRenderObserver } from "../../test/memo-render-observer";

afterEach(cleanup);
const noop = () => undefined;

async function fixture(count: number) {
  const rows: NavigationThreadSummary[] = Array.from({ length: count }, (_, i) => ({
    id: `indicator-${i}`, title: `Contrived row ${i}`, source: "codex", titleSource: "explicit",
    linkedDirectories: [], inbox: { inInbox: false }, updatedAt: 1,
  }));
  let emit: (event: AgentEvent) => void = noop;
  const api: DesktopApi = {
    onAgentEvent: (listener) => { emit = listener; return noop; },
    readThread: async ({ threadId }) => ({ backend: "codex", threadId, fetchedAt: 1, threadStatus: "idle",
      replay: { entries: [], messages: [], pagination: { supportsPagination: true, hasPreviousPage: false } } }),
  };
  let state!: ReturnType<typeof useThreadSessionState>;
  function Harness() {
    state = useThreadSessionState({ desktopApi: api, thread: rows[0] });
    return rows.map((thread) => <ThreadRow key={thread.id} thread={thread}
      onSelectThread={noop} onOpenContextMenu={noop} thinkingThreadKeys={state.thinkingThreadKeys}
      approvalRequestThreadKeys={state.approvalRequestThreadKeys} inputRequestThreadKeys={state.inputRequestThreadKeys} />);
  }
  const view = render(<Harness />);
  await waitFor(() => expect(state.response?.threadId).toBe(rows[0]!.id));
  act(() => emit({ backend: "codex", notification: { method: "turn/started", params: {
    threadId: rows[0]!.id, turn: { id: "indicator-turn", status: "in_progress" },
  } } }));
  return { view, read: () => state, delta: (text: string) => act(() => emit({ backend: "codex", notification: {
    method: "item/agentMessage/delta", params: { threadId: rows[0]!.id, turnId: "indicator-turn", itemId: "reply", delta: text },
  } })) };
}

function indicators(state: ReturnType<typeof useThreadSessionState>) {
  return [state.thinkingThreadKeys, state.approvalRequestThreadKeys, state.inputRequestThreadKeys];
}

describe("session navigation indicator projection", () => {
  it("keeps every indicator identity through arbitrary transcript-only deltas", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.string({ minLength: 1, maxLength: 12 }), { minLength: 1, maxLength: 6 }), async (deltas) => {
      const f = await fixture(1);
      try {
        const before = indicators(f.read());
        expect(before).toEqual([{ "codex:indicator-0": true }, {}, {}]);
        let content = "";
        for (const text of deltas) {
          content += text;
          f.delta(text);
          const after = indicators(f.read());
          expect(f.read().pendingAssistantMessage?.text).toBe(content);
          expect(after).toEqual(before);
          for (let i = 0; i < before.length; i++) expect(after[i]).toBe(before[i]);
        }
      } finally { f.view.unmount(); }
    }), { numRuns: 20 });
  });

  it.each([20, 40])("budgets zero row renders and indicator records for 20 deltas with %i rows", async (count) => {
    let renders = 0;
    const observer = memoRenderObserver(ThreadRow, "ThreadRow");
    observer.install(() => { renders++; });
    const f = await fixture(count);
    try {
      const baseline = renders;
      const before = indicators(f.read());
      let records = 0;
      for (let i = 0; i < 20; i++) {
        f.delta("contrived");
        indicators(f.read()).forEach((record, index) => { if (record !== before[index]) records++; });
      }
      expect({ rowRenders: renders - baseline, indicatorRecords: records }).toEqual({ rowRenders: 0, indicatorRecords: 0 });
      expect(f.read().pendingAssistantMessage).toMatchObject({ text: "contrived".repeat(20) });
    } finally { f.view.unmount(); observer.restore(); }
  });
});
