import "@testing-library/jest-dom/vitest";
import {
  buildThreadMarkdownLink,
  type AppServerBackendKind,
  type AppServerThreadEntry,
  type NavigationQueryRequest,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadLinkProvider, type ThreadLinkSource } from "../../../lib/thread-links";
import { TranscriptList } from "../TranscriptList";

/**
 * Rule: a thread link that names this machine resolves and renders exactly
 * as a bare local link, on every surface and in every window.
 *
 * A peer-owned transcript carries the operator's own link two ways. The
 * owner's copy names this machine explicitly, because the federation bridge
 * qualifies bare links before the owner records the turn. The pending copy
 * shown until then still holds the bare link the operator typed, which means
 * "a thread on this machine", not a thread on the owner.
 *
 * Either may render in the main window or in a window that serves the peer.
 * In that window a bare link names the peer, so a link to this machine must
 * keep saying so: no remote-viewer pop-out, hover reads on this machine, and
 * a click that shows the thread in the main window.
 */

const VIEWER = "pwr_viewer-0000-0000-0000-000000000001";
const PEER = "pwr_peer-0000-0000-0000-000000000002";
const LOCAL_THREAD_ID = "019f5d79-a595-73f2-84d9-a0976762c303";
const MESSAGE_ID = "019f5d79-a595-73f2-84d9-a0976762c304";
const LOCAL_TITLE = "Fixture local thread";

type FederationWindowGlobal = typeof window & {
  __pwragentFederationTarget?: unknown;
  pwragent?: unknown;
};

afterEach(() => {
  cleanup();
  delete (window as FederationWindowGlobal).__pwragentFederationTarget;
  delete (window as FederationWindowGlobal).pwragent;
});

type Carrier = "owner-copy" | "pending-copy";
type WindowKind = "main" | "peer";

type Case = {
  backend: AppServerBackendKind | undefined;
  carrier: Carrier;
  label: string;
  loaded: boolean;
  messageId: boolean;
  window: WindowKind;
};

const PEER_SOURCE: ThreadLinkSource = { backend: "codex", instanceId: PEER };

function localThread(backend: AppServerBackendKind): NavigationThreadSummary {
  return {
    id: LOCAL_THREAD_ID,
    title: LOCAL_TITLE,
    titleSource: "generated",
    source: backend,
    linkedDirectories: [],
    inbox: { unread: false },
  } as unknown as NavigationThreadSummary;
}

function messageText(testCase: Case, instanceId: string | undefined): string {
  return `${buildThreadMarkdownLink({
    threadId: LOCAL_THREAD_ID,
    title: testCase.label,
    ...(testCase.backend ? { backend: testCase.backend } : {}),
    ...(instanceId ? { instanceId } : {}),
    ...(testCase.messageId ? { messageId: MESSAGE_ID } : {}),
  })} try that one`;
}

/** Where a click took the operator, in machine terms. */
type Opened = {
  machine: string;
  backend: AppServerBackendKind;
  threadId: string;
  messageId?: string;
} | undefined;

type Observed = {
  chip: string | undefined;
  popout: boolean;
  opened: Opened;
};

/**
 * This machine's navigation owner. It knows the local thread, and answers
 * every peer read with an empty, complete page.
 */
function desktopApi(backend: AppServerBackendKind | undefined) {
  const reads: NavigationQueryRequest[] = [];
  const openThreadInMainWindow = vi.fn(async (
    _request: { backend: AppServerBackendKind; messageId?: string; threadId: string },
  ) => undefined);
  const api = {
    getNavigationQueryPage: vi.fn(async (request: NavigationQueryRequest) => {
      reads.push(request);
      const identity = request.query.kind === "exact" ? request.query.identities[0] : undefined;
      const local = !request.federationTarget
        && identity?.threadId === LOCAL_THREAD_ID
        && identity.backend === (backend ?? "claude");
      return {
        complete: true,
        coverage: { state: "complete" },
        entries: local
          ? [{ row: { ...localThread(identity.backend), ref: {} } }]
          : [],
      };
    }),
    openThreadInMainWindow,
  };
  return { api, openThreadInMainWindow, reads };
}

async function observe(params: {
  entry: AppServerThreadEntry;
  source: ThreadLinkSource | undefined;
  testCase: Case;
}): Promise<Observed & { peerReads: number }> {
  const { testCase } = params;
  const peerWindow = testCase.window === "peer";
  const harness = desktopApi(testCase.backend);
  const global = window as FederationWindowGlobal;
  global.pwragent = harness.api;
  if (peerWindow) {
    global.__pwragentFederationTarget = { scope: "remote", instanceId: PEER };
  }
  const onShowThread = vi.fn();
  const view = render(
    <ThreadLinkProvider
      localInstanceId={VIEWER}
      onOpenRemoteViewer={vi.fn()}
      onShowThread={onShowThread}
      // A window serving the peer lists the peer's rows, never this
      // machine's, so the local thread is never loaded there.
      threads={testCase.loaded && !peerWindow
        ? [localThread(testCase.backend ?? "claude")]
        : []}
    >
      <TranscriptList
        entries={[params.entry]}
        loading={false}
        loadingMore={false}
        onLoadOlder={async () => undefined}
        threadLinkSource={params.source}
      />
    </ThreadLinkProvider>,
  );
  try {
    // Let an encountered off-page link finish its owner read.
    for (let index = 0; index < 4; index += 1) {
      await act(async () => {});
    }
    const chip = screen.queryByRole("button", { name: /^Open thread / });
    const popout = screen.queryByRole("button", { name: /^Open remote viewer/ }) !== null;
    if (chip) fireEvent.click(chip);
    const shown = onShowThread.mock.calls[0]?.[0] as
      | { backend: AppServerBackendKind; instanceId?: string; messageId?: string; threadId: string }
      | undefined;
    const inMain = harness.openThreadInMainWindow.mock.calls[0]?.[0];
    const opened: Opened = inMain
      ? { machine: VIEWER, ...inMain }
      : shown
      ? {
          // A bare navigation request stays in the window's own instance.
          machine: shown.instanceId ?? (peerWindow ? PEER : VIEWER),
          backend: shown.backend,
          threadId: shown.threadId,
          ...(shown.messageId ? { messageId: shown.messageId } : {}),
        }
      : undefined;
    return {
      chip: chip?.getAttribute("aria-label") ?? undefined,
      popout,
      opened,
      peerReads: harness.reads.filter((read) => read.federationTarget?.scope === "remote").length,
    };
  } finally {
    view.unmount();
    delete global.__pwragentFederationTarget;
    delete global.pwragent;
  }
}

function userMessage(id: string, text: string): AppServerThreadEntry {
  return { type: "message", id, role: "user", text, createdAt: 1 };
}

/**
 * What the same link renders as when it is a bare link in this machine's
 * own transcript, in the main window. A window serving the peer never has
 * the local thread loaded, so its baseline is the unloaded one.
 */
async function baseline(testCase: Case): Promise<Observed> {
  const { peerReads: _peerReads, ...observed } = await observe({
    entry: userMessage("local-message", messageText(testCase, undefined)),
    source: undefined,
    testCase: {
      ...testCase,
      loaded: testCase.loaded && testCase.window === "main",
      window: "main",
    },
  });
  return observed;
}

/** The same link as a peer-owned transcript carries it. */
async function inPeerTranscript(testCase: Case) {
  return await observe({
    entry: testCase.carrier === "owner-copy"
      ? userMessage("owner-message", messageText(testCase, VIEWER))
      : userMessage("optimistic-1794440546000-abc123", messageText(testCase, undefined)),
    source: PEER_SOURCE,
    testCase,
  });
}

const caseArbitrary: fc.Arbitrary<Case> = fc.record({
  backend: fc.constantFrom<AppServerBackendKind | undefined>("claude", "codex", undefined),
  carrier: fc.constantFrom<Carrier>("owner-copy", "pending-copy"),
  label: fc.constantFrom("Owner Core for Outposts", "Fixture link"),
  loaded: fc.boolean(),
  messageId: fc.boolean(),
  window: fc.constantFrom<WindowKind>("main", "peer"),
});

describe("thread links that name this machine", () => {
  it("render exactly as a bare local link in a peer-owned transcript, in every window", async () => {
    await fc.assert(
      fc.asyncProperty(caseArbitrary, async (testCase) => {
        const expected = await baseline(testCase);
        // A link that resolves nowhere renders as text on both sides, which
        // would let the property pass without comparing a chip.
        if (testCase.backend) {
          expect(expected.chip).toBe(`Open thread ${LOCAL_TITLE}`);
          expect(expected.popout).toBe(false);
          expect(expected.opened?.machine).toBe(VIEWER);
        }
        const { peerReads, ...actual } = await inPeerTranscript(testCase);
        expect(actual).toEqual(expected);
        // Hover facts and names for this machine's thread come from here.
        expect(peerReads).toBe(0);
      }),
      { numRuns: 64 },
    );
  });

  it.each<WindowKind>(["main", "peer"])(
    "draws no pop-out on the pending copy of a sent #-chip (%s window)",
    async (windowKind) => {
      const testCase: Case = {
        backend: "claude",
        carrier: "pending-copy",
        label: "Owner Core for Outposts",
        loaded: true,
        messageId: false,
        window: windowKind,
      };
      const { peerReads: _peerReads, ...observed } = await inPeerTranscript(testCase);
      expect(observed).toEqual({
        chip: `Open thread ${LOCAL_TITLE}`,
        popout: false,
        opened: { machine: VIEWER, backend: "claude", threadId: LOCAL_THREAD_ID },
      });
    },
  );

  it.each<WindowKind>(["main", "peer"])(
    "still reads a bare link the owner wrote as the owner's thread (%s window)",
    async (windowKind) => {
      const testCase: Case = {
        backend: "codex",
        carrier: "owner-copy",
        label: "Peer thread",
        loaded: false,
        messageId: false,
        window: windowKind,
      };
      const { peerReads: _peerReads, ...observed } = await observe({
        entry: userMessage("owner-message", messageText(testCase, undefined)),
        source: PEER_SOURCE,
        testCase,
      });
      expect(observed.chip).toBe("Open thread Peer thread");
      expect(observed.opened).toEqual({
        machine: PEER, backend: "codex", threadId: LOCAL_THREAD_ID,
      });
    },
  );
});
