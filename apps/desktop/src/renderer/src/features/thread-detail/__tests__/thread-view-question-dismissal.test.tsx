import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFederatedThreadRef, type NavigationThreadSummary, type OperatorQuestionThreadRequest,
  type OperatorRequestsChangedEvent } from "@pwragent/shared";
import { useIntegratedTerminals } from "../../../lib/useIntegratedTerminals";
import { ThreadView, type ThreadViewProps } from "../ThreadView";

afterEach(cleanup);

const target = { scope: "remote" as const, instanceId: "owner" };
const thread: NavigationThreadSummary = {
  id: "thread-1", source: "codex", title: "Example", titleSource: "explicit",
  linkedDirectories: [], inbox: { inInbox: false },
  federation: {
    ref: buildFederatedThreadRef({ instanceId: target.instanceId, backend: "codex", threadId: "thread-1" }),
    instanceLabel: "Studio", peerStatus: "connected",
    capabilities: ["thread_detail", "turn_control"],
  },
};

function View(props: Partial<Omit<ThreadViewProps, "terminals">>) {
  const terminals = useIntegratedTerminals(props.desktopApi);
  return <ThreadView
    addOptimisticUserMessage={() => "optimistic-1"}
    backends={[]}
    clearPendingRequest={() => undefined}
    composerDisabled={false}
    loading={false}
    loadingMore={false}
    messageCount={1}
    skills={[]}
    onLoadOlder={async () => undefined}
    removeOptimisticMessage={() => undefined}
    selectedThread={thread}
    transcriptEntries={[{
      type: "message", id: "question-1", role: "assistant", text: "Which environment?",
      delivery: "async", questions: [{ title: "Which environment?", options: null }],
    }]}
    {...props}
    terminals={terminals}
  />;
}

describe("question dismissal ownership", () => {
  it.each([undefined, "active-turn"])("sends a remote dismissal to its owner during turn %s", async (activeTurnId) => {
    const dismissOperatorQuestion = vi.fn(async () => {});
    render(<View activeTurnId={activeTurnId} desktopApi={{ dismissOperatorQuestion }} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(dismissOperatorQuestion).toHaveBeenCalledWith({
      backend: "codex", threadId: "thread-1", messageId: "question-1", federationTarget: target,
    }));
  });

  it.each([false, true])("folds another window's dismissal and restores it on mount (remote: %s)", async (remote) => {
    let listener: ((event: OperatorRequestsChangedEvent) => void) | undefined;
    const listDismissedOperatorQuestions = vi.fn(async () => [] as string[]);
    const desktopApi = { listDismissedOperatorQuestions,
      onOperatorRequestsChanged: (callback: (event: OperatorRequestsChangedEvent) => void) => {
        listener = callback;
        return () => { listener = undefined; };
      },
    };
    const selectedThread = remote ? thread : { ...thread, federation: undefined };
    const view = render(<View selectedThread={selectedThread} activeTurnId="active-turn" desktopApi={desktopApi} />);
    await waitFor(() => expect(listDismissedOperatorQuestions).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    listDismissedOperatorQuestions.mockResolvedValue(["question-1"]);
    act(() => listener!({ reason: "questions", backend: "codex", threadId: "thread-1",
      ...(remote ? { federationTarget: target } : {}),
    }));
    await waitFor(() => expect(screen.getByText("Dismissed")).toBeInTheDocument());
    expect(listDismissedOperatorQuestions).toHaveBeenLastCalledWith({ backend: "codex", threadId: "thread-1",
      ...(remote ? { federationTarget: target } : {}),
    });
    // Inspecting the question again must not undo its owner-side dismissal.
    fireEvent.click(screen.getByRole("button", { name: "Show questions" }));
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    act(() => listener!({ reason: "questions" }));
    await waitFor(() => expect(listDismissedOperatorQuestions).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    view.unmount();
    render(<View selectedThread={selectedThread} desktopApi={desktopApi} />);
    await waitFor(() => expect(screen.getByText("Dismissed")).toBeInTheDocument());
  });

  it("leaves the question open and reports an unsupported owner", async () => {
    const onShowNotice = vi.fn();
    const dismissOperatorQuestion = vi.fn(async () => { throw new Error("Update the owner instance."); });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<View desktopApi={{ dismissOperatorQuestion }} onShowNotice={onShowNotice} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(onShowNotice).toHaveBeenCalledWith(expect.objectContaining({
      tone: "error", message: "Update the owner instance.",
    })));
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it("keeps colliding local and remote question ids separate", async () => {
    const listDismissedOperatorQuestions = vi.fn(async (request: OperatorQuestionThreadRequest) =>
      request.federationTarget ? [] : ["question-1"]);
    const desktopApi = { listDismissedOperatorQuestions };
    const view = render(<View selectedThread={{ ...thread, federation: undefined }} desktopApi={desktopApi} />);
    await waitFor(() => expect(screen.getByText("Dismissed")).toBeInTheDocument());
    view.rerender(<View selectedThread={thread} desktopApi={desktopApi} />);
    await waitFor(() => expect(listDismissedOperatorQuestions).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("reloads a dismissal that arrives while an older snapshot is in flight", async () => {
    let listener: ((event: OperatorRequestsChangedEvent) => void) | undefined;
    let finishFirst!: (ids: string[]) => void;
    const first = new Promise<string[]>((resolve) => { finishFirst = resolve; });
    const listDismissedOperatorQuestions = vi.fn(async () => ["question-1"]).mockImplementationOnce(() => first);
    render(<View desktopApi={{ listDismissedOperatorQuestions,
      onOperatorRequestsChanged: (callback) => { listener = callback; return () => {}; },
    }} />);
    act(() => listener!({ reason: "questions", backend: "codex", threadId: "thread-1", federationTarget: target }));
    await act(async () => finishFirst([]));
    await waitFor(() => expect(screen.getByText("Dismissed")).toBeInTheDocument());
    expect(listDismissedOperatorQuestions).toHaveBeenCalledTimes(2);
  });
});
