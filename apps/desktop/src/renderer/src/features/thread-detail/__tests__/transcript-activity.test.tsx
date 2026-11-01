import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServerThreadActivityDetail, NavigationThreadSummary } from "@pwragent/shared";
import { ThreadLinkProvider } from "../../../lib/thread-links";
import { TranscriptActivity } from "../TranscriptActivity";
import { buildLiveActivityEntry } from "../live-transcript-activity";

describe("TranscriptActivity", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([false, true])("renders a title-only tool once without an empty expansion (command: %s)", (withCommand) => {
    render(
      <TranscriptActivity
        expanded
        entry={{
          type: "activity",
          id: "tool-1",
          summary: "use_tool",
          details: [{
            id: "tool-1:detail",
            kind: "command",
            label: "use_tool",
            ...(withCommand ? { command: { displayCommand: "use_tool", source: "tool" as const } } : {}),
          }],
        }}
      />,
    );

    expect(screen.getAllByText("use_tool")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "use_tool" })).not.toBeInTheDocument();
  });

  it.each<Partial<AppServerThreadActivityDetail>>([
    { command: { displayCommand: 'use_tool\n{"query":"Fixture"}', source: "tool" } },
    { command: { displayCommand: "use_tool", source: "tool", output: "Done" } },
    { command: { displayCommand: "use_tool", source: "shell" } },
    { path: "/repo/fixture.ts" },
    { markdown: "Additional tool information" },
    { url: "https://example.com/fixture" },
    { status: "failed" },
  ])("keeps expansion when a repeated label has additional data: %j", (detail) => {
    render(
      <TranscriptActivity
        entry={{
          type: "activity",
          id: "tool-1",
          summary: "use_tool",
          details: [{ id: "tool-1:detail", kind: "command", label: "use_tool", ...detail }],
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "use_tool" })).toHaveAttribute("aria-expanded", "false");
  });

  it.each(([
    ["failed", "Failed"],
    ["cancelled", "Cancelled"],
    ["in_progress", "Running"],
    ["completed", "Done"],
  ] as const).flatMap(([status, label]) =>
    [false, true].map((withCommand) => ({ status, label, withCommand })),
  ))("keeps a title-only live tool's $status status accessible (command: $withCommand)", ({ status, label, withCommand }) => {
    const entry = buildLiveActivityEntry({
      id: "tool-1",
      details: [{
        id: "tool-1:detail",
        kind: "command",
        label: "use_tool",
        status,
        ...(withCommand ? { command: { displayCommand: "use_tool", source: "tool" as const } } : {}),
      }],
    });
    expect(entry.status).toBe(status);
    render(<TranscriptActivity entry={entry} />);

    const toggle = screen.getByRole("button", { name: "use_tool" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(withCommand && status === "completed" ? "Success" : label)).toBeInTheDocument();
  });

  it("shows a direct activity path relative to the longest thread directory", async () => {
    const copyText = vi.fn(async () => undefined);
    const absolutePath =
      "/Users/fixture-user/.pwragent/worktrees/ms2ai7od/PwrAgnt/apps/desktop/src/main/acp/acp-runtime-capabilities.ts";
    const label = `Read \`${absolutePath}\``;

    render(
      <TranscriptActivity
        desktopApi={{ copyText }}
        directoryPaths={[
          "/Users/fixture-user/pwrdrvr/PwrAgnt",
          "/Users/fixture-user/.pwragent/worktrees/ms2ai7od/PwrAgnt",
        ]}
        entry={{
          type: "activity",
          id: "read-1",
          summary: label,
          details: [
            {
              id: "read-1:detail",
              kind: "read",
              label,
              path: absolutePath,
              command: {
                displayCommand: label,
                source: "tool",
                output: "Read 80 lines",
              },
            },
          ],
        }}
      />,
    );

    const displayLabel =
      "Read `apps/desktop/src/main/acp/acp-runtime-capabilities.ts`";
    const toggle = screen.getByRole("button", { name: displayLabel });
    expect(toggle).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy activity" }));
    await waitFor(() => {
      expect(copyText).toHaveBeenCalledWith(`${label}\n${label}`);
    });

    fireEvent.click(toggle);

    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy invocation" })).toBeInTheDocument();
  });

  it("formats nested detail labels while keeping outside paths absolute", () => {
    const projectPath = "/repo/PwrAgnt/apps/desktop/src/main.ts";
    const outsidePath = "/repo/PwrAgnt-other/scripts/release.ts";

    render(
      <TranscriptActivity
        directoryPaths={["/repo/PwrAgnt"]}
        entry={{
          type: "activity",
          id: "reads-1",
          summary: "Read 2 files",
          details: [
            {
              id: "read-project",
              kind: "read",
              label: `Read \`${projectPath}\``,
              path: projectPath,
            },
            {
              id: "read-outside",
              kind: "read",
              label: `Read \`${outsidePath}\``,
              path: outsidePath,
            },
          ],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Read 2 files" }));

    expect(screen.getByText("Read `apps/desktop/src/main.ts`")).toBeInTheDocument();
    expect(screen.getByText(`Read \`${outsidePath}\``)).toBeInTheDocument();
  });

  it("does not replace a matching path prefix inside an outside path", () => {
    const projectPath = "/repo/PwrAgnt";
    const outsidePath = "/repo/PwrAgnt-old/file.ts";

    render(
      <TranscriptActivity
        directoryPaths={[projectPath]}
        entry={{
          type: "activity",
          id: "shared-prefix-paths",
          summary: `Compared \`${projectPath}\` with \`${outsidePath}\``,
          details: [
            {
              id: "project-path",
              kind: "read",
              label: `Read \`${projectPath}\``,
              path: projectPath,
            },
            {
              id: "outside-path",
              kind: "read",
              label: `Read \`${outsidePath}\``,
              path: outsidePath,
            },
          ],
        }}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: `Compared \`.\` with \`${outsidePath}\``,
      }),
    ).toBeInTheDocument();
  });

  it("renders send_message_to_thread as a linked, expandable message", () => {
    const onShowThread = vi.fn();
    render(
      <ThreadLinkProvider
        onShowThread={onShowThread}
        threads={[{
          id: "target-thread",
          title: "Runner preflight",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          inbox: { inInbox: true, unread: false },
        } as NavigationThreadSummary]}
      >
        <TranscriptActivity
          entry={{
            type: "activity",
            id: "send-thread-message",
            summary: "send message to thread",
            status: "completed",
            details: [{
              id: "send-thread-message:detail",
              kind: "command",
              label: "send message to thread",
              status: "completed",
              command: {
                rawCommand: "pwragent/send_message_to_thread",
                displayCommand: [
                  "pwragent/send_message_to_thread",
                  JSON.stringify({
                    backend: "codex",
                    threadId: "target-thread",
                    prompt: "Please inspect **the failing check**.",
                  }, null, 2),
                ].join("\n"),
                output: JSON.stringify({
                  backend: "codex",
                  threadId: "target-thread",
                  messageId: "user:turn-9",
                  messageUrl:
                    "pwragent://thread/target-thread?backend=codex&messageId=user%3Aturn-9",
                  threadUrl: "pwragent://thread/target-thread?backend=codex",
                }),
                source: "tool",
              },
            }],
          }}
        />
      </ThreadLinkProvider>,
    );

    expect(screen.getByRole("button", {
      name: "Open thread Runner preflight",
    })).toBeInTheDocument();
    expect(screen.queryByText("the failing check")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Message sent to" }));
    expect(screen.getByText("the failing check")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", {
      name: "Open thread Runner preflight",
    }));
    expect(onShowThread).toHaveBeenCalledWith(expect.objectContaining({
      backend: "codex",
      messageId: "user:turn-9",
      threadId: "target-thread",
    }));
  });

  it("renders read_thread messages instead of its JSON payload", () => {
    const onShowThread = vi.fn();
    render(
      <ThreadLinkProvider
        onShowThread={onShowThread}
        threads={[{
          id: "target-thread",
          title: "Runner preflight",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          inbox: { inInbox: true, unread: false },
        } as NavigationThreadSummary]}
      >
        <TranscriptActivity
          entry={{
            type: "activity",
            id: "read-thread",
            summary: "read thread",
            status: "completed",
            details: [{
              id: "read-thread:detail",
              kind: "command",
              label: "read thread",
              status: "completed",
              command: {
                rawCommand: "pwragent/read_thread",
                displayCommand: "pwragent/read_thread\n{\"backend\":\"codex\",\"threadId\":\"target-thread\"}",
                output: JSON.stringify({
                  read: {
                    backend: "codex",
                    threadId: "target-thread",
                    threadUrl: "pwragent://thread/target-thread?backend=codex",
                    messages: [{
                      id: "assistant-message-4",
                      role: "assistant",
                      text: "The **preflight passed** on the mounted runner.",
                      messageUrl:
                        "pwragent://thread/target-thread?backend=codex&messageId=assistant-message-4",
                    }],
                  },
                }),
                source: "tool",
              },
            }],
          }}
        />
      </ThreadLinkProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Read thread" }));
    expect(screen.getByText("preflight passed")).toBeInTheDocument();
    expect(screen.queryByText(/"threadId"/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open message" }));
    expect(onShowThread).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "assistant-message-4",
      threadId: "target-thread",
    }));
  });

  describe("watch_thread_pull_request", () => {
    function watchEntry(params: { args?: Record<string, unknown>; output?: unknown; rawCommand?: string }) {
      const rawCommand = params.rawCommand ?? "pwragent/watch_thread_pull_request";
      return {
        type: "activity" as const,
        id: "watch-pr",
        summary: "watch thread pull request",
        status: "completed" as const,
        details: [{
          id: "watch-pr:detail",
          kind: "command" as const,
          label: "watch thread pull request",
          status: "completed" as const,
          command: {
            rawCommand,
            displayCommand: [rawCommand, JSON.stringify(params.args ?? {})].join("\n"),
            ...(params.output !== undefined
              ? { output: typeof params.output === "string" ? params.output : JSON.stringify(params.output) }
              : {}),
            source: "tool" as const,
          },
        }],
      };
    }
    const ciWatch = {
      watchId: "watch-ci", backend: "codex", threadId: "thread-1", prKey: "github.com/pwrdrvr/pwragent#3174",
      prUrl: "https://github.com/pwrdrvr/PwrAgent/pull/3174", prNumber: 3174, headSha: "a".repeat(40),
      notifyOn: ["success", "failure"], createdAt: 1, failureHandledByAutoFix: false, kind: "checks",
    };
    const terminalWatch = { ...ciWatch, watchId: "watch-merge", headSha: "", notifyOn: ["merged", "closed"], kind: "terminal" };
    const result = (extra: Record<string, unknown>) => ({
      pullRequestWatch: { coveredByAutoFix: [], prAutomation: {}, armed: true, reason: "armed", ...extra },
    });

    it.each([
      [
        "a CI watch after a re-run",
        result({ watch: { ...ciWatch, runAttempt: 2 }, message: "Watching PR #3174 at aaaaaaa for the next success or failure (attempt 2)." }),
        "Waiting for CI · #3174 · attempt 2",
      ],
      [
        "an already armed CI watch",
        result({ watch: ciWatch, reason: "already_armed", message: "Already watching PR #3174." }),
        "Already waiting for CI · #3174",
      ],
      [
        "a merge/close watch",
        result({ terminalWatch, message: "Watching PR #3174 until it merges or closes without merge." }),
        "Watching #3174 for merge or close",
      ],
      [
        "a CI result that already finished",
        result({ armed: false, reason: "outcome_already_final", currentOutcome: "success", message: "No watch was created: checks on aaaaaaa already finished with success 4s ago." }),
        "No CI watch: checks already finished",
      ],
      [
        "a merged PR",
        result({ armed: false, reason: "pr_terminal", currentOutcome: "merged", terminal: { outcome: "merged", prNumber: 3174 }, message: "No watch was created: PR #3174 is already merged." }),
        "No watch: #3174 is already merged",
      ],
      [
        "an agent's list",
        { pullRequestWatches: { action: "list", watches: [ciWatch, terminalWatch], message: "2 watches wait on this thread." } },
        "2 PR watches waiting",
      ],
      [
        "an agent's cancel",
        { pullRequestWatches: { action: "cancel", watches: [], cancelled: ciWatch, message: "Stopped waiting for CI on PR #3174. Nothing else waits on this thread." } },
        "Stopped waiting for CI · #3174",
      ],
    ])("labels %s from the tool's result", (_name, output, label) => {
      render(<TranscriptActivity entry={watchEntry({ output })} />);
      expect(screen.getByText(label)).toBeInTheDocument();
      // The result is read, not printed.
      expect(screen.queryByText(/"pullRequestWatch/)).not.toBeInTheDocument();
    });

    it("expands to the result's own sentence and reads the PR number from the url when no watch has it", () => {
      render(<TranscriptActivity entry={watchEntry({
        args: { url: "https://github.com/pwrdrvr/PwrAgent/pull/3174", notifyOn: ["success", "failure", "merged"] },
        output: result({
          armed: false,
          reason: "outcome_already_final",
          terminalWatch,
          message: "No CI watch was created: checks on aaaaaaa already finished with failure 2s ago.",
        }),
      })} />);
      const toggle = screen.getByRole("button", {
        name: "No CI watch: checks already finished · watching #3174 for merge or close",
      });
      expect(screen.queryByText(/already finished with failure/)).not.toBeInTheDocument();
      fireEvent.click(toggle);
      expect(screen.getByText(/already finished with failure 2s ago/)).toBeInTheDocument();
    });

    it("reads Claude's MCP tool name and an error result", () => {
      render(<TranscriptActivity entry={watchEntry({
        rawCommand: "mcp__pwragent__watch_thread_pull_request",
        output: { ok: false, error: { code: "not_found", message: "No waiting watch on this thread has that watchId." } },
      })} />);
      fireEvent.click(screen.getByRole("button", { name: "No PR watch" }));
      expect(screen.getByText("No waiting watch on this thread has that watchId.")).toBeInTheDocument();
    });

    it("leaves a call with no result to the generic row", () => {
      render(<TranscriptActivity entry={watchEntry({})} />);
      expect(screen.queryByText(/Waiting for CI|PR watch/)).not.toBeInTheDocument();
      expect(screen.getByText("watch thread pull request")).toBeInTheDocument();
    });
  });
});
