import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentEvent,
  AppServerNotification,
  AppServerThreadActivityEntry,
  AppServerPendingRequestNotification,
  MessagingPlatformStatus,
  NavigationDirectorySummary,
  NavigationLaunchpadDraft,
  NavigationThreadSummary,
  StartReviewRequest,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import type { PendingMcpInteractionState } from "../mcp-elicitation";
import type { PendingQuestionnaireState } from "../questionnaire";

vi.mock("../IntegratedTerminal", () => ({
  IntegratedTerminal: (props: {
    threadKey: string;
    cwd?: string;
    height: number;
    visible?: boolean;
    onClose: () => void;
    onExit: () => void;
  }) => (
    <section
      aria-label="Integrated terminal"
      data-cwd={props.cwd ?? ""}
      data-height={props.height}
      data-thread-key={props.threadKey}
      hidden={props.visible === false}
    >
      <button type="button" title="Close terminal" onClick={props.onClose}>
        Close terminal
      </button>
      <button type="button" onClick={props.onExit}>
        Simulate terminal exit
      </button>
    </section>
  ),
}));

import { useIntegratedTerminals } from "../../../lib/useIntegratedTerminals";
import {
  ThreadView as ThreadViewWithTerminals,
  type ThreadViewProps,
} from "../ThreadView";

/**
 * `terminals` is owned by App in production (it has to outlive ThreadView's
 * unmounts). Tests drive ThreadView directly, so stand the real controller up
 * here against each test's mock `desktopApi` — that keeps the terminal
 * assertions exercising the actual open/hide/close logic rather than a stub.
 */
function ThreadView(props: Omit<ThreadViewProps, "terminals">): ReactElement {
  const terminals = useIntegratedTerminals(props.desktopApi);
  return <ThreadViewWithTerminals {...props} terminals={terminals} />;
}

function buildRendererLiveDiffEvent(params: {
  additions: number;
  diff: string;
  lazy?: boolean;
  path: string;
  removals: number;
  threadId: string;
  turnId: string;
}): AgentEvent {
  const entryId = `live-diff-${params.turnId}`;
  const basename = params.path.split(/[\\/]/).at(-1) ?? params.path;
  const rendererActivityEntry: AppServerThreadActivityEntry = {
    type: "activity",
    id: entryId,
    createdAt: 1_000,
    summary: `Edited 1 file, +${params.additions}, -${params.removals}`,
    details: [
      {
        id: `${entryId}-1`,
        kind: "write",
        label: `Update ${basename}`,
        path: params.path,
        fileDiff: {
          kind: "update",
          diff: params.lazy ? "" : params.diff,
          ...(params.lazy
            ? {
                diffRef: {
                  source: "live" as const,
                  key: `live:${params.threadId}:${entryId}:${entryId}-1`,
                  threadId: params.threadId,
                  entryId,
                  detailId: `${entryId}-1`,
                },
              }
            : {}),
          additions: params.additions,
          removals: params.removals,
        },
      },
    ],
  };
  return {
    backend: "codex",
    notification: {
      method: "turn/diff/updated",
      params: {
        threadId: params.threadId,
        turnId: params.turnId,
        diff: params.diff,
      },
    },
    rendererActivityEntry,
  };
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:expanded-transcript-image")
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn()
  });
});

describe("ThreadView", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows draggable empty thread chrome with messaging status", async () => {
    const statuses = [
      {
        changedAt: 1000,
        health: "enabled",
        platform: "telegram",
        account: "@pwragent_bot",
      },
    ] satisfies MessagingPlatformStatus[];

    render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[]}
        clearPendingRequest={() => undefined}
        composerDisabled={false}
        desktopApi={{
          getMessagingPlatformStatuses: vi.fn(async () => statuses),
          onMessagingPlatformStatusEvent: vi.fn(() => () => {}),
        }}
        loading={false}
        loadingMore={false}
        messageCount={0}
        skills={[]}
        transcriptEntries={[]}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
      />
    );

    expect(
      screen.getByRole("heading", { level: 2, name: "Pick a Thread" })
    ).toBeInTheDocument();
    const emptyState = screen
      .getByRole("heading", { level: 2, name: "Select a thread" })
      .closest(".thread-empty-state");
    const header = document.querySelector(".thread-header--placeholder");

    expect(emptyState).not.toBeNull();
    expect(emptyState?.querySelector(".thread-empty-state__content")).not.toBeNull();
    expect(header).not.toBeNull();
    await waitFor(() => {
      expect(screen.getByLabelText(/Telegram: Enabled/)).toBeInTheDocument();
    });
  });

  it("renders a directory-less thread with transcript history and context", () => {
    render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[
          {
            kind: "codex",
            label: "Codex app server",
            available: true,
            account: {
              type: "chatgpt",
              email: "user@example.com",
              planType: "pro",
              requiresOpenaiAuth: false,
            },
            rateLimits: [
              {
                name: "5h limit",
                usedPercent: 15,
                resetAt: Date.now() + 60 * 60 * 1000,
                windowSeconds: 18_000,
                windowMinutes: 300,
              },
              {
                name: "Weekly limit",
                usedPercent: 9,
                resetAt: Date.now() + 3 * 24 * 60 * 60 * 1000,
                windowSeconds: 604_800,
                windowMinutes: 10_080,
              },
            ],
            methods: ["thread/list", "thread/read", "turn/start", "skills/list"],
            capabilities: {
              listThreads: true,
              createThread: false,
              resumeThread: true,
              renameThread: false,
              readThread: true,
              startTurn: true,
              interruptTurn: false,
              steerTurn: false,
              transcriptPagination: true,
              toolUse: false,
              approvalRequests: false,
              multiDirectoryThreads: true
            },
            executionModes: [
              {
                mode: "default",
                label: "Default Access",
                available: true,
                isDefault: true,
              },
              {
                mode: "full-access",
                label: "Full Access",
                available: true,
              },
            ],
          },
          {
            kind: "grok",
            label: "Grok app server",
            available: false,
            methods: [],
            capabilities: {
              listThreads: false,
              createThread: false,
              resumeThread: false,
              renameThread: false,
              readThread: false,
              startTurn: false,
              interruptTurn: false,
              steerTurn: false,
              transcriptPagination: false,
              toolUse: false,
              approvalRequests: false,
              multiDirectoryThreads: false
            },
            executionModes: [
              {
                mode: "default",
                label: "Default Access",
                available: false,
                isDefault: true,
                unavailableReason: "XAI_API_KEY is not set",
              },
            ],
            unavailableReason: "XAI_API_KEY is not set"
          }
        ]}
        composerDisabled={false}
        desktopApi={{
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-2",
            turnId: "turn-1",
          }),
        }}
        loading={false}
        loadingMore={false}
        messageCount={2}
        platform="darwin"
        selectedThread={{
          id: "thread-2",
          title: "Plan the app-server protocol",
          titleSource: "explicit",
          summary:
            "Inspect **thread/read** output and normalize it for [desktop docs](https://example.com).",
          source: "codex",
          executionMode: "default",
          updatedAt: Date.now(),
          linkedDirectories: [],
          inbox: {
            inInbox: false
          }
        }}
        skills={[
          {
            name: "frontend-design",
            description: "Design and verify renderer UI work.",
            path: "/Users/huntharo/.codex/skills/frontend-design/SKILL.md",
            enabled: true,
          },
        ]}
        transcriptEntries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Inspect [$frontend-design](/Users/huntharo/.codex/skills/frontend-design/SKILL.md)."
          },
          {
            type: "activity",
            id: "activity-1",
            summary: "Explored 2 files",
            details: [
              {
                id: "detail-1",
                kind: "read",
                label: "Read TranscriptList.tsx"
              },
              {
                id: "detail-2",
                kind: "read",
                label: "Read ThreadView.tsx"
              }
            ]
          },
          {
            type: "message",
            id: "message-2",
            role: "assistant",
            text: "The desktop client now reads the full transcript."
          }
        ]}
        clearPendingRequest={() => undefined}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
        skillLoading={false}
      />
    );

    expect(
      screen.getByRole("heading", { level: 2, name: "Plan the app-server protocol" })
    ).toBeInTheDocument();
    expect(document.querySelector(".thread-header__compact-title")).toHaveTextContent(
      "Plan the app-server protocol"
    );
    expect(document.querySelector(".thread-header__title")).toBeNull();
    expect(document.querySelector(".thread-header__summary")).toBeNull();
    expect(screen.getAllByText("OpenAI").length).toBeGreaterThan(0);
    // The context rail is a tabbed activity bar now; clicking the Thread
    // info tab reveals its panel (linked directories + execution context).
    fireEvent.click(screen.getByRole("tab", { name: "Thread info" }));

    expect(screen.getByText("No linked directory")).toBeInTheDocument();
    expect(
      screen.getByText("The desktop client now reads the full transcript.")
    ).toBeInTheDocument();
    expect(screen.queryByText("thread/read")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "desktop docs" })).not.toBeInTheDocument();
    expect(screen.getByText("Explored 2 files")).toBeInTheDocument();
    expect(screen.getByText("$frontend-design")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Execution context" })).toBeInTheDocument();
    // Backend availability + account + rate limits now live under their own
    // Provider status tab (covered in ProviderStatusPanel.test.tsx). Here we
    // just confirm the tab is present in the rail.
    expect(screen.getByRole("tab", { name: "Provider status" })).toBeInTheDocument();
    expect(screen.getByLabelText("Reply")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("passes directory summaries to the thread review composer for project switching", async () => {
    const startReview = vi.fn(async (request: StartReviewRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      reviewThreadId: request.threadId,
      turnId: "turn-review-1",
    }));
    const giphyDirectory: NavigationDirectorySummary = {
      key: "directory:/Users/huntharo/GIPHY/giphy-services",
      kind: "directory",
      label: "giphy-services",
      path: "/Users/huntharo/GIPHY/giphy-services",
      threadKeys: ["codex:thread-1"],
      needsAttentionCount: 0,
      gitStatus: {
        currentBranch: "fix-channels-tagged-magic-tags-table",
        defaultBranch: "main",
        branches: ["fix-channels-tagged-magic-tags-table", "main"],
        baseBranches: [
          "origin/main",
          "main",
          "fix-channels-tagged-magic-tags-table",
        ],
        syncState: "untracked",
      },
    };
    const kubeDirectory: NavigationDirectorySummary = {
      key: "directory:/Users/huntharo/infra/kube-manifests",
      kind: "directory",
      label: "kube-manifests",
      path: "/Users/huntharo/infra/kube-manifests",
      threadKeys: ["codex:thread-1"],
      needsAttentionCount: 0,
      gitStatus: {
        currentBranch: "deploy/search-grpc",
        defaultBranch: "develop",
        branches: ["deploy/search-grpc", "develop"],
        baseBranches: [
          "origin/develop",
          "develop",
          "deploy/search-grpc",
        ],
        syncState: "untracked",
      },
    };

    render(
      <ThreadView
        addOptimisticReviewEntry={(_text) => "optimistic-review-1"}
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[]}
        clearPendingRequest={() => undefined}
        composerDisabled={false}
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startReview,
        }}
        directories={[giphyDirectory, kubeDirectory]}
        loading={false}
        loadingMore={false}
        messageCount={1}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
        selectedDirectory={giphyDirectory}
        selectedThread={{
          id: "thread-1",
          title: "Build Search gRPC",
          titleSource: "explicit",
          source: "codex",
          gitBranch: "deploy/search-grpc",
          executionMode: "default",
          updatedAt: Date.now(),
          linkedDirectories: [
            {
              id: "/Users/huntharo/GIPHY/giphy-services",
              kind: "worktree",
              label: "giphy-services",
              path: "/Users/huntharo/GIPHY/giphy-services",
              worktreePath:
                "/Users/huntharo/.codex/profiles/sstk/worktrees/mrctwp7f/giphy-services",
            },
            {
              id: "/Users/huntharo/infra/kube-manifests",
              kind: "worktree",
              label: "kube-manifests",
              path: "/Users/huntharo/infra/kube-manifests",
              worktreePath:
                "/Users/huntharo/.codex/profiles/sstk/worktrees/mrctwp7f/kube-manifests",
            },
          ],
          inbox: { inInbox: true },
        }}
        skills={[]}
        transcriptEntries={[]}
      />
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "/review" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await Promise.resolve();
    });

    expect(screen.getByLabelText("Base branch")).toHaveValue("origin/main");

    fireEvent.change(screen.getByLabelText("Review project"), {
      target: {
        value:
          "/Users/huntharo/.codex/profiles/sstk/worktrees/mrctwp7f/kube-manifests",
      },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Base branch")).toHaveValue("origin/develop");
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start review" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(startReview).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        target: { type: "baseBranch", branch: "origin/develop" },
        delivery: "inline",
        cwd:
          "/Users/huntharo/.codex/profiles/sstk/worktrees/mrctwp7f/kube-manifests",
      });
    });
  });

  it("keeps the integrated terminal open state per selected thread", async () => {
    const firstThread: NavigationThreadSummary = {
      id: "thread-a",
      title: "Thread A",
      titleSource: "explicit",
      source: "codex",
      executionMode: "default",
      updatedAt: Date.now(),
      projectKey: "/repo/a",
      linkedDirectories: [],
      inbox: {
        inInbox: true,
      },
    };
    const secondThread: NavigationThreadSummary = {
      ...firstThread,
      id: "thread-b",
      title: "Thread B",
      projectKey: "/repo/b",
    };
    const closeIntegratedTerminal = vi.fn(async () => undefined);
    const commonProps = {
      addOptimisticUserMessage: (_text: string) => "optimistic-1",
      backends: [],
      clearPendingRequest: () => undefined,
      composerDisabled: false,
      desktopApi: {
        closeIntegratedTerminal,
      },
      loading: false,
      loadingMore: false,
      messageCount: 1,
      onLoadOlder: async () => undefined,
      removeOptimisticMessage: (_id: string) => undefined,
      skills: [],
      transcriptEntries: [],
    };

    const { container, rerender } = render(
      <ThreadView {...commonProps} selectedThread={firstThread} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open integrated terminal" }));

    expect(await screen.findByLabelText("Integrated terminal")).toHaveAttribute(
      "data-thread-key",
      "codex:thread-a",
    );
    expect(screen.getByLabelText("Integrated terminal")).toHaveAttribute(
      "data-height",
      "260",
    );
    expect(screen.getByRole("button", { name: "Hide integrated terminal" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    rerender(<ThreadView {...commonProps} selectedThread={secondThread} />);

    expect(screen.getByLabelText("Integrated terminal")).not.toBeVisible();
    expect(
      container.querySelector('[aria-label="Integrated terminal"]'),
    ).toHaveAttribute("hidden");
    expect(closeIntegratedTerminal).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Open integrated terminal" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    rerender(<ThreadView {...commonProps} selectedThread={firstThread} />);

    expect(screen.getByLabelText("Integrated terminal")).toHaveAttribute(
      "data-cwd",
      "/repo/a",
    );
    expect(screen.getByRole("button", { name: "Hide integrated terminal" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Hide integrated terminal" }));

    expect(screen.getByLabelText("Integrated terminal")).not.toBeVisible();
    expect(
      container.querySelector('[aria-label="Integrated terminal"]'),
    ).toHaveAttribute("hidden");
    expect(closeIntegratedTerminal).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open integrated terminal" }));
    fireEvent.click(await screen.findByTitle("Close terminal"));

    expect(closeIntegratedTerminal).toHaveBeenCalledWith({
      threadKey: "codex:thread-a",
    });
  });

  // Regression: terminal state used to live in ThreadView's useState, so every
  // unmount (search view, or a refresh that flips `threadDetailPending`) left
  // the PTY running in main with nothing in the UI pointing at it. Main is the
  // owner now, so a freshly mounted ThreadView must rediscover live sessions.
  it("restores a running terminal reported by the main process without a click", async () => {
    const selectedThread: NavigationThreadSummary = {
      id: "thread-detached",
      title: "Thread Detached",
      titleSource: "explicit",
      source: "codex",
      executionMode: "default",
      updatedAt: Date.now(),
      projectKey: "/repo/detached",
      linkedDirectories: [],
      inbox: { inInbox: true },
    };
    const desktopApi = {
      listIntegratedTerminals: async () => [
        {
          sessionId: "session-1",
          threadKey: "codex:thread-detached",
          cwd: "/repo/detached",
          shell: "/bin/zsh",
          pid: 4242,
          panelHidden: false,
          createdAt: 1000,
        },
      ],
    } satisfies DesktopApi;

    render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[]}
        clearPendingRequest={() => undefined}
        composerDisabled={false}
        desktopApi={desktopApi}
        loading={false}
        loadingMore={false}
        messageCount={1}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
        selectedThread={selectedThread}
        skills={[]}
        transcriptEntries={[]}
      />,
    );

    const terminal = await screen.findByLabelText("Integrated terminal");
    expect(terminal).toHaveAttribute("data-thread-key", "codex:thread-detached");
    expect(terminal).toBeVisible();
    expect(
      await screen.findByRole("button", { name: "Hide integrated terminal" }),
    ).toBeInTheDocument();
  });

  it("flags a running terminal the user collapsed instead of silently hiding it", async () => {
    const selectedThread: NavigationThreadSummary = {
      id: "thread-collapsed",
      title: "Thread Collapsed",
      titleSource: "explicit",
      source: "codex",
      executionMode: "default",
      updatedAt: Date.now(),
      projectKey: "/repo/collapsed",
      linkedDirectories: [],
      inbox: { inInbox: true },
    };
    const desktopApi = {
      listIntegratedTerminals: async () => [
        {
          sessionId: "session-2",
          threadKey: "codex:thread-collapsed",
          cwd: "/repo/collapsed",
          shell: "/bin/zsh",
          pid: 4243,
          panelHidden: true,
          createdAt: 1000,
        },
      ],
    } satisfies DesktopApi;

    render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[]}
        clearPendingRequest={() => undefined}
        composerDisabled={false}
        desktopApi={desktopApi}
        loading={false}
        loadingMore={false}
        messageCount={1}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
        selectedThread={selectedThread}
        skills={[]}
        transcriptEntries={[]}
      />,
    );

    // The shell is alive but collapsed: the pane stays mounted-but-hidden and
    // the toggle advertises that there is something to come back to.
    const toggle = await screen.findByRole("button", {
      name: "Show running integrated terminal",
    });
    expect(toggle).toHaveClass("is-running");
    expect(screen.getByLabelText("Integrated terminal")).not.toBeVisible();
  });

  it("opens the integrated terminal in the local handoff directory when projectKey is stale", async () => {
    const selectedThread: NavigationThreadSummary = {
      id: "thread-local-handoff",
      title: "Local handoff",
      titleSource: "explicit",
      source: "codex",
      executionMode: "default",
      updatedAt: Date.now(),
      projectKey: "/repo/.codex/worktrees/stale/app",
      linkedDirectories: [
        {
          id: "pwragent-handoff:codex:thread-local-handoff",
          kind: "local",
          label: "app",
          path: "/repo/app",
        },
      ],
      inbox: {
        inInbox: true,
      },
    };

    render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[]}
        clearPendingRequest={() => undefined}
        composerDisabled={false}
        loading={false}
        loadingMore={false}
        messageCount={1}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
        selectedThread={selectedThread}
        skills={[]}
        transcriptEntries={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open integrated terminal" }));

    expect(await screen.findByLabelText("Integrated terminal")).toHaveAttribute(
      "data-cwd",
      "/repo/app",
    );
  });

  it("opens the integrated terminal in the linked worktree path instead of projectKey", async () => {
    const selectedThread: NavigationThreadSummary = {
      id: "thread-worktree-handoff",
      title: "Worktree handoff",
      titleSource: "explicit",
      source: "codex",
      executionMode: "default",
      updatedAt: Date.now(),
      projectKey: "/repo/app",
      linkedDirectories: [
        {
          id: "pwragent-handoff:codex:thread-worktree-handoff",
          kind: "worktree",
          label: "app",
          path: "/repo/app",
          worktreePath: "/repo/app/.worktrees/app-feature",
        },
      ],
      inbox: {
        inInbox: true,
      },
    };

    render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[]}
        clearPendingRequest={() => undefined}
        composerDisabled={false}
        loading={false}
        loadingMore={false}
        messageCount={1}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
        selectedThread={selectedThread}
        skills={[]}
        transcriptEntries={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open integrated terminal" }));

    expect(await screen.findByLabelText("Integrated terminal")).toHaveAttribute(
      "data-cwd",
      "/repo/app/.worktrees/app-feature",
    );
  });

  it("hides the integrated terminal when the pty exits without closing it again", async () => {
    const selectedThread: NavigationThreadSummary = {
      id: "thread-a",
      title: "Thread A",
      titleSource: "explicit",
      source: "codex",
      executionMode: "default",
      updatedAt: Date.now(),
      projectKey: "/repo/a",
      linkedDirectories: [],
      inbox: {
        inInbox: true,
      },
    };
    const closeIntegratedTerminal = vi.fn(async () => undefined);

    render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[]}
        clearPendingRequest={() => undefined}
        composerDisabled={false}
        desktopApi={{
          closeIntegratedTerminal,
        }}
        loading={false}
        loadingMore={false}
        messageCount={1}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
        selectedThread={selectedThread}
        skills={[]}
        transcriptEntries={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open integrated terminal" }));
    fireEvent.click(await screen.findByText("Simulate terminal exit"));

    expect(screen.queryByLabelText("Integrated terminal")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open integrated terminal" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(closeIntegratedTerminal).not.toHaveBeenCalled();
  });

  it("renders launchpad header chips and messaging status icons", async () => {
    const statuses = [
      {
        changedAt: 1000,
        health: "enabled",
        platform: "telegram",
        account: "@pwragent_bot",
      },
    ] satisfies MessagingPlatformStatus[];
    const selectedDirectory = {
      key: "directory:/Users/huntharo/github/PwrAgnt",
      kind: "directory",
      label: "PwrAgnt",
      path: "/Users/huntharo/github/PwrAgnt",
      threadKeys: ["thread-1", "thread-2"],
      needsAttentionCount: 0,
      gitStatus: {
        currentBranch: "main",
        upstreamBranch: "origin/main",
        syncState: "in-sync",
      },
    } satisfies NavigationDirectorySummary;
    const selectedLaunchpad = {
      backend: "codex",
      branchName: "main",
      createdAt: 1000,
      directoryKey: selectedDirectory.key,
      directoryKind: selectedDirectory.kind,
      directoryLabel: selectedDirectory.label,
      directoryPath: selectedDirectory.path,
      executionMode: "full-access",
      prompt: "",
      updatedAt: 1000,
      workMode: "worktree",
    } satisfies NavigationLaunchpadDraft;

    render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[
          {
            kind: "codex",
            label: "Codex app server",
            available: true,
            methods: ["thread/list", "thread/read", "turn/start", "skills/list"],
            capabilities: {
              listThreads: true,
              createThread: true,
              resumeThread: true,
              renameThread: false,
              readThread: true,
              startTurn: true,
              interruptTurn: false,
              steerTurn: false,
              transcriptPagination: true,
              toolUse: false,
              approvalRequests: false,
              multiDirectoryThreads: true,
            },
            executionModes: [
              {
                mode: "default",
                label: "Default Access",
                available: true,
                isDefault: true,
              },
              {
                mode: "full-access",
                label: "Full Access",
                available: true,
              },
            ],
          },
        ]}
        clearPendingRequest={() => undefined}
        composerDisabled={false}
        desktopApi={{
          getMessagingPlatformStatuses: vi.fn(async () => statuses),
          onMessagingPlatformStatusEvent: vi.fn(() => () => {}),
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-launchpad",
            turnId: "turn-1",
          }),
        }}
        loading={false}
        loadingMore={false}
        messageCount={2}
        selectedDirectory={selectedDirectory}
        selectedLaunchpad={selectedLaunchpad}
        skills={[]}
        transcriptEntries={[]}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
      />
    );

    const header = document.querySelector(".thread-header--launchpad");
    expect(header).not.toBeNull();
    expect(within(header as HTMLElement).getByText("New thread")).toBeInTheDocument();
    expect(within(header as HTMLElement).getByText("Codex app server")).toBeInTheDocument();
    // Access mode is shown only in the composer now, not the header.
    expect(within(header as HTMLElement).queryByText("Full Access")).toBeNull();
    await waitFor(() => {
      expect(screen.getByLabelText(/Telegram: Enabled/)).toBeInTheDocument();
    });
    expect(screen.getByRole("group", { name: "Messaging platform status" })).toBeInTheDocument();
  });

  it("shows environment setup details from config even when the deprecated setup flag is false", async () => {
    const selectedDirectory = {
      key: "directory:/repo",
      kind: "directory",
      label: "PwrSnap",
      path: "/repo",
      threadKeys: [],
      needsAttentionCount: 0,
    } satisfies NavigationDirectorySummary;
    const selectedLaunchpad = {
      backend: "codex",
      createdAt: 1000,
      directoryKey: selectedDirectory.key,
      directoryKind: selectedDirectory.kind,
      directoryLabel: selectedDirectory.label,
      directoryPath: selectedDirectory.path,
      executionMode: "full-access",
      prompt: "Investigate clipboard filenames",
      updatedAt: 1000,
      workMode: "worktree",
      codexEnvironmentId: "environment",
      codexEnvironmentExecutionTarget: "local",
      // Deprecated persisted value from older launchpad rows.
      codexEnvironmentSetupEnabled: false,
      codexEnvironmentOptions: [
        {
          id: "environment",
          name: "PwrSnap",
          sourcePath: "/repo/.codex/environments/environment.toml",
          setupScript: "nvm install\ncorepack enable\npnpm install",
          actions: [],
        },
      ],
    } satisfies NavigationLaunchpadDraft;
    const onMaterializeLaunchpad = vi.fn(() => new Promise<void>(() => {}));

    render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[
          {
            kind: "codex",
            label: "Codex app server",
            available: true,
            methods: ["thread/list", "thread/read", "turn/start", "skills/list"],
            capabilities: {
              listThreads: true,
              createThread: true,
              resumeThread: true,
              renameThread: false,
              readThread: true,
              startTurn: true,
              interruptTurn: false,
              steerTurn: false,
              transcriptPagination: true,
              toolUse: false,
              approvalRequests: false,
              multiDirectoryThreads: true,
            },
            executionModes: [
              {
                mode: "full-access",
                label: "Full Access",
                available: true,
                isDefault: true,
              },
            ],
          },
        ]}
        clearPendingRequest={() => undefined}
        composerDisabled={false}
        loading={false}
        loadingMore={false}
        messageCount={0}
        selectedDirectory={selectedDirectory}
        selectedLaunchpad={selectedLaunchpad}
        skills={[]}
        transcriptEntries={[]}
        onLoadOlder={async () => undefined}
        onMaterializeLaunchpad={onMaterializeLaunchpad}
        removeOptimisticMessage={(_id) => undefined}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));

    expect(
      await screen.findByRole("heading", { name: "Running environment setup" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Setup command")).toHaveTextContent("pnpm install");
    expect(screen.getAllByText("PwrSnap").length).toBeGreaterThan(0);
  });

  it("shows pending environment setup while a forked worktree is preparing", async () => {
    let setupProgress: Parameters<
      NonNullable<DesktopApi["onCodexEnvironmentSetupProgress"]>
    >[0] = () => undefined;
    const desktopApi = {
      onCodexEnvironmentSetupProgress: (callback: typeof setupProgress) => {
        setupProgress = callback;
        return () => undefined;
      },
    };

    render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[]}
        clearPendingRequest={() => undefined}
        composerDisabled={false}
        desktopApi={desktopApi}
        loading={false}
        loadingMore={false}
        messageCount={0}
        pendingForkEnvironmentSetup={{
          backend: "codex",
          command: "pnpm install",
          directoryKey: "fork:codex:thread-parent:new-worktree",
          directoryLabel: "PwrAgent",
          environmentId: "pwragent",
          environmentName: "PwrAgent",
        }}
        skills={[]}
        transcriptEntries={[]}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Running environment setup" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Setup command")).toHaveTextContent("pnpm install");
    expect(screen.getByText("New worktree")).toBeInTheDocument();

    act(() => {
      setupProgress({
        at: Date.now(),
        command: "pnpm install",
        cwd: "/repo/app/.worktrees/thread-fork/app",
        directoryKey: "fork:codex:thread-parent:new-worktree",
        environmentId: "pwragent",
        environmentName: "PwrAgent",
        phase: "stdout",
        chunk: "installing dependencies\n",
      });
    });

    expect(screen.getByText("/repo/app/.worktrees/thread-fork/app")).toBeInTheDocument();
    expect(screen.getByLabelText("Setup output")).toHaveTextContent(
      "installing dependencies",
    );
  });

  it("keeps launch failures closable from the pending setup screen", async () => {
    const selectedDirectory = {
      key: "directory:/repo",
      kind: "directory",
      label: "PwrAgent",
      path: "/repo",
      threadKeys: [],
      needsAttentionCount: 0,
    } satisfies NavigationDirectorySummary;
    const selectedLaunchpad = {
      backend: "acp:gemini",
      createdAt: 1000,
      directoryKey: selectedDirectory.key,
      directoryKind: selectedDirectory.kind,
      directoryLabel: selectedDirectory.label,
      directoryPath: selectedDirectory.path,
      executionMode: "default",
      prompt: "Run node --version",
      updatedAt: 1000,
      workMode: "worktree",
    } satisfies NavigationLaunchpadDraft;
    const onMaterializeLaunchpad = vi.fn(async () => {
      throw new Error("json-rpc error (500): You have exhausted your capacity on this model.");
    });

    render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[
          {
            kind: "acp:gemini",
            label: "Gemini",
            available: true,
            methods: ["session/new", "session/prompt"],
            capabilities: {
              listThreads: true,
              createThread: true,
              resumeThread: true,
              renameThread: true,
              readThread: true,
              startTurn: true,
              interruptTurn: true,
              steerTurn: false,
              transcriptPagination: false,
              toolUse: true,
              approvalRequests: true,
              multiDirectoryThreads: true,
            },
            executionModes: [],
          },
        ]}
        clearPendingRequest={() => undefined}
        composerDisabled={false}
        loading={false}
        loadingMore={false}
        messageCount={0}
        selectedDirectory={selectedDirectory}
        selectedLaunchpad={selectedLaunchpad}
        skills={[]}
        transcriptEntries={[]}
        onLoadOlder={async () => undefined}
        onMaterializeLaunchpad={onMaterializeLaunchpad}
        removeOptimisticMessage={(_id) => undefined}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));

    expect(await screen.findByRole("heading", { name: "Could not start PwrAgent" }))
      .toBeInTheDocument();
    expect(
      screen.getByText(
        "json-rpc error (500): You have exhausted your capacity on this model.",
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(await screen.findByRole("textbox", { name: "New thread" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Start thread" })).toBeInTheDocument();
  });

  it("describes sub-thread launchpads as grouped children with empty history", () => {
    const selectedDirectory = {
      key: "subthread:codex:thread-parent:new-worktree",
      kind: "directory",
      label: "PwrAgnt",
      path: "/Users/huntharo/pwrdrvr/PwrAgnt",
      threadKeys: [],
      needsAttentionCount: 0,
    } satisfies NavigationDirectorySummary;
    const selectedLaunchpad = {
      backend: "codex",
      branchName: "main",
      createdAt: 1000,
      directoryKey: selectedDirectory.key,
      directoryKind: selectedDirectory.kind,
      directoryLabel: selectedDirectory.label,
      directoryPath: selectedDirectory.path,
      executionMode: "default",
      parentThreadId: "thread-parent",
      parentThreadTitle: "Issue 193 Markdown attachments",
      prompt: "",
      updatedAt: 1000,
      workMode: "worktree",
    } satisfies NavigationLaunchpadDraft;

    render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[]}
        clearPendingRequest={() => undefined}
        composerDisabled={false}
        loading={false}
        loadingMore={false}
        messageCount={0}
        selectedDirectory={selectedDirectory}
        selectedLaunchpad={selectedLaunchpad}
        skills={[]}
        transcriptEntries={[]}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
      />
    );

    expect(screen.getByText("Grouped under")).toBeInTheDocument();
    expect(screen.getByText("Issue 193 Markdown attachments")).toBeInTheDocument();
    expect(screen.getByText("History")).toBeInTheDocument();
    expect(screen.getByText("Starts empty")).toBeInTheDocument();
    expect(screen.getByText("Base branch")).toBeInTheDocument();
    expect(screen.getAllByText("main").length).toBeGreaterThan(0);
    expect(screen.queryByText("Not a Git repo")).not.toBeInTheDocument();
  });

  it("describes same-worktree sub-thread launchpads as shared worktrees", () => {
    const selectedDirectory = {
      key: "subthread:codex:thread-parent:same-worktree",
      kind: "directory",
      label: "PwrAgnt",
      path: "/Users/huntharo/.codex/worktrees/mpsmzvdh/PwrAgnt",
      threadKeys: [],
      needsAttentionCount: 0,
    } satisfies NavigationDirectorySummary;
    const selectedLaunchpad = {
      backend: "codex",
      branchName: "feat/messaging-artifact-delivery",
      createdAt: 1000,
      directoryKey: selectedDirectory.key,
      directoryKind: selectedDirectory.kind,
      directoryLabel: selectedDirectory.label,
      directoryPath: selectedDirectory.path,
      executionMode: "default",
      parentThreadId: "thread-parent",
      parentThreadTitle: "Issue 193 Markdown attachments",
      prompt: "",
      updatedAt: 1000,
      workMode: "local",
    } satisfies NavigationLaunchpadDraft;

    render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[]}
        clearPendingRequest={() => undefined}
        composerDisabled={false}
        loading={false}
        loadingMore={false}
        messageCount={0}
        selectedDirectory={selectedDirectory}
        selectedLaunchpad={selectedLaunchpad}
        skills={[]}
        transcriptEntries={[]}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
      />
    );

    expect(screen.getByText("Workspace").nextElementSibling).toHaveTextContent(
      "Same worktree",
    );
    expect(screen.getByText("Current branch").nextElementSibling).toHaveTextContent(
      "feat/messaging-artifact-delivery",
    );
    expect(screen.getByText("Status").nextElementSibling).toHaveTextContent(
      "Git worktree",
    );
    expect(screen.queryByText("Local checkout")).not.toBeInTheDocument();
    expect(screen.queryByText("Not a Git repo")).not.toBeInTheDocument();
  });

  it("keeps launchpad drafts editable until a known backend reports unavailable", async () => {
    const selectedDirectory = {
      key: "workspace:new-thread",
      kind: "workspace",
      label: "Workspaces",
      threadKeys: [],
      needsAttentionCount: 0,
    } satisfies NavigationDirectorySummary;
    const selectedLaunchpad = {
      backend: "codex",
      createdAt: 1000,
      directoryKey: selectedDirectory.key,
      directoryKind: selectedDirectory.kind,
      directoryLabel: selectedDirectory.label,
      executionMode: "default",
      prompt: "",
      updatedAt: 1000,
      workMode: "local",
    } satisfies NavigationLaunchpadDraft;

    render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[]}
        clearPendingRequest={() => undefined}
        composerDisabled={false}
        loading={false}
        loadingMore={false}
        messageCount={0}
        selectedDirectory={selectedDirectory}
        selectedLaunchpad={selectedLaunchpad}
        skills={[]}
        transcriptEntries={[]}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
      />
    );

    expect(await screen.findByRole("textbox", { name: "New thread" })).toBeEnabled();
  });

  it("surfaces ACP unavailable reasons in launchpad drafts", async () => {
    const selectedDirectory = {
      key: "workspace:new-thread",
      kind: "workspace",
      label: "Workspaces",
      threadKeys: [],
      needsAttentionCount: 0,
    } satisfies NavigationDirectorySummary;
    const selectedLaunchpad = {
      backend: "acp:gemini",
      createdAt: 1000,
      directoryKey: selectedDirectory.key,
      directoryKind: selectedDirectory.kind,
      directoryLabel: selectedDirectory.label,
      executionMode: "default",
      prompt: "",
      updatedAt: 1000,
      workMode: "local",
    } satisfies NavigationLaunchpadDraft;

    render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[
          {
            kind: "acp:gemini",
            label: "Gemini",
            available: false,
            methods: [],
            capabilities: {
              listThreads: true,
              createThread: true,
              resumeThread: true,
              renameThread: true,
              readThread: true,
              startTurn: true,
              interruptTurn: true,
              steerTurn: false,
              transcriptPagination: true,
              toolUse: false,
              approvalRequests: true,
              multiDirectoryThreads: false,
            },
            executionModes: [
              {
                mode: "default",
                label: "Default",
                available: false,
                isDefault: true,
                unavailableReason: "ACP agent authentication required",
              },
            ],
            unavailableReason: "ACP agent authentication required",
          },
        ]}
        clearPendingRequest={() => undefined}
        composerDisabled={false}
        loading={false}
        loadingMore={false}
        messageCount={0}
        selectedDirectory={selectedDirectory}
        selectedLaunchpad={selectedLaunchpad}
        skills={[]}
        transcriptEntries={[]}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
      />
    );

    expect(
      await screen.findByText("ACP agent authentication required")
    ).toHaveClass("composer__meta--error");
    expect(screen.getByRole("textbox", { name: "New thread" })).toHaveAttribute(
      "contenteditable",
      "false",
    );
  });

  it("shows missing recorded working directory details and copies the thread id", async () => {
    const copyText = vi.fn(async () => undefined);
    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        copyText
      }
    });

    render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[
          {
            kind: "codex",
            label: "Codex app server",
            available: true,
            methods: ["thread/list", "thread/read", "turn/start", "skills/list"],
            capabilities: {
              listThreads: true,
              createThread: false,
              resumeThread: true,
              renameThread: false,
              readThread: true,
              startTurn: true,
              interruptTurn: false,
              steerTurn: false,
              transcriptPagination: true,
              toolUse: false,
              approvalRequests: false,
              multiDirectoryThreads: true
            },
            executionModes: [
              {
                mode: "default",
                label: "Default Access",
                available: true,
                isDefault: true,
              },
            ],
          }
        ]}
        composerDisabled={false}
        desktopApi={{
          startTurn: async () => ({
            backend: "codex",
            threadId: "019d88a2-0e0b-77f0-bfce-130ae8e37d8f",
            turnId: "turn-1",
          }),
        }}
        loading={false}
        loadingMore={false}
        messageCount={1}
        selectedThread={{
          id: "019d88a2-0e0b-77f0-bfce-130ae8e37d8f",
          title: "Plan Slidev theme extraction",
          titleSource: "explicit",
          source: "codex",
          projectKey: "/Users/huntharo/.codex/worktrees/be87/search-product",
          updatedAt: Date.now(),
          linkedDirectories: [],
          inbox: {
            inInbox: false
          }
        }}
        skills={[]}
        transcriptEntries={[
          {
            type: "message",
            id: "message-1",
            role: "assistant",
            text: "The thread still loads."
          }
        ]}
        clearPendingRequest={() => undefined}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "This thread is linked to a directory that no longer exists: /Users/huntharo/.codex/worktrees/be87/search-product"
    );

    fireEvent.click(screen.getByRole("tab", { name: "Thread info" }));

    expect(screen.getByText("Recorded working directory is no longer available.")).toBeInTheDocument();
    expect(screen.getByText("search-product")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy thread id" }));

    expect(copyText).toHaveBeenCalledWith("019d88a2-0e0b-77f0-bfce-130ae8e37d8f");
  });

  it("opens transcript image previews in a lightbox and dismisses them with Escape", () => {
    const dataUrl = "data:image/png;base64,aGVsbG8=";

    render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[
          {
            kind: "codex",
            label: "Codex app server",
            available: true,
            methods: ["thread/list", "thread/read", "turn/start", "skills/list"],
            capabilities: {
              listThreads: true,
              createThread: false,
              resumeThread: true,
              renameThread: false,
              readThread: true,
              startTurn: true,
              interruptTurn: false,
              steerTurn: false,
              transcriptPagination: true,
              toolUse: false,
              approvalRequests: false,
              multiDirectoryThreads: true
            },
            executionModes: [
              {
                mode: "default",
                label: "Default Access",
                available: true,
                isDefault: true,
              },
            ],
          }
        ]}
        composerDisabled={false}
        desktopApi={{
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-images",
            turnId: "turn-1",
          }),
        }}
        loading={false}
        loadingMore={false}
        messageCount={1}
        selectedThread={{
          id: "thread-images",
          title: "Inspect image rendering",
          titleSource: "explicit",
          source: "codex",
          updatedAt: Date.now(),
          linkedDirectories: [],
          inbox: {
            inInbox: false
          }
        }}
        skills={[]}
        transcriptEntries={[
          {
            type: "message",
            id: "message-image-1",
            role: "user",
            text: "",
            parts: [
              {
                type: "image",
                url: dataUrl,
                alt: "Transcript screenshot"
              }
            ]
          }
        ]}
        clearPendingRequest={() => undefined}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Expand transcript image 1" }));

    const dialog = screen.getByRole("dialog", { name: "Expanded image" });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByAltText("Transcript screenshot")).toHaveAttribute(
      "src",
      "blob:expanded-transcript-image"
    );

    fireEvent.keyDown(window, { key: "Escape" });

    expect(
      screen.queryByRole("dialog", { name: "Expanded image" })
    ).not.toBeInTheDocument();
  });

  it("clears an expanded transcript image when the selected thread changes", () => {
    const viewProps = {
      addOptimisticUserMessage: (_text: string) => "optimistic-1",
      backends: [
        {
          kind: "codex" as const,
          label: "Codex app server",
          available: true,
          methods: ["thread/list", "thread/read", "turn/start", "skills/list"],
          capabilities: {
            listThreads: true,
            createThread: false,
            resumeThread: true,
            renameThread: false,
            readThread: true,
            startTurn: true,
            interruptTurn: false,
            steerTurn: false,
            transcriptPagination: true,
            toolUse: false,
            approvalRequests: false,
            multiDirectoryThreads: true
          },
          executionModes: [
            {
              mode: "default" as const,
              label: "Default Access",
              available: true,
              isDefault: true,
            },
          ],
        }
      ],
      composerDisabled: false,
      desktopApi: {
        startTurn: async () => ({
          backend: "codex" as const,
          threadId: "thread-images",
          turnId: "turn-1",
        }),
      },
      loading: false,
      loadingMore: false,
      messageCount: 1,
      skills: [],
      transcriptEntries: [
        {
          type: "message" as const,
          id: "message-image-1",
          role: "user" as const,
          text: "",
          parts: [
            {
              type: "image" as const,
              url: "file:///tmp/screenshot.png",
              alt: "Transcript screenshot"
            }
          ]
        }
      ],
      clearPendingRequest: () => undefined,
      onLoadOlder: async () => undefined,
      removeOptimisticMessage: (_id: string) => undefined,
    };

    const { rerender } = render(
      <ThreadView
        {...viewProps}
        selectedThread={{
          id: "thread-images",
          title: "Inspect image rendering",
          titleSource: "explicit",
          source: "codex",
          updatedAt: Date.now(),
          linkedDirectories: [],
          inbox: {
            inInbox: false
          }
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Expand transcript image 1" }));
    expect(screen.getByRole("dialog", { name: "Expanded image" })).toBeInTheDocument();

    rerender(
      <ThreadView
        {...viewProps}
        selectedThread={{
          id: "thread-next",
          title: "Another thread",
          titleSource: "explicit",
          source: "codex",
          updatedAt: Date.now(),
          linkedDirectories: [],
          inbox: {
            inInbox: false
          }
        }}
      />
    );

    expect(
      screen.queryByRole("dialog", { name: "Expanded image" })
    ).not.toBeInTheDocument();
  });

  it("renders live assistant commentary passed in from session state", async () => {
    const selectedThread = {
      id: "thread-2",
      title: "Plan the app-server protocol",
      titleSource: "explicit" as const,
      source: "codex" as const,
      updatedAt: Date.now(),
      linkedDirectories: [],
      inbox: {
        inInbox: false
      }
    };

    const { rerender } = render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[
          {
            kind: "codex",
            label: "Codex app server",
            available: true,
            methods: ["thread/list", "thread/read", "turn/start", "skills/list"],
            capabilities: {
              listThreads: true,
              createThread: false,
              resumeThread: true,
              renameThread: false,
              readThread: true,
              startTurn: true,
              interruptTurn: false,
              steerTurn: false,
              transcriptPagination: true,
              toolUse: false,
              approvalRequests: false,
              multiDirectoryThreads: true
            },
            executionModes: [
              {
                mode: "default",
                label: "Default Access",
                available: true,
                isDefault: true,
              },
            ],
          }
        ]}
        composerDisabled={false}
        desktopApi={{
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-2",
            turnId: "turn-1",
          }),
        }}
        loading={false}
        loadingMore={false}
        messageCount={1}
        selectedThread={selectedThread}
        skills={[]}
        transcriptEntries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Run npm view dive"
          }
        ]}
        clearPendingRequest={() => undefined}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
      />
    );

    rerender(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[
          {
            kind: "codex",
            label: "Codex app server",
            available: true,
            methods: ["thread/list", "thread/read", "turn/start", "skills/list"],
            capabilities: {
              listThreads: true,
              createThread: false,
              resumeThread: true,
              renameThread: false,
              readThread: true,
              startTurn: true,
              interruptTurn: false,
              steerTurn: false,
              transcriptPagination: true,
              toolUse: false,
              approvalRequests: false,
              multiDirectoryThreads: true
            },
            executionModes: [
              {
                mode: "default",
                label: "Default Access",
                available: true,
                isDefault: true,
              },
            ],
          }
        ]}
        composerDisabled={false}
        desktopApi={{
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-2",
            turnId: "turn-1",
          }),
        }}
        loading={false}
        loadingMore={false}
        messageCount={1}
        pendingAssistantMessage={{
          type: "message",
          id: "msg-1",
          role: "assistant",
          phase: "commentary",
          text: "I ran `npm view dive`"
        }}
        selectedThread={selectedThread}
        skills={[]}
        transcriptEntries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Run npm view dive"
          }
        ]}
        clearPendingRequest={() => undefined}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
      />
    );

    expect(screen.getByText("I ran")).toBeInTheDocument();
    expect(screen.getByText("npm view dive")).toBeInTheDocument();
    expect(screen.getByText("I ran").closest("article")).toHaveClass(
      "transcript-message--assistant"
    );

    rerender(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[
          {
            kind: "codex",
            label: "Codex app server",
            available: true,
            methods: ["thread/list", "thread/read", "turn/start", "skills/list"],
            capabilities: {
              listThreads: true,
              createThread: false,
              resumeThread: true,
              renameThread: false,
              readThread: true,
              startTurn: true,
              interruptTurn: false,
              steerTurn: false,
              transcriptPagination: true,
              toolUse: false,
              approvalRequests: false,
              multiDirectoryThreads: true
            },
            executionModes: [
              {
                mode: "default",
                label: "Default Access",
                available: true,
                isDefault: true,
              },
            ],
          }
        ]}
        composerDisabled={false}
        desktopApi={{
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-2",
            turnId: "turn-1",
          }),
        }}
        loading={false}
        loadingMore={false}
        messageCount={1}
        selectedThread={selectedThread}
        skills={[]}
        transcriptEntries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Run npm view dive"
          }
        ]}
        clearPendingRequest={() => undefined}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
      />
    );

    expect(screen.queryByText("I ran")).not.toBeInTheDocument();
  });

  it("renders live plan progress from turn/plan/updated and clears it once replay catches up", async () => {
    const selectedThread = {
      id: "thread-2",
      title: "Plan the app-server protocol",
      titleSource: "explicit" as const,
      source: "codex" as const,
      updatedAt: Date.now(),
      linkedDirectories: [],
      inbox: {
        inInbox: false
      }
    };
    const livePlan = {
      type: "plan" as const,
      id: "persisted-plan-1",
      explanation: "Track the desktop transcript work in three steps.",
      steps: [
        { step: "Normalize replay", status: "pending" as const },
        { step: "Render plan card", status: "pending" as const },
        { step: "Verify the thread view", status: "pending" as const }
      ]
    };
    let agentEventHandler: ((event: AgentEvent) => void) | undefined;

    const { rerender } = render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[
          {
            kind: "codex",
            label: "Codex app server",
            available: true,
            methods: ["thread/list", "thread/read", "turn/start", "skills/list"],
            capabilities: {
              listThreads: true,
              createThread: false,
              resumeThread: true,
              renameThread: false,
              readThread: true,
              startTurn: true,
              interruptTurn: false,
              steerTurn: false,
              transcriptPagination: true,
              toolUse: false,
              approvalRequests: false,
              multiDirectoryThreads: true
            },
            executionModes: [
              {
                mode: "default",
                label: "Default Access",
                available: true,
                isDefault: true,
              },
            ],
          }
        ]}
        composerDisabled={false}
        desktopApi={{
          onAgentEvent: (callback) => {
            agentEventHandler = callback as typeof agentEventHandler;
            return () => undefined;
          },
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-2",
            turnId: "turn-1",
          }),
        }}
        loading={false}
        loadingMore={false}
        messageCount={1}
        selectedThread={selectedThread}
        skills={[]}
        transcriptEntries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Render the task list."
          }
        ]}
        clearPendingRequest={() => undefined}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
      />
    );

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/plan/updated",
          params: {
            threadId: "thread-2",
            turnId: "turn-1",
            plan: {
              explanation: livePlan.explanation,
              steps: livePlan.steps
            }
          }
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/plan/updated",
          params: {
            threadId: "thread-other",
            turnId: "turn-2",
            plan: {
              explanation: "Ignore this other thread.",
              steps: [{ step: "Ignore", status: "completed" }]
            }
          }
        },
      });
    });

    expect(screen.getByText("0 out of 3 tasks completed")).toBeInTheDocument();
    expect(screen.getByText("Normalize replay")).toBeInTheDocument();
    expect(screen.getByText("Render plan card")).toBeInTheDocument();
    expect(screen.getByText("Verify the thread view")).toBeInTheDocument();
    expect(screen.queryByText("Ignore this other thread.")).not.toBeInTheDocument();

    rerender(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[
          {
            kind: "codex",
            label: "Codex app server",
            available: true,
            methods: ["thread/list", "thread/read", "turn/start", "skills/list"],
            capabilities: {
              listThreads: true,
              createThread: false,
              resumeThread: true,
              renameThread: false,
              readThread: true,
              startTurn: true,
              interruptTurn: false,
              steerTurn: false,
              transcriptPagination: true,
              toolUse: false,
              approvalRequests: false,
              multiDirectoryThreads: true
            },
            executionModes: [
              {
                mode: "default",
                label: "Default Access",
                available: true,
                isDefault: true,
              },
            ],
          }
        ]}
        composerDisabled={false}
        desktopApi={{
          onAgentEvent: (callback) => {
            agentEventHandler = callback as typeof agentEventHandler;
            return () => undefined;
          },
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-2",
            turnId: "turn-1",
          }),
        }}
        loading={false}
        loadingMore={false}
        messageCount={1}
        selectedThread={selectedThread}
        skills={[]}
        transcriptEntries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Render the task list."
          },
          livePlan
        ]}
        clearPendingRequest={() => undefined}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
      />
    );

    expect(screen.getAllByText("0 out of 3 tasks completed")).toHaveLength(1);
  });

  it("renders live plan markdown from item plan notifications", async () => {
    const selectedThread = {
      id: "thread-2",
      title: "Plan breakfast",
      titleSource: "explicit" as const,
      source: "codex" as const,
      updatedAt: Date.now(),
      linkedDirectories: [],
      inbox: {
        inInbox: false
      }
    };
    let agentEventHandler: ((event: AgentEvent) => void) | undefined;

    const { rerender } = render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[
          {
            kind: "codex",
            label: "Codex app server",
            available: true,
            methods: ["thread/list", "thread/read", "turn/start", "skills/list"],
            capabilities: {
              listThreads: true,
              createThread: false,
              resumeThread: true,
              renameThread: false,
              readThread: true,
              startTurn: true,
              interruptTurn: false,
              steerTurn: false,
              transcriptPagination: true,
              toolUse: false,
              approvalRequests: false,
              multiDirectoryThreads: true
            },
            executionModes: [
              {
                mode: "default",
                label: "Default Access",
                available: true,
                isDefault: true,
              },
            ],
          }
        ]}
        composerDisabled={false}
        desktopApi={{
          onAgentEvent: (callback) => {
            agentEventHandler = callback as typeof agentEventHandler;
            return () => undefined;
          },
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-2",
            turnId: "turn-1",
          }),
        }}
        loading={false}
        loadingMore={false}
        messageCount={1}
        selectedThread={selectedThread}
        skills={[]}
        transcriptEntries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Make a breakfast plan."
          }
        ]}
        clearPendingRequest={() => undefined}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
      />
    );

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/plan/delta",
          params: {
            threadId: "thread-2",
            turnId: "turn-1",
            item: {
              id: "plan-item-1",
              type: "plan"
            },
            delta: "## Breakfast plan\n\n"
          }
        } as AppServerNotification,
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/plan/delta",
          params: {
            threadId: "thread-2",
            turnId: "turn-1",
            item: {
              id: "plan-item-1",
              type: "plan"
            },
            delta: "Choose bagels after checking the cream cheese."
          }
        } as AppServerNotification,
      });
    });

    expect(screen.getByRole("heading", { name: "Breakfast plan" })).toBeInTheDocument();
    expect(
      screen.getByText("Choose bagels after checking the cream cheese.")
    ).toBeInTheDocument();

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-2",
            turnId: "turn-1",
            item: {
              id: "plan-item-1",
              type: "plan",
              text: "## Final breakfast plan\n\nEat bagels if the cream cheese passes inspection."
            }
          }
        },
      });
    });

    expect(screen.getByRole("heading", { name: "Final breakfast plan" })).toBeInTheDocument();
    expect(
      screen.getByText("Eat bagels if the cream cheese passes inspection.")
    ).toBeInTheDocument();

    rerender(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[
          {
            kind: "codex",
            label: "Codex app server",
            available: true,
            methods: ["thread/list", "thread/read", "turn/start", "skills/list"],
            capabilities: {
              listThreads: true,
              createThread: false,
              resumeThread: true,
              renameThread: false,
              readThread: true,
              startTurn: true,
              interruptTurn: false,
              steerTurn: false,
              transcriptPagination: true,
              toolUse: false,
              approvalRequests: false,
              multiDirectoryThreads: true
            },
            executionModes: [
              {
                mode: "default",
                label: "Default Access",
                available: true,
                isDefault: true,
              },
            ],
          }
        ]}
        composerDisabled={false}
        desktopApi={{
          onAgentEvent: (callback) => {
            agentEventHandler = callback as typeof agentEventHandler;
            return () => undefined;
          },
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-2",
            turnId: "turn-1",
          }),
        }}
        loading={false}
        loadingMore={false}
        messageCount={1}
        selectedThread={selectedThread}
        skills={[]}
        transcriptEntries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Make a breakfast plan."
          },
          {
            type: "plan",
            id: "persisted-plan-item-1",
            markdown: "## Final breakfast plan\n\nEat bagels if the cream cheese passes inspection.",
            steps: []
          }
        ]}
        clearPendingRequest={() => undefined}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
      />
    );

    expect(screen.getAllByRole("heading", { name: "Final breakfast plan" })).toHaveLength(1);
  });

  it("renders global MCP startup and OAuth status for the selected backend", async () => {
    const selectedThread = {
      id: "thread-2",
      title: "Browser task",
      titleSource: "explicit" as const,
      source: "codex" as const,
      updatedAt: Date.now(),
      linkedDirectories: [],
      inbox: {
        inInbox: false
      }
    };
    let agentEventHandler:
      | ((event: {
          backend: "codex" | "grok";
          notification: AppServerNotification;
        }) => void)
      | undefined;

    render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[
          {
            kind: "codex",
            label: "Codex app server",
            available: true,
            methods: ["thread/list", "thread/read", "turn/start", "skills/list"],
            capabilities: {
              listThreads: true,
              createThread: false,
              resumeThread: true,
              renameThread: false,
              readThread: true,
              startTurn: true,
              interruptTurn: false,
              steerTurn: false,
              transcriptPagination: false,
              toolUse: true,
              approvalRequests: false,
              multiDirectoryThreads: true
            },
            executionModes: [
              {
                mode: "default",
                label: "Default Access",
                available: true,
                isDefault: true,
              },
            ],
          }
        ]}
        composerDisabled={false}
        desktopApi={{
          onAgentEvent: (callback) => {
            agentEventHandler = callback as typeof agentEventHandler;
            return () => undefined;
          },
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-2",
            turnId: "turn-1",
          }),
        }}
        loading={false}
        loadingMore={false}
        messageCount={1}
        selectedThread={selectedThread}
        skills={[]}
        transcriptEntries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Use Playwright."
          }
        ]}
        clearPendingRequest={() => undefined}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
      />
    );

    await act(async () => {
      agentEventHandler?.({
        backend: "grok",
        notification: {
          method: "mcpServer/startupStatus/updated",
          params: {
            name: "ignored",
            status: "ready",
            error: null,
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "mcpServer/startupStatus/updated",
          params: {
            name: "playwright",
            status: "starting",
            error: null,
          },
        },
      });
    });

    expect(screen.getByText("MCP playwright starting")).toBeInTheDocument();
    expect(screen.queryByText("MCP ignored ready")).not.toBeInTheDocument();

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "mcpServer/oauthLogin/completed",
          params: {
            name: "playwright",
            success: true,
          },
        },
      });
    });

    fireEvent.click(screen.getByRole("button", { name: /MCP status updates \(2\)/ }));
    expect(screen.getByText("MCP playwright login completed")).toBeInTheDocument();
  });

  it("keeps multiple global MCP startup statuses visible", async () => {
    const selectedThread = {
      id: "thread-2",
      title: "Browser task",
      titleSource: "explicit" as const,
      source: "codex" as const,
      updatedAt: Date.now(),
      linkedDirectories: [],
      inbox: {
        inInbox: false
      }
    };
    let agentEventHandler: ((event: AgentEvent) => void) | undefined;

    render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[
          {
            kind: "codex",
            label: "Codex app server",
            available: true,
            methods: ["thread/list", "thread/read", "turn/start", "skills/list"],
            capabilities: {
              listThreads: true,
              createThread: false,
              resumeThread: true,
              renameThread: false,
              readThread: true,
              startTurn: true,
              interruptTurn: false,
              steerTurn: false,
              transcriptPagination: false,
              toolUse: true,
              approvalRequests: false,
              multiDirectoryThreads: true
            },
            executionModes: [
              {
                mode: "default",
                label: "Default Access",
                available: true,
                isDefault: true,
              },
            ],
          }
        ]}
        composerDisabled={false}
        desktopApi={{
          onAgentEvent: (callback) => {
            agentEventHandler = callback as typeof agentEventHandler;
            return () => undefined;
          },
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-2",
            turnId: "turn-1",
          }),
        }}
        loading={false}
        loadingMore={false}
        messageCount={1}
        selectedThread={selectedThread}
        skills={[]}
        transcriptEntries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Start a new thread."
          }
        ]}
        clearPendingRequest={() => undefined}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
      />
    );

    await act(async () => {
      for (const name of ["browser-use", "playwright", "codex_apps"]) {
        agentEventHandler?.({
          backend: "codex",
          notification: {
            method: "mcpServer/startupStatus/updated",
            params: {
              name,
              status: "ready",
              error: null,
            },
          },
        });
      }
    });

    fireEvent.click(screen.getByRole("button", { name: /MCP status updates \(3\)/ }));
    expect(screen.getByText("MCP browser-use ready")).toBeInTheDocument();
    expect(screen.getByText("MCP playwright ready")).toBeInTheDocument();
    expect(screen.getByText("MCP codex_apps ready")).toBeInTheDocument();
  });

  it("renders live diff activity from turn/diff/updated and clears it once replay catches up", async () => {
    const selectedThread = {
      id: "thread-2",
      title: "Fix the transcript merge markers",
      titleSource: "explicit" as const,
      source: "codex" as const,
      updatedAt: Date.now(),
      linkedDirectories: [],
      inbox: {
        inInbox: false
      }
    };
    const liveDiff = [
      "diff --git a/apps/desktop/src/renderer/src/lib/useThreadSessionState.ts b/apps/desktop/src/renderer/src/lib/useThreadSessionState.ts",
      "--- a/apps/desktop/src/renderer/src/lib/useThreadSessionState.ts",
      "+++ b/apps/desktop/src/renderer/src/lib/useThreadSessionState.ts",
      "@@ -113,2 +113,1 @@",
      "-<<<<<<< HEAD",
      "-function appendMessageEntries(",
      "+function messageMatchesOptimisticEntry("
    ].join("\n");
    let agentEventHandler: ((event: AgentEvent) => void) | undefined;

    const { rerender } = render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[
          {
            kind: "codex",
            label: "Codex app server",
            available: true,
            methods: ["thread/list", "thread/read", "turn/start", "skills/list"],
            capabilities: {
              listThreads: true,
              createThread: false,
              resumeThread: true,
              renameThread: false,
              readThread: true,
              startTurn: true,
              interruptTurn: false,
              steerTurn: false,
              transcriptPagination: true,
              toolUse: false,
              approvalRequests: false,
              multiDirectoryThreads: true
            },
            executionModes: [
              {
                mode: "default",
                label: "Default Access",
                available: true,
                isDefault: true,
              },
            ],
          }
        ]}
        composerDisabled={false}
        desktopApi={{
          onAgentEvent: (callback) => {
            agentEventHandler = callback as typeof agentEventHandler;
            return () => undefined;
          },
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-2",
            turnId: "turn-1",
          }),
        }}
        loading={false}
        loadingMore={false}
        messageCount={1}
        selectedThread={selectedThread}
        skills={[]}
        transcriptEntries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Fix the merge markers."
          }
        ]}
        clearPendingRequest={() => undefined}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
      />
    );

    await act(async () => {
      agentEventHandler?.(
        buildRendererLiveDiffEvent({
          additions: 1,
          diff: liveDiff,
          path: "apps/desktop/src/renderer/src/lib/useThreadSessionState.ts",
          removals: 2,
          threadId: "thread-2",
          turnId: "turn-1",
        }),
      );
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/diff/updated",
          params: {
            threadId: "thread-other",
            turnId: "turn-2",
            diff: "diff --git a/ignored.ts b/ignored.ts"
          }
        },
      });
    });

    // The LiveWorkRail (above the composer per issue #495) renders the
    // cumulative diff summary in its rail-level title (#495 follow-up
    // merged the section heading into the rail title) and each file
    // as its own expand button — no second click needed to reach the
    // file list, unlike the old in-transcript activity row.
    expect(
      screen.getByRole("complementary", { name: /Edited 1 file, \+1, -2/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("Update useThreadSessionState.ts")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Update useThreadSessionState.ts/i }));

    expect(screen.getByText("function messageMatchesOptimisticEntry(")).toBeInTheDocument();
    expect(screen.queryByText("ignored.ts")).not.toBeInTheDocument();

    rerender(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[
          {
            kind: "codex",
            label: "Codex app server",
            available: true,
            methods: ["thread/list", "thread/read", "turn/start", "skills/list"],
            capabilities: {
              listThreads: true,
              createThread: false,
              resumeThread: true,
              renameThread: false,
              readThread: true,
              startTurn: true,
              interruptTurn: false,
              steerTurn: false,
              transcriptPagination: true,
              toolUse: false,
              approvalRequests: false,
              multiDirectoryThreads: true
            },
            executionModes: [
              {
                mode: "default",
                label: "Default Access",
                available: true,
                isDefault: true,
              },
            ],
          }
        ]}
        composerDisabled={false}
        desktopApi={{
          onAgentEvent: (callback) => {
            agentEventHandler = callback as typeof agentEventHandler;
            return () => undefined;
          },
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-2",
            turnId: "turn-1",
          }),
        }}
        loading={false}
        loadingMore={false}
        messageCount={2}
        selectedThread={selectedThread}
        skills={[]}
        transcriptEntries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Fix the merge markers."
          },
          {
            type: "activity",
            id: "activity-1",
            summary: "Edited 1 file",
            details: [
              {
                id: "detail-1",
                kind: "write",
                label: "Update useThreadSessionState.ts",
                path: "/repo/apps/desktop/src/renderer/src/lib/useThreadSessionState.ts",
                fileDiff: {
                  kind: "update",
                  additions: 1,
                  removals: 2,
                  diff: liveDiff
                }
              }
            ]
          }
        ]}
        clearPendingRequest={() => undefined}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
      />
    );

    // Replay caught up: the pending live entry clears (no dupe), but the
    // rail keeps rendering the persisted entry's edits — accumulated
    // edited files rehydrate from the replay instead of vanishing. The rail
    // summary stays at one edited file; if the pending live entry remained,
    // this would double-count into a two-file rail summary instead.
    const rail = screen.getByRole("complementary", {
      name: /Edited 1 file, \+1, -2/,
    });
    expect(rail).toBeInTheDocument();
    expect(
      within(rail).getAllByRole("button", { name: /Edited 1 file/i }),
    ).toHaveLength(2);
  });

  it("clears lazy live diff activity once matching replay diff arrives", async () => {
    const selectedThread = {
      id: "thread-lazy",
      title: "Fix lazy diff catch-up",
      titleSource: "explicit" as const,
      source: "codex" as const,
      updatedAt: Date.now(),
      linkedDirectories: [],
      inbox: {
        inInbox: false,
      },
    };
    const liveDiff = [
      "diff --git a/apps/desktop/src/renderer/src/lib/useThreadSessionState.ts b/apps/desktop/src/renderer/src/lib/useThreadSessionState.ts",
      "--- a/apps/desktop/src/renderer/src/lib/useThreadSessionState.ts",
      "+++ b/apps/desktop/src/renderer/src/lib/useThreadSessionState.ts",
      "@@ -113,2 +113,1 @@",
      "-<<<<<<< HEAD",
      "-function appendMessageEntries(",
      "+function messageMatchesOptimisticEntry(",
    ].join("\n");
    let agentEventHandler: ((event: AgentEvent) => void) | undefined;
    const getThreadFileDiff = vi.fn(async () => ({ diff: liveDiff }));

    const renderThread = (transcriptEntries: any[]) => (
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[]}
        composerDisabled={false}
        desktopApi={{
          getThreadFileDiff,
          onAgentEvent: (callback) => {
            agentEventHandler = callback as typeof agentEventHandler;
            return () => undefined;
          },
        }}
        loading={false}
        loadingMore={false}
        messageCount={transcriptEntries.length}
        selectedThread={selectedThread}
        skills={[]}
        transcriptEntries={transcriptEntries}
        clearPendingRequest={() => undefined}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
      />
    );

    const { rerender } = render(
      renderThread([
        {
          type: "message",
          id: "message-1",
          role: "user",
          text: "Fix the merge markers.",
        },
      ]),
    );

    await act(async () => {
      agentEventHandler?.(
        buildRendererLiveDiffEvent({
          additions: 1,
          diff: liveDiff,
          lazy: true,
          path: "apps/desktop/src/renderer/src/lib/useThreadSessionState.ts",
          removals: 2,
          threadId: "thread-lazy",
          turnId: "turn-1",
        }),
      );
    });

    rerender(
      renderThread([
        {
          type: "message",
          id: "message-1",
          role: "user",
          text: "Fix the merge markers.",
        },
        {
          type: "activity",
          id: "activity-1",
          summary: "Edited 1 file",
          turn: { id: "turn-1", status: "in_progress" },
          details: [
            {
              id: "detail-1",
              kind: "write",
              label: "Update useThreadSessionState.ts",
              path: "apps/desktop/src/renderer/src/lib/useThreadSessionState.ts",
              fileDiff: {
                kind: "update",
                additions: 1,
                removals: 2,
                diff: liveDiff,
              },
            },
          ],
        },
      ]),
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Update useThreadSessionState.ts/i }),
    );

    expect(screen.getByText("function messageMatchesOptimisticEntry(")).toBeInTheDocument();
    expect(getThreadFileDiff).not.toHaveBeenCalled();
    expect(
      screen.getByRole("complementary", { name: /Edited 1 file, \+1, -2/ }),
    ).toBeInTheDocument();
  });

  it("renders Codex warning notifications inline", async () => {
    const selectedThread = {
      id: "thread-2",
      title: "Too many skills",
      titleSource: "explicit" as const,
      source: "codex" as const,
      updatedAt: Date.now(),
      linkedDirectories: [],
      inbox: {
        inInbox: false
      }
    };
    let agentEventHandler:
      | ((event: {
          backend: "codex";
          notification: AppServerNotification;
        }) => void)
      | undefined;

    render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[
          {
            kind: "codex",
            label: "Codex app server",
            available: true,
            methods: ["thread/list", "thread/read", "turn/start", "skills/list"],
            capabilities: {
              listThreads: true,
              createThread: false,
              resumeThread: true,
              renameThread: false,
              readThread: true,
              startTurn: true,
              interruptTurn: false,
              steerTurn: false,
              transcriptPagination: true,
              toolUse: false,
              approvalRequests: false,
              multiDirectoryThreads: true
            },
            executionModes: [
              {
                mode: "default",
                label: "Default Access",
                available: true,
                isDefault: true,
              },
            ],
          }
        ]}
        composerDisabled={false}
        desktopApi={{
          onAgentEvent: (callback) => {
            agentEventHandler = callback as typeof agentEventHandler;
            return () => undefined;
          },
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-2",
            turnId: "turn-1",
          }),
        }}
        loading={false}
        loadingMore={false}
        messageCount={1}
        selectedThread={selectedThread}
        skills={[]}
        transcriptEntries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Start with many skills."
          }
        ]}
        clearPendingRequest={() => undefined}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
      />
    );

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "warning",
          params: {
            threadId: "thread-2",
            message:
              "Warning: Exceeded skills context budget of 2%. Loaded skill descriptions were truncated."
          },
        } as AppServerNotification,
      });
    });

    expect(
      screen.getByText(
        "Warning: Exceeded skills context budget of 2%. Loaded skill descriptions were truncated."
      )
    ).toBeInTheDocument();
  });

  it("maps command approval actions to native decision values and dismisses the approval card", async () => {
    const submitServerRequest = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-2",
      requestId: "req-1",
    }));
    let currentPendingRequest: AppServerPendingRequestNotification | undefined = {
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-2",
        requestId: "req-1",
        availableDecisions: ["accept", "decline", "cancel"],
        command: "npm view dive",
      },
    };
    let currentPendingStatus: string | undefined = "Waiting for approval";
    const clearPendingRequest = vi.fn((_requestId: string, nextStatus?: string) => {
      currentPendingRequest = undefined;
      currentPendingStatus = nextStatus;
      rerenderThreadView();
    });

    const { rerender } = render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[
          {
            kind: "codex",
            label: "Codex app server",
            available: true,
            methods: ["thread/list", "thread/read", "turn/start", "skills/list"],
            capabilities: {
              listThreads: true,
              createThread: false,
              resumeThread: true,
              renameThread: false,
              readThread: true,
              startTurn: true,
              interruptTurn: false,
              steerTurn: false,
              transcriptPagination: true,
              toolUse: false,
              approvalRequests: true,
              multiDirectoryThreads: true
            },
            executionModes: [
              {
                mode: "default",
                label: "Default Access",
                available: true,
                isDefault: true,
              },
            ],
          }
        ]}
        composerDisabled={false}
        desktopApi={{
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-2",
            turnId: "turn-1",
          }),
          submitServerRequest,
        }}
        loading={false}
        loadingMore={false}
        messageCount={1}
        pendingRequest={currentPendingRequest}
        pendingStatusText={currentPendingStatus}
        selectedThread={{
          id: "thread-2",
          title: "Plan the app-server protocol",
          titleSource: "explicit",
          source: "codex",
          updatedAt: Date.now(),
          linkedDirectories: [],
          inbox: {
            inInbox: false
          }
        }}
        skills={[]}
        transcriptEntries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Run npm view dive"
          }
        ]}
        clearPendingRequest={clearPendingRequest}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
      />
    );

    const rerenderThreadView = () => {
      rerender(
        <ThreadView
          addOptimisticUserMessage={(_text) => "optimistic-1"}
          backends={[
            {
              kind: "codex",
              label: "Codex app server",
              available: true,
              methods: ["thread/list", "thread/read", "turn/start", "skills/list"],
              capabilities: {
                listThreads: true,
                createThread: false,
                resumeThread: true,
                renameThread: false,
                readThread: true,
                startTurn: true,
                interruptTurn: false,
                steerTurn: false,
                transcriptPagination: true,
                toolUse: false,
                approvalRequests: true,
                multiDirectoryThreads: true
              },
              executionModes: [
                {
                  mode: "default",
                  label: "Default Access",
                  available: true,
                  isDefault: true,
                },
              ],
            }
          ]}
          composerDisabled={false}
          desktopApi={{
            startTurn: async () => ({
              backend: "codex",
              threadId: "thread-2",
              turnId: "turn-1",
            }),
            submitServerRequest,
          }}
          loading={false}
          loadingMore={false}
          messageCount={1}
          pendingRequest={currentPendingRequest}
          pendingStatusText={currentPendingStatus}
          selectedThread={{
            id: "thread-2",
            title: "Plan the app-server protocol",
            titleSource: "explicit",
            source: "codex",
            updatedAt: Date.now(),
            linkedDirectories: [],
            inbox: {
              inInbox: false
            }
          }}
          skills={[]}
          transcriptEntries={[
            {
              type: "message",
              id: "message-1",
              role: "user",
              text: "Run npm view dive"
            }
          ]}
          clearPendingRequest={clearPendingRequest}
          onLoadOlder={async () => undefined}
          removeOptimisticMessage={(_id) => undefined}
        />
      );
    };

    expect(screen.getByRole("group", { name: "Pending approval" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Approve Once" }));

    await waitFor(() => {
      expect(submitServerRequest).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-2",
        turnId: undefined,
        requestId: "req-1",
        response: { decision: "accept" },
      });
    });

    await waitFor(() => {
      expect(
        screen.queryByRole("group", { name: "Pending approval" })
      ).not.toBeInTheDocument();
    });
    expect(clearPendingRequest).toHaveBeenCalledWith("req-1", "Thinking");
  });

  it("submits pending questionnaire answers with the request_user_input response shape", async () => {
    const submitServerRequest = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-2",
      requestId: "input-request-1",
    }));
    let currentPendingUserInput: PendingQuestionnaireState | undefined = {
      method: "item/tool/requestUserInput",
      threadId: "thread-2",
      turnId: "turn-1",
      itemId: "input-1",
      requestId: "input-request-1",
      currentIndex: 0,
      phase: "answering",
      answers: [null],
      questions: [
        {
          id: "approach",
          header: "Approach",
          question: "Which implementation path should I take?",
          options: [
            {
              key: "A",
              label: "Small patch (Recommended)",
              description: "Keep this scoped.",
              recommended: true,
            },
            {
              key: "B",
              label: "Large refactor",
              description: "Touch adjacent flows.",
              recommended: false,
            },
          ],
          allowFreeform: false,
          secret: false,
        },
      ],
    };
    let currentPendingStatus: string | undefined = "Waiting for input";
    const clearPendingRequest = vi.fn((_requestId: string, nextStatus?: string) => {
      currentPendingUserInput = undefined;
      currentPendingStatus = nextStatus;
      rerenderThreadView();
    });
    const updatePendingUserInput = vi.fn(
      (
        requestId: string,
        updater: (state: PendingQuestionnaireState) => PendingQuestionnaireState
      ) => {
        if (currentPendingUserInput?.requestId === requestId) {
          currentPendingUserInput = updater(currentPendingUserInput);
          rerenderThreadView();
        }
      }
    );

    const { rerender } = render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[
          {
            kind: "codex",
            label: "Codex app server",
            available: true,
            methods: ["thread/list", "thread/read", "turn/start", "skills/list"],
            capabilities: {
              listThreads: true,
              createThread: false,
              resumeThread: true,
              renameThread: false,
              readThread: true,
              startTurn: true,
              interruptTurn: false,
              steerTurn: false,
              transcriptPagination: true,
              toolUse: false,
              approvalRequests: true,
              multiDirectoryThreads: true
            },
            executionModes: [
              {
                mode: "default",
                label: "Default Access",
                available: true,
                isDefault: true,
              },
            ],
          }
        ]}
        composerDisabled={false}
        desktopApi={{
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-2",
            turnId: "turn-1",
          }),
          submitServerRequest,
        }}
        loading={false}
        loadingMore={false}
        messageCount={1}
        pendingStatusText={currentPendingStatus}
        pendingUserInput={currentPendingUserInput}
        selectedThread={{
          id: "thread-2",
          title: "Plan the app-server protocol",
          titleSource: "explicit",
          source: "codex",
          updatedAt: Date.now(),
          linkedDirectories: [],
          inbox: {
            inInbox: false
          }
        }}
        skills={[]}
        transcriptEntries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Ask me a plan question"
          }
        ]}
        clearPendingRequest={clearPendingRequest}
        onLoadOlder={async () => undefined}
        onUpdatePendingUserInput={updatePendingUserInput}
        removeOptimisticMessage={(_id) => undefined}
      />
    );

    const rerenderThreadView = () => {
      rerender(
        <ThreadView
          addOptimisticUserMessage={(_text) => "optimistic-1"}
          backends={[
            {
              kind: "codex",
              label: "Codex app server",
              available: true,
              methods: ["thread/list", "thread/read", "turn/start", "skills/list"],
              capabilities: {
                listThreads: true,
                createThread: false,
                resumeThread: true,
                renameThread: false,
                readThread: true,
                startTurn: true,
                interruptTurn: false,
                steerTurn: false,
                transcriptPagination: true,
                toolUse: false,
                approvalRequests: true,
                multiDirectoryThreads: true
              },
              executionModes: [
                {
                  mode: "default",
                  label: "Default Access",
                  available: true,
                  isDefault: true,
                },
              ],
            }
          ]}
          composerDisabled={false}
          desktopApi={{
            startTurn: async () => ({
              backend: "codex",
              threadId: "thread-2",
              turnId: "turn-1",
            }),
            submitServerRequest,
          }}
          loading={false}
          loadingMore={false}
          messageCount={1}
          pendingStatusText={currentPendingStatus}
          pendingUserInput={currentPendingUserInput}
          selectedThread={{
            id: "thread-2",
            title: "Plan the app-server protocol",
            titleSource: "explicit",
            source: "codex",
            updatedAt: Date.now(),
            linkedDirectories: [],
            inbox: {
              inInbox: false
            }
          }}
          skills={[]}
          transcriptEntries={[
            {
              type: "message",
              id: "message-1",
              role: "user",
              text: "Ask me a plan question"
            }
          ]}
          clearPendingRequest={clearPendingRequest}
          onLoadOlder={async () => undefined}
          onUpdatePendingUserInput={updatePendingUserInput}
          removeOptimisticMessage={(_id) => undefined}
        />
      );
    };

    expect(screen.getByRole("group", { name: "Pending input" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Small patch/ }));

    await waitFor(() => {
      expect(submitServerRequest).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-2",
        turnId: "turn-1",
        requestId: "input-request-1",
        response: {
          answers: {
            approach: {
              answers: ["Small patch (Recommended)"]
            }
          }
        },
      });
    });

    await waitFor(() => {
      expect(
        screen.queryByRole("group", { name: "Pending input" })
      ).not.toBeInTheDocument();
    });
    expect(clearPendingRequest).toHaveBeenCalledWith("input-request-1", "Thinking");
  });

  it("submits pending MCP interactions through the server request bridge", async () => {
    let currentPendingMcpInteraction: PendingMcpInteractionState | undefined = {
      method: "mcpServer/elicitation/request",
      threadId: "thread-2",
      turnId: "turn-1",
      requestId: "mcp-request-1",
      serverName: "playwright",
      message: "Allow the playwright MCP server to run tool \"browser_tabs\"?",
      mode: "form",
      _meta: {
        tool_description: "List, create, close, or select a browser tab.",
      },
      form: {
        empty: true,
        fields: [],
      },
      url: null,
    };
    let currentPendingStatus = "Waiting for MCP approval";
    const submitServerRequest = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-2",
      turnId: "turn-1",
      requestId: "mcp-request-1",
    }));
    const clearPendingRequest = vi.fn((_requestId: string, nextStatus?: string) => {
      currentPendingMcpInteraction = undefined;
      currentPendingStatus = nextStatus ?? "";
      rerenderThreadView();
    });
    const updatePendingMcpInteraction = vi.fn(
      (
        _requestId: string,
        updater: (state: PendingMcpInteractionState) => PendingMcpInteractionState
      ) => {
        if (currentPendingMcpInteraction) {
          currentPendingMcpInteraction = updater(currentPendingMcpInteraction);
          rerenderThreadView();
        }
      }
    );

    const { rerender } = render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[
          {
            kind: "codex",
            label: "Codex app server",
            available: true,
            methods: ["thread/list", "thread/read", "turn/start", "skills/list"],
            capabilities: {
              listThreads: true,
              createThread: false,
              resumeThread: true,
              renameThread: false,
              readThread: true,
              startTurn: true,
              interruptTurn: false,
              steerTurn: false,
              transcriptPagination: true,
              toolUse: false,
              approvalRequests: true,
              multiDirectoryThreads: true
            },
            executionModes: [
              {
                mode: "default",
                label: "Default Access",
                available: true,
                isDefault: true,
              },
            ],
          }
        ]}
        composerDisabled={false}
        desktopApi={{
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-2",
            turnId: "turn-1",
          }),
          submitServerRequest,
        }}
        loading={false}
        loadingMore={false}
        messageCount={1}
        pendingMcpInteraction={currentPendingMcpInteraction}
        pendingStatusText={currentPendingStatus}
        selectedThread={{
          id: "thread-2",
          title: "Plan the app-server protocol",
          titleSource: "explicit",
          source: "codex",
          updatedAt: Date.now(),
          linkedDirectories: [],
          inbox: {
            inInbox: false
          }
        }}
        skills={[]}
        transcriptEntries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Use the browser"
          }
        ]}
        clearPendingRequest={clearPendingRequest}
        onLoadOlder={async () => undefined}
        onUpdatePendingMcpInteraction={updatePendingMcpInteraction}
        removeOptimisticMessage={(_id) => undefined}
      />
    );

    const rerenderThreadView = () => {
      rerender(
        <ThreadView
          addOptimisticUserMessage={(_text) => "optimistic-1"}
          backends={[
            {
              kind: "codex",
              label: "Codex app server",
              available: true,
              methods: ["thread/list", "thread/read", "turn/start", "skills/list"],
              capabilities: {
                listThreads: true,
                createThread: false,
                resumeThread: true,
                renameThread: false,
                readThread: true,
                startTurn: true,
                interruptTurn: false,
                steerTurn: false,
                transcriptPagination: true,
                toolUse: false,
                approvalRequests: true,
                multiDirectoryThreads: true
              },
              executionModes: [
                {
                  mode: "default",
                  label: "Default Access",
                  available: true,
                  isDefault: true,
                },
              ],
            }
          ]}
          composerDisabled={false}
          desktopApi={{
            startTurn: async () => ({
              backend: "codex",
              threadId: "thread-2",
              turnId: "turn-1",
            }),
            submitServerRequest,
          }}
          loading={false}
          loadingMore={false}
          messageCount={1}
          pendingMcpInteraction={currentPendingMcpInteraction}
          pendingStatusText={currentPendingStatus}
          selectedThread={{
            id: "thread-2",
            title: "Plan the app-server protocol",
            titleSource: "explicit",
            source: "codex",
            updatedAt: Date.now(),
            linkedDirectories: [],
            inbox: {
              inInbox: false
            }
          }}
          skills={[]}
          transcriptEntries={[
            {
              type: "message",
              id: "message-1",
              role: "user",
              text: "Use the browser"
            }
          ]}
          clearPendingRequest={clearPendingRequest}
          onLoadOlder={async () => undefined}
          onUpdatePendingMcpInteraction={updatePendingMcpInteraction}
          removeOptimisticMessage={(_id) => undefined}
        />
      );
    };

    expect(
      screen.getByRole("group", { name: "Pending MCP interaction" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Allow" }));

    await waitFor(() => {
      expect(submitServerRequest).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-2",
        turnId: "turn-1",
        requestId: "mcp-request-1",
        response: {
          action: "accept",
          content: {},
          _meta: null,
        },
      });
    });

    await waitFor(() => {
      expect(
        screen.queryByRole("group", { name: "Pending MCP interaction" })
      ).not.toBeInTheDocument();
    });
    expect(clearPendingRequest).toHaveBeenCalledWith("mcp-request-1", "Thinking");
  });

  it("clears a stale approval card when assistant output resumes", async () => {
    const selectedThread = {
      id: "thread-2",
      title: "Plan the app-server protocol",
      titleSource: "explicit" as const,
      source: "codex" as const,
      updatedAt: Date.now(),
      linkedDirectories: [],
      inbox: {
        inInbox: false
      }
    };

    const { rerender } = render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[
          {
            kind: "codex",
            label: "Codex app server",
            available: true,
            methods: ["thread/list", "thread/read", "turn/start", "skills/list"],
            capabilities: {
              listThreads: true,
              createThread: false,
              resumeThread: true,
              renameThread: false,
              readThread: true,
              startTurn: true,
              interruptTurn: false,
              steerTurn: false,
              transcriptPagination: true,
              toolUse: false,
              approvalRequests: true,
              multiDirectoryThreads: true
            },
            executionModes: [
              {
                mode: "default",
                label: "Default Access",
                available: true,
                isDefault: true,
              },
            ],
          }
        ]}
        composerDisabled={false}
        desktopApi={{
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-2",
            turnId: "turn-1",
          }),
        }}
        loading={false}
        loadingMore={false}
        messageCount={1}
        pendingRequest={{
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread-2",
            requestId: "req-1",
            command: "npm view dive",
          },
        }}
        pendingStatusText="Waiting for approval"
        selectedThread={selectedThread}
        skills={[]}
        transcriptEntries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Run npm view dive"
          }
        ]}
        clearPendingRequest={() => undefined}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
      />
    );

    expect(screen.getByRole("group", { name: "Pending approval" })).toBeInTheDocument();
    expect(screen.getByText("Waiting for approval")).toBeInTheDocument();

    rerender(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[
          {
            kind: "codex",
            label: "Codex app server",
            available: true,
            methods: ["thread/list", "thread/read", "turn/start", "skills/list"],
            capabilities: {
              listThreads: true,
              createThread: false,
              resumeThread: true,
              renameThread: false,
              readThread: true,
              startTurn: true,
              interruptTurn: false,
              steerTurn: false,
              transcriptPagination: true,
              toolUse: false,
              approvalRequests: true,
              multiDirectoryThreads: true
            },
            executionModes: [
              {
                mode: "default",
                label: "Default Access",
                available: true,
                isDefault: true,
              },
            ],
          }
        ]}
        composerDisabled={false}
        desktopApi={{
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-2",
            turnId: "turn-1",
          }),
        }}
        loading={false}
        loadingMore={false}
        messageCount={1}
        pendingAssistantMessage={{
          type: "message",
          id: "msg-1",
          role: "assistant",
          phase: "commentary",
          text: "The request was handled."
        }}
        pendingStatusText="Thinking"
        selectedThread={selectedThread}
        skills={[]}
        transcriptEntries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Run npm view dive"
          }
        ]}
        clearPendingRequest={() => undefined}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
      />
    );

    expect(
      screen.queryByRole("group", { name: "Pending approval" })
    ).not.toBeInTheDocument();
    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.getByText("The request was handled.")).toBeInTheDocument();
  });

  it("warns when a selected thread has branch drift and can update the expected branch", async () => {
    const updateThreadExpectedBranch = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-branch",
      branch: "main",
      updatedAt: Date.now(),
    }));
    const refreshNavigation = vi.fn(async () => undefined);

    render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[
          {
            kind: "codex",
            label: "Codex app server",
            available: true,
            methods: ["thread/list", "thread/read", "turn/start", "skills/list"],
            capabilities: {
              listThreads: true,
              createThread: false,
              resumeThread: true,
              renameThread: false,
              readThread: true,
              startTurn: true,
              interruptTurn: false,
              steerTurn: false,
              transcriptPagination: true,
              toolUse: false,
              approvalRequests: false,
              multiDirectoryThreads: true,
            },
            executionModes: [
              {
                mode: "default",
                label: "Default Access",
                available: true,
                isDefault: true,
              },
            ],
          },
        ]}
        composerDisabled={false}
        desktopApi={{
          updateThreadExpectedBranch,
        }}
        loading={false}
        loadingMore={false}
        messageCount={1}
        selectedThread={{
          id: "thread-branch",
          title: "Branch drift",
          titleSource: "explicit",
          source: "codex",
          gitBranch: "feature/old",
          observedGitBranch: "main",
          updatedAt: Date.now(),
          linkedDirectories: [],
          inbox: {
            inInbox: false,
          },
        }}
        skills={[]}
        transcriptEntries={[]}
        clearPendingRequest={() => undefined}
        onLoadOlder={async () => undefined}
        onRefreshNavigation={refreshNavigation}
        removeOptimisticMessage={(_id) => undefined}
      />,
    );

    const dialog = await screen.findByRole("dialog", { name: "Thread branch changed" });
    expect(dialog).toHaveTextContent(/Thread expects\s*feature\/old/);
    expect(dialog).toHaveTextContent(/Worktree is on\s*main/);
    expect(dialog).toHaveTextContent("I'll switch back");
    expect(dialog).toHaveTextContent("Keep current branch");
    expect(dialog).toHaveTextContent(
      "If earlier turns made commits on feature/old, those commits may not be visible on main",
    );
    expect(
      within(dialog).getByRole("button", {
        name: "Keep warning. I'll switch back to feature/old",
      }),
    ).toBeInTheDocument();
    const useCurrentBranchButton = within(dialog).getByRole("button", {
      name: "Accept current branch as correct. Continue working on main without further warnings",
    });

    fireEvent.click(useCurrentBranchButton);

    await waitFor(() => {
      expect(updateThreadExpectedBranch).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-branch",
        branch: "main",
      });
    });
    expect(refreshNavigation).toHaveBeenCalled();
  });

  it("can dismiss the branch drift dialog while keeping a visible drift indicator", async () => {
    const updateThreadExpectedBranch = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-branch",
      branch: "main",
      updatedAt: Date.now(),
    }));
    const retainThreadBranchDrift = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-branch",
      expectedBranch: "feature/old",
      observedBranch: "main",
      retainedAt: Date.now(),
    }));

    render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[]}
        composerDisabled={false}
        desktopApi={{
          retainThreadBranchDrift,
          updateThreadExpectedBranch,
        }}
        loading={false}
        loadingMore={false}
        messageCount={1}
        selectedThread={{
          id: "thread-branch",
          title: "Branch drift",
          titleSource: "explicit",
          source: "codex",
          gitBranch: "feature/old",
          observedGitBranch: "main",
          updatedAt: Date.now(),
          linkedDirectories: [],
          inbox: {
            inInbox: false,
          },
        }}
        skills={[]}
        transcriptEntries={[]}
        clearPendingRequest={() => undefined}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
      />,
    );

    const dialog = await screen.findByRole("dialog", { name: "Thread branch changed" });

    fireEvent.click(within(dialog).getByRole("button", { name: "Close branch warning" }));

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Thread branch changed" }),
      ).not.toBeInTheDocument();
    });
    expect(updateThreadExpectedBranch).not.toHaveBeenCalled();
    expect(retainThreadBranchDrift).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Branch warning: this thread expects feature/old, but the worktree is on main.",
    );
  });

  it("checks branch drift on selection and focus without background polling", async () => {
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    const checkThreadBranchDrift = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-branch",
      checkedAt: Date.now(),
      expectedBranch: "feature/old",
      observedBranch: "feature/old",
      drifted: false,
    }));
    let focusCallback: (() => void) | undefined;

    try {
      render(
        <ThreadView
          addOptimisticUserMessage={(_text) => "optimistic-1"}
          backends={[]}
          composerDisabled={false}
          desktopApi={{
            checkThreadBranchDrift,
            onWindowFocus: (callback) => {
              focusCallback = callback;
              return () => {
                focusCallback = undefined;
              };
            },
          }}
          loading={false}
          loadingMore={false}
          messageCount={1}
          selectedThread={{
            id: "thread-branch",
            title: "Branch drift",
            titleSource: "explicit",
            source: "codex",
            gitBranch: "feature/old",
            observedGitBranch: "feature/old",
            updatedAt: Date.now(),
            linkedDirectories: [],
            inbox: {
              inInbox: false,
            },
          }}
          skills={[]}
          transcriptEntries={[]}
          clearPendingRequest={() => undefined}
          onLoadOlder={async () => undefined}
          removeOptimisticMessage={(_id) => undefined}
        />,
      );

      await waitFor(() => {
        expect(checkThreadBranchDrift).toHaveBeenCalledTimes(1);
      });
      expect(checkThreadBranchDrift).toHaveBeenLastCalledWith({
        backend: "codex",
        expectedBranch: "feature/old",
        threadId: "thread-branch",
      });
      expect(setIntervalSpy).not.toHaveBeenCalledWith(expect.any(Function), 30_000);

      await act(async () => {
        focusCallback?.();
      });

      await waitFor(() => {
        expect(checkThreadBranchDrift).toHaveBeenCalledTimes(2);
      });
      expect(checkThreadBranchDrift).toHaveBeenLastCalledWith({
        backend: "codex",
        expectedBranch: "feature/old",
        threadId: "thread-branch",
      });
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("suppresses the branch drift dialog while a turn is active", async () => {
    const driftThread = {
      id: "thread-branch",
      title: "Branch drift",
      titleSource: "explicit" as const,
      source: "codex" as const,
      gitBranch: "feature/old",
      observedGitBranch: "main",
      updatedAt: Date.now(),
      linkedDirectories: [],
      inbox: { inInbox: false },
    };

    function Harness({ activeTurnId }: { activeTurnId?: string }) {
      return (
        <ThreadView
          activeTurnId={activeTurnId}
          addOptimisticUserMessage={(_text) => "optimistic-1"}
          backends={[]}
          composerDisabled={false}
          desktopApi={{}}
          loading={false}
          loadingMore={false}
          messageCount={1}
          selectedThread={driftThread}
          skills={[]}
          transcriptEntries={[]}
          clearPendingRequest={() => undefined}
          onLoadOlder={async () => undefined}
          removeOptimisticMessage={(_id) => undefined}
        />
      );
    }

    const { rerender } = render(<Harness activeTurnId="turn-1" />);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      screen.queryByRole("dialog", { name: "Thread branch changed" }),
    ).not.toBeInTheDocument();

    rerender(<Harness activeTurnId={undefined} />);

    await waitFor(() => {
      expect(
        screen.getByRole("dialog", { name: "Thread branch changed" }),
      ).toBeInTheDocument();
    });
  });

  it("suppresses the branch drift dialog when another top-level dialog is active", async () => {
    const driftThread = {
      id: "thread-branch",
      title: "Branch drift",
      titleSource: "explicit" as const,
      source: "codex" as const,
      gitBranch: "feature/old",
      observedGitBranch: "main",
      updatedAt: Date.now(),
      linkedDirectories: [],
      inbox: { inInbox: false },
    };

    function Harness({ suppress }: { suppress?: boolean }) {
      return (
        <ThreadView
          addOptimisticUserMessage={(_text) => "optimistic-1"}
          backends={[]}
          composerDisabled={false}
          desktopApi={{}}
          loading={false}
          loadingMore={false}
          messageCount={1}
          selectedThread={driftThread}
          suppressBranchDriftDialog={suppress}
          skills={[]}
          transcriptEntries={[]}
          clearPendingRequest={() => undefined}
          onLoadOlder={async () => undefined}
          removeOptimisticMessage={(_id) => undefined}
        />
      );
    }

    const { rerender } = render(<Harness />);

    await waitFor(() => {
      expect(
        screen.getByRole("dialog", { name: "Thread branch changed" }),
      ).toBeInTheDocument();
    });

    rerender(<Harness suppress />);

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Thread branch changed" }),
      ).not.toBeInTheDocument();
    });

    rerender(<Harness />);

    await waitFor(() => {
      expect(
        screen.getByRole("dialog", { name: "Thread branch changed" }),
      ).toBeInTheDocument();
    });
  });

  it("refreshes branch drift state while the branch drift dialog is suppressed", async () => {
    const checkThreadBranchDrift = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-branch",
      checkedAt: Date.now(),
      expectedBranch: "feature/old",
      observedBranch: "main",
      drifted: true,
    }));
    const refreshNavigation = vi.fn(async () => undefined);

    const baseThread = {
      id: "thread-branch",
      title: "Branch drift",
      titleSource: "explicit" as const,
      source: "codex" as const,
      gitBranch: "feature/old",
      updatedAt: Date.now(),
      linkedDirectories: [],
      inbox: { inInbox: false },
    };

    function Harness({
      observedGitBranch,
      suppress,
    }: {
      observedGitBranch: string;
      suppress?: boolean;
    }) {
      return (
        <ThreadView
          addOptimisticUserMessage={(_text) => "optimistic-1"}
          backends={[]}
          composerDisabled={false}
          desktopApi={{ checkThreadBranchDrift }}
          loading={false}
          loadingMore={false}
          messageCount={1}
          selectedThread={{ ...baseThread, observedGitBranch }}
          suppressBranchDriftDialog={suppress}
          skills={[]}
          transcriptEntries={[]}
          clearPendingRequest={() => undefined}
          onLoadOlder={async () => undefined}
          onRefreshNavigation={refreshNavigation}
          removeOptimisticMessage={(_id) => undefined}
        />
      );
    }

    const { rerender } = render(
      <Harness observedGitBranch="feature/old" suppress />
    );

    await waitFor(() => {
      expect(refreshNavigation).toHaveBeenCalled();
    });
    expect(
      screen.queryByRole("dialog", { name: "Thread branch changed" }),
    ).not.toBeInTheDocument();

    rerender(<Harness observedGitBranch="main" />);

    await waitFor(() => {
      expect(
        screen.getByRole("dialog", { name: "Thread branch changed" }),
      ).toBeInTheDocument();
    });
  });

  it("re-checks branch drift on end-of-turn falling edge", async () => {
    const checkThreadBranchDrift = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-branch",
      checkedAt: Date.now(),
      expectedBranch: "feature/old",
      observedBranch: "main",
      drifted: true,
    }));

    function Harness({ activeTurnId }: { activeTurnId?: string }) {
      return (
        <ThreadView
          activeTurnId={activeTurnId}
          addOptimisticUserMessage={(_text) => "optimistic-1"}
          backends={[]}
          composerDisabled={false}
          desktopApi={{ checkThreadBranchDrift }}
          loading={false}
          loadingMore={false}
          messageCount={1}
          selectedThread={{
            id: "thread-branch",
            title: "Branch drift",
            titleSource: "explicit",
            source: "codex",
            gitBranch: "feature/old",
            observedGitBranch: "feature/old",
            updatedAt: Date.now(),
            linkedDirectories: [],
            inbox: { inInbox: false },
          }}
          skills={[]}
          transcriptEntries={[]}
          clearPendingRequest={() => undefined}
          onLoadOlder={async () => undefined}
          removeOptimisticMessage={(_id) => undefined}
        />
      );
    }

    const { rerender } = render(<Harness activeTurnId="turn-1" />);

    // Mount triggers the focus check, but the gate suppresses the
    // dialog while activeTurnId is set.
    await waitFor(() => {
      expect(checkThreadBranchDrift).toHaveBeenCalled();
    });
    expect(
      screen.queryByRole("dialog", { name: "Thread branch changed" }),
    ).not.toBeInTheDocument();

    const callsBeforeEnd = checkThreadBranchDrift.mock.calls.length;

    rerender(<Harness activeTurnId={undefined} />);

    await waitFor(() => {
      expect(checkThreadBranchDrift.mock.calls.length).toBeGreaterThan(callsBeforeEnd);
    });
    await waitFor(() => {
      expect(
        screen.getByRole("dialog", { name: "Thread branch changed" }),
      ).toBeInTheDocument();
    });
  });

  it("ignores retained pairs where expected branch is HEAD (R14)", async () => {
    // Thread overlay has a retained (HEAD, fix/foo) pair from an older
    // client version. The dialog must STILL surface a (HEAD, fix/foo)
    // drift because R14 ignores HEAD-expected retained pairs on read.
    render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[]}
        composerDisabled={false}
        desktopApi={{}}
        loading={false}
        loadingMore={false}
        messageCount={1}
        selectedThread={{
          id: "thread-head-retention",
          title: "HEAD retention",
          titleSource: "explicit",
          source: "codex",
          gitBranch: "HEAD",
          observedGitBranch: "fix/foo",
          retainedBranchDriftPairs: [
            { expectedBranch: "HEAD", observedBranch: "fix/foo", retainedAt: 1 },
          ],
          updatedAt: Date.now(),
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
        skills={[]}
        transcriptEntries={[]}
        clearPendingRequest={() => undefined}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
      />,
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Thread branch changed",
    });
    expect(dialog).toBeInTheDocument();
  });

  it("does not fire end-of-turn drift check when both thread and activeTurnId change in one render", async () => {
    const checkThreadBranchDrift = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-b",
      checkedAt: Date.now(),
      expectedBranch: "feature/b",
      observedBranch: "feature/b",
      drifted: false,
    }));

    function Harness({
      activeTurnId,
      threadId,
    }: {
      activeTurnId?: string;
      threadId: string;
    }) {
      return (
        <ThreadView
          activeTurnId={activeTurnId}
          addOptimisticUserMessage={(_text) => "optimistic-1"}
          backends={[]}
          composerDisabled={false}
          desktopApi={{ checkThreadBranchDrift }}
          loading={false}
          loadingMore={false}
          messageCount={1}
          selectedThread={{
            id: threadId,
            title: threadId,
            titleSource: "explicit",
            source: "codex",
            gitBranch: "feature/b",
            observedGitBranch: "feature/b",
            updatedAt: Date.now(),
            linkedDirectories: [],
            inbox: { inInbox: false },
          }}
          skills={[]}
          transcriptEntries={[]}
          clearPendingRequest={() => undefined}
          onLoadOlder={async () => undefined}
          removeOptimisticMessage={(_id) => undefined}
        />
      );
    }

    // Thread A with active turn.
    const { rerender } = render(<Harness activeTurnId="turn-1" threadId="thread-a" />);
    await waitFor(() => {
      expect(checkThreadBranchDrift).toHaveBeenCalled();
    });
    const callsAfterMount = checkThreadBranchDrift.mock.calls.length;

    // Same render: switch to thread B AND clear activeTurnId. The
    // falling-edge guard requires threadKey unchanged, so no extra
    // recheck should fire from the falling-edge effect (only the
    // normal focus-on-selection check).
    rerender(<Harness activeTurnId={undefined} threadId="thread-b" />);

    await new Promise((resolve) => setTimeout(resolve, 50));
    // One additional call from the focus-path effect (selection change)
    // is acceptable. The falling-edge effect should NOT have added a
    // separate one for thread A.
    const callsAfterSwitch = checkThreadBranchDrift.mock.calls.length;
    expect(callsAfterSwitch - callsAfterMount).toBeLessThanOrEqual(1);

    // No dialog should appear because the IPC reports no drift on B.
    expect(
      screen.queryByRole("dialog", { name: "Thread branch changed" }),
    ).not.toBeInTheDocument();
  });

  it("defers completed live transcript publishing outside the render phase", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onPublished = vi.fn();
    let agentEventHandler:
      | ((event: {
          backend: "codex";
          notification: AppServerNotification;
        }) => void)
      | undefined;

    function Harness() {
      const [entries, setEntries] = useState<any[]>([]);

      return (
        <ThreadView
          activeTurnId="turn-1"
          activeTurnStartedAt={1_000}
          addOptimisticUserMessage={(_text) => "optimistic-1"}
          backends={[]}
          composerDisabled={false}
          desktopApi={{
            onAgentEvent: (callback) => {
              agentEventHandler = callback as typeof agentEventHandler;
              return () => undefined;
            },
          }}
          loading={false}
          loadingMore={false}
          messageCount={entries.length}
          selectedThread={{
            id: "thread-live",
            title: "Live turn",
            titleSource: "explicit",
            source: "codex",
            updatedAt: Date.now(),
            linkedDirectories: [],
            inbox: {
              inInbox: false,
            },
          }}
          skills={[]}
          transcriptEntries={entries}
          clearPendingRequest={() => undefined}
          onLiveTranscriptEntry={(entry) => {
            onPublished(entry);
            setEntries((current) => [...current, entry]);
          }}
          onLoadOlder={async () => undefined}
          removeOptimisticMessage={(_id) => undefined}
        />
      );
    }

    try {
      render(<Harness />);

      await act(async () => {
        agentEventHandler?.({
          backend: "codex",
          notification: {
            method: "mcpServer/startupStatus/updated",
            params: {
              name: "context7",
              status: "ready",
            },
          },
        });
      });

      await act(async () => {
        agentEventHandler?.({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-live",
              turnId: "turn-1",
              turn: {
                id: "turn-1",
                status: "completed",
                completedAt: 2_000,
                output: [],
              },
            },
          },
        });
      });

      await waitFor(() => {
        expect(onPublished).toHaveBeenCalledWith(
          expect.objectContaining({
            id: "live-mcp-protocol-status",
            turn: expect.objectContaining({
              id: "turn-1",
              status: "completed",
            }),
          }),
        );
      });
      expect(
        consoleErrorSpy.mock.calls.some((call) =>
          call.some(
            (part) =>
              typeof part === "string" &&
              part.includes("Cannot update a component"),
          ),
        ),
      ).toBe(false);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("submits the launchpad prompt when continuing after environment setup failure", async () => {
    const startTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-env-failure",
      turnId: "turn-1",
    }));
    const onActiveTurnIdChange = vi.fn();
    const onPendingStatusChange = vi.fn();

    render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[]}
        composerDisabled={false}
        desktopApi={{ startTurn }}
        loading={false}
        loadingMore={false}
        messageCount={1}
        selectedThread={{
          id: "thread-env-failure",
          title: "Untitled thread",
          titleSource: "fallback",
          source: "codex",
          executionMode: "full-access",
          model: "gpt-5.5",
          reasoningEffort: "high",
          updatedAt: Date.now(),
          codexEnvironmentRuntime: {
            environmentId: "environment",
            environmentName: "PwrAgent",
            executionTarget: "local",
            setupStatus: "failed",
          },
          linkedDirectories: [
            {
              id: "/repo",
              kind: "worktree",
              label: "repo",
              path: "/repo",
              worktreePath: "/repo/.worktrees/thread-env-failure",
            },
          ],
          optimisticUserMessage: {
            text: "Fix the failed setup",
            imageParts: [{ type: "image", url: "data:image/png;base64,abc" }],
            createdAt: 1_000,
          },
          inbox: {
            inInbox: true,
            reason: "new-thread",
          },
        }}
        skills={[]}
        transcriptEntries={[]}
        clearPendingRequest={() => undefined}
        onActiveTurnIdChange={onActiveTurnIdChange}
        onLoadOlder={async () => undefined}
        onPendingStatusChange={onPendingStatusChange}
        removeOptimisticMessage={(_id) => undefined}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Continue anyway" }));

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-env-failure",
        input: [
          { type: "text", text: "Fix the failed setup" },
          { type: "image", url: "data:image/png;base64,abc" },
        ],
        executionMode: "full-access",
        model: "gpt-5.5",
        reasoningEffort: "high",
        serviceTier: undefined,
        fastMode: undefined,
      });
    });
    expect(onPendingStatusChange).toHaveBeenCalledWith("Thinking");
    expect(onActiveTurnIdChange).toHaveBeenCalledWith("turn-1");
  });

  it("hides the environment setup failure choice after the thread has messages", () => {
    render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[]}
        composerDisabled={false}
        desktopApi={{}}
        loading={false}
        loadingMore={false}
        messageCount={1}
        selectedThread={{
          id: "thread-env-failure",
          title: "A new problem I ran into really bit me last night",
          titleSource: "derived",
          source: "codex",
          executionMode: "full-access",
          updatedAt: Date.now(),
          codexEnvironmentRuntime: {
            environmentId: "environment",
            environmentName: "PwrAgent",
            executionTarget: "local",
            setupStatus: "failed",
          },
          linkedDirectories: [
            {
              id: "/repo",
              kind: "worktree",
              label: "repo",
              path: "/repo",
              worktreePath: "/repo/.worktrees/thread-env-failure",
            },
          ],
          inbox: {
            inInbox: true,
            reason: "updated-since-seen",
          },
        }}
        skills={[]}
        transcriptEntries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "What is the CWD?",
          },
        ]}
        clearPendingRequest={() => undefined}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
      />
    );

    expect(
      screen.queryByRole("button", { name: "Continue anyway" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Environment setup failed"),
    ).not.toBeInTheDocument();
  });

  it("keeps the edited-files entry visible exactly once after turn/completed (no duplicate-row regression — issue #495)", async () => {
    // Reproduces the duplicate-row bug from issue #495: prior to the
    // fix, `turn/completed` deferred the pending entry into
    // optimisticEntries (and thus the transcript) AND left it as the
    // pending entry — two rows for the same diff. After the fix, the
    // rail owns the pending entry, the transcript owns the deferred
    // entry, and there is exactly one rendering at any given time.
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    let agentEventHandler: ((event: AgentEvent) => void) | undefined;
    const liveDiff = [
      "diff --git a/apps/desktop/src/renderer/src/lib/useThreadSessionState.ts b/apps/desktop/src/renderer/src/lib/useThreadSessionState.ts",
      "--- a/apps/desktop/src/renderer/src/lib/useThreadSessionState.ts",
      "+++ b/apps/desktop/src/renderer/src/lib/useThreadSessionState.ts",
      "@@ -113,2 +113,1 @@",
      "-<<<<<<< HEAD",
      "-function appendMessageEntries(",
      "+function messageMatchesOptimisticEntry(",
    ].join("\n");

    function Harness() {
      // Mirrors the real upstream lifecycle: the hook clears
      // `activeTurnId` on `turn/completed` so the rail flips from
      // live → pinned. The Harness simulates that here.
      const [activeTurnId, setActiveTurnId] = useState<string | undefined>("turn-1");
      const [entries, setEntries] = useState<any[]>([]);
      return (
        <ThreadView
          activeTurnId={activeTurnId}
          activeTurnStartedAt={1_000}
          addOptimisticUserMessage={(_text) => "optimistic-1"}
          backends={[]}
          composerDisabled={false}
          desktopApi={{
            onAgentEvent: (callback) => {
              const wrapped: typeof callback = (event) => {
                callback(event);
                if (event.notification.method === "turn/completed") {
                  setActiveTurnId(undefined);
                }
              };
              agentEventHandler = wrapped as typeof agentEventHandler;
              return () => undefined;
            },
          }}
          loading={false}
          loadingMore={false}
          messageCount={entries.length}
          selectedThread={{
            id: "thread-dupe",
            title: "Dupe-fix regression",
            titleSource: "explicit",
            source: "codex",
            updatedAt: Date.now(),
            linkedDirectories: [],
            inbox: { inInbox: false },
          }}
          skills={[]}
          transcriptEntries={entries}
          clearPendingRequest={() => undefined}
          onLiveTranscriptEntry={(entry) => {
            setEntries((current) => [...current, entry]);
          }}
          onLoadOlder={async () => undefined}
          removeOptimisticMessage={(_id) => undefined}
        />
      );
    }

    try {
      render(<Harness />);

      // During the active turn, the rail (h3 heading) is the single
      // display surface for the cumulative diff.
      await act(async () => {
        agentEventHandler?.(
          buildRendererLiveDiffEvent({
            additions: 1,
            diff: liveDiff,
            path: "apps/desktop/src/renderer/src/lib/useThreadSessionState.ts",
            removals: 2,
            threadId: "thread-dupe",
            turnId: "turn-1",
          }),
        );
      });
      // Rail title carries the summary (the section h3 was merged into
      // the rail title in the #495 follow-up).
      expect(
        screen.getAllByRole("complementary", { name: /Edited 1 file/ }),
      ).toHaveLength(1);

      // turn/completed → pending cleared, snapshot keeps the rail
      // showing, deferred entry settles into the transcript via
      // optimisticEntries. The rail's `complementary` landmark stays
      // exactly one; the transcript may render zero or one
      // TranscriptActivity toggle button as the persisted record.
      await act(async () => {
        agentEventHandler?.({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-dupe",
              turnId: "turn-1",
              turn: {
                id: "turn-1",
                status: "completed",
                completedAt: 2_000,
                output: [],
              },
            },
          },
        });
      });
      // Wait for the deferred microtask + state flushes to settle.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      // Rail stays (pinned snapshot). The transcript also receives the
      // deferred entry, which renders TranscriptActivity's toggle
      // button — separate display surface. Two displays of the same
      // conceptual entry across rail + transcript is the
      // user-approved post-#495 model; what we strictly forbid is
      // *duplication within a single surface*. Scope the transcript
      // check inside its region so the rail's own collapse button
      // (now also labeled with the summary) isn't counted.
      expect(
        screen.getAllByRole("complementary", { name: /Edited 1 file/ }),
      ).toHaveLength(1);
      const transcriptRegion = screen.getByRole("region", { name: "Transcript" });
      expect(
        within(transcriptRegion)
          .queryAllByRole("button", { name: /^Edited 1 file/i })
          .length,
      ).toBeLessThanOrEqual(1);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("keeps the prior turn's uncommitted edits in the rail when a new turn starts", async () => {
    let agentEventHandler: ((event: AgentEvent) => void) | undefined;
    const liveDiff = [
      "diff --git a/apps/desktop/src/renderer/src/lib/useThreadSessionState.ts b/apps/desktop/src/renderer/src/lib/useThreadSessionState.ts",
      "--- a/apps/desktop/src/renderer/src/lib/useThreadSessionState.ts",
      "+++ b/apps/desktop/src/renderer/src/lib/useThreadSessionState.ts",
      "@@ -1,1 +1,2 @@",
      " existing line",
      "+added by turn 1",
    ].join("\n");

    function Harness() {
      const [activeTurnId, setActiveTurnId] = useState<string | undefined>("turn-1");
      const [entries, setEntries] = useState<any[]>([]);
      return (
        <>
          <button type="button" onClick={() => setActiveTurnId("turn-2")}>
            Start turn 2
          </button>
          <ThreadView
            activeTurnId={activeTurnId}
            activeTurnStartedAt={1_000}
            addOptimisticUserMessage={(_text) => "optimistic-1"}
            backends={[]}
            composerDisabled={false}
            desktopApi={{
              onAgentEvent: (callback) => {
                const wrapped: typeof callback = (event) => {
                  callback(event);
                  if (event.notification.method === "turn/completed") {
                    setActiveTurnId(undefined);
                  }
                };
                agentEventHandler = wrapped as typeof agentEventHandler;
                return () => undefined;
              },
            }}
            loading={false}
            loadingMore={false}
            messageCount={entries.length}
            selectedThread={{
              id: "thread-pin",
              title: "Pin lifecycle",
              titleSource: "explicit",
              source: "codex",
              updatedAt: Date.now(),
              linkedDirectories: [],
              inbox: { inInbox: false },
            }}
            skills={[]}
            transcriptEntries={entries}
            clearPendingRequest={() => undefined}
            onLiveTranscriptEntry={(entry) => {
              setEntries((current) => [...current, entry]);
            }}
            onLoadOlder={async () => undefined}
            removeOptimisticMessage={(_id) => undefined}
          />
        </>
      );
    }

    render(<Harness />);

    await act(async () => {
      agentEventHandler?.(
        buildRendererLiveDiffEvent({
          additions: 1,
          diff: liveDiff,
          path: "apps/desktop/src/renderer/src/lib/useThreadSessionState.ts",
          removals: 0,
          threadId: "thread-pin",
          turnId: "turn-1",
        }),
      );
    });
    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-pin",
            turnId: "turn-1",
            turn: {
              id: "turn-1",
              status: "completed",
              completedAt: 2_000,
              output: [],
            },
          },
        },
      });
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Rail shows the pinned snapshot from turn 1.
    expect(
      screen.getByRole("complementary", { name: /\(last turn\)/i }),
    ).toBeInTheDocument();

    // Simulate the next turn starting.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start turn 2" }));
    });

    // Turn 1's edits were not committed, so they stay in the rail when
    // turn 2 starts — edits accumulate across turns until a successful
    // `git commit` lands (the turn AFTER the commit clears them; see
    // edited-file-groups.test.ts for the commit-boundary cases). The
    // "(last turn)" pinned suffix drops because a turn is active again.
    expect(
      screen.getByRole("complementary", { name: /Edited 1 file/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("complementary", { name: /\(last turn\)/i }),
    ).not.toBeInTheDocument();
  });

  it("retains a failed turn's edits in the rail instead of dropping them", async () => {
    let agentEventHandler: ((event: AgentEvent) => void) | undefined;
    const liveDiff = [
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1,1 +1,2 @@",
      " existing line",
      "+added before the failure",
    ].join("\n");

    function Harness() {
      const [entries, setEntries] = useState<any[]>([]);
      return (
        <ThreadView
          activeTurnId="turn-1"
          activeTurnStartedAt={1_000}
          addOptimisticUserMessage={(_text) => "optimistic-1"}
          backends={[]}
          composerDisabled={false}
          desktopApi={{
            onAgentEvent: (callback) => {
              agentEventHandler = callback as typeof agentEventHandler;
              return () => undefined;
            },
          }}
          loading={false}
          loadingMore={false}
          messageCount={entries.length}
          selectedThread={{
            id: "thread-fail",
            title: "Failure lifecycle",
            titleSource: "explicit",
            source: "codex",
            updatedAt: Date.now(),
            linkedDirectories: [],
            inbox: { inInbox: false },
          }}
          skills={[]}
          transcriptEntries={entries}
          clearPendingRequest={() => undefined}
          onLiveTranscriptEntry={(entry) => {
            setEntries((current) => [...current, entry]);
          }}
          onLoadOlder={async () => undefined}
          removeOptimisticMessage={(_id) => undefined}
        />
      );
    }

    render(<Harness />);

    await act(async () => {
      agentEventHandler?.(
        buildRendererLiveDiffEvent({
          additions: 1,
          diff: liveDiff,
          path: "src/example.ts",
          removals: 0,
          threadId: "thread-fail",
          turnId: "turn-1",
        }),
      );
    });
    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/failed",
          params: {
            threadId: "thread-fail",
            turnId: "turn-1",
            turn: {
              id: "turn-1",
              status: "failed",
              error: { message: "boom" },
            },
          },
        },
      });
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // The failed turn made a real edit before stopping; it is deferred
    // into the transcript so the accumulated Edited Files groups keep it
    // rather than dropping it until a replay refresh re-fetches it.
    expect(
      screen.getByRole("complementary", { name: /Edited 1 file/ }),
    ).toBeInTheDocument();
  });
});
