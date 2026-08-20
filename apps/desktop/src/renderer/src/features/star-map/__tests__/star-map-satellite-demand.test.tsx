import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";

// Counted, not stubbed: the Edits tab still has to work, and what is under
// test is how often the card walks the transcript, not what it finds.
const collectSpy = vi.hoisted(() => vi.fn());
vi.mock("../../thread-detail/edited-file-groups", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../thread-detail/edited-file-groups")>();
  return {
    ...actual,
    collectEditedFileGroups: (
      params: Parameters<typeof actual.collectEditedFileGroups>[0],
    ) => {
      collectSpy(params);
      return actual.collectEditedFileGroups(params);
    },
  };
});

const { StarMapChatCard } = await import("../StarMapChatCard");
const { StarMapContextCard } = await import("../StarMapSatelliteCards");

const CARD_KEY = "card-1";

function thread(): NavigationThreadSummary {
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

function buildApi(): DesktopApi {
  return {
    platform: "darwin",
    readThread: vi.fn(async () => ({
      backend: "codex",
      threadId: "t-local",
      replay: {
        entries: [],
        messages: [],
        pagination: { supportsPagination: false, hasPreviousPage: false },
      },
    })),
    listBackends: vi.fn(async () => ({ backends: [] })),
    onAgentEvent: vi.fn(() => () => undefined),
  } as unknown as DesktopApi;
}

function chatCard(desktopApi: DesktopApi) {
  return (
    <StarMapChatCard
      cardKey={CARD_KEY}
      desktopApi={desktopApi}
      onClose={() => undefined}
      onOpenFull={() => undefined}
      onRaise={() => undefined}
      onRectChange={() => undefined}
      rect={{ left: 40, top: 40, width: 420, height: 520 }}
      scale={1}
      bounds={{ width: 4000, height: 3000 }}
      thread={thread()}
      contextOpen
      onToggleContext={() => undefined}
      onToggleTerminal={() => undefined}
      zIndex={40}
    />
  );
}

function contextSatellite(desktopApi: DesktopApi) {
  return (
    <StarMapContextCard
      cardKey={CARD_KEY}
      desktopApi={desktopApi}
      thread={thread()}
      rect={{ left: 480, top: 40, width: 320, height: 520 }}
      zIndex={40}
      onClose={() => undefined}
    />
  );
}

describe("star map card context demand", () => {
  it("derives nothing while no satellite is mounted", async () => {
    // The map drops every satellite at overview zoom while leaving
    // `contextOpen` set. Keyed on that flag, a card would walk its whole
    // transcript on every streamed entry for a rail nobody can see.
    const desktopApi = buildApi();
    collectSpy.mockClear();
    render(chatCard(desktopApi));

    await waitFor(() => {
      expect(desktopApi.readThread).toHaveBeenCalled();
    });

    expect(collectSpy).not.toHaveBeenCalled();
  });

  it("starts deriving once a satellite subscribes", async () => {
    const desktopApi = buildApi();
    collectSpy.mockClear();
    const { rerender } = render(chatCard(desktopApi));

    await waitFor(() => {
      expect(desktopApi.readThread).toHaveBeenCalled();
    });
    expect(collectSpy).not.toHaveBeenCalled();

    rerender(
      <>
        {chatCard(desktopApi)}
        {contextSatellite(desktopApi)}
      </>,
    );

    await waitFor(() => {
      expect(collectSpy).toHaveBeenCalled();
    });
    expect(
      screen.getByRole("region", { name: "Thread context: Local work" }),
    ).toBeTruthy();
  });
});
