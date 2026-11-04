import { useEffect, useRef, useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../desktop-api";
import { useNavigationSelectedDetail } from "../useNavigationSelectedDetail";
import { useThreadSessionState } from "../useThreadSessionState";

// Renderer boundary companion to the registry profile. This measures a real
// click through the production hooks to React readiness, not browser paint.
describe.skipIf(process.env.PWRAGENT_PROFILE_CRITICAL_PATHS !== "1")("selection timing profile", () => {
  it("records click-to-transcript separately from selected detail readiness", async () => {
    const thread: NavigationThreadSummary = {
      id: "fixture", source: "codex", title: "Fixture", titleSource: "explicit",
      linkedDirectories: [], inbox: { inInbox: false }, updatedAt: 1,
    };
    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const completedDetails = new Set<object>();
    const api: DesktopApi = {
      onAgentEvent: () => () => {},
      readThread: async () => {
        await wait(15);
        return { backend: "codex", threadId: thread.id, fetchedAt: 1,
          replay: { entries: [{ type: "message", id: "history", role: "assistant", text: "Fixture transcript" }], messages: [],
            pagination: { supportsPagination: true, hasPreviousPage: false } } };
      },
      getNavigationSelectedDetail: async (request) => {
        const sample = samples.at(-1);
        await wait(80);
        if (sample) completedDetails.add(sample);
        return { protocol: 2, ref: request.ref, revision: "fixture", readiness: "ready", identity: "present", thread, workspaceDirectories: [] };
      },
    };
    const samples: { temperature: string; clickToTranscriptMs?: number; clickToDetailMs?: number }[] = [];
    function Harness() {
      const [selected, setSelected] = useState<NavigationThreadSummary>();
      const click = useRef<{ at: number; sample: typeof samples[number] } | undefined>(undefined);
      const session = useThreadSessionState({ desktopApi: api, thread: selected });
      const detail = useNavigationSelectedDetail({ desktopApi: api,
        ref: selected ? { backend: selected.source, threadId: selected.id } : undefined });
      useEffect(() => {
        if (!selected || !click.current) return;
        const { at, sample } = click.current;
        if (session.response?.threadId === selected.id && !session.loading && session.entries.some((entry) => entry.id === "history")) {
          sample.clickToTranscriptMs ??= performance.now() - at;
        }
        if (completedDetails.has(sample) && detail.state?.readiness === "ready" && detail.state.detail?.thread?.id === selected.id) {
          sample.clickToDetailMs ??= performance.now() - at;
        }
      });
      return <>
        <button onClick={() => {
          const sample = { temperature: samples.length === 0 ? "cold" : "warm" };
          samples.push(sample);
          click.current = { at: performance.now(), sample };
          setSelected(thread);
        }}>Select</button>
        <button onClick={() => { click.current = undefined; setSelected(undefined); }}>Clear</button>
      </>;
    }
    const view = render(<Harness />);
    try {
      for (let index = 0; index < 4; index += 1) {
        act(() => { fireEvent.click(screen.getByText("Select")); });
        await waitFor(() => expect(samples[index]?.clickToDetailMs).toBeDefined());
        expect(samples[index]?.clickToTranscriptMs).toBeDefined();
        act(() => { fireEvent.click(screen.getByText("Clear")); });
      }
      console.info("SELECTION_PROFILE", JSON.stringify(samples));
    } finally {
      view.unmount();
    }
  });
});
