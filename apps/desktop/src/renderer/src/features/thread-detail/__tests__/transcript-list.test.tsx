import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptList } from "../TranscriptList";

describe("TranscriptList", () => {
  let scrollHeight = 480;
  let clientHeight = 240;
  let clientWidth = 320;
  let offsetWidth = 336;
  let scrollToMock: ReturnType<typeof vi.fn>;
  let createObjectURLMock: ReturnType<typeof vi.fn>;
  let revokeObjectURLMock: ReturnType<typeof vi.fn>;

  function scrollAwayWithScrollbar(element: HTMLElement, scrollTop: number) {
    fireEvent.pointerDown(element, {
      clientX: clientWidth + 8,
      clientY: 24,
    });
    element.scrollTop = scrollTop;
    fireEvent.scroll(element);
  }

  beforeEach(() => {
    scrollHeight = 480;
    clientHeight = 240;
    clientWidth = 320;
    offsetWidth = 336;
    scrollToMock = vi.fn(function scrollTo(
      this: HTMLElement,
      options?: number | ScrollToOptions,
      y?: number
    ) {
      if (typeof options === "number") {
        this.scrollTop = y ?? 0;
        return;
      }

      this.scrollTop = options?.top ?? 0;
    });

    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return scrollHeight;
      }
    });

    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return clientHeight;
      }
    });

    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return clientWidth;
      }
    });

    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get() {
        return offsetWidth;
      }
    });

    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value() {
        return {
          bottom: clientHeight,
          height: clientHeight,
          left: 0,
          right: offsetWidth,
          top: 0,
          width: offsetWidth,
          x: 0,
          y: 0,
          toJSON: () => undefined,
        };
      }
    });

    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollToMock
    });

    createObjectURLMock = vi.fn(() => "blob:transcript-image");
    revokeObjectURLMock = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURLMock
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURLMock
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders transcript history and exposes incremental history loading when available", () => {
    const loadOlder = vi.fn(async () => undefined);

    render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Open [`ce:work`](/Users/huntharo/.codex/skills/ce-work/SKILL.md)\n\n- **Check Unit 4**\n- Keep Unit 3 isolated"
          },
          {
            type: "activity",
            id: "activity-1",
            summary: "Explored 2 files, ran 1 command",
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
              },
              {
                id: "detail-3",
                kind: "command",
                label: "pwd && rg --files"
              }
            ]
          },
          {
            type: "message",
            id: "message-2",
            role: "assistant",
            text: "The desktop shell is live.\n\nRun `pnpm test -- --project desktop-renderer` next."
          }
        ]}
        loading={false}
        loadingMore={false}
        pagination={{
          supportsPagination: true,
          hasPreviousPage: true,
          previousCursor: "cursor-1"
        }}
        threadId="thread-1"
        onLoadOlder={loadOlder}
      />
    );

    expect(screen.getByRole("link", { name: "ce:work" })).toHaveAttribute(
      "href",
      "file:///Users/huntharo/.codex/skills/ce-work/SKILL.md"
    );
    expect(screen.getByText("Check Unit 4", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("Keep Unit 3 isolated")).toBeInTheDocument();
    expect(screen.getByText("pnpm test -- --project desktop-renderer")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "ce:work" }).closest("article")
    ).toHaveClass("transcript-message--user");
    expect(
      screen.getByText("pnpm test -- --project desktop-renderer").closest("article")
    ).toHaveClass("transcript-message--assistant");
    expect(screen.getByText("Explored 2 files, ran 1 command")).toBeInTheDocument();
    expect(screen.queryByText("Read TranscriptList.tsx")).not.toBeInTheDocument();
    expect(screen.queryByText("Read ThreadView.tsx")).not.toBeInTheDocument();
    expect(screen.queryByText("pwd && rg --files")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /Explored 2 files, ran 1 command/i })
    );

    expect(screen.getByText("Read TranscriptList.tsx")).toBeInTheDocument();
    expect(screen.getByText("Read ThreadView.tsx")).toBeInTheDocument();
    expect(screen.getByText("pwd && rg --files")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));

    expect(loadOlder).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "Jump to latest message" })
    ).not.toBeInTheDocument();
  });

  it("renders skill mentions as chips when present alongside markdown text", () => {
    const loadOlder = vi.fn(async () => undefined);

    render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Load [$frontend-design](/Users/huntharo/.codex/skills/frontend-design/SKILL.md) and **keep** the current styling."
          },
          {
            type: "message",
            id: "message-2",
            role: "assistant",
            text: "The desktop shell is live and listing Codex threads."
          }
        ]}
        loading={false}
        loadingMore={false}
        pagination={{
          supportsPagination: true,
          hasPreviousPage: true,
          previousCursor: "cursor-1"
        }}
        skills={[
          {
            name: "frontend-design",
            description: "Design and verify renderer UI work.",
            path: "/Users/huntharo/.codex/skills/frontend-design/SKILL.md",
            enabled: true,
          },
        ]}
        threadId="thread-1"
        onLoadOlder={loadOlder}
      />
    );

    expect(screen.getByText("$frontend-design")).toBeInTheDocument();
    expect(screen.getByText("keep", { selector: "strong" })).toBeInTheDocument();
    expect(
      screen.getByText("$frontend-design").closest("article")
    ).toHaveClass("transcript-message--user");
  });

  it("opens transcript file links in the configured editor", async () => {
    const openApplication = vi.fn(async () => ({ opened: true as const }));

    render(
      <TranscriptList
        applications={{
          editors: [
            {
              id: "vscode",
              kind: "editor",
              name: "VS Code",
              source: "application",
              appPath: "/Applications/Visual Studio Code.app",
              canOpenWorkspace: true,
            },
            {
              id: "zed",
              kind: "editor",
              name: "Zed",
              source: "application",
              appPath: "/Applications/Zed.app",
              canOpenWorkspace: true,
            },
          ],
          terminals: [],
          preferredEditorId: { value: "zed", source: "config" },
          preferredTerminalId: { value: "", source: "default" },
        }}
        desktopApi={{ openApplication }}
        entries={[
          {
            type: "message",
            id: "message-1",
            role: "assistant",
            text: "I updated [AGENTS.md](/repo/PwrAgent/AGENTS.md:17).",
          },
        ]}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    fireEvent.click(screen.getByRole("link", { name: "AGENTS.md" }));

    await waitFor(() => {
      expect(openApplication).toHaveBeenCalledWith({
        applicationId: "zed",
        kind: "editor",
        targetPath: "/repo/PwrAgent/AGENTS.md",
      });
    });
  });

  it("does not turn pasted plan paths into transcript links", () => {
    render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Use docs/plans/2026-05-02-001-feat-messaging-tool-update-verbosity-plan.md for the fix.",
          },
        ]}
        loading={false}
        loadingMore={false}
        pagination={{
          supportsPagination: false,
          hasPreviousPage: false,
        }}
        threadId="thread-1"
        onLoadOlder={vi.fn(async () => undefined)}
      />
    );

    expect(
      screen.getByText(
        "Use docs/plans/2026-05-02-001-feat-messaging-tool-update-verbosity-plan.md for the fix."
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders inline image previews and opens them on demand", () => {
    const onOpenImage = vi.fn();
    const dataUrl = "data:image/png;base64,aGVsbG8=";
    const secondDataUrl = "data:image/png;base64,d29ybGQ=";

    render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Describe this image",
            parts: [
              {
                type: "text",
                text: "Describe this image"
              },
              {
                type: "image",
                url: dataUrl,
                alt: "Transcript screenshot"
              },
              {
                type: "image",
                url: secondDataUrl,
                alt: "Second transcript screenshot"
              }
            ]
          },
          {
            type: "message",
            id: "message-2",
            role: "assistant",
            text: "",
            parts: [
              {
                type: "image",
                url: "https://example.com/thread-image.png",
                alt: "Assistant image"
              }
            ]
          }
        ]}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onOpenImage={onOpenImage}
        onLoadOlder={async () => undefined}
      />
    );

    expect(screen.getByText("Describe this image")).toBeInTheDocument();
    expect(screen.getByAltText("Transcript screenshot")).toHaveAttribute(
      "src",
      "blob:transcript-image"
    );
    expect(screen.getByAltText("Second transcript screenshot")).toHaveAttribute(
      "src",
      "blob:transcript-image"
    );
    expect(screen.getByAltText("Assistant image")).toBeInTheDocument();
    expect(createObjectURLMock).toHaveBeenCalledTimes(2);
    expect(
      screen.getByAltText("Transcript screenshot").closest(".transcript-message__image-grid")
    ).toBe(
      screen.getByAltText("Second transcript screenshot").closest(".transcript-message__image-grid")
    );

    fireEvent.click(screen.getByAltText("Transcript screenshot").closest("button")!);

    expect(onOpenImage).toHaveBeenCalledWith({
      type: "image",
      url: dataUrl,
      alt: "Transcript screenshot"
    });
  });

  it("renders pending status inside the transcript list", () => {
    render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "What can this skill do?"
          }
        ]}
        loading={false}
        loadingMore={false}
        pendingStatusText="Waiting for the app server…"
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent("Waiting for the app server…");
    expect(screen.getByRole("status").querySelector(".thinking-scanner")).not.toBeNull();
  });

  it("renders replayed plan progress inline in the transcript", () => {
    render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Show the desktop task list."
          },
          {
            type: "plan",
            id: "plan-1",
            explanation: "Keep the renderer and replay contract aligned.",
            markdown: "## Final plan\n\nUse the transcript plan renderer for durable output.",
            steps: [
              { step: "Normalize replay", status: "pending" },
              { step: "Render transcript plan card", status: "pending" },
              { step: "Verify with tests", status: "pending" }
            ]
          }
        ]}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(screen.getByText("0 out of 3 tasks completed")).toBeInTheDocument();
    expect(
      screen.getByText("Keep the renderer and replay contract aligned.")
    ).toBeInTheDocument();
    expect(screen.getByText("Normalize replay")).toBeInTheDocument();
    expect(screen.getByText("Render transcript plan card")).toBeInTheDocument();
    expect(screen.getByText("Verify with tests")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Final plan" })).toBeInTheDocument();
    expect(
      screen.getByText("Use the transcript plan renderer for durable output.")
    ).toBeInTheDocument();
    expect(screen.getAllByText("Pending")).toHaveLength(3);
  });

  it("renders a live assistant message before the turn is persisted", () => {
    render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Run npm view dive"
          }
        ]}
        loading={false}
        loadingMore={false}
        pendingAssistantMessage={{
          type: "message",
          id: "pending-assistant-1",
          role: "assistant",
          text: "I ran `npm view dive`"
        }}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(screen.getByText("I ran")).toBeInTheDocument();
    expect(screen.getByText("npm view dive")).toBeInTheDocument();
    expect(screen.getByText("I ran").closest("article")).toHaveClass(
      "transcript-message--assistant"
    );
  });

  it("collapses completed assistant commentary before the final answer", () => {
    render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "commentary-1",
            role: "assistant",
            phase: "commentary",
            text: "First commentary.",
          },
          {
            type: "message",
            id: "commentary-2",
            role: "assistant",
            phase: "commentary",
            text: "Second commentary.",
          },
          {
            type: "message",
            id: "commentary-3",
            role: "assistant",
            phase: "commentary",
            text: "Third commentary.",
          },
          {
            type: "message",
            id: "final-1",
            role: "assistant",
            phase: "final",
            text: "Final answer.",
          },
        ]}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const toggle = screen.getByRole("button", { name: "3 previous messages" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Final answer.")).toBeVisible();
    expect(screen.getByText("First commentary.")).not.toBeVisible();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("First commentary.")).toBeVisible();
    expect(screen.getByText("Second commentary.")).toBeVisible();
    expect(screen.getByText("Third commentary.")).toBeVisible();
  });

  it("keeps all active commentary messages visible", () => {
    render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "commentary-1",
            role: "assistant",
            phase: "commentary",
            text: "First commentary.",
          },
          {
            type: "message",
            id: "commentary-2",
            role: "assistant",
            phase: "commentary",
            text: "Second commentary.",
          },
          {
            type: "message",
            id: "commentary-3",
            role: "assistant",
            phase: "commentary",
            text: "Third commentary.",
          },
        ]}
        loading={false}
        loadingMore={false}
        pendingAssistantMessage={{
          type: "message",
          id: "commentary-4",
          role: "assistant",
          phase: "commentary",
          text: "Fourth commentary.",
        }}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(screen.queryByRole("button", { name: /previous message/ })).not.toBeInTheDocument();
    expect(screen.getByText("First commentary.")).toBeVisible();
    expect(screen.getByText("Second commentary.")).toBeVisible();
    expect(screen.getByText("Third commentary.")).toBeVisible();
    expect(screen.getByText("Fourth commentary.")).toBeVisible();
  });

  it("renders a live activity entry before the turn is persisted", () => {
    render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Fix the merge markers"
          }
        ]}
        loading={false}
        loadingMore={false}
        pendingActivityEntry={{
          type: "activity",
          id: "pending-activity-1",
          summary: "Edited 1 file, +1, -2",
          details: [
            {
              id: "pending-detail-1",
              kind: "write",
              label: "Update useThreadSessionState.ts",
              path: "/repo/apps/desktop/src/renderer/src/lib/useThreadSessionState.ts",
              fileDiff: {
                kind: "update",
                additions: 1,
                removals: 2,
                diff: [
                  "--- a/apps/desktop/src/renderer/src/lib/useThreadSessionState.ts",
                  "+++ b/apps/desktop/src/renderer/src/lib/useThreadSessionState.ts",
                  "@@ -1,3 +1,2 @@",
                  "-<<<<<<< HEAD",
                  "-function appendMessageEntries(",
                  "+function messageMatchesOptimisticEntry("
                ].join("\n")
              }
            }
          ]
        }}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const toggle = screen.getByRole("button", { name: /Edited 1 file, \+1, -2/i });
    expect(toggle).toBeInTheDocument();

    fireEvent.click(toggle);

    expect(screen.getByText("Update useThreadSessionState.ts")).toBeInTheDocument();
    expect(screen.getAllByText("-2")[0]).toBeInTheDocument();
    expect(screen.getAllByText("+1")[0]).toBeInTheDocument();
    expect(screen.queryByText("function messageMatchesOptimisticEntry(")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Update useThreadSessionState.ts/i }));

    expect(screen.getByText("function messageMatchesOptimisticEntry(")).toBeInTheDocument();
  });

  it("inserts pending activity by event time among optimistic turn entries", () => {
    const activeTurn = {
      id: "turn-1",
      status: "in_progress" as const,
      startedAt: 1_000,
    };

    render(
      <TranscriptList
        activeTurnId="turn-1"
        activeTurnStartedAt={1_000}
        entries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Keep testing the composer."
          },
          {
            type: "activity",
            id: "activity-1",
            summary: "Used 2 tools",
            createdAt: 1_500,
            details: [
              {
                id: "detail-1",
                kind: "command",
                label: "pnpm --filter @pwragent/desktop typecheck"
              }
            ],
            turn: activeTurn
          },
          {
            type: "message",
            id: "message-2",
            role: "assistant",
            phase: "commentary",
            text: "The focused composer tests are green.",
            createdAt: 3_000,
            turn: activeTurn
          },
          {
            type: "activity",
            id: "activity-2",
            summary: "pnpm --filter @pwragent/desktop test",
            createdAt: 4_000,
            details: [
              {
                id: "detail-2",
                kind: "command",
                label: "pnpm --filter @pwragent/desktop test:e2e -- directory-launchpad-skills.spec.ts"
              }
            ],
            turn: activeTurn
          }
        ]}
        loading={false}
        loadingMore={false}
        pendingActivityEntry={{
          type: "activity",
          id: "pending-file-change-1",
          summary: "Changed 1 file",
          createdAt: 2_000,
          details: [
            {
              id: "pending-detail-1",
              kind: "write",
              label: "Update Composer.tsx",
              path: "/repo/apps/desktop/src/renderer/src/features/composer/Composer.tsx"
            }
          ],
          turn: activeTurn
        }}
        pendingStatusText="Thinking"
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const transcriptText = document.body.textContent ?? "";
    const firstActivityIndex = transcriptText.indexOf("Used 2 tools");
    const changedIndex = transcriptText.indexOf("Changed 1 file");
    const commentaryIndex = transcriptText.indexOf("The focused composer tests are green.");
    const laterActivityIndex = transcriptText.indexOf("pnpm --filter @pwragent/desktop test");

    expect(firstActivityIndex).toBeGreaterThanOrEqual(0);
    expect(changedIndex).toBeGreaterThan(firstActivityIndex);
    expect(commentaryIndex).toBeGreaterThan(changedIndex);
    expect(laterActivityIndex).toBeGreaterThan(commentaryIndex);
  });

  it("keeps just-finished live tool activity reachable when the final message arrives", async () => {
    const completedTurn = {
      id: "turn-1",
      status: "completed" as const,
      startedAt: 1_000,
      completedAt: 72_000,
      durationMs: 71_000,
    };

    render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Fix the transcript activity."
          },
          {
            type: "message",
            id: "message-2",
            role: "assistant",
            text: "Fixed.",
            turn: completedTurn,
          }
        ]}
        loading={false}
        loadingMore={false}
        pendingActivityEntry={{
          type: "activity",
          id: "tool-usage-1",
          summary: "Used 2 tools",
          details: [
            {
              id: "tool-detail-1",
              kind: "command",
              label: "rg -n transcript activity"
            },
            {
              id: "tool-detail-2",
              kind: "read",
              label: "Read TranscriptList.tsx"
            }
          ],
          turn: completedTurn,
        }}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const workGroup = screen.getByRole("button", { name: /Worked for 1m 11s/i });
    expect(workGroup).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(workGroup);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Used 2 tools/i })).toBeVisible();
    });
  });

  it("anchors a freshly loaded transcript to the newest entry", () => {
    render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Show me the current desktop thread shell"
          },
          {
            type: "activity",
            id: "activity-1",
            summary: "Explored 2 files, ran 1 command",
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
              },
              {
                id: "detail-3",
                kind: "command",
                label: "pwd && rg --files"
              }
            ]
          },
          {
            type: "message",
            id: "message-2",
            role: "assistant",
            text: "The desktop shell is live and listing Codex threads."
          }
        ]}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const list = screen.getByRole("list");

    expect(list.scrollTop).toBe(480);
    expect(scrollToMock).not.toHaveBeenCalled();
  });

  it("collapses activity details by default and toggles them inline", () => {
    render(
      <TranscriptList
        entries={[
          {
            type: "activity",
            id: "activity-1",
            summary: "Explored 3 files",
            details: [
              {
                id: "detail-1",
                kind: "read",
                label: "Read TranscriptActivity.tsx"
              },
              {
                id: "detail-2",
                kind: "read",
                label: "Read TranscriptList.tsx"
              },
              {
                id: "detail-3",
                kind: "command",
                label: "Searched transcript-activity"
              }
            ]
          }
        ]}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const toggle = screen.getByRole("button", { name: /Explored 3 files/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Read TranscriptActivity.tsx")).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Read TranscriptActivity.tsx")).toBeInTheDocument();
    expect(screen.getByText("Read TranscriptList.tsx")).toBeInTheDocument();
    expect(screen.getByText("Searched transcript-activity")).toBeInTheDocument();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Read TranscriptActivity.tsx")).not.toBeInTheDocument();
  });

  it("renders pending same-turn work before a persisted final assistant reply", () => {
    render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "user-1",
            role: "user",
            text: "Are there two websocket layers?",
            turn: { id: "turn-1", status: "completed" }
          },
          {
            type: "message",
            id: "assistant-final-1",
            role: "assistant",
            phase: "final",
            text: "Yes, there are two separate websocket layers.",
            turn: { id: "turn-1", status: "completed" }
          }
        ]}
        loading={false}
        loadingMore={false}
        pendingProtocolActivityEntry={{
          type: "activity",
          id: "protocol-activity-1",
          summary: "MCP status updates (3)",
          status: "completed",
          details: [
            {
              id: "mcp-status-1",
              kind: "command",
              label: "MCP server status updated",
              status: "completed"
            }
          ],
          turn: { id: "turn-1", status: "completed" }
        }}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const workGroup = screen.getByRole("button", { name: /Previous work/i });
    const finalReply = screen.getByText("Yes, there are two separate websocket layers.");

    expect(
      workGroup.compareDocumentPosition(finalReply) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(workGroup).toHaveAttribute("aria-expanded", "false");
  });

  it("replaces a persisted entry when pending protocol activity has the same id", () => {
    render(
      <TranscriptList
        entries={[
          {
            type: "activity",
            id: "live-mcp-protocol-status",
            summary: "MCP server starting",
            status: "in_progress",
            details: [
              {
                id: "mcp-status-context7",
                kind: "command",
                label: "MCP context7 starting",
                status: "in_progress"
              }
            ]
          }
        ]}
        loading={false}
        loadingMore={false}
        pendingProtocolActivityEntry={{
          type: "activity",
          id: "live-mcp-protocol-status",
          summary: "MCP server ready",
          status: "completed",
          details: [
            {
              id: "mcp-status-context7",
              kind: "command",
              label: "MCP context7 ready",
              status: "completed"
            }
          ]
        }}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(screen.getAllByRole("button", { name: /MCP server ready/i })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /MCP server starting/i })).not.toBeInTheDocument();
  });

  it("keeps a pending tool below the earlier pending assistant message that started first", () => {
    render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "user-1",
            role: "user",
            text: "Run npm view dive pls",
            turn: { id: "turn-1", status: "in_progress" }
          }
        ]}
        loading={false}
        loadingMore={false}
        pendingActivityEntry={{
          type: "activity",
          id: "live-tools-turn-1",
          createdAt: 1_777_480_902_942,
          summary: "Ran 1 command",
          status: "completed",
          details: [
            {
              id: "call-dive",
              kind: "command",
              label: "npm view dive (419ms)",
              status: "completed"
            }
          ],
          turn: { id: "turn-1", status: "in_progress" }
        }}
        pendingAssistantMessage={{
          type: "message",
          id: "commentary-1",
          role: "assistant",
          createdAt: 1_777_480_901_377,
          text: "I’ll run the package lookup directly and relay the useful parts of the output.",
          turn: { id: "turn-1", status: "in_progress" }
        }}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const commentary = screen.getByText(
      "I’ll run the package lookup directly and relay the useful parts of the output."
    );
    const tool = screen.getByRole("button", { name: /Ran 1 command/i });

    expect(
      commentary.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("keeps later pending assistant text below an earlier final same-turn message", () => {
    render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "user-1",
            role: "user",
            text: "Keep the visible transcript chronological.",
            createdAt: 1_777_480_900_000,
            turn: { id: "turn-1", status: "completed" }
          },
          {
            type: "message",
            id: "assistant-final-1",
            role: "assistant",
            phase: "final",
            text: "First visible assistant update.",
            createdAt: 1_777_480_902_000,
            turn: { id: "turn-1", status: "completed" }
          }
        ]}
        loading={false}
        loadingMore={false}
        pendingAssistantMessage={{
          type: "message",
          id: "assistant-pending-2",
          role: "assistant",
          text: "Second visible assistant update.",
          createdAt: 1_777_480_903_000,
          turn: { id: "turn-1", status: "completed" }
        }}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const first = screen.getByText("First visible assistant update.");
    const second = screen.getByText("Second visible assistant update.");

    expect(
      first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("collapses completed work groups when a final message arrives while live work is still pending", async () => {
    render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "user-1",
            role: "user",
            text: "Investigate transcript ordering.",
            turn: {
              id: "turn-1",
              status: "completed",
              durationMs: 956_000
            }
          },
          {
            type: "message",
            id: "commentary-1",
            role: "assistant",
            phase: "commentary",
            text: "I’ll trace this from the protocol capture.",
            turn: {
              id: "turn-1",
              status: "completed",
              durationMs: 956_000
            }
          },
          {
            type: "message",
            id: "final-1",
            role: "assistant",
            phase: "final",
            text: "Found and fixed the transcript ordering issue.",
            turn: {
              id: "turn-1",
              status: "completed",
              durationMs: 956_000
            }
          }
        ]}
        loading={false}
        loadingMore={false}
        pendingActivityEntry={{
          type: "activity",
          id: "live-tools-turn-1",
          summary: "Ran 1 command",
          status: "completed",
          details: [
            {
              id: "call-1",
              kind: "command",
              label: "rg -n transcript apps/desktop",
              status: "completed"
            }
          ],
          turn: {
            id: "turn-1",
            status: "completed",
            durationMs: 956_000
          }
        }}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const workGroup = screen.getByRole("button", { name: /Worked for 15m 56s/i });

    await waitFor(() => {
      expect(workGroup).toHaveAttribute("aria-expanded", "false");
    });
  });

  it("renders simple write diffs fully without zoom controls", () => {
    render(
      <TranscriptList
        entries={[
          {
            type: "activity",
            id: "activity-1",
            summary: "Edited 1 file",
            details: [
              {
                id: "detail-1",
                kind: "write",
                label: "Update TranscriptList.tsx",
                path: "/repo/apps/desktop/src/renderer/src/features/thread-detail/TranscriptList.tsx",
                fileDiff: {
                  kind: "update",
                  additions: 1,
                  removals: 1,
                  diff: [
                    "--- a/apps/desktop/src/renderer/src/features/thread-detail/TranscriptList.tsx",
                    "+++ b/apps/desktop/src/renderer/src/features/thread-detail/TranscriptList.tsx",
                    "@@ -10,6 +10,6 @@",
                    " export function TranscriptList() {",
                    "   const a = 1;",
                    "   const b = 2;",
                    "   const c = 3;",
                    "-  return a + b;",
                    "+  return a + b + c;",
                    " }"
                  ].join("\n")
                }
              }
            ]
          }
        ]}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Edited 1 file/i }));

    expect(screen.getByText("Update TranscriptList.tsx")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Update TranscriptList.tsx/i }));

    expect(screen.getByText("const b = 2;")).toBeInTheDocument();
    expect(screen.getByText("const c = 3;")).toBeInTheDocument();
    expect(screen.queryByText("2 unmodified lines skipped")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Zoom in" })).not.toBeInTheDocument();
  });

  it("preserves the reader position when older messages are prepended", () => {
    const { rerender } = render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "message-2",
            role: "user",
            text: "Second message"
          },
          {
            type: "message",
            id: "message-3",
            role: "assistant",
            text: "Third message"
          }
        ]}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const list = screen.getByRole("list");
    list.scrollTop = 80;
    fireEvent.scroll(list);

    scrollHeight = 640;

    rerender(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "message-1",
            role: "assistant",
            text: "First message"
          },
          {
            type: "message",
            id: "message-2",
            role: "user",
            text: "Second message"
          },
          {
            type: "message",
            id: "message-3",
            role: "assistant",
            text: "Third message"
          }
        ]}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(list.scrollTop).toBe(240);
  });

  it("shows the jump-to-latest control only when the newest entry is below the viewport", () => {
    render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "First message"
          },
          {
            type: "message",
            id: "message-2",
            role: "assistant",
            text: "Second message"
          }
        ]}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const list = screen.getByRole("list");

    expect(
      screen.queryByRole("button", { name: "Jump to latest message" })
    ).not.toBeInTheDocument();

    list.scrollTop = 0;
    fireEvent.scroll(list);

    expect(screen.getByRole("button", { name: "Jump to latest message" })).toBeInTheDocument();
  });

  it("uses smooth scrolling only for the explicit jump-to-latest action", () => {
    render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "First message"
          },
          {
            type: "message",
            id: "message-2",
            role: "assistant",
            text: "Second message"
          }
        ]}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const list = screen.getByRole("list");
    list.scrollTop = 0;
    fireEvent.scroll(list);
    scrollToMock.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Jump to latest message" }));

    expect(scrollToMock).toHaveBeenCalledWith({
      behavior: "smooth",
      top: 480
    });
  });

  it("restores the previous viewport when switching back to a cached thread", () => {
    const { rerender } = render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "thread-1-message-1",
            role: "user",
            text: "Thread one first message"
          },
          {
            type: "message",
            id: "thread-1-message-2",
            role: "assistant",
            text: "Thread one second message"
          },
          {
            type: "message",
            id: "thread-1-message-3",
            role: "assistant",
            text: "Thread one third message"
          }
        ]}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const list = screen.getByRole("list");
    scrollAwayWithScrollbar(list, 72);

    rerender(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "thread-2-message-1",
            role: "user",
            text: "Thread two first message"
          },
          {
            type: "message",
            id: "thread-2-message-2",
            role: "assistant",
            text: "Thread two second message"
          }
        ]}
        loading={false}
        loadingMore={false}
        threadId="thread-2"
        onLoadOlder={async () => undefined}
      />
    );

    list.scrollTop = 18;
    fireEvent.scroll(list);

    rerender(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "thread-1-message-1",
            role: "user",
            text: "Thread one first message"
          },
          {
            type: "message",
            id: "thread-1-message-2",
            role: "assistant",
            text: "Thread one second message"
          },
          {
            type: "message",
            id: "thread-1-message-3",
            role: "assistant",
            text: "Thread one third message"
          }
        ]}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(list.scrollTop).toBe(72);
  });

  it("restores a scrolled-away thread to its saved viewport", () => {
    const { rerender } = render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "thread-1-message-1",
            role: "user",
            text: "Thread one first message"
          },
          {
            type: "message",
            id: "thread-1-message-2",
            role: "assistant",
            text: "Thread one second message"
          }
        ]}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const list = screen.getByRole("list");
    list.scrollTop = 60;
    fireEvent.scroll(list);

    rerender(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "thread-2-message-1",
            role: "user",
            text: "Thread two first message"
          }
        ]}
        loading={false}
        loadingMore={false}
        threadId="thread-2"
        onLoadOlder={async () => undefined}
      />
    );

    rerender(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "thread-1-message-1",
            role: "user",
            text: "Thread one first message"
          },
          {
            type: "message",
            id: "thread-1-message-2",
            role: "assistant",
            text: "Thread one second message"
          }
        ]}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(list.scrollTop).toBe(60);
  });

  it("does not re-arm auto-scroll while a cached transcript is refreshing", () => {
    const { rerender } = render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "thread-1-message-1",
            role: "user",
            text: "Thread one first message"
          },
          {
            type: "message",
            id: "thread-1-message-2",
            role: "assistant",
            text: "Thread one second message"
          },
          {
            type: "message",
            id: "thread-1-message-3",
            role: "assistant",
            text: "Thread one third message"
          }
        ]}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const list = screen.getByRole("list");
    scrollAwayWithScrollbar(list, 72);
    scrollToMock.mockClear();

    rerender(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "thread-1-message-1",
            role: "user",
            text: "Thread one first message"
          },
          {
            type: "message",
            id: "thread-1-message-2",
            role: "assistant",
            text: "Thread one second message"
          },
          {
            type: "message",
            id: "thread-1-message-3",
            role: "assistant",
            text: "Thread one third message"
          }
        ]}
        loading={true}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    scrollHeight = 640;

    rerender(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "thread-1-message-1",
            role: "user",
            text: "Thread one first message"
          },
          {
            type: "message",
            id: "thread-1-message-2",
            role: "assistant",
            text: "Thread one second message"
          },
          {
            type: "message",
            id: "thread-1-message-3",
            role: "assistant",
            text: "Thread one third message"
          },
          {
            type: "message",
            id: "thread-1-message-4",
            role: "assistant",
            text: "Thread one fourth message"
          }
        ]}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(list.scrollTop).toBe(72);
    expect(scrollToMock).not.toHaveBeenCalled();
  });

  it("keeps following the bottom while a streamed turn grows in place", () => {
    const longEntries = Array.from({ length: 24 }, (_, index) => ({
      type: "message" as const,
      id: `history-message-${index + 1}`,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `History message ${index + 1}`
    }));
    scrollHeight = 720;
    const { rerender } = render(
      <TranscriptList
        entries={longEntries}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const list = screen.getByRole("list");
    list.scrollTop = 480;
    fireEvent.scroll(list);

    scrollHeight = 840;
    const entriesWithUserPrompt = [
      ...longEntries,
      {
        type: "message" as const,
        id: "user-prompt-1",
        role: "user" as const,
        text: "Please continue from here."
      }
    ];
    rerender(
      <TranscriptList
        entries={entriesWithUserPrompt}
        loading={false}
        loadingMore={false}
        pendingStatusText="Thinking"
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );
    expect(list.scrollTop).toBe(840);

    list.scrollTop = 600;
    fireEvent.scroll(list);
    scrollHeight = 980;
    rerender(
      <TranscriptList
        entries={entriesWithUserPrompt}
        loading={false}
        loadingMore={false}
        pendingActivityEntry={{
          type: "activity",
          id: "tool-usage-1",
          summary: "Searched 12 files",
          details: [
            {
              id: "tool-detail-1",
              kind: "command",
              label: "rg -n scroll apps/desktop/src"
            }
          ]
        }}
        pendingAssistantMessage={{
          type: "message",
          id: "assistant-stream-1",
          role: "assistant",
          phase: "commentary",
          text: "I found the transcript scroll handling."
        }}
        pendingStatusText="Thinking"
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );
    expect(list.scrollTop).toBe(980);

    list.scrollTop = 740;
    fireEvent.scroll(list);
    scrollHeight = 1120;
    rerender(
      <TranscriptList
        entries={entriesWithUserPrompt}
        loading={false}
        loadingMore={false}
        pendingActivityEntry={{
          type: "activity",
          id: "tool-usage-1",
          summary: "Searched 12 files and read 3 files",
          details: [
            {
              id: "tool-detail-1",
              kind: "command",
              label: "rg -n scroll apps/desktop/src"
            },
            {
              id: "tool-detail-2",
              kind: "read",
              label: "Read TranscriptList.tsx"
            }
          ]
        }}
        pendingAssistantMessage={{
          type: "message",
          id: "assistant-stream-1",
          role: "assistant",
          phase: "commentary",
          text: [
            "I found the transcript scroll handling.",
            "The pending assistant message is still streaming, so the same message id grows taller.",
            "When the viewport was already pinned to the bottom, that growth should keep moving the viewport."
          ].join(" ")
        }}
        pendingStatusText="Thinking"
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(list.scrollTop).toBe(1120);
  });

  it("keeps following after a new prompt is appended to a long bottom-pinned chat", () => {
    const entries = Array.from({ length: 32 }, (_, index) => ({
      type: "message" as const,
      id: `long-message-${index + 1}`,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `Long transcript message ${index + 1}`
    }));
    scrollHeight = 960;
    const { rerender } = render(
      <TranscriptList
        entries={entries}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const list = screen.getByRole("list");
    list.scrollTop = 720;
    fireEvent.scroll(list);

    const entriesWithNextPrompt = [
      ...entries,
      {
        type: "message" as const,
        id: "user-prompt-2",
        role: "user" as const,
        text: "Add one more answer at the bottom."
      }
    ];
    scrollHeight = 1080;
    rerender(
      <TranscriptList
        entries={entriesWithNextPrompt}
        loading={false}
        loadingMore={false}
        pendingStatusText="Thinking"
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );
    expect(list.scrollTop).toBe(1080);

    list.scrollTop = 840;
    fireEvent.scroll(list);
    scrollHeight = 1200;
    rerender(
      <TranscriptList
        entries={entriesWithNextPrompt}
        loading={false}
        loadingMore={false}
        pendingAssistantMessage={{
          type: "message",
          id: "assistant-stream-2",
          role: "assistant",
          phase: "final",
          text: "Here is the beginning of the answer."
        }}
        pendingStatusText="Thinking"
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );
    expect(list.scrollTop).toBe(1200);

    list.scrollTop = 960;
    fireEvent.scroll(list);
    scrollHeight = 1340;
    rerender(
      <TranscriptList
        entries={entriesWithNextPrompt}
        loading={false}
        loadingMore={false}
        pendingAssistantMessage={{
          type: "message",
          id: "assistant-stream-2",
          role: "assistant",
          phase: "final",
          text: [
            "Here is the beginning of the answer.",
            "More streamed content arrived after the prompt, and following mode should keep the latest line visible."
          ].join(" ")
        }}
        pendingStatusText="Thinking"
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(list.scrollTop).toBe(1340);
  });

  it("stops following the bottom as soon as the reader scrolls away", () => {
    const entries = Array.from({ length: 24 }, (_, index) => ({
      type: "message" as const,
      id: `generic-scroll-message-${index + 1}`,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `Generic scroll transcript message ${index + 1}`
    }));
    scrollHeight = 720;
    const { rerender } = render(
      <TranscriptList
        entries={entries}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const list = screen.getByRole("list");
    list.scrollTop = 480;
    fireEvent.scroll(list);

    list.scrollTop = 120;
    fireEvent.scroll(list);

    scrollHeight = 880;
    rerender(
      <TranscriptList
        entries={[
          ...entries,
          {
            type: "message",
            id: "assistant-live-append",
            role: "assistant",
            text: "This live append should still pull the glued transcript to the bottom."
          }
        ]}
        loading={false}
        loadingMore={false}
        pendingStatusText="Thinking"
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(list.scrollTop).toBe(120);
  });

  it("does not pull the reader back down when a streamed assistant message grows after scroll-away", () => {
    const entries = Array.from({ length: 24 }, (_, index) => ({
      type: "message" as const,
      id: `stream-scroll-message-${index + 1}`,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `Stream scroll transcript message ${index + 1}`
    }));
    scrollHeight = 720;
    const { rerender } = render(
      <TranscriptList
        entries={entries}
        loading={false}
        loadingMore={false}
        pendingAssistantMessage={{
          type: "message",
          id: "assistant-stream-scroll-away",
          role: "assistant",
          phase: "final",
          text: "Streaming starts."
        }}
        pendingStatusText="Thinking"
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const list = screen.getByRole("list");
    list.scrollTop = 480;
    fireEvent.scroll(list);

    list.scrollTop = 120;
    fireEvent.scroll(list);

    scrollHeight = 920;
    rerender(
      <TranscriptList
        entries={entries}
        loading={false}
        loadingMore={false}
        pendingAssistantMessage={{
          type: "message",
          id: "assistant-stream-scroll-away",
          role: "assistant",
          phase: "final",
          text: [
            "Streaming starts.",
            "More text arrived while the reader was inspecting older transcript content."
          ].join(" ")
        }}
        pendingStatusText="Thinking"
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(list.scrollTop).toBe(120);
  });

  it("reglues and scrolls to bottom when a send request arrives", () => {
    const entries = Array.from({ length: 20 }, (_, index) => ({
      type: "message" as const,
      id: `reglue-message-${index + 1}`,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `Reglue transcript message ${index + 1}`
    }));
    scrollHeight = 720;
    const { rerender } = render(
      <TranscriptList
        entries={entries}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const list = screen.getByRole("list");
    scrollAwayWithScrollbar(list, 96);

    rerender(
      <TranscriptList
        entries={entries}
        loading={false}
        loadingMore={false}
        reglueRequestKey={1}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );
    expect(list.scrollTop).toBe(720);

    scrollHeight = 840;
    rerender(
      <TranscriptList
        entries={[
          ...entries,
          {
            type: "message",
            id: "reglued-user-prompt",
            role: "user",
            text: "This prompt should stay at the bottom after send."
          }
        ]}
        loading={false}
        loadingMore={false}
        pendingStatusText="Thinking"
        reglueRequestKey={1}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(list.scrollTop).toBe(840);
  });

  it("does not reuse a consumed reglue request after the reader scrolls away", () => {
    const entries = Array.from({ length: 20 }, (_, index) => ({
      type: "message" as const,
      id: `consumed-reglue-message-${index + 1}`,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `Consumed reglue transcript message ${index + 1}`
    }));
    scrollHeight = 720;
    const { rerender } = render(
      <TranscriptList
        entries={entries}
        loading={false}
        loadingMore={false}
        reglueRequestKey={1}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const list = screen.getByRole("list");
    expect(list.scrollTop).toBe(720);

    list.scrollTop = 120;
    fireEvent.scroll(list);

    scrollHeight = 920;
    rerender(
      <TranscriptList
        entries={entries}
        loading={false}
        loadingMore={false}
        pendingAssistantMessage={{
          type: "message",
          id: "consumed-reglue-stream",
          role: "assistant",
          phase: "final",
          text: "Streaming should not reuse the old send-time reglue request."
        }}
        pendingStatusText="Thinking"
        reglueRequestKey={1}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(list.scrollTop).toBe(120);
  });

  it("keeps the bottom pinned when rendered content grows after layout", () => {
    let resizeCallback: ResizeObserverCallback | undefined;
    const OriginalResizeObserver = globalThis.ResizeObserver;
    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }

      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
    }
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: ResizeObserverMock,
    });

    try {
      const entries = Array.from({ length: 18 }, (_, index) => ({
        type: "message" as const,
        id: `resize-message-${index + 1}`,
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        text: `Resize transcript message ${index + 1}`
      }));
      scrollHeight = 720;
      render(
        <TranscriptList
          entries={entries}
          loading={false}
          loadingMore={false}
          threadId="thread-1"
          onLoadOlder={async () => undefined}
        />
      );

      const list = screen.getByRole("list");
      list.scrollTop = 480;
      fireEvent.scroll(list);

      scrollHeight = 860;
      resizeCallback?.([], {} as ResizeObserver);

      expect(list.scrollTop).toBe(860);
    } finally {
      Object.defineProperty(globalThis, "ResizeObserver", {
        configurable: true,
        value: OriginalResizeObserver,
      });
    }
  });

  it("keeps the bottom pinned when the transcript viewport shrinks without user scroll", () => {
    const entries = Array.from({ length: 18 }, (_, index) => ({
      type: "message" as const,
      id: `viewport-resize-message-${index + 1}`,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `Viewport resize transcript message ${index + 1}`
    }));
    scrollHeight = 720;
    clientHeight = 240;
    render(
      <TranscriptList
        entries={entries}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const list = screen.getByRole("list");
    list.scrollTop = 480;
    fireEvent.scroll(list);

    clientHeight = 154;
    fireEvent.scroll(list);

    expect(list.scrollTop).toBe(720);
    expect(screen.queryByRole("button", { name: "Jump to latest message" })).not.toBeInTheDocument();
  });

  it("does not move the reader when new messages arrive below an older viewport", () => {
    const entries = Array.from({ length: 16 }, (_, index) => ({
      type: "message" as const,
      id: `message-${index + 1}`,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `Message ${index + 1}`
    }));
    scrollHeight = 720;
    const { rerender } = render(
      <TranscriptList
        entries={entries}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const list = screen.getByRole("list");
    scrollAwayWithScrollbar(list, 96);

    scrollHeight = 920;
    rerender(
      <TranscriptList
        entries={[
          ...entries,
          {
            type: "message",
            id: "new-message-1",
            role: "assistant",
            text: "This arrived out of view."
          }
        ]}
        loading={false}
        loadingMore={false}
        pendingAssistantMessage={{
          type: "message",
          id: "new-message-2",
          role: "assistant",
          phase: "commentary",
          text: "This is still below the reader."
        }}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(list.scrollTop).toBe(96);
  });

  it("re-enters bottom-following mode after the jump-to-latest button is clicked", () => {
    scrollHeight = 720;
    const { rerender } = render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "First message"
          },
          {
            type: "message",
            id: "message-2",
            role: "assistant",
            text: "Second message"
          }
        ]}
        loading={false}
        loadingMore={false}
        pendingAssistantMessage={{
          type: "message",
          id: "assistant-stream-3",
          role: "assistant",
          phase: "commentary",
          text: "Streaming starts."
        }}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const list = screen.getByRole("list");
    list.scrollTop = 80;
    fireEvent.scroll(list);
    fireEvent.click(screen.getByRole("button", { name: "Jump to latest message" }));
    expect(scrollToMock).toHaveBeenLastCalledWith({
      behavior: "smooth",
      top: 720
    });

    list.scrollTop = 480;
    fireEvent.scroll(list);
    scrollHeight = 860;
    rerender(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "First message"
          },
          {
            type: "message",
            id: "message-2",
            role: "assistant",
            text: "Second message"
          }
        ]}
        loading={false}
        loadingMore={false}
        pendingAssistantMessage={{
          type: "message",
          id: "assistant-stream-3",
          role: "assistant",
          phase: "commentary",
          text: "Streaming starts. More content arrives after the jump button re-entered following mode."
        }}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(list.scrollTop).toBe(860);
  });

  it("re-enters bottom-following mode after manually scrolling to the bottom", () => {
    scrollHeight = 720;
    const { rerender } = render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "First message"
          },
          {
            type: "message",
            id: "message-2",
            role: "assistant",
            text: "Second message"
          }
        ]}
        loading={false}
        loadingMore={false}
        pendingAssistantMessage={{
          type: "message",
          id: "assistant-stream-4",
          role: "assistant",
          phase: "commentary",
          text: "Streaming starts."
        }}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const list = screen.getByRole("list");
    list.scrollTop = 80;
    fireEvent.scroll(list);
    list.scrollTop = 480;
    fireEvent.scroll(list);

    scrollHeight = 860;
    rerender(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "First message"
          },
          {
            type: "message",
            id: "message-2",
            role: "assistant",
            text: "Second message"
          }
        ]}
        loading={false}
        loadingMore={false}
        pendingAssistantMessage={{
          type: "message",
          id: "assistant-stream-4",
          role: "assistant",
          phase: "commentary",
          text: "Streaming starts. Manual scrolling reached the bottom, so the next streamed chunk should stay visible."
        }}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(list.scrollTop).toBe(860);
  });

  it("shows command approval reason and command when no prompt is provided", () => {
    const { container } = render(
      <TranscriptList
        entries={[]}
        loading={false}
        loadingMore={false}
        pendingRequest={{
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread-1",
            requestId: "approval-1",
            reason: "Network access is required.",
            command: "/bin/zsh -lc 'npm view dive'",
          },
        }}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(screen.getByRole("group", { name: "Pending approval" })).toBeInTheDocument();
    expect(screen.getByText(/Network access is required/)).toBeInTheDocument();
    expect(screen.getByText("Command:")).toBeInTheDocument();
    expect(container.querySelector(".transcript-request pre code")).toHaveTextContent(
      "npm view dive"
    );
    expect(screen.queryByText(/\/bin\/zsh -lc/)).not.toBeInTheDocument();
  });

  it("prefers parsed command actions for command approval display", () => {
    const { container } = render(
      <TranscriptList
        entries={[]}
        loading={false}
        loadingMore={false}
        pendingRequest={{
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread-1",
            requestId: "approval-1",
            reason: "Network access is required.",
            command: "/bin/zsh -lc 'npm view dive'",
            commandActions: [
              {
                type: "search",
                command: "npm view dive",
              },
            ],
          },
        }}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(screen.getByRole("group", { name: "Pending approval" })).toBeInTheDocument();
    expect(screen.getByText("Command:")).toBeInTheDocument();
    expect(container.querySelector(".transcript-request pre code")).toHaveTextContent(
      "npm view dive"
    );
    expect(screen.queryByText(/\/bin\/zsh -lc/)).not.toBeInTheDocument();
  });

  it("renders pending user input without approval actions", () => {
    render(
      <TranscriptList
        entries={[]}
        loading={false}
        loadingMore={false}
        pendingUserInput={{
          method: "item/tool/requestUserInput",
          threadId: "thread-1",
          requestId: "input-request-1",
          currentIndex: 0,
          answers: [null],
          questions: [
            {
              id: "approach",
              header: "Approach",
              question: "Which path should I take?",
              options: [
                {
                  key: "A",
                  label: "Small patch (Recommended)",
                  description: "Keep this scoped.",
                  recommended: true,
                },
              ],
              allowFreeform: false,
              secret: false,
            },
          ],
        }}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(screen.getByRole("group", { name: "Pending input" })).toBeInTheDocument();
    expect(screen.getByText("Question 1 of 1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Decline" })).not.toBeInTheDocument();
  });

  it("renders pending MCP interaction without shell approval actions", () => {
    render(
      <TranscriptList
        entries={[]}
        loading={false}
        loadingMore={false}
        pendingMcpInteraction={{
          method: "mcpServer/elicitation/request",
          threadId: "thread-1",
          requestId: "mcp-request-1",
          serverName: "playwright",
          message: "Allow the playwright MCP server to run tool \"browser_tabs\"?",
          mode: "form",
          turnId: "turn-1",
          _meta: {
            tool_description: "List, create, close, or select a browser tab.",
          },
          form: {
            empty: true,
            fields: [],
          },
          url: null,
        }}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(
      screen.getByRole("group", { name: "Pending MCP interaction" })
    ).toBeInTheDocument();
    expect(screen.getByText("MCP approval")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Allow" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });
});
