import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { StarMapChatCard } from "../StarMapChatCard";

const RECT = { left: 40, top: 40, width: 420, height: 520 };

/**
 * A thread owned by a peer. The federation ref is the whole point: the
 * card must route both reads and writes to that instance without the
 * thread ever being pinned or merged into the local snapshot.
 */
function remoteThread(): NavigationThreadSummary {
  return {
    id: "t-remote",
    title: "Remote work",
    titleSource: "generated",
    linkedDirectories: [],
    source: "codex",
    inbox: { inInbox: false },
    updatedAt: 1,
    federation: {
      instanceLabel: "Studio Mac",
      ref: {
        backend: "codex",
        threadId: "t-remote",
        target: { scope: "remote", instanceId: "pwr_peer" },
      },
    },
  } as unknown as NavigationThreadSummary;
}

function localThread(): NavigationThreadSummary {
  return {
    id: "t-local",
    title: "Local work",
    titleSource: "generated",
    linkedDirectories: [],
    source: "codex",
    inbox: { inInbox: false },
    updatedAt: 1,
  } as unknown as NavigationThreadSummary;
}

function buildApi(overrides: Partial<DesktopApi> = {}): DesktopApi {
  return {
    readThread: vi.fn(async () => ({
      backend: "codex",
      threadId: "t",
      replay: { entries: [], pagination: undefined },
    })),
    startTurn: vi.fn(async () => ({
      backend: "codex",
      threadId: "t",
      turnId: "turn-1",
    })),
    onAgentEvent: vi.fn(() => () => undefined),
    ...overrides,
  } as unknown as DesktopApi;
}

function renderCard(params: {
  desktopApi: DesktopApi;
  thread: NavigationThreadSummary;
}) {
  render(
    <StarMapChatCard
      cardKey="card-1"
      desktopApi={params.desktopApi}
      onClose={() => undefined}
      onOpenFull={() => undefined}
      onRaise={() => undefined}
      onRectChange={() => undefined}
      rect={RECT}
      thread={params.thread}
      zIndex={40}
    />,
  );
}

async function typeAndSend(title: string, text: string) {
  const input = screen.getByRole("textbox", { name: `Message ${title}` });
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: "Enter" });
  return input as HTMLTextAreaElement;
}

describe("StarMapChatCard federation routing", () => {
  it("hydrates a peer's thread against that peer", async () => {
    const desktopApi = buildApi();
    renderCard({ desktopApi, thread: remoteThread() });

    await waitFor(() => {
      expect(desktopApi.readThread).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "t-remote",
          federationTarget: { scope: "remote", instanceId: "pwr_peer" },
        }),
      );
    });
  });

  it("starts a turn on the owning peer, not the viewer", async () => {
    const desktopApi = buildApi();
    renderCard({ desktopApi, thread: remoteThread() });
    await typeAndSend("Remote work", "ship it");

    await waitFor(() => {
      expect(desktopApi.startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          backend: "codex",
          threadId: "t-remote",
          federationTarget: { scope: "remote", instanceId: "pwr_peer" },
          input: [{ type: "text", text: "ship it" }],
        }),
      );
    });
  });

  it("leaves a local thread's target to the window's own scope", async () => {
    const desktopApi = buildApi();
    renderCard({ desktopApi, thread: localThread() });
    await typeAndSend("Local work", "hello");

    await waitFor(() => {
      expect(desktopApi.startTurn).toHaveBeenCalled();
    });
    const request = (desktopApi.startTurn as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(request.threadId).toBe("t-local");
    // No per-thread ref, so nothing overrides the renderer's own target.
    expect(request.federationTarget).toBeUndefined();
  });
});

describe("StarMapChatCard send failures", () => {
  it("hands the text back to the input when the peer refuses", async () => {
    const desktopApi = buildApi({
      startTurn: vi.fn(async () => {
        throw new Error("peer is offline");
      }),
    } as unknown as Partial<DesktopApi>);
    renderCard({ desktopApi, thread: remoteThread() });
    const input = await typeAndSend("Remote work", "do not lose me");

    // A send that never reached the backend must not cost the operator
    // what they typed.
    await waitFor(() => {
      expect(input.value).toBe("do not lose me");
    });
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /peer is offline/,
    );
  });

  it("shows the message optimistically while the turn is in flight", async () => {
    // Baseline for the rollback test below: without this, "the message is
    // gone after a failure" could pass simply because it never appeared.
    const desktopApi = buildApi({
      startTurn: vi.fn(() => new Promise(() => undefined)),
    } as unknown as Partial<DesktopApi>);
    renderCard({ desktopApi, thread: remoteThread() });
    await typeAndSend("Remote work", "in flight");

    // Ignore the composer: a textarea's content matches text queries, and
    // the draft would otherwise satisfy this on its own.
    expect(
      await screen.findByText("in flight", { ignore: "textarea" }),
    ).toBeTruthy();
  });

  it("rolls the optimistic message back when the turn never started", async () => {
    const desktopApi = buildApi({
      startTurn: vi.fn(async () => {
        throw new Error("nope");
      }),
    } as unknown as Partial<DesktopApi>);
    renderCard({ desktopApi, thread: remoteThread() });
    await typeAndSend("Remote work", "rolled back");

    // The transcript must not keep a message for a turn that never ran.
    // The composer is excluded because the restored draft lives there and
    // text queries match textarea content.
    await waitFor(() => {
      expect(
        screen.queryByText("rolled back", { ignore: "textarea" }),
      ).toBeNull();
    });
    expect((await screen.findByRole("alert")).textContent).toMatch(/nope/);
  });

  it("clears the draft when the send succeeds", async () => {
    const desktopApi = buildApi();
    renderCard({ desktopApi, thread: remoteThread() });
    const input = await typeAndSend("Remote work", "sent for real");

    await waitFor(() => {
      expect(desktopApi.startTurn).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(input.value).toBe("");
    });
  });
});
