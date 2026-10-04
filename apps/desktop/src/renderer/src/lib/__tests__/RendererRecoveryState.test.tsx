import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RendererErrorBoundary } from "../../features/diagnostics/RendererErrorBoundary";
import type { ComposerDraftStore, ComposerDraftSnapshot } from "../../features/composer/useComposerDraftStore";
import {
  RendererRecoveryStateProvider, useRecoverableComposerDraftStore, useRecoverableState,
} from "../RendererRecoveryState";
import { RENDERER_RECOVERY_DELAY_MS } from "../../../../shared/renderer-recovery";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (window as Window & { pwragent?: unknown }).pwragent;
});

describe("window recovery state", () => {
  it("retains exact draft content, parked drafts, queue ownership and committed selection across remounts", () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let failing = false;
    const stores: ComposerDraftStore[] = [];
    function WindowContent() {
      const store = useRecoverableComposerDraftStore();
      const [selection, setSelection] = useRecoverableState("selection", "first-thread");
      stores.push(store);
      if (failing) throw new Error("lost UI");
      return <button onClick={() => setSelection("second-thread")}>{selection}</button>;
    }
    const tree = () => (
      <StrictMode>
        <RendererRecoveryStateProvider>
          <RendererErrorBoundary><WindowContent /></RendererErrorBoundary>
        </RendererRecoveryStateProvider>
      </StrictMode>
    );
    const view = render(tree());
    const original = stores.at(-1)!;
    const snapshot: ComposerDraftSnapshot = {
      draft: "Unsent text with a skill and attachments",
      editorDocument: { type: "doc", content: [{ type: "paragraph" }] },
      imageAttachments: [{ id: "image", name: "example.png", size: 1, type: "image/png", url: "data:image/png;base64,YQ==" }],
      fileAttachments: [{ id: "file", label: "example.txt", path: "/contrived/example.txt" }],
      skillTokens: [{ id: "skill", index: 4, name: "example", path: "/skills/example", description: "Contrived skill" }],
    };
    act(() => {
      original.set("thread:codex:second-thread", snapshot);
      original.pushDraft("thread:codex:second-thread", { ...snapshot, draft: "Parked text" });
      original.setQueuedTurns("thread:codex:second-thread", [{
        id: "queue", queueEntryId: "main-owned-queue", text: "Already queued",
        imageAttachments: [], fileAttachments: [],
      }]);
    });
    fireEvent.click(screen.getByRole("button", { name: "first-thread" }));
    failing = true;
    view.rerender(tree());
    expect(screen.getByRole("alert")).toBeInTheDocument();
    failing = false;
    act(() => vi.advanceTimersByTime(RENDERER_RECOVERY_DELAY_MS));
    expect(screen.getByRole("button", { name: "second-thread" })).toBeInTheDocument();
    const restored = stores.at(-1)!;
    expect(restored).toBe(original);
    expect(restored.get("thread:codex:second-thread")).toEqual(snapshot);
    expect(restored.popDraft("thread:codex:second-thread")?.draft).toBe("Parked text");
    expect(restored.getQueuedTurn("thread:codex:second-thread")?.queueEntryId).toBe("main-owned-queue");
  });

  it("keeps draft stores isolated between windows and loses memory on a new page lifetime", () => {
    const stores: ComposerDraftStore[] = [];
    function Capture() {
      stores.push(useRecoverableComposerDraftStore());
      return null;
    }
    const first = render(<RendererRecoveryStateProvider><Capture /></RendererRecoveryStateProvider>);
    const original = stores.at(-1)!;
    original.set("thread:codex:one", { draft: "Window one", imageAttachments: [], skillTokens: [] });
    render(<RendererRecoveryStateProvider><Capture /></RendererRecoveryStateProvider>);
    expect(stores.at(-1)!.get("thread:codex:one")).toBeUndefined();
    first.unmount();
    render(<RendererRecoveryStateProvider><Capture /></RendererRecoveryStateProvider>);
    expect(stores.at(-1)!.get("thread:codex:one")).toBeUndefined();
  });
});
