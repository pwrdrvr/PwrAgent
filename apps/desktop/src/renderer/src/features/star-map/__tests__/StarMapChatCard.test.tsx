import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { StarMapChatCard } from "../StarMapChatCard";
import { resetComposerMentionSourcesCache } from "../../composer/useComposerMentionSources";
import { isStarMapTypingTarget } from "../star-map-keyboard";
import { shouldPanOnWheel, shouldStartCanvasPan } from "../star-map-orbit";
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
function remoteThread(
  overrides: Partial<NavigationThreadSummary> = {},
): NavigationThreadSummary {
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
    ...overrides,
  } as unknown as NavigationThreadSummary;
}

function localThread(
  overrides: Partial<NavigationThreadSummary> = {},
): NavigationThreadSummary {
  return {
    id: "t-local",
    title: "Local work",
    titleSource: "generated",
    linkedDirectories: [],
    source: "codex",
    inbox: { inInbox: false },
    updatedAt: 1,
    ...overrides,
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

type CardParams = {
  desktopApi: DesktopApi;
  thread: NavigationThreadSummary;
};

function card(params: CardParams) {
  return (
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
      onToggleContext={() => undefined}
      onToggleTerminal={() => undefined}
      zIndex={40}
    />
  );
}

function renderCard(params: CardParams) {
  const view = render(card(params));
  return view;
}

/**
 * The composer is a Tiptap editor, not a textarea. It exposes a `value`
 * setter on its contenteditable node exactly so a controlled-input idiom
 * still drives it, which is what `fireEvent.change` reaches here.
 */
async function typeAndSend(title: string, text: string) {
  const input = screen.getByRole("textbox", { name: `Message ${title}` });
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: "Enter" });
  return input as HTMLElement & { value: string };
}

/**
 * Text queries match the composer's own content, so a draft would satisfy a
 * "this reached the transcript" assertion on its own.
 */
const IGNORE_COMPOSER = ".composer-tiptap-input, .composer-tiptap-input *";

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
    // The composer is excluded because the restored draft lives there.
    await waitFor(() => {
      expect(
        screen.queryByText("do not lose me", { ignore: IGNORE_COMPOSER }),
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

    expect(
      await screen.findByText("in flight", { ignore: IGNORE_COMPOSER }),
    ).toBeTruthy();
  });
});

describe("satellite toggles", () => {
  function renderToggleCard(props?: {
    contextOpen?: boolean;
    terminalOpen?: boolean;
    onToggleContext?: (cardKey: string) => void;
    onToggleTerminal?: (cardKey: string) => void;
  }) {
    return render(
      <StarMapChatCard
        cardKey="card-1"
        desktopApi={buildApi()}
        onClose={() => undefined}
        onOpenFull={() => undefined}
        onRaise={() => undefined}
        onRectChange={() => undefined}
        rect={RECT}
        scale={1}
        bounds={{ width: 4000, height: 3000 }}
        thread={localThread()}
        contextOpen={props?.contextOpen}
        terminalOpen={props?.terminalOpen}
        onToggleContext={props?.onToggleContext ?? (() => undefined)}
        onToggleTerminal={props?.onToggleTerminal ?? (() => undefined)}
        zIndex={40}
      />,
    );
  }

  it("asks the controller for the context satellite, and reflects it", () => {
    const onToggleContext = vi.fn();
    renderToggleCard({ onToggleContext });
    const toggle = screen.getByRole("button", { name: /Show thread context/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(onToggleContext).toHaveBeenCalledWith("card-1");
  });

  it("names the open state once the satellite is up", () => {
    renderToggleCard({ contextOpen: true, terminalOpen: true });
    expect(
      screen
        .getByRole("button", { name: /Hide thread context/ })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: /Close terminal/ })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("asks the controller for the terminal satellite", () => {
    const onToggleTerminal = vi.fn();
    renderToggleCard({ onToggleTerminal });
    fireEvent.click(screen.getByRole("button", { name: /Open terminal/ }));
    expect(onToggleTerminal).toHaveBeenCalledWith("card-1");
  });

  it("keeps the satellites OUT of the card: no rail pane inside", () => {
    // The first cut rendered ThreadContextPanel inside the card, which
    // popped over the transcript instead of docking beside it. Satellites
    // are the screen's to render; the card only carries the toggles.
    const { container } = renderToggleCard({ contextOpen: true });
    expect(container.querySelector(".context-rail")).toBeNull();
  });
});

/**
 * A card over a running turn. Sending here has to reach the live turn: a
 * `startTurn` while one is in flight is not a second conversation, it is a
 * message the operator loses.
 */
describe("StarMapChatCard steering a live turn", () => {
  /**
   * The session hook takes "is a turn running" from the navigation snapshot
   * as well as the thread read, and resyncs from the snapshot — so a card is
   * only busy when both say so.
   */
  const BUSY = { threadStatus: "active" } as Partial<NavigationThreadSummary>;

  function busyApi(overrides: Partial<DesktopApi> = {}): DesktopApi {
    return buildApi({
      readThread: vi.fn(async () => ({
        backend: "codex",
        threadId: "t-local",
        // A window that opens a thread mid-turn only learns the turn is
        // running from the hydrated snapshot, and it adopts one only when
        // the thread itself reports active.
        threadStatus: "active",
        replay: {
          entries: [
            {
              type: "message",
              id: "m-live",
              role: "assistant",
              text: "working on it",
              parts: [{ type: "text", text: "working on it" }],
              createdAt: 1,
              turn: { id: "turn-live", status: "in_progress" },
            },
          ],
          messages: [],
          pagination: { supportsPagination: false, hasPreviousPage: false },
        },
      })),
      steerTurn: vi.fn(async () => ({
        backend: "codex",
        threadId: "t-local",
        turnId: "turn-live",
        disposition: "steered" as const,
      })),
      ...overrides,
    } as unknown as Partial<DesktopApi>);
  }

  it("steers the running turn instead of starting a second one", async () => {
    const desktopApi = busyApi();
    renderCard({ desktopApi, thread: localThread(BUSY) });
    await screen.findByRole("button", { name: "Steer" });
    await typeAndSend("Local work", "also check the logs");

    await waitFor(() => {
      expect(desktopApi.steerTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          backend: "codex",
          expectedTurnId: "turn-live",
          input: [{ type: "text", text: "also check the logs" }],
          threadId: "t-local",
        }),
      );
    });
    expect(desktopApi.startTurn).not.toHaveBeenCalled();
    expect(
      await screen.findByText("Steered into the running turn."),
    ).toBeTruthy();
  });

  it("says so when the backend held the message for the next turn", async () => {
    const desktopApi = busyApi({
      steerTurn: vi.fn(async () => ({
        backend: "codex",
        threadId: "t-local",
        turnId: "turn-live",
        disposition: "queued",
      })),
    } as unknown as Partial<DesktopApi>);
    renderCard({ desktopApi, thread: localThread(BUSY) });
    await screen.findByRole("button", { name: "Steer" });
    await typeAndSend("Local work", "and then deploy");

    // Steered and queued are both accepted sends that land in different
    // places, and only the backend knows which happened.
    expect(await screen.findByText("Queued for the next turn.")).toBeTruthy();
  });

  it("gives the text back when the backend refuses to steer", async () => {
    const desktopApi = busyApi({
      steerTurn: vi.fn(async () => {
        throw new Error("Selected backend does not support turn/steer");
      }),
    } as unknown as Partial<DesktopApi>);
    renderCard({ desktopApi, thread: localThread(BUSY) });
    await screen.findByRole("button", { name: "Steer" });
    const input = await typeAndSend("Local work", "do not lose me");

    await waitFor(() => {
      expect(input.value).toBe("do not lose me");
    });
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /does not support turn\/steer/,
    );
    await waitFor(() => {
      expect(
        screen.queryByText("do not lose me", { ignore: IGNORE_COMPOSER }),
      ).toBeNull();
    });
  });

  it("keeps a peer's steer pointed at that peer", async () => {
    const desktopApi = busyApi();
    renderCard({ desktopApi, thread: remoteThread(BUSY) });
    await screen.findByRole("button", { name: "Steer" });
    await typeAndSend("Remote work", "over there");

    await waitFor(() => {
      expect(desktopApi.steerTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          federationTarget: { scope: "remote", instanceId: "pwr_peer" },
        }),
      );
    });
  });

  it("refuses to start a second turn before the running one is identified", async () => {
    // A thread reports busy from the navigation snapshot before any turn id
    // is hydrated — a peer's or a messaging adapter's turn does exactly
    // this. Starting a turn in that window is the second-turn-on-a-running-
    // thread the steer path exists to prevent.
    const desktopApi = busyApi({
      readThread: vi.fn(async () => ({
        backend: "codex",
        threadId: "t-local",
        replay: {
          entries: [],
          messages: [],
          pagination: { supportsPagination: false, hasPreviousPage: false },
        },
      })),
    } as unknown as Partial<DesktopApi>);
    renderCard({ desktopApi, thread: localThread(BUSY) });
    const input = await typeAndSend("Local work", "do not double-turn");

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Still identifying the running turn/,
    );
    expect(desktopApi.startTurn).not.toHaveBeenCalled();
    expect(desktopApi.steerTurn).not.toHaveBeenCalled();
    // Nothing reached the backend, so the operator keeps what they typed.
    await waitFor(() => {
      expect(input.value).toBe("do not double-turn");
    });
  });

  it("leaves the control live so that refusal is reachable", async () => {
    // Disabling here would hide the state behind a dead button the operator
    // can neither use nor understand.
    const desktopApi = busyApi({
      readThread: vi.fn(async () => ({
        backend: "codex",
        threadId: "t-local",
        replay: {
          entries: [],
          messages: [],
          pagination: { supportsPagination: false, hasPreviousPage: false },
        },
      })),
    } as unknown as Partial<DesktopApi>);
    renderCard({ desktopApi, thread: localThread(BUSY) });
    const steer = (await screen.findByRole("button", {
      name: "Steer",
    })) as HTMLButtonElement;
    const input = screen.getByRole("textbox", { name: "Message Local work" });
    fireEvent.change(input, { target: { value: "let me through" } });

    await waitFor(() => {
      expect(steer.disabled).toBe(false);
    });
  });

  it("drops the landing notice once that turn is over", async () => {
    // The notice describes a turn. Left alone it would sit on an idle card
    // for hours still claiming something is in flight.
    // The card has more than one agent-event subscriber (the thread
    // session and the lazy skill list), so the fake has to fan out rather
    // than remember the last listener to register.
    const listeners: Array<(event: unknown) => void> = [];
    const emit = (event: unknown): void => {
      for (const listener of listeners) listener(event);
    };
    const desktopApi = busyApi({
      onAgentEvent: vi.fn((listener: (event: unknown) => void) => {
        listeners.push(listener);
        return () => undefined;
      }),
    } as unknown as Partial<DesktopApi>);
    renderCard({ desktopApi, thread: localThread(BUSY) });
    await screen.findByRole("button", { name: "Steer" });
    await typeAndSend("Local work", "also check the logs");
    expect(
      await screen.findByText("Steered into the running turn."),
    ).toBeTruthy();

    act(() => {
      emit({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: { threadId: "t-local", turnId: "turn-live" },
        },
      });
    });

    await waitFor(() => {
      expect(screen.queryByText("Steered into the running turn.")).toBeNull();
    });
  });

  it("disables the control when the bridge cannot steer at all", async () => {
    const desktopApi = busyApi({ steerTurn: undefined });
    renderCard({ desktopApi, thread: localThread(BUSY) });
    const steer = (await screen.findByRole("button", {
      name: "Steer",
    })) as HTMLButtonElement;
    const input = screen.getByRole("textbox", { name: "Message Local work" });
    fireEvent.change(input, { target: { value: "no route for this" } });

    await waitFor(() => {
      expect(steer.disabled).toBe(true);
    });
  });
});

describe("StarMapChatCard mentions", () => {
  beforeEach(() => {
    // The directory/thread population is cached across cards on purpose;
    // that cache must not leak between specs.
    resetComposerMentionSourcesCache();
  });

  const SNAPSHOT = {
    directories: [
      {
        key: "d-app",
        kind: "repo",
        label: "app",
        latestUpdatedAt: 2,
        path: "/Users/dev/app",
      },
    ],
    threads: [
      localThread(),
      localThread({ id: "t-other", title: "Rewrite the parser" }),
    ],
  };

  function mentionApi(overrides: Partial<DesktopApi> = {}): DesktopApi {
    return buildApi({
      getNavigationSnapshot: vi.fn(async () => SNAPSHOT),
      listSkills: vi.fn(async () => ({
        backend: "codex",
        fetchedAt: 1,
        data: [
          {
            cwd: "/Users/dev/app",
            skills: [{ name: "deploy", path: "/skills/deploy.md" }],
          },
        ],
      })),
      ...overrides,
    } as unknown as Partial<DesktopApi>);
  }

  function composer() {
    return screen.getByRole("textbox", { name: "Message Local work" });
  }

  it("loads skills only once the operator types $", async () => {
    // A card the operator only reads must not pay for a skill list.
    const desktopApi = mentionApi();
    renderCard({ desktopApi, thread: localThread() });
    await screen.findByRole("button", { name: "Send" });
    expect(desktopApi.listSkills).not.toHaveBeenCalled();

    fireEvent.change(composer(), { target: { value: "run $dep" } });
    await waitFor(() => {
      expect(desktopApi.listSkills).toHaveBeenCalled();
    });
    expect(
      (await screen.findByRole("option")).textContent,
    ).toContain("$deploy");
  });

  it("offers tracked directories on @ and links them as markdown", async () => {
    const desktopApi = mentionApi();
    renderCard({ desktopApi, thread: localThread() });
    await screen.findByRole("button", { name: "Send" });
    expect(desktopApi.getNavigationSnapshot).not.toHaveBeenCalled();

    fireEvent.change(composer(), { target: { value: "check @ap" } });
    const option = await screen.findByRole("option");
    expect(option.textContent).toContain("app");

    fireEvent.click(option);
    fireEvent.keyDown(composer(), { key: "Enter" });
    await waitFor(() => {
      expect(desktopApi.startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          input: [
            { type: "text", text: "check [@app](/Users/dev/app)" },
          ],
        }),
      );
    });
  });

  it("settles a whole picker session on one snapshot fetch", async () => {
    // Load-bearing, and not only for caching: the sources memo changes
    // identity when the fetch lands, which re-runs the effect that asked
    // for it. Without the cache's staleness guard that is a fetch loop,
    // and it would run at typing speed rather than showing up as an error.
    const desktopApi = mentionApi();
    renderCard({ desktopApi, thread: localThread() });
    await screen.findByRole("button", { name: "Send" });

    for (const value of ["look in @", "look in @a", "look in @ap"]) {
      fireEvent.change(composer(), { target: { value } });
      await screen.findByRole("option");
    }
    expect(desktopApi.getNavigationSnapshot).toHaveBeenCalledTimes(1);
  });

  it("never offers the thread the card is already on", async () => {
    // On a bare `#` the current thread would otherwise take the first row,
    // and referencing it tells the agent nothing it does not have.
    const desktopApi = mentionApi();
    renderCard({ desktopApi, thread: localThread() });
    await screen.findByRole("button", { name: "Send" });

    fireEvent.change(composer(), { target: { value: "see #" } });
    const options = await screen.findAllByRole("option");
    const labels = options.map((option) => option.textContent ?? "");
    expect(labels.some((label) => label.includes("Rewrite the parser"))).toBe(
      true,
    );
    expect(labels.some((label) => label.includes("Local work"))).toBe(false);
  });

  it("keeps an open picker inside the card's gesture guards", async () => {
    // The popover renders in the card rather than through a body portal
    // precisely so these three selectors still cover it. A portalled list
    // would send arrow keys and wheel events straight to the camera.
    const desktopApi = mentionApi();
    renderCard({ desktopApi, thread: localThread() });
    await screen.findByRole("button", { name: "Send" });

    fireEvent.change(composer(), { target: { value: "check @ap" } });
    const option = await screen.findByRole("option");
    expect(option.closest(".star-map-chat-card")).not.toBeNull();
    expect(isStarMapTypingTarget(option)).toBe(true);
    expect(shouldPanOnWheel(option)).toBe(false);
    expect(shouldStartCanvasPan(option)).toBe(false);
  });
});

describe("StarMapChatCard settings menu", () => {
  beforeEach(() => {
    resetComposerMentionSourcesCache();
  });

  function settingsApi(overrides: Partial<DesktopApi> = {}): DesktopApi {
    return buildApi({
      listBackends: vi.fn(async () => ({
        fetchedAt: 1,
        backends: [
          {
            kind: "codex",
            label: "Codex",
            available: true,
            methods: [],
            capabilities: {},
            executionModes: [
              { mode: "default", label: "Default Access", available: true },
              { mode: "full-access", label: "Full Access", available: true },
            ],
            launchpadOptions: {
              models: [
                { id: "gpt-5-codex", supportsFast: true },
                { id: "gpt-5-spark", supportsFast: false },
              ],
              reasoningEfforts: ["low", "medium", "high"],
              supportsFastMode: true,
            },
          },
        ],
      })),
      setThreadExecutionMode: vi.fn(async () => ({})),
      setThreadModelSettings: vi.fn(async () => ({})),
      ...overrides,
    } as unknown as Partial<DesktopApi>);
  }

  async function openSettingsMenu() {
    fireEvent.click(
      await screen.findByRole("button", { name: /^Thread settings/ }),
    );
  }

  it("describes the backend once, on first open, with the card's target", async () => {
    const desktopApi = settingsApi();
    renderCard({ desktopApi, thread: remoteThread({ model: "gpt-5-codex" }) });
    await screen.findByRole("button", { name: "Send" });
    expect(desktopApi.listBackends).not.toHaveBeenCalled();

    await openSettingsMenu();
    await waitFor(() => {
      expect(desktopApi.listBackends).toHaveBeenCalledTimes(1);
    });
    expect(desktopApi.listBackends).toHaveBeenCalledWith({
      includeUnavailable: true,
      federationTarget: { scope: "remote", instanceId: "pwr_peer" },
    });

    // Reopening reuses the loaded options rather than describing again.
    fireEvent.keyDown(document, { key: "Escape" });
    await openSettingsMenu();
    expect(desktopApi.listBackends).toHaveBeenCalledTimes(1);
  });

  it("changes the model through the submenu, on the thread's own target", async () => {
    const desktopApi = settingsApi();
    renderCard({ desktopApi, thread: remoteThread({ model: "gpt-5-codex" }) });
    await openSettingsMenu();

    fireEvent.click(await screen.findByRole("menuitem", { name: /Model/ }));
    fireEvent.click(
      await screen.findByRole("menuitemradio", { name: "gpt-5-spark" }),
    );
    await waitFor(() => {
      expect(desktopApi.setThreadModelSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          backend: "codex",
          federationTarget: { scope: "remote", instanceId: "pwr_peer" },
          model: "gpt-5-spark",
          threadId: "t-remote",
        }),
      );
    });
  });

  it("switches access mode through the Access submenu", async () => {
    const desktopApi = settingsApi();
    renderCard({
      desktopApi,
      thread: localThread({ executionMode: "default", model: "gpt-5-codex" }),
    });
    await openSettingsMenu();

    fireEvent.click(await screen.findByRole("menuitem", { name: /Access/ }));
    fireEvent.click(
      await screen.findByRole("menuitemradio", { name: "Full Access" }),
    );
    await waitFor(() => {
      expect(desktopApi.setThreadExecutionMode).toHaveBeenCalledWith({
        backend: "codex",
        executionMode: "full-access",
        federationTarget: undefined,
        threadId: "t-local",
      });
    });
  });

  it("hides Access when the backend describes only one available mode", async () => {
    // The ACP shape: the registry describes no full-access mode, and
    // setThreadExecutionMode would be an acknowledged no-op — so the menu
    // must not offer a working-looking Full Access row.
    const desktopApi = settingsApi({
      listBackends: vi.fn(async () => ({
        fetchedAt: 1,
        backends: [
          {
            kind: "codex",
            label: "Codex",
            available: true,
            methods: [],
            capabilities: {},
            executionModes: [
              { mode: "default", label: "Default Access", available: true },
              { mode: "full-access", label: "Full Access", available: false },
            ],
            launchpadOptions: {
              models: [{ id: "gpt-5-codex", supportsFast: true }],
              reasoningEfforts: ["low", "high"],
              supportsFastMode: true,
            },
          },
        ],
      })),
    } as unknown as Partial<DesktopApi>);
    renderCard({ desktopApi, thread: localThread({ model: "gpt-5-codex" }) });
    await openSettingsMenu();

    // The fast toggle only renders once the describe landed, so its
    // presence proves Access's absence is a decision, not a race.
    await screen.findByRole("menuitemcheckbox", { name: "Fast mode" });
    expect(screen.queryByRole("menuitem", { name: /Access/ })).toBeNull();
  });

  it("toggles fast mode for a model that supports it", async () => {
    const desktopApi = settingsApi();
    renderCard({
      desktopApi,
      thread: localThread({ fastMode: false, model: "gpt-5-codex" }),
    });
    await openSettingsMenu();

    fireEvent.click(
      await screen.findByRole("menuitemcheckbox", { name: "Fast mode" }),
    );
    await waitFor(() => {
      expect(desktopApi.setThreadModelSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          backend: "codex",
          fastMode: true,
          model: "gpt-5-codex",
          threadId: "t-local",
        }),
      );
    });
  });
});
