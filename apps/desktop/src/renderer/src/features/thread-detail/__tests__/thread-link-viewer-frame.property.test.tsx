import "@testing-library/jest-dom/vitest";
import {
  buildThreadMarkdownLink,
  type AppServerBackendKind,
  type AppServerThreadEntry,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadLinkProvider, type ThreadLinkSource } from "../../../lib/thread-links";
import { TranscriptList } from "../TranscriptList";

/**
 * Rule: a thread link that names the viewing instance resolves and renders
 * exactly as a bare local link, whichever way the transcript carries it.
 *
 * A peer-owned transcript carries the operator's own link two ways. The
 * owner's copy names the viewer explicitly, because the federation bridge
 * qualifies bare links before the owner records the turn. The pending copy
 * the viewer shows until then still holds the bare link the operator typed,
 * which means "a thread on this machine" — not a thread on the owner.
 */

const VIEWER = "pwr_viewer-0000-0000-0000-000000000001";
const PEER = "pwr_peer-0000-0000-0000-000000000002";
const LOCAL_THREAD_ID = "019f5d79-a595-73f2-84d9-a0976762c303";
const MESSAGE_ID = "019f5d79-a595-73f2-84d9-a0976762c304";
const LOCAL_TITLE = "Fixture local thread";

afterEach(() => {
  cleanup();
});

type Carrier = "owner-copy" | "pending-copy";

type Case = {
  backend: AppServerBackendKind | undefined;
  carrier: Carrier;
  label: string;
  loaded: boolean;
  messageId: boolean;
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

type Observed = {
  chip: string | undefined;
  popout: boolean;
  shown: unknown;
};

function observe(params: {
  entry: AppServerThreadEntry;
  source: ThreadLinkSource | undefined;
  testCase: Case;
}): Observed {
  const onShowThread = vi.fn();
  const view = render(
    <ThreadLinkProvider
      localInstanceId={VIEWER}
      onOpenRemoteViewer={vi.fn()}
      onShowThread={onShowThread}
      threads={params.testCase.loaded
        ? [localThread(params.testCase.backend ?? "claude")]
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
    const chip = screen.queryByRole("button", { name: /^Open thread / });
    const popout = screen.queryByRole("button", { name: /^Open remote viewer/ }) !== null;
    if (chip) fireEvent.click(chip);
    return {
      chip: chip?.getAttribute("aria-label") ?? undefined,
      popout,
      shown: onShowThread.mock.calls[0]?.[0],
    };
  } finally {
    view.unmount();
  }
}

function userMessage(id: string, text: string): AppServerThreadEntry {
  return { type: "message", id, role: "user", text, createdAt: 1 };
}

/** What the same link renders as in this viewer's own transcript. */
function baseline(testCase: Case): Observed {
  return observe({
    entry: userMessage("local-message", messageText(testCase, undefined)),
    source: undefined,
    testCase,
  });
}

/** The same link as a peer-owned transcript carries it. */
function inPeerTranscript(testCase: Case): Observed {
  return observe({
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
});

describe("thread links that name the viewer", () => {
  it("render exactly as a bare local link in a peer-owned transcript", () => {
    fc.assert(
      fc.property(caseArbitrary, (testCase) => {
        const expected = baseline(testCase);
        // A link that resolves nowhere renders as text on both sides, which
        // would let the property pass without comparing a chip.
        if (testCase.backend || testCase.loaded) {
          expect(expected.chip).toBeDefined();
          expect(expected.popout).toBe(false);
        }
        expect(inPeerTranscript(testCase)).toEqual(expected);
      }),
      { numRuns: 48 },
    );
  });

  it("draws no pop-out on the operator's pending copy of a sent #-chip", () => {
    const testCase: Case = {
      backend: "claude",
      carrier: "pending-copy",
      label: "Owner Core for Outposts",
      loaded: true,
      messageId: false,
    };
    expect(inPeerTranscript(testCase)).toEqual({
      chip: `Open thread ${LOCAL_TITLE}`,
      popout: false,
      shown: { backend: "claude", threadId: LOCAL_THREAD_ID },
    });
  });

  it("still reads a bare link the owner wrote as the owner's thread", () => {
    const testCase: Case = {
      backend: "codex",
      carrier: "owner-copy",
      label: "Peer thread",
      loaded: false,
      messageId: false,
    };
    expect(observe({
      entry: userMessage("owner-message", messageText(testCase, undefined)),
      source: PEER_SOURCE,
      testCase,
    })).toEqual({
      chip: "Open thread Peer thread",
      popout: true,
      shown: { backend: "codex", instanceId: PEER, threadId: LOCAL_THREAD_ID },
    });
  });
});
