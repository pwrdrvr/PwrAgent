import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import {
  STAR_MAP_CHAT_CARD_RAIL_WIDTH,
  StarMapChatCard,
} from "../StarMapChatCard";
import {
  DEFAULT_INITIAL_THREAD_HISTORY_TURN_LIMIT,
  DEFAULT_RENDERED_TRANSCRIPT_ENTRY_LIMIT,
} from "../../../lib/thread-history-limits";

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
      scale={1}
      bounds={{ width: 4000, height: 3000 }}
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

describe("StarMapChatCard transcript loading", () => {
  it("asks for the last few turns rather than the whole thread", async () => {
    const desktopApi = buildApi();
    renderCard({ desktopApi, thread: remoteThread() });

    // No limit means `readThread` replays from the thread's first message.
    // On a 135 MB thread that is the entire transcript over the bridge.
    await waitFor(() => {
      expect(desktopApi.readThread).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: DEFAULT_INITIAL_THREAD_HISTORY_TURN_LIMIT,
        }),
      );
    });
  });

  it("mounts only the newest entries of a long transcript", async () => {
    const entries = Array.from({ length: 200 }, (_, index) => ({
      type: "message" as const,
      id: `m-${index}`,
      role: "assistant" as const,
      text: `entry ${index}`,
    }));
    const desktopApi = buildApi({
      readThread: vi.fn(async () => ({
        backend: "codex",
        threadId: "t",
        replay: {
          entries,
          messages: [],
          pagination: { supportsPagination: false, hasPreviousPage: false },
        },
      })),
    } as unknown as Partial<DesktopApi>);
    renderCard({ desktopApi, thread: remoteThread() });

    // The tail is mounted; the head is held back until the operator scrolls
    // for it. Rendering all 200 is what makes a big thread unresponsive.
    await waitFor(() => {
      expect(screen.getByText("entry 199")).toBeTruthy();
    });
    expect(screen.queryByText("entry 0")).toBeNull();
    expect(
      screen.queryByText(`entry ${200 - DEFAULT_RENDERED_TRANSCRIPT_ENTRY_LIMIT}`),
    ).toBeTruthy();
  });
});

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

  it("starts a turn on the owning peer and clears the sent draft", async () => {
    const desktopApi = buildApi();
    renderCard({ desktopApi, thread: remoteThread() });
    const input = await typeAndSend("Remote work", "ship it");

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
    await waitFor(() => {
      expect(input.value).toBe("");
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
  it("restores the draft and rolls back its optimistic message when the peer refuses", async () => {
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
    // The transcript must not keep a message for a turn that never ran.
    // The composer is excluded because the restored draft lives there and
    // text queries match textarea content.
    await waitFor(() => {
      expect(
        screen.queryByText("do not lose me", { ignore: "textarea" }),
      ).toBeNull();
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
});

describe("context rail drawer", () => {
  /**
   * The screen owns a card's rect and feeds it back, so the harness does
   * too — a static rect would let the card compute its next width from a
   * stale one and hide exactly the bug that produces.
   */
  function RailHarness(props: { onWidth: (width: number) => void }) {
    const [rect, setRect] = useState(RECT);
    return (
      <StarMapChatCard
        cardKey="card-1"
        desktopApi={buildApi()}
        onClose={() => undefined}
        onOpenFull={() => undefined}
        onRaise={() => undefined}
        onRectChange={(unused, next) => {
          props.onWidth(next.width);
          setRect(next);
        }}
        rect={rect}
        scale={1}
        bounds={{ width: 4000, height: 3000 }}
        thread={localThread()}
        zIndex={40}
      />
    );
  }

  function renderRailCard(onWidth: (width: number) => void = () => undefined) {
    return render(<RailHarness onWidth={onWidth} />);
  }

  it("opens the thread context tabs beside the transcript", async () => {
    const { container } = renderRailCard();
    const toggle = screen.getByRole("button", {
      name: /Show thread context/,
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".context-rail")).toBeNull();

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(container.querySelector(".context-rail")).not.toBeNull();
    });
    expect(
      screen.getByRole("button", { name: /Hide thread context/ }),
    ).toBeTruthy();
    // The transcript reserves the gutter rather than sliding under the rail.
    expect(
      container.querySelector(".star-map-chat-card__transcript--railed"),
    ).not.toBeNull();
  });

  it("grows the card by the rail's width instead of squeezing the chat", async () => {
    // 420 minus a 300px rail leaves 120px of transcript, which is not a
    // chat any more.
    const widths: number[] = [];
    renderRailCard((width) => widths.push(width));

    fireEvent.click(screen.getByRole("button", { name: /Show thread context/ }));
    await waitFor(() => expect(widths).toHaveLength(1));
    expect(widths[0]).toBe(RECT.width + STAR_MAP_CHAT_CARD_RAIL_WIDTH);

    fireEvent.click(screen.getByRole("button", { name: /Hide thread context/ }));
    await waitFor(() => expect(widths).toHaveLength(2));
    expect(widths[1]).toBe(RECT.width);
  });

  it("closes the rail back down", async () => {
    const { container } = renderRailCard();
    fireEvent.click(screen.getByRole("button", { name: /Show thread context/ }));
    await waitFor(() => {
      expect(container.querySelector(".context-rail")).not.toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: /Hide thread context/ }));
    await waitFor(() => {
      expect(container.querySelector(".context-rail")).toBeNull();
    });
    expect(
      container.querySelector(".star-map-chat-card__transcript--railed"),
    ).toBeNull();
  });
});
