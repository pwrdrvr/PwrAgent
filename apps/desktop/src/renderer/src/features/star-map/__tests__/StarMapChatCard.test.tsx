import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentEvent,
  BackendCapabilities,
  CelestialIconId,
  DesktopSettingsSnapshot,
  NavigationThreadSummary,
  NavigationQueryRequest,
  NavigationQueryPage,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { normalizeImageFile } from "../../../lib/image-normalization";
import { StarMapChatCard } from "../StarMapChatCard";
import {
  useComposerDraftStore,
  type ComposerDraftStore,
} from "../../composer/useComposerDraftStore";
import { resetComposerMentionSourcesCache } from "../../composer/useComposerMentionSources";
import { resetFullAccessRiskWarningCache } from "../../../lib/useExecutionModeSelection";
import { isStarMapTypingTarget } from "../star-map-keyboard";
import { shouldPanOnWheel, shouldStartCanvasPan } from "../star-map-orbit";
import {
  DEFAULT_INITIAL_THREAD_HISTORY_TURN_LIMIT,
  DEFAULT_RENDERED_TRANSCRIPT_ENTRY_LIMIT,
} from "../../../lib/thread-history-limits";

vi.mock("../../../lib/image-normalization", () => ({
  normalizeImageFile: vi.fn(async (file: File) => ({
    conversionPath: "renderer" as const,
    dataUrl: "data:image/png;base64,c3Rhci1tYXA=",
    height: 24,
    mimeType: "image/png" as const,
    original: {
      height: 24,
      mimeType: file.type,
      name: file.name,
      size: file.size,
      width: 32,
    },
    size: file.size,
    width: 32,
  })),
}));

const RECT = { left: 40, top: 40, width: 420, height: 520 };

function deferred<T>(): {
  promise: Promise<T>;
  reject: (reason: unknown) => void;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

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

const fixtureThreads = new WeakMap<DesktopApi, Map<string, NavigationThreadSummary>>();

function buildApi(overrides: Partial<DesktopApi> = {}): DesktopApi {
  const api = {
    getNavigationSelectedDetail: vi.fn(async (request: Parameters<NonNullable<DesktopApi["getNavigationSelectedDetail"]>>[0]) => ({
      protocol: 2, ref: request.ref, revision: "detail", identity: "present", readiness: "ready",
      thread: fixtureThreads.get(api)?.get(JSON.stringify([request.ref.backend, request.ref.threadId])) ?? remoteThread({ id: request.ref.threadId, source: request.ref.backend }),
    })),
    getNavigationQueueProjection: vi.fn(async (request: Parameters<NonNullable<DesktopApi["getNavigationQueueProjection"]>>[0]) => ({
      protocol: 2, ref: request.ref, revision: "fifo", readiness: "ready", complete: true, entries: [],
    })),
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
  return api;
}

function reviewCapabilities(startReview: boolean): BackendCapabilities {
  return {
    approvalRequests: true,
    createThread: true,
    interruptTurn: true,
    listThreads: true,
    multiDirectoryThreads: true,
    readThread: true,
    renameThread: true,
    resumeThread: true,
    startReview,
    startTurn: true,
    steerTurn: false,
    toolUse: true,
    transcriptPagination: false,
  };
}

function reviewCapableApi(
  backend: "codex" | "acp:grok",
  overrides: Partial<DesktopApi> = {},
): DesktopApi {
  return buildApi({
    ...(backend.startsWith("acp:")
      ? {
          listBackends: vi.fn(async () => ({
            fetchedAt: 1,
            backends: [
              {
                available: true,
                capabilities: reviewCapabilities(true),
                executionModes: [],
                kind: backend,
                label: "Grok",
                methods: [],
              },
            ],
          })),
        }
      : {}),
    ...overrides,
  });
}

type CardParams = {
  composerDraftStore?: ComposerDraftStore;
  desktopApi: DesktopApi;
  instanceIcon?: string;
  instanceLabel?: string;
  onUserRepliedToThread?: (
    thread: NavigationThreadSummary,
  ) => void | Promise<void>;
  pastedImageMaxPatches?: number;
  thread: NavigationThreadSummary;
};

function card(params: CardParams) {
  if (params.desktopApi) {
    const rows = fixtureThreads.get(params.desktopApi) ?? new Map<string, NavigationThreadSummary>();
    rows.set(JSON.stringify([params.thread.source, params.thread.id]), params.thread);
    fixtureThreads.set(params.desktopApi, rows);
  }
  return (
    <StarMapChatCard
      cardKey="card-1"
      composerDraftStore={params.composerDraftStore}
      desktopApi={params.desktopApi}
      /* Cast the VALUE, not the prop: the unknown-id case needs to pass
         an id this build does not know, but the prop's own type must stay
         checked so a future change to it still fails here. */
      instanceIcon={params.instanceIcon as CelestialIconId | undefined}
      instanceLabel={params.instanceLabel}
      onClose={() => undefined}
      onOpenFull={() => undefined}
      onUserRepliedToThread={params.onUserRepliedToThread}
      onRaise={() => undefined}
      onRectChange={() => undefined}
      pastedImageMaxPatches={params.pastedImageMaxPatches}
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
async function findReadyTextbox(options: { name: string | RegExp }) {
  const element = await screen.findByRole("textbox", options);
  await waitFor(() => expect(element.getAttribute("contenteditable")).toBe("true"));
  return element;
}

async function typeAndSend(title: string, text: string) {
  const input = await findReadyTextbox( { name: `Message ${title}` });
  await waitFor(() => expect(input.getAttribute("contenteditable")).toBe("true"));
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: "Enter" });
  return input as HTMLElement & { value: string };
}

function transferImage(
  input: HTMLElement,
  file: File,
  event: "drop" | "paste",
): void {
  const transfer = {
    files: [file],
    getData: () => "",
    items: [
      {
        getAsFile: () => file,
        kind: "file",
        type: file.type,
      },
    ],
    types: ["Files"],
  };
  if (event === "paste") {
    fireEvent.paste(input, { clipboardData: transfer });
  } else {
    fireEvent.drop(input, { dataTransfer: transfer });
  }
}

/**
 * Text queries match the composer's own content, so a draft would satisfy a
 * "this reached the transcript" assertion on its own.
 */
const IGNORE_COMPOSER = ".composer-tiptap-input, .composer-tiptap-input *";

describe("StarMapChatCard gesture persistence", () => {
  it("raises in memory and commits once when dragging a non-top card", () => {
    const onRaise = vi.fn(() => true);
    const onRectChange = vi.fn();
    const onRectCommit = vi.fn();
    const { container } = render(
      <StarMapChatCard
        cardKey="card-1"
        desktopApi={buildApi()}
        onClose={() => undefined}
        onOpenFull={() => undefined}
        onRaise={onRaise}
        onRectChange={onRectChange}
        onRectCommit={onRectCommit}
        rect={RECT}
        thread={localThread()}
        scale={1}
        bounds={{ width: 4000, height: 3000 }}
        onToggleContext={() => undefined}
        onToggleTerminal={() => undefined}
        zIndex={40}
      />,
    );
    const header = container.querySelector(".star-map-chat-card__bar");
    expect(header).not.toBeNull();

    fireEvent.pointerDown(header as Element, {
      button: 0,
      clientX: 100,
      clientY: 100,
      pointerId: 1,
    });
    fireEvent.pointerMove(header as Element, {
      clientX: 125,
      clientY: 120,
      pointerId: 1,
    });
    fireEvent.pointerUp(header as Element, {
      clientX: 125,
      clientY: 120,
      pointerId: 1,
    });

    expect(onRaise).toHaveBeenCalledTimes(1);
    expect(onRaise).toHaveBeenCalledWith("card-1", false);
    expect(onRectChange).toHaveBeenCalledTimes(1);
    expect(onRectCommit).toHaveBeenCalledTimes(1);
  });
});

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

describe("StarMapChatCard sub-agents", () => {
  it("surfaces a running monitor above the compact composer", () => {
    const desktopApi = buildApi();
    renderCard({
      desktopApi,
      thread: localThread({
        subAgents: [
          {
            monitorId: "monitor-1",
            task: "Watch the production rollout",
            status: "running",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            backend: "codex",
            monitorThreadId: "monitor-thread",
            monitorTurnId: "monitor-turn",
          },
        ],
      }),
    });

    const strip = screen.getByRole("region", { name: "Active sub-agents" });
    expect(strip.textContent).toContain("Watch the production rollout");
    expect(strip.compareDocumentPosition(screen.getByRole("textbox")))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("stops a remote monitor on its owning instance", async () => {
    const stopSubAgent = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "t-remote",
      monitorId: "monitor-remote",
      stoppedAt: Date.now(),
    }));
    const desktopApi = buildApi({ stopSubAgent });
    renderCard({
      desktopApi,
      thread: remoteThread({
        subAgents: [
          {
            monitorId: "monitor-remote",
            task: "Watch the peer rollout",
            status: "running",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            backend: "codex",
            monitorThreadId: "monitor-thread",
            monitorTurnId: "monitor-turn",
          },
        ],
      }),
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Stop sub-agent: Watch the peer rollout",
      }),
    );

    await waitFor(() => {
      expect(stopSubAgent).toHaveBeenCalledWith({
        backend: "codex",
        federationTarget: { scope: "remote", instanceId: "pwr_peer" },
        threadId: "t-remote",
        monitorId: "monitor-remote",
      });
    });
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
    const onUserRepliedToThread = vi.fn();
    const thread = remoteThread({
      inbox: { inInbox: true, reason: "updated-since-seen" },
    });
    renderCard({ desktopApi, onUserRepliedToThread, thread });
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
    expect(onUserRepliedToThread).toHaveBeenCalledWith(thread);
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

  it("pastes a PNG into the outgoing turn", async () => {
    const desktopApi = buildApi();
    renderCard({ desktopApi, thread: localThread() });
    const input = await findReadyTextbox( { name: "Message Local work" });
    const image = new File(["star-map"], "star-map.png", {
      type: "image/png",
    });

    fireEvent.paste(input, {
      clipboardData: {
        files: [image],
        getData: () => "",
        items: [
          {
            getAsFile: () => image,
            kind: "file",
            type: "image/png",
          },
        ],
        types: ["Files"],
      },
    });
    await screen.findByRole("img", { name: "star-map.png" });
    fireEvent.change(input, { target: { value: "What is wrong here?" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(desktopApi.startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          input: [
            { type: "text", text: "What is wrong here?" },
            {
              type: "image",
              name: "star-map.png",
              url: "data:image/png;base64,c3Rhci1tYXA=",
            },
          ],
        }),
      );
    });
  });

  it("keeps image paste enabled for a remote thread with no negative capability", async () => {
    const desktopApi = buildApi();
    renderCard({ desktopApi, thread: remoteThread() });
    const input = await findReadyTextbox( { name: "Message Remote work" });
    const image = new File(["remote"], "remote.png", {
      type: "image/png",
    });

    transferImage(input, image, "paste");
    await screen.findByRole("img", { name: "remote.png" });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(desktopApi.startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          federationTarget: { scope: "remote", instanceId: "pwr_peer" },
          input: [
            {
              type: "image",
              name: "remote.png",
              url: "data:image/png;base64,c3Rhci1tYXA=",
            },
          ],
        }),
      );
    });
  });

  it("rejects images for a Codex model that reports supportsImage false", async () => {
    vi.mocked(normalizeImageFile).mockClear();
    const desktopApi = buildApi({
      listBackends: vi.fn(async () => ({
        fetchedAt: 1,
        backends: [
          {
            available: true,
            capabilities: reviewCapabilities(false),
            executionModes: [],
            kind: "codex" as const,
            label: "Codex",
            launchpadOptions: {
              models: [
                {
                  id: "gpt-5.3-codex-spark",
                  label: "GPT-5.3-Codex-Spark",
                  supportsImage: false,
                },
              ],
            },
            methods: [],
          },
        ],
      })),
    });
    renderCard({
      desktopApi,
      thread: localThread({ model: "gpt-5.3-codex-spark" }),
    });
    await waitFor(() => expect(desktopApi.listBackends).toHaveBeenCalled());
    const input = await findReadyTextbox( { name: "Message Local work" });
    const image = new File(["spark"], "spark.png", { type: "image/png" });

    transferImage(input, image, "paste");

    expect((await screen.findByRole("alert")).textContent).toContain(
      "GPT-5.3-Codex-Spark doesn't support image attachments.",
    );
    expect(normalizeImageFile).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Pasted images")).toBeNull();
  });

  it("rejects images when an ACP runtime reports prompt.image false", async () => {
    vi.mocked(normalizeImageFile).mockClear();
    const desktopApi = buildApi({
      listBackends: vi.fn(async () => ({
        fetchedAt: 1,
        backends: [
          {
            acp: {
              registryId: "grok",
              distributionKinds: ["binary" as const],
              installStatus: "installed" as const,
              authStatus: "authenticated" as const,
              verificationStatus: "verified" as const,
              runtime: {
                schemaVersion: 1 as const,
                status: "discovered" as const,
                agentCapabilities: { prompt: { image: false } },
              },
            },
            available: true,
            capabilities: reviewCapabilities(false),
            executionModes: [],
            kind: "acp:grok" as const,
            label: "Grok",
            methods: [],
          },
        ],
      })),
    });
    renderCard({
      desktopApi,
      thread: localThread({ source: "acp:grok", model: "grok-4" }),
    });
    await waitFor(() => expect(desktopApi.listBackends).toHaveBeenCalled());
    const input = await findReadyTextbox( { name: "Message Local work" });
    const image = new File(["grok"], "grok.png", { type: "image/png" });

    transferImage(input, image, "drop");

    expect((await screen.findByRole("alert")).textContent).toContain(
      "grok-4 doesn't support image attachments.",
    );
    expect(normalizeImageFile).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Pasted images")).toBeNull();
  });

  it("uses the configured image patch budget when normalizing", async () => {
    vi.mocked(normalizeImageFile).mockClear();
    const desktopApi = buildApi();
    renderCard({
      desktopApi,
      pastedImageMaxPatches: 321,
      thread: localThread(),
    });
    const input = await findReadyTextbox( { name: "Message Local work" });
    const image = new File(["star-map"], "star-map.png", {
      type: "image/png",
    });

    fireEvent.paste(input, {
      clipboardData: {
        files: [image],
        getData: () => "",
        items: [
          {
            getAsFile: () => image,
            kind: "file",
            type: "image/png",
          },
        ],
        types: ["Files"],
      },
    });

    await screen.findByRole("img", { name: "star-map.png" });
    expect(normalizeImageFile).toHaveBeenCalledWith(
      image,
      expect.objectContaining({ maxPatchCount: 321 }),
    );
  });

  it("preserves an animated GIF instead of normalizing it", async () => {
    const desktopApi = buildApi();
    renderCard({ desktopApi, thread: localThread() });
    const input = await findReadyTextbox( { name: "Message Local work" });
    const image = new File(["GIF89a"], "animated.gif", {
      type: "image/gif",
    });

    fireEvent.paste(input, {
      clipboardData: {
        files: [image],
        getData: () => "",
        items: [
          {
            getAsFile: () => image,
            kind: "file",
            type: "image/gif",
          },
        ],
        types: ["Files"],
      },
    });
    await screen.findByRole("img", { name: "animated.gif" });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(desktopApi.startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          input: [
            {
              type: "image",
              name: "animated.gif",
              url: "data:image/gif;base64,R0lGODlh",
            },
          ],
        }),
      );
    });
  });

  it("sends a pasted PDF through the existing local-file turn path", async () => {
    const desktopApi = buildApi({
      getPathForFile: vi.fn(() => "/tmp/brief.pdf"),
    });
    renderCard({ desktopApi, thread: localThread() });
    const input = await findReadyTextbox( { name: "Message Local work" });
    const pdf = new File(["%PDF-1.7"], "brief.pdf", {
      type: "application/pdf",
    });

    fireEvent.paste(input, {
      clipboardData: {
        files: [pdf],
        getData: () => "",
        items: [
          {
            getAsFile: () => pdf,
            kind: "file",
            type: "application/pdf",
          },
        ],
        types: ["Files"],
      },
    });
    expect(await screen.findByText("brief.pdf")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(desktopApi.startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          input: [
            {
              type: "text",
              text: "[@brief.pdf](/tmp/brief.pdf)",
            },
            {
              name: "brief.pdf",
              path: "/tmp/brief.pdf",
              type: "localFile",
            },
          ],
        }),
      );
    });
  });

  it("does not attach a local PDF to a remote thread", async () => {
    const getPathForFile = vi.fn(() => "/tmp/brief.pdf");
    const desktopApi = buildApi({ getPathForFile });
    renderCard({ desktopApi, thread: remoteThread() });
    const input = await findReadyTextbox( { name: "Message Remote work" });
    const pdf = new File(["%PDF-1.7"], "brief.pdf", {
      type: "application/pdf",
    });

    fireEvent.paste(input, {
      clipboardData: {
        files: [pdf],
        getData: () => "",
        items: [
          {
            getAsFile: () => pdf,
            kind: "file",
            type: "application/pdf",
          },
        ],
        types: ["Files"],
      },
    });

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /another instance/,
    );
    expect(getPathForFile).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Attached files")).toBeNull();
  });
});

describe("StarMapChatCard slash commands", () => {
  it.each([
    ["Codex", "codex", "compact"],
    ["ACP", "acp:grok", "session-info"],
  ] as const)("loads and offers %s provider commands", async (
    _provider,
    backend,
    command,
  ) => {
    const listSkills = vi.fn(async () => ({
      backend,
      fetchedAt: 1,
      data: [
        {
          commands: [
            {
              name: command,
              description: `Run ${command}`,
              backend,
              scope: "session" as const,
              source: "provider" as const,
            },
          ],
          skills: [],
        },
      ],
    }));
    const desktopApi = buildApi({ listSkills });
    const thread = localThread({ source: backend });
    renderCard({ desktopApi, thread });

    fireEvent.change(
      screen.getByRole("textbox", { name: "Message Local work" }),
      { target: { value: `/${command.slice(0, 3)}` } },
    );

    await waitFor(() => {
      expect(listSkills).toHaveBeenCalledWith(
        expect.objectContaining({ backend, threadId: "t-local" }),
      );
    });
    expect(
      await screen.findByRole("option", { name: new RegExp(`/${command}`, "i") }),
    ).toBeTruthy();
  });

  it("does not offer or intercept review for an unsupported ACP backend", async () => {
    const startReview = vi.fn();
    const startTurn = vi.fn(async () => ({
      backend: "acp:grok" as const,
      threadId: "t-local",
      turnId: "turn-acp-1",
    }));
    const desktopApi = buildApi({
      listBackends: vi.fn(async () => ({
        fetchedAt: 1,
        backends: [
          {
            available: true,
            capabilities: reviewCapabilities(false),
            executionModes: [],
            kind: "acp:grok" as const,
            label: "Grok",
            methods: [],
          },
        ],
      })),
      startReview,
      startTurn,
    });
    renderCard({
      desktopApi,
      thread: localThread({ source: "acp:grok" }),
    });
    await waitFor(() => {
      expect(desktopApi.listBackends).toHaveBeenCalled();
    });
    const input = await findReadyTextbox( { name: "Message Local work" });
    fireEvent.change(input, { target: { value: "/" } });
    expect(screen.queryByRole("option", { name: /\/review/i })).toBeNull();

    fireEvent.change(input, { target: { value: "/review" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          backend: "acp:grok",
          input: [{ type: "text", text: "/review" }],
        }),
      );
    });
    expect(startReview).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps an attached image when /review is rejected", async () => {
    const startReview = vi.fn();
    const desktopApi = buildApi({ startReview });
    renderCard({ desktopApi, thread: localThread() });
    const input = await findReadyTextbox( { name: "Message Local work" });
    const image = new File(["star-map"], "review.png", {
      type: "image/png",
    });

    fireEvent.paste(input, {
      clipboardData: {
        files: [image],
        getData: () => "",
        items: [
          {
            getAsFile: () => image,
            kind: "file",
            type: "image/png",
          },
        ],
        types: ["Files"],
      },
    });
    await screen.findByRole("img", { name: "review.png" });
    fireEvent.change(input, { target: { value: "/" } });
    expect(screen.queryByRole("option", { name: /\/review/i })).toBeNull();
    fireEvent.change(input, { target: { value: "/review" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /\/review does not accept attachments/i,
    );
    expect(screen.getByRole("img", { name: "review.png" })).toBeTruthy();
    expect(startReview).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each(["codex", "acp:grok"] as const)(
    "opens the review setup on the first Enter for %s",
    async (backend) => {
      const startReview = vi.fn(async () => ({
        backend,
        threadId: "t-local",
        reviewThreadId: "review-1",
        turnId: "turn-review-1",
      }));
      const desktopApi = reviewCapableApi(backend, { startReview });
      renderCard({
        desktopApi,
        thread: localThread({ source: backend }),
      });
      const input = await findReadyTextbox( {
        name: "Message Local work",
      });
      if (backend.startsWith("acp:")) {
        fireEvent.change(input, { target: { value: "/" } });
        await screen.findByRole("option", { name: /\/review/i });
      }
      fireEvent.change(input, { target: { value: "/review" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(
        await screen.findByRole("dialog", {
          name: "Start review for Local work",
        }),
      ).toBeTruthy();
      expect(input.getAttribute("contenteditable")).toBe("false");
      expect(startReview).not.toHaveBeenCalled();
      expect(desktopApi.startTurn).not.toHaveBeenCalled();
    },
  );

  it.each(["codex", "acp:grok"] as const)(
    "opens highlighted /review from a bare slash on the first Enter for %s",
    async (backend) => {
      const desktopApi = reviewCapableApi(backend, {
        startReview: vi.fn(),
      });
      renderCard({
        desktopApi,
        thread: localThread({ source: backend }),
      });
      const input = await findReadyTextbox( {
        name: "Message Local work",
      });
      fireEvent.change(input, { target: { value: "/" } });
      expect(
        (await screen.findByRole("option", { name: /\/review/i })).getAttribute(
          "aria-selected",
        ),
      ).toBe("true");

      fireEvent.keyDown(input, { key: "Enter" });

      expect(
        await screen.findByRole("dialog", {
          name: "Start review for Local work",
        }),
      ).toBeTruthy();
      expect(desktopApi.startReview).not.toHaveBeenCalled();
      expect(desktopApi.startTurn).not.toHaveBeenCalled();
    },
  );

  it.each(["codex", "acp:grok"] as const)(
    "submits the configured review through the %s review API",
    async (backend) => {
      const startReview = vi.fn(async () => ({
        backend,
        threadId: "t-local",
        reviewThreadId: "review-1",
        turnId: "turn-review-1",
      }));
      const desktopApi = reviewCapableApi(backend, { startReview });
      const onUserRepliedToThread = vi.fn();
      renderCard({
        desktopApi,
        onUserRepliedToThread,
        thread: localThread({ source: backend }),
      });
      const input = await findReadyTextbox( {
        name: "Message Local work",
      });
      if (backend.startsWith("acp:")) {
        fireEvent.change(input, { target: { value: "/" } });
        await screen.findByRole("option", { name: /\/review/i });
      }
      fireEvent.change(input, { target: { value: "/review" } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      const dialog = await screen.findByRole("dialog", {
        name: "Start review for Local work",
      });
      fireEvent.click(
        within(dialog).getByRole("button", { name: /Current changes/ }),
      );
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Start review" }),
      );

      await waitFor(() => {
        expect(startReview).toHaveBeenCalledWith({
          backend,
          threadId: "t-local",
          target: { type: "uncommittedChanges" },
          delivery: "inline",
        });
      });
      await waitFor(() => {
        expect(
          screen.queryByRole("dialog", {
            name: "Start review for Local work",
          }),
        ).toBeNull();
      });
      expect(onUserRepliedToThread).not.toHaveBeenCalled();
    },
  );

  it("locks only the chat card that owns the review setup", async () => {
    const firstApi = buildApi({ startReview: vi.fn() });
    const secondApi = buildApi();
    render(
      <>
        {card({ desktopApi: firstApi, thread: localThread() })}
        <StarMapChatCard
          cardKey="card-2"
          desktopApi={secondApi}
          onClose={() => undefined}
          onOpenFull={() => undefined}
          onRaise={() => undefined}
          onRectChange={() => undefined}
          rect={{ ...RECT, left: 500 }}
          thread={localThread({ id: "t-second", title: "Other work" })}
          scale={1}
          bounds={{ width: 4000, height: 3000 }}
          onToggleContext={() => undefined}
          onToggleTerminal={() => undefined}
          zIndex={41}
        />
      </>,
    );
    const firstInput = await findReadyTextbox( {
      name: "Message Local work",
    });
    const secondInput = await findReadyTextbox( {
      name: "Message Other work",
    });
    fireEvent.change(firstInput, { target: { value: "/review" } });
    fireEvent.keyDown(firstInput, { key: "Enter" });
    await screen.findByRole("dialog", { name: "Start review for Local work" });

    expect(firstInput.getAttribute("contenteditable")).toBe("false");
    expect(secondInput.getAttribute("contenteditable")).toBe("true");
    fireEvent.change(secondInput, { target: { value: "still interactive" } });
    fireEvent.keyDown(secondInput, { key: "Enter" });
    await waitFor(() => {
      expect(secondApi.startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "t-second",
          input: [{ type: "text", text: "still interactive" }],
        }),
      );
    });
  });

  it("cancels the review setup and re-enables its composer", async () => {
    const desktopApi = buildApi({ startReview: vi.fn() });
    renderCard({ desktopApi, thread: localThread() });
    const input = await findReadyTextbox( { name: "Message Local work" });
    fireEvent.change(input, { target: { value: "/review" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const dialog = await screen.findByRole("dialog", {
      name: "Start review for Local work",
    });
    // Tiptap can emit its pre-disable document once more while editability
    // synchronizes. Cancel must still leave the same clean composer state as
    // the main window, not resurrect the command and its autocomplete.
    fireEvent.change(input, { target: { value: "/review" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Start review for Local work" }),
      ).toBeNull();
    });
    const restoredInput = screen.getByRole("textbox", {
      name: "Message Local work",
    }) as HTMLElement & { value: string };
    expect(restoredInput.getAttribute("contenteditable")).toBe("true");
    expect(restoredInput.value).toBe("");
    expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
    expect(desktopApi.startReview).not.toHaveBeenCalled();
  });

  it("cancels review setup on Escape even if the disabled editor kept focus", async () => {
    const desktopApi = buildApi({ startReview: vi.fn() });
    renderCard({ desktopApi, thread: localThread() });
    const input = await findReadyTextbox( { name: "Message Local work" });
    fireEvent.change(input, { target: { value: "/review" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByRole("dialog", { name: "Start review for Local work" });

    fireEvent.keyDown(input, { key: "Escape" });

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Start review for Local work" }),
      ).toBeNull();
    });
    const restoredInput = screen.getByRole("textbox", {
      name: "Message Local work",
    }) as HTMLElement & { value: string };
    expect(restoredInput.value).toBe("");
    expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
    expect(desktopApi.startReview).not.toHaveBeenCalled();
  });

  it("starts the selected review on Enter even if the disabled editor kept focus", async () => {
    const startReview = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "t-local",
      reviewThreadId: "review-1",
      turnId: "turn-review-1",
    }));
    const desktopApi = buildApi({ startReview });
    renderCard({ desktopApi, thread: localThread() });
    const input = await findReadyTextbox( { name: "Message Local work" });
    fireEvent.change(input, { target: { value: "/review" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByRole("dialog", { name: "Start review for Local work" });

    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(startReview).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "t-local",
        target: { type: "baseBranch", branch: "main" },
        delivery: "inline",
      });
    });
    expect(
      screen.queryByRole("dialog", { name: "Start review for Local work" }),
    ).toBeNull();
  });

  it("starts the focused review target on Enter", async () => {
    const startReview = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "t-local",
      reviewThreadId: "review-1",
      turnId: "turn-review-1",
    }));
    const desktopApi = buildApi({ startReview });
    renderCard({ desktopApi, thread: localThread() });
    const input = await findReadyTextbox( { name: "Message Local work" });
    fireEvent.change(input, { target: { value: "/review" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const dialog = await screen.findByRole("dialog", {
      name: "Start review for Local work",
    });

    fireEvent.keyDown(
      within(dialog).getByRole("button", { name: /Current changes/ }),
      { key: "Enter" },
    );

    await waitFor(() => {
      expect(startReview).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "t-local",
        target: { type: "uncommittedChanges" },
        delivery: "inline",
      });
    });
    expect(
      screen.queryByRole("dialog", { name: "Start review for Local work" }),
    ).toBeNull();
  });

  it("closes review setup as soon as Start review is accepted", async () => {
    let resolveStart: (() => void) | undefined;
    const startReview = vi.fn(
      () => new Promise<never>((resolve) => {
        resolveStart = () => resolve(undefined as never);
      }),
    );
    const desktopApi = buildApi({ startReview });
    renderCard({ desktopApi, thread: localThread() });
    const input = await findReadyTextbox( { name: "Message Local work" });
    fireEvent.change(input, { target: { value: "/review" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const dialog = await screen.findByRole("dialog", {
      name: "Start review for Local work",
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: /Current changes/ }),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Start review" }),
    );

    expect(startReview).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("dialog", { name: "Start review for Local work" }),
    ).toBeNull();
    resolveStart?.();
  });

  it("closes review setup without disabling the card's terminal control", async () => {
    const onToggleTerminal = vi.fn();
    const desktopApi = buildApi({ startReview: vi.fn() });
    render(
      <StarMapChatCard
        cardKey="card-1"
        desktopApi={desktopApi}
        onClose={() => undefined}
        onOpenFull={() => undefined}
        onRaise={() => undefined}
        onRectChange={() => undefined}
        rect={RECT}
        thread={localThread()}
        scale={1}
        bounds={{ width: 4000, height: 3000 }}
        onToggleContext={() => undefined}
        onToggleTerminal={onToggleTerminal}
        zIndex={40}
      />,
    );
    const input = await findReadyTextbox( { name: "Message Local work" });
    fireEvent.change(input, { target: { value: "/review" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const dialog = await screen.findByRole("dialog", {
      name: "Start review for Local work",
    });

    fireEvent.click(screen.getByRole("button", { name: /Open terminal/ }));
    expect(onToggleTerminal).toHaveBeenCalledWith("card-1");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Close review setup" }),
    );
    expect(
      screen.queryByRole("dialog", { name: "Start review for Local work" }),
    ).toBeNull();
    expect(
      screen
        .getByRole("textbox", { name: "Message Local work" })
        .getAttribute("contenteditable"),
    ).toBe("true");
  });

  it.each([false, true])(
    "routes Codex /compact on the first Enter with provider commands loaded=%s",
    async (commandsLoaded) => {
      const compactThread = vi.fn(async () => ({
        backend: "codex" as const,
        threadId: "t-local",
        turnId: "turn-compact-1",
      }));
      const desktopApi = buildApi({
        compactThread,
        ...(commandsLoaded
          ? {
              listSkills: vi.fn(async () => ({
                backend: "codex" as const,
                fetchedAt: 1,
                data: [
                  {
                    commands: [
                      {
                        backend: "codex" as const,
                        description: "Compact the thread",
                        name: "compact",
                        scope: "session" as const,
                        source: "provider" as const,
                      },
                    ],
                    skills: [],
                  },
                ],
              })),
            }
          : {}),
      });
      const onUserRepliedToThread = vi.fn();
      renderCard({
        desktopApi,
        onUserRepliedToThread,
        thread: localThread(),
      });
      const input = await findReadyTextbox( {
        name: "Message Local work",
      });
      fireEvent.change(input, { target: { value: "/compact" } });
      if (commandsLoaded) {
        await screen.findByRole("option", { name: /\/compact/i });
      }
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => {
        expect(compactThread).toHaveBeenCalledWith({
          backend: "codex",
          threadId: "t-local",
        });
      });
      expect(desktopApi.startTurn).not.toHaveBeenCalled();
      expect(onUserRepliedToThread).not.toHaveBeenCalled();
    },
  );

  it("keeps an attached file when /compact is rejected", async () => {
    const compactThread = vi.fn();
    const desktopApi = buildApi({
      compactThread,
      getPathForFile: vi.fn(() => "/tmp/brief.pdf"),
      listSkills: vi.fn(async () => ({
        backend: "codex" as const,
        fetchedAt: 1,
        data: [
          {
            commands: [
              {
                backend: "codex" as const,
                description: "Compact the thread",
                name: "compact",
                scope: "session" as const,
                source: "provider" as const,
              },
            ],
            skills: [],
          },
        ],
      })),
    });
    renderCard({ desktopApi, thread: localThread() });
    const input = await findReadyTextbox( { name: "Message Local work" });
    const pdf = new File(["%PDF-1.7"], "brief.pdf", {
      type: "application/pdf",
    });

    fireEvent.paste(input, {
      clipboardData: {
        files: [pdf],
        getData: () => "",
        items: [
          {
            getAsFile: () => pdf,
            kind: "file",
            type: "application/pdf",
          },
        ],
        types: ["Files"],
      },
    });
    expect(await screen.findByText("brief.pdf")).toBeTruthy();
    fireEvent.change(input, { target: { value: "/" } });
    await waitFor(() => {
      expect(desktopApi.listSkills).toHaveBeenCalled();
    });
    expect(screen.queryByRole("option", { name: /\/compact/i })).toBeNull();
    fireEvent.change(input, { target: { value: "/compact" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /\/compact does not accept attachments/i,
    );
    expect(screen.getByText("brief.pdf")).toBeTruthy();
    expect(compactThread).not.toHaveBeenCalled();
  });

  it("keeps ACP provider commands available with attachments", async () => {
    const startTurn = vi.fn(async () => ({
      backend: "acp:grok" as const,
      threadId: "t-local",
      turnId: "turn-acp-1",
    }));
    const desktopApi = buildApi({
      listSkills: vi.fn(async () => ({
        backend: "acp:grok" as const,
        fetchedAt: 1,
        data: [
          {
            commands: [
              {
                backend: "acp:grok" as const,
                description: "Show session details",
                name: "session-info",
                scope: "session" as const,
                source: "provider" as const,
              },
            ],
            skills: [],
          },
        ],
      })),
      startTurn,
    });
    renderCard({
      desktopApi,
      thread: localThread({ source: "acp:grok" }),
    });
    const input = await findReadyTextbox( { name: "Message Local work" });
    const image = new File(["star-map"], "context.png", {
      type: "image/png",
    });

    fireEvent.paste(input, {
      clipboardData: {
        files: [image],
        getData: () => "",
        items: [
          {
            getAsFile: () => image,
            kind: "file",
            type: "image/png",
          },
        ],
        types: ["Files"],
      },
    });
    await screen.findByRole("img", { name: "context.png" });
    fireEvent.change(input, { target: { value: "/ses" } });
    expect(
      await screen.findByRole("option", { name: /\/session-info/i }),
    ).toBeTruthy();
    fireEvent.change(input, { target: { value: "/session-info" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          backend: "acp:grok",
          input: [
            { type: "text", text: "/session-info" },
            expect.objectContaining({ name: "context.png", type: "image" }),
          ],
        }),
      );
    });
  });

  it("sends an ACP-native slash command to the ACP session", async () => {
    const startTurn = vi.fn(async () => ({
      backend: "acp:grok" as const,
      threadId: "t-local",
      turnId: "turn-acp-1",
    }));
    const desktopApi = buildApi({ startTurn });
    renderCard({
      desktopApi,
      thread: localThread({ source: "acp:grok" }),
    });
    const input = await findReadyTextbox( { name: "Message Local work" });
    fireEvent.change(input, { target: { value: "/session-info" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          backend: "acp:grok",
          threadId: "t-local",
          input: [{ type: "text", text: "/session-info" }],
        }),
      );
    });
  });
});

describe("StarMapChatCard start-turn queue handling", () => {
  it("retains the backend-acknowledged queue entry visibly", async () => {
    const startTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "t-local",
      turnId: "turn-queued",
      queueStatus: "queued" as const,
      queueEntryId: "queue-owner-1",
      queueEntryCreatedAt: 123,
    }));
    const { result } = renderHook(() => useComposerDraftStore());
    const desktopApi = buildApi({ startTurn });
    renderCard({
      composerDraftStore: result.current,
      desktopApi,
      thread: localThread(),
    });

    await typeAndSend("Local work", "wait your turn");

    await waitFor(() => {
      expect(screen.getByLabelText("Queued message").textContent).toBe(
        "Queued nextwait your turn",
      );
    });
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        queueEntryId: expect.stringMatching(/^queued-turn-/),
      }),
    );
    expect(
      result.current.getQueuedTurns("thread:codex:t-local"),
    ).toEqual([
      expect.objectContaining({
        backendQueuePending: false,
        queueEntryId: "queue-owner-1",
        queueEntryCreatedAt: 123,
        text: "wait your turn",
      }),
    ]);
  });

  it("clears a remote queue entry only for its owning peer's lifecycle event", async () => {
    const listeners: Array<(event: AgentEvent) => void> = [];
    const onAgentEvent = vi.fn((listener: (event: AgentEvent) => void) => {
      listeners.push(listener);
      return () => undefined;
    });
    const startTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "t-remote",
      turnId: "turn-queued",
      queueStatus: "queued" as const,
      queueEntryId: "queue-owner-remote",
      queueEntryCreatedAt: 123,
    }));
    const { result } = renderHook(() => useComposerDraftStore());
    const desktopApi = buildApi({ onAgentEvent, startTurn });
    renderCard({
      composerDraftStore: result.current,
      desktopApi,
      thread: remoteThread(),
    });
    await typeAndSend("Remote work", "remote queue");
    await screen.findByLabelText("Queued message");

    act(() => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          federationTarget: { scope: "local" },
          notification: {
            method: "thread/turnQueue/updated",
            params: {
              queueEntryId: "queue-owner-remote",
              status: "started",
              threadId: "t-remote",
            },
          },
        } as AgentEvent);
      }
    });
    expect(screen.getByLabelText("Queued message")).toBeTruthy();

    act(() => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          federationTarget: { scope: "remote", instanceId: "pwr_peer" },
          notification: {
            method: "thread/turnQueue/updated",
            params: {
              queueEntryId: "queue-owner-remote",
              status: "started",
              threadId: "t-remote",
            },
          },
        } as AgentEvent);
      }
    });
    await waitFor(() => {
      expect(screen.queryByLabelText("Queued message")).toBeNull();
    });
  });
});

describe("StarMapChatCard send failures", () => {
  it("keeps a new draft but does not start twice while admission is pending", async () => {
    const admission = deferred<{
      backend: "codex";
      threadId: string;
      turnId: string;
    }>();
    const startTurn = vi.fn(() => admission.promise);
    const desktopApi = buildApi({ startTurn });
    const { result } = renderHook(() => useComposerDraftStore());
    renderCard({
      composerDraftStore: result.current,
      desktopApi,
      thread: localThread(),
    });
    const input = await findReadyTextbox( {
      name: "Message Local work",
    }) as HTMLElement & { value: string };
    fireEvent.change(input, { target: { value: "first message" } });
    const sendButton = screen.getByRole("button", { name: "Send" });

    // Two native activations can land before React has painted the busy
    // state derived from the first optimistic message. Admission itself is
    // the concurrency boundary, so the card must guard it synchronously.
    act(() => {
      sendButton.click();
      sendButton.click();
    });

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByLabelText("Queued message").textContent).toBe(
      "Sending…first message",
    );
    fireEvent.change(input, { target: { value: "new draft" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(startTurn).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(input.value).toBe("new draft");
    });

    act(() => {
      admission.resolve({
        backend: "codex",
        threadId: "t-local",
        turnId: "turn-1",
      });
    });
    await waitFor(() => {
      expect(screen.queryByLabelText("Queued message")).toBeNull();
    });
    expect(input.value).toBe("new draft");
  });

  it("keeps newer edits visible and parks the failed submission for recovery", async () => {
    const admission = deferred<{
      backend: "codex";
      threadId: string;
      turnId: string;
    }>();
    const { result } = renderHook(() => useComposerDraftStore());
    const composerDraftStore = result.current;
    const desktopApi = buildApi({
      startTurn: vi.fn(() => admission.promise),
    });
    renderCard({ composerDraftStore, desktopApi, thread: localThread() });
    const input = await typeAndSend("Local work", "failed submission");

    fireEvent.change(input, { target: { value: "newer edit" } });
    admission.reject(new Error("admission failed"));

    await waitFor(() => {
      expect(input.value).toBe("newer edit");
    });
    expect(
      composerDraftStore.popDraft("thread:codex:t-local"),
    ).toEqual(expect.objectContaining({ draft: "failed submission" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /admission failed/,
    );
    expect(screen.queryByLabelText("Queued message")).toBeNull();
  });

  it("restores the draft and rolls back its optimistic message when the peer refuses", async () => {
    const onUserRepliedToThread = vi.fn();
    const desktopApi = buildApi({
      startTurn: vi.fn(async () => {
        throw new Error("peer is offline");
      }),
    } as unknown as Partial<DesktopApi>);
    renderCard({ desktopApi, onUserRepliedToThread, thread: remoteThread() });
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
    expect(onUserRepliedToThread).not.toHaveBeenCalled();
  });

  it("shows the message optimistically while the turn is in flight", async () => {
    // Baseline for the rollback test below: without this, "the message is
    // gone after a failure" could pass simply because it never appeared.
    const onUserRepliedToThread = vi.fn();
    const desktopApi = buildApi({
      startTurn: vi.fn(() => new Promise(() => undefined)),
    } as unknown as Partial<DesktopApi>);
    renderCard({ desktopApi, onUserRepliedToThread, thread: remoteThread() });
    await typeAndSend("Remote work", "in flight");

    expect(
      await screen.findByText("in flight", { ignore: IGNORE_COMPOSER }),
    ).toBeTruthy();
    expect(onUserRepliedToThread).not.toHaveBeenCalled();
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
    const onUserRepliedToThread = vi.fn();
    const thread = localThread(BUSY);
    renderCard({ desktopApi, onUserRepliedToThread, thread });
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
    expect(onUserRepliedToThread).toHaveBeenCalledWith(thread);
  });

  it("says so when the backend held the message for the next turn", async () => {
    const onUserRepliedToThread = vi.fn();
    const desktopApi = busyApi({
      steerTurn: vi.fn(async () => ({
        backend: "codex",
        threadId: "t-local",
        turnId: "turn-live",
        disposition: "queued",
      })),
    } as unknown as Partial<DesktopApi>);
    const thread = localThread(BUSY);
    renderCard({ desktopApi, onUserRepliedToThread, thread });
    await screen.findByRole("button", { name: "Steer" });
    await typeAndSend("Local work", "and then deploy");

    // Steered and queued are both accepted sends that land in different
    // places, and only the backend knows which happened.
    expect(await screen.findByText("Queued for the next turn.")).toBeTruthy();
    expect(onUserRepliedToThread).toHaveBeenCalledWith(thread);
  });

  it("gives the text back when the backend refuses to steer", async () => {
    const onUserRepliedToThread = vi.fn();
    const desktopApi = busyApi({
      steerTurn: vi.fn(async () => {
        throw new Error("Selected backend does not support turn/steer");
      }),
    } as unknown as Partial<DesktopApi>);
    renderCard({
      desktopApi,
      onUserRepliedToThread,
      thread: localThread(BUSY),
    });
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
    expect(onUserRepliedToThread).not.toHaveBeenCalled();
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
    const input = await findReadyTextbox( { name: "Message Local work" });
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
    const input = await findReadyTextbox( { name: "Message Local work" });
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

  function mentionPage(request: NavigationQueryRequest, population = SNAPSHOT): NavigationQueryPage {
    return {
      protocol: 2,
      queryKey: JSON.stringify(request.query),
      generation: "fixture",
      ownerEpoch: "fixture",
      countsRevision: "fixture",
      coverage: { state: "complete" },
      counts: { total: population.threads.length, active: 0, unread: 0, review: 0 },
      complete: true,
      directories: request.query.kind === "directory-index"
        ? population.directories.map((directory) => ({
            key: directory.key,
            kind: "directory",
            label: directory.label,
            path: directory.path,
            latestUpdatedAt: directory.latestUpdatedAt,
            counts: { total: 0, active: 0, unread: 0, review: 0 },
            pinnedRootCount: 0,
            unpinnedRootCount: 0,
            launchpadPresent: false,
          }))
        : [],
      entries: request.query.kind === "directory-index" ? [] : population.threads.map((thread) => ({
        row: {
          ref: { backend: thread.source, threadId: thread.id },
          rowRevision: "fixture",
          id: thread.id,
          source: thread.source,
          title: thread.title,
          titleSource: thread.titleSource,
          linkedDirectories: thread.linkedDirectories,
          inbox: thread.inbox,
          prs: thread.prs,
          gitBranch: thread.gitBranch,
          ordinaryChildCount: 0,
          nativeSubAgentGroupPresent: false,
          queueCount: 0,
          queueState: "unknown",
        },
        orderKey: thread.id,
        placement: { kind: "root" },
      })),
    };
  }

  function mentionApi(overrides: Partial<DesktopApi> = {}): DesktopApi {
    return buildApi({
      getNavigationSnapshot: vi.fn(() => { throw new Error("Deprecated collection read"); }),
      getNavigationQueryPage: vi.fn(async (request) => mentionPage(request)),
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

  it("requests bounded owner matches for each picker query", async () => {
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
    expect(desktopApi.getNavigationSnapshot).not.toHaveBeenCalled();
    await waitFor(() => expect(desktopApi.getNavigationQueryPage).toHaveBeenCalledTimes(6));
  });

  it("refreshes a fresh mention cache after project registration", async () => {
    let notifyNavigationChanged: (() => void) | undefined;
    let registered = false;
    const getNavigationQueryPage = vi.fn(async (request: NavigationQueryRequest) =>
      mentionPage(request, !registered ? SNAPSHOT : {
        ...SNAPSHOT,
        directories: [
          ...SNAPSHOT.directories,
          {
            key: "d-new-project",
            kind: "repo",
            label: "new-project",
            latestUpdatedAt: 3,
            path: "/Users/dev/new-project",
          },
        ],
      }));
    const onNavigationMentionSourcesChanged = vi.fn(
      (callback: () => void) => {
        notifyNavigationChanged = callback;
        return () => undefined;
      },
    );
    const desktopApi = mentionApi({
      getNavigationQueryPage,
      onNavigationMentionSourcesChanged,
    });
    renderCard({ desktopApi, thread: localThread() });
    await screen.findByRole("button", { name: "Send" });
    expect(onNavigationMentionSourcesChanged).toHaveBeenCalledOnce();

    fireEvent.change(composer(), { target: { value: "check @ap" } });
    expect((await screen.findByRole("option")).textContent).toContain("app");
    fireEvent.change(composer(), { target: { value: "check " } });

    registered = true;
    act(() => notifyNavigationChanged?.());
    expect(getNavigationQueryPage).toHaveBeenCalledTimes(2);
    fireEvent.change(composer(), { target: { value: "check @new" } });

    await waitFor(() => {
      expect(screen.getByRole("option").textContent).toContain("new-project");
    });
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
    // The dismissed-forever preference is cached window-wide so N cards
    // share one settings read; that cache outlives a render tree.
    resetFullAccessRiskWarningCache();
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
                {
                  id: "gpt-5-spark",
                  supportsFast: false,
                  supportsImage: false,
                },
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

  it("describes the backend once on mount with the card's target", async () => {
    const desktopApi = settingsApi();
    renderCard({ desktopApi, thread: remoteThread({ model: "gpt-5-codex" }) });
    await screen.findByRole("button", { name: "Send" });
    await waitFor(() => {
      expect(desktopApi.listBackends).toHaveBeenCalledTimes(1);
    });
    expect(desktopApi.listBackends).toHaveBeenCalledWith({
      includeUnavailable: true,
      federationTarget: { scope: "remote", instanceId: "pwr_peer" },
    });

    // Opening and reopening reuse the loaded options rather than describing
    // again. Image capability gating needs the same summary before the first
    // paste, not only after the settings door has opened.
    await openSettingsMenu();
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

  it("updates image gating immediately after an optimistic model change", async () => {
    vi.mocked(normalizeImageFile).mockClear();
    const desktopApi = settingsApi();
    renderCard({ desktopApi, thread: localThread({ model: "gpt-5-codex" }) });
    await openSettingsMenu();

    fireEvent.click(await screen.findByRole("menuitem", { name: /Model/ }));
    fireEvent.click(
      await screen.findByRole("menuitemradio", { name: "gpt-5-spark" }),
    );
    await screen.findByText("gpt-5-spark");
    const input = await findReadyTextbox( { name: "Message Local work" });
    const image = new File(["spark"], "spark.png", { type: "image/png" });

    transferImage(input, image, "paste");

    expect((await screen.findByRole("alert")).textContent).toContain(
      "gpt-5-spark doesn't support image attachments.",
    );
    expect(normalizeImageFile).not.toHaveBeenCalled();
  });

  /**
   * The Full Access confirmation is the shared renderer gate, not the
   * composer's own state: this chip escalated a thread in one un-gated
   * click for as long as the dialog lived inside `Composer`.
   */
  async function chooseAccessMode(label: string): Promise<void> {
    fireEvent.click(await screen.findByRole("menuitem", { name: /Access/ }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: label }));
  }

  /** Settings reads resolve a tick after mount; the gate reads false until then. */
  async function settleDismissedRead(desktopApi: DesktopApi): Promise<void> {
    await waitFor(() => {
      expect(desktopApi.readFullAccessPolicy).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  function settingsSnapshotApi(
    fullAccessRiskWarningDismissed: boolean,
    overrides: Partial<DesktopApi> = {},
  ): DesktopApi {
    return settingsApi({
      readFullAccessPolicy: vi.fn(async () => ({
        fullAccessRiskWarningDismissed,
      })),
      ...overrides,
    } as unknown as Partial<DesktopApi>);
  }

  it("confirms the first escalation to Full Access before applying it", async () => {
    const desktopApi = settingsApi();
    renderCard({
      desktopApi,
      thread: localThread({ executionMode: "default", model: "gpt-5-codex" }),
    });
    await openSettingsMenu();
    await chooseAccessMode("Full Access");

    const dialog = await screen.findByRole("dialog", {
      name: "Enable Full Access?",
    });
    expect(dialog.textContent).toContain("network access");
    expect(dialog.textContent).toContain("supply chain attack");
    expect(desktopApi.setThreadExecutionMode).not.toHaveBeenCalled();

    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "I Understand and Accept the Risks",
      }),
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

  it("keeps the warning's input off the map behind it", async () => {
    // The dialog portals out of the card's DOM but not out of its React
    // tree, and in the Star Map window its ancestors are the map's own
    // `onPointerDown` (canvas pan, marquee, click-to-drop-selection) and
    // `onKeyDown` (Escape unwinds the selection). The dialog sits outside
    // every `.star-map-*` container `shouldStartCanvasPan` tests for, so
    // without containment a drag on the scrim pans the map underneath it.
    const onPointerDown = vi.fn();
    const onKeyDown = vi.fn();
    const desktopApi = settingsApi();
    render(
      <div onKeyDown={onKeyDown} onPointerDown={onPointerDown}>
        {card({
          desktopApi,
          thread: localThread({
            executionMode: "default",
            model: "gpt-5-codex",
          }),
        })}
      </div>,
    );
    await openSettingsMenu();
    await chooseAccessMode("Full Access");

    const dialog = await screen.findByRole("dialog", {
      name: "Enable Full Access?",
    });
    const scrim = dialog.closest(".full-access-warning-modal");
    expect(scrim).not.toBeNull();
    onPointerDown.mockClear();
    onKeyDown.mockClear();

    fireEvent.pointerDown(scrim as Element, { button: 0 });
    fireEvent.keyDown(scrim as Element, { key: "Escape" });

    expect(onPointerDown).not.toHaveBeenCalled();
    expect(onKeyDown).not.toHaveBeenCalled();
  });

  it("leaves the thread on Default Access when the warning is cancelled", async () => {
    const desktopApi = settingsApi();
    renderCard({
      desktopApi,
      thread: localThread({ executionMode: "default", model: "gpt-5-codex" }),
    });
    await openSettingsMenu();
    await chooseAccessMode("Full Access");

    const dialog = await screen.findByRole("dialog", {
      name: "Enable Full Access?",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Enable Full Access?" }),
      ).toBeNull();
    });
    expect(desktopApi.setThreadExecutionMode).not.toHaveBeenCalled();
    // The chip carries the mode in its accessible name, so this is the
    // operator's own view of the thread still being on Default Access —
    // the optimistic patch must not have run either.
    const chip = await screen.findByRole("button", {
      name: /^Thread settings/,
    });
    expect(chip.getAttribute("aria-label")).toContain("Default Access");
  });

  it("skips the warning once the operator dismissed it on this desktop", async () => {
    const desktopApi = settingsSnapshotApi(true);
    renderCard({
      desktopApi,
      thread: localThread({ executionMode: "default", model: "gpt-5-codex" }),
    });
    await settleDismissedRead(desktopApi);
    await openSettingsMenu();
    await chooseAccessMode("Full Access");

    expect(
      screen.queryByRole("dialog", { name: "Enable Full Access?" }),
    ).toBeNull();
    await waitFor(() => {
      expect(desktopApi.setThreadExecutionMode).toHaveBeenCalledWith({
        backend: "codex",
        executionMode: "full-access",
        federationTarget: undefined,
        threadId: "t-local",
      });
    });
  });

  it("persists the dismissal this window from the card's own dialog", async () => {
    // No `App` above this window to own the preference, so the gate reads
    // and writes the setting itself.
    const writeSettingsConfig = vi.fn(async () => ({
      update: {
        version: 2,
        configRevision: "next",
        changedDomains: ["experimental"] as const,
        normalizedPatch: {
          experimental: { fullAccessRiskWarningDismissed: true },
        },
        scheduledProviderRefreshes: [],
      },
      snapshot: {} as DesktopSettingsSnapshot,
    }));
    const desktopApi = settingsSnapshotApi(false, {
      writeSettingsConfig,
    } as unknown as Partial<DesktopApi>);
    renderCard({
      desktopApi,
      thread: localThread({ executionMode: "default", model: "gpt-5-codex" }),
    });
    await settleDismissedRead(desktopApi);
    await openSettingsMenu();
    await chooseAccessMode("Full Access");

    const dialog = await screen.findByRole("dialog", {
      name: "Enable Full Access?",
    });
    fireEvent.click(
      within(dialog).getByLabelText("Do not warn me again on this desktop."),
    );
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "I Understand and Accept the Risks",
      }),
    );

    await waitFor(() => {
      expect(writeSettingsConfig).toHaveBeenCalledWith({
        patch: { experimental: { fullAccessRiskWarningDismissed: true } },
      });
      expect(desktopApi.setThreadExecutionMode).toHaveBeenCalledWith(
        expect.objectContaining({ executionMode: "full-access" }),
      );
    });
  });

  it("drops back to Default Access without a confirmation", async () => {
    // The gate is an escalation gate; de-escalating is never risky and
    // must stay one click.
    const desktopApi = settingsApi();
    renderCard({
      desktopApi,
      thread: localThread({
        executionMode: "full-access",
        model: "gpt-5-codex",
      }),
    });
    await openSettingsMenu();
    await chooseAccessMode("Default Access");

    expect(
      screen.queryByRole("dialog", { name: "Enable Full Access?" }),
    ).toBeNull();
    await waitFor(() => {
      expect(desktopApi.setThreadExecutionMode).toHaveBeenCalledWith({
        backend: "codex",
        executionMode: "default",
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

describe("StarMapChatCard title bar", () => {
  it("carries the instance as its celestial mark, not as bar text", () => {
    // The bar has one scarce resource: horizontal room the thread title
    // needs. A full hostname plus directory ("Harold-MBP-M2-Max / work")
    // spent more of it than the title did, so the machine reads as the
    // same mark the map already gives it and the name moves to the
    // accessible name and the hover tooltip. Assert BOTH halves: the
    // name must be gone from the bar's text, and still reachable by
    // name — dropping it entirely would trade a cramped title for an
    // unidentifiable card.
    renderCard({
      desktopApi: buildApi(),
      instanceIcon: "moon",
      instanceLabel: "Studio Mac",
      thread: remoteThread(),
    });

    const banner = screen.getByRole("banner", { hidden: true });
    expect(banner.textContent).not.toContain("Studio Mac");
    expect(
      screen.getByRole("img", { name: "Instance: Studio Mac" }),
    ).toBeTruthy();
  });

  it("keeps the name visible when no celestial mark can render", () => {
    // Two ways to have a label and no usable icon: the assignment
    // snapshot has not landed yet (undefined), or a peer on a newer
    // build named an id this build does not know — the celestial
    // contract makes that "unassigned" and CelestialIcon renders null
    // for it. Either way the slot must fall back to the name rather
    // than going blank.
    for (const instanceIcon of [undefined, "quasar"]) {
      const view = renderCard({
        desktopApi: buildApi(),
        instanceIcon,
        instanceLabel: "Studio Mac",
        thread: remoteThread(),
      });

      const banner = screen.getByRole("banner", { hidden: true });
      expect(banner.textContent).toContain("Studio Mac");
      view.unmount();
    }
  });

  it("gathers the card's controls into one group, close kept apart", () => {
    // Three lone glyphs drifting across the bar read as unrelated; the
    // group is what makes them one row of controls. Close stays outside
    // it — a destructive control should not sit flush against the ones
    // the hand reaches for repeatedly.
    renderCard({
      desktopApi: buildApi(),
      instanceIcon: "moon",
      instanceLabel: "Studio Mac",
      thread: remoteThread(),
    });

    const actions = document.querySelector(".star-map-chat-card__actions");
    expect(actions).toBeTruthy();
    const grouped = [...(actions?.querySelectorAll("button") ?? [])].map(
      (button) => button.getAttribute("aria-label"),
    );
    expect(grouped).toEqual([
      "Show thread context for Remote work",
      "Open terminal for Remote work",
      "Open Remote work in the full thread view",
    ]);
    expect(actions?.querySelector(".star-map-chat-card__close")).toBeNull();
  });
});

describe("StarMapChatCard title bar tooltips", () => {
  function hoverTooltipText(control: Element): string | undefined {
    fireEvent.mouseEnter(control);
    return document.querySelector('[role="tooltip"]')?.textContent ?? undefined;
  }

  it("gives every bar control a hover tooltip, not just some of them", () => {
    // The bar lost its words: the instance is an icon, Open is ↗, and the
    // toggles were always glyphs. A tooltip on only one of them reads as
    // the others being broken — which is exactly how it shipped and how
    // it got caught. This asserts the SET, so the next glyph added here
    // cannot land without one.
    renderCard({
      desktopApi: buildApi(),
      instanceIcon: "moon",
      instanceLabel: "Studio Mac",
      thread: remoteThread(),
    });

    const bar = screen.getByRole("banner", { hidden: true });
    const controls = [
      ...bar.querySelectorAll("button, .star-map-chat-card__instance"),
    ];
    expect(controls.length).toBe(5);
    for (const control of controls) {
      expect(hoverTooltipText(control)).toBeTruthy();
      fireEvent.mouseLeave(control);
    }
  });

  it("says what a toggle will do, and keeps saying it after the click", () => {
    // A toggle's tooltip names the ACTION, which is the opposite of the
    // state it is in. The pointer does not leave on click, so a label
    // left un-flipped would sit there offering the thing just done.
    const view = renderCard({
      desktopApi: buildApi(),
      instanceLabel: "Studio Mac",
      thread: remoteThread(),
    });

    const terminal = screen.getByRole("button", {
      name: "Open terminal for Remote work",
    });
    expect(hoverTooltipText(terminal)).toBe("Open terminal");
    fireEvent.click(terminal);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      "Close terminal",
    );
    view.unmount();
  });

  it("leaves a tooltip another control owns alone when a toggle fires", () => {
    // A toggle re-labels its own tooltip after the click. `update` writes
    // to whatever tooltip is on screen, so without an owner check a
    // keyboard activation — pointer still resting on the title, focus
    // moved by Tab — rewrote the TITLE's tooltip in place.
    renderCard({
      desktopApi: buildApi(),
      instanceLabel: "Studio Mac",
      thread: remoteThread(),
    });

    const title = document.querySelector(".star-map-chat-card__title");
    expect(hoverTooltipText(title as Element)).toBe("Remote work");
    fireEvent.click(
      screen.getByRole("button", { name: "Show thread context for Remote work" }),
    );
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      "Remote work",
    );
  });

  it("tells a peer card where ↗ lands even with no label for that peer", () => {
    // The label is decoration; the destination is not. StarMapScreen
    // reads the label straight out of `displayLabelById`, so an unlinked
    // peer leaves it undefined — and the sentence used to collapse to
    // "the main window" while ↗ opened a federation window.
    renderCard({
      desktopApi: buildApi(),
      thread: remoteThread(),
    });

    expect(
      hoverTooltipText(
        screen.getByRole("button", {
          name: "Open Remote work in the full thread view",
        }),
      ),
    ).toBe("Open in a window connected to that instance");
  });

  it("names the peer in the ↗ tooltip, since the bar only shows its icon", () => {
    // ↗ does not land in the same place for every card, and the machine
    // is no longer written out beside it.
    renderCard({
      desktopApi: buildApi(),
      instanceIcon: "moon",
      instanceLabel: "Studio Mac",
      thread: remoteThread(),
    });

    expect(
      hoverTooltipText(
        screen.getByRole("button", {
          name: "Open Remote work in the full thread view",
        }),
      ),
    ).toBe("Open in a window connected to Studio Mac");
  });
});

describe("Star Map exact detail and FIFO authority", () => {
  it("keeps a visible row read-only until exact configuration and every FIFO page arrive", async () => {
    const detail = deferred<Awaited<ReturnType<NonNullable<DesktopApi["getNavigationSelectedDetail"]>>>>();
    const queue = deferred<Awaited<ReturnType<NonNullable<DesktopApi["getNavigationQueueProjection"]>>>>();
    const ref = { backend: "codex" as const, threadId: "t-remote", ownerInstanceId: "pwr_peer" };
    const desktopApi = buildApi({
      getNavigationSelectedDetail: vi.fn(() => detail.promise),
      getNavigationQueueProjection: vi.fn()
        .mockResolvedValueOnce({ protocol: 2, ref, revision: "fifo", readiness: "ready", complete: false, entries: [], nextCursor: "next" })
        .mockReturnValueOnce(queue.promise),
    });
    renderCard({ desktopApi, thread: remoteThread({ model: "stale-row-model" }) });
    const editor = screen.getByRole("textbox", { name: "Message Remote work" });
    expect(editor.getAttribute("contenteditable")).toBe("false");
    await act(async () => detail.resolve({ protocol: 2, ref, revision: "detail", readiness: "ready", identity: "present",
      thread: remoteThread({ model: "owner-model" }),
    }));
    expect(editor.getAttribute("contenteditable")).toBe("false");
    expect(desktopApi.startTurn).not.toHaveBeenCalled();
    await act(async () => queue.resolve({ protocol: 2, ref, revision: "fifo", readiness: "ready", complete: true, entries: [] }));
    await waitFor(() => expect(editor.getAttribute("contenteditable")).toBe("true"));
    expect(screen.getByRole("button", { name: /^Thread settings/ }).textContent).toContain("owner-model");
    await typeAndSend("Remote work", "ready now");
    await waitFor(() => expect(desktopApi.startTurn).toHaveBeenCalledTimes(1));
  });

  it("requires an upgrade when a bridge only has row and transcript reads", async () => {
    const desktopApi = buildApi({ getNavigationSelectedDetail: undefined, getNavigationQueueProjection: undefined });
    renderCard({ desktopApi, thread: remoteThread() });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Upgrade this instance"));
    expect(screen.getByRole("textbox", { name: "Message Remote work" }).getAttribute("contenteditable")).toBe("false");
    expect(desktopApi.startTurn).not.toHaveBeenCalled();
  });
});
