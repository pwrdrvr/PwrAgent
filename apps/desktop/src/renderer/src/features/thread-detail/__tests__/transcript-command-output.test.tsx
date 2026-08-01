import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptCommandOutput } from "../TranscriptCommandOutput";

describe("TranscriptCommandOutput", () => {
  afterEach(() => {
    delete (window as Window & { pwragent?: unknown }).pwragent;
    vi.restoreAllMocks();
  });

  it("renders command metadata and captured output", () => {
    render(
      <TranscriptCommandOutput
        detail={{
          id: "cmd-1",
          kind: "command",
          label: "npm view dive (373ms)",
          status: "completed",
          command: {
            displayCommand: "npm view dive",
            rawCommand: "/bin/zsh -lc 'npm view dive'",
            output: "dive@0.5.0 | Proprietary | deps: none",
            exitCode: 0,
            durationMs: 373,
          },
        }}
      />
    );

    expect(screen.getByText("$ npm view dive")).toBeInTheDocument();
    expect(screen.getByText("dive@0.5.0 | Proprietary | deps: none")).toBeInTheDocument();
    expect(screen.getByText("Shell")).toBeInTheDocument();
    expect(screen.getByText("Success · ran for 373ms")).toBeInTheDocument();
  });

  it("labels collaboration agent output separately from shell output", () => {
    render(
      <TranscriptCommandOutput
        detail={{
          id: "agent-1",
          kind: "command",
          label: "Waited on agent 019e5630",
          status: "completed",
          command: {
            displayCommand: "wait 019e5630",
            rawCommand: "wait",
            output: "019e5630: completed\nOutput:\n  Review transcript",
          },
        }}
      />
    );

    expect(screen.getByText("Agent")).toBeInTheDocument();
    expect(screen.getByText("$ wait 019e5630")).toBeInTheDocument();
    expect(screen.getAllByText((_, element) =>
      element?.textContent?.includes("Review transcript") ?? false
    ).length).toBeGreaterThan(0);
  });

  it("renders structured native-agent waits as delegated work with transcript access", () => {
    const openSubAgentTranscriptWindow = vi.fn(async () => ({ opened: true }));
    (window as Window & { pwragent?: unknown }).pwragent = {
      openSubAgentTranscriptWindow,
    };
    render(
      <TranscriptCommandOutput
        detail={{
          id: "agent-wait-1",
          kind: "command",
          label: "Waited on agent 019fb3d1",
          status: "completed",
          command: {
            displayCommand: "wait 019fb3d1",
            rawCommand: "wait",
            output: "The agent is still working.",
            subAgent: {
              backend: "codex",
              origin: "codex-native",
              operation: "wait",
              model: "gpt-5.6-sol",
              reasoningEffort: "high",
              fastMode: true,
              agents: [
                {
                  threadId: "019fb3d1-28e0-7a30-b964-e93d7a1f3435",
                  name: "Kieregaard",
                  status: "running",
                  message: "Implementing the replacement.",
                },
              ],
            },
          },
        }}
      />,
    );

    expect(screen.getByText("Codex native agent")).toBeInTheDocument();
    expect(screen.getByText("Waited on agent")).toBeInTheDocument();
    expect(screen.getByText("Kieregaard")).toBeInTheDocument();
    expect(screen.getByText("gpt-5.6-sol")).toBeInTheDocument();
    expect(screen.getByText("Reasoning: high")).toBeInTheDocument();
    expect(screen.getByText("Fast mode: on")).toBeInTheDocument();
    expect(screen.queryByText("$ wait 019fb3d1")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open transcript" }));

    expect(openSubAgentTranscriptWindow).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "019fb3d1-28e0-7a30-b964-e93d7a1f3435",
      title: "Kieregaard",
    });
  });

  it("opens a PwrAgent-managed sub-agent transcript with its source backend", () => {
    const openSubAgentTranscriptWindow = vi.fn(async () => ({ opened: true }));
    (window as Window & { pwragent?: unknown }).pwragent = {
      openSubAgentTranscriptWindow,
    };
    render(
      <TranscriptCommandOutput
        detail={{
          id: "agent-monitor-1",
          kind: "command",
          label: "Created monitor",
          status: "completed",
          command: {
            displayCommand: "create_monitor",
            rawCommand: "create_monitor",
            subAgent: {
              backend: "acp:gemini",
              origin: "pwragent",
              operation: "spawn",
              agents: [
                {
                  threadId: "monitor-thread-1",
                  name: "Build monitor",
                },
              ],
            },
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open transcript" }));

    expect(openSubAgentTranscriptWindow).toHaveBeenCalledWith({
      backend: "acp:gemini",
      threadId: "monitor-thread-1",
      title: "Build monitor",
    });
  });

  it("renders structured ACP tool invocations without pretending they are shell commands", () => {
    render(
      <TranscriptCommandOutput
        detail={{
          id: "grep-1",
          kind: "read",
          label: "grep",
          status: "completed",
          command: {
            displayCommand:
              'grep(pattern="grok", glob="*.{ts,tsx,md,json}", head_limit=20)',
            source: "tool",
            output: "found 9 matches",
          },
        }}
      />
    );

    expect(screen.getByText("Tool")).toBeInTheDocument();
    expect(
      screen.getByText(
        'grep(pattern="grok", glob="*.{ts,tsx,md,json}", head_limit=20)',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy invocation" })).toBeInTheDocument();
    expect(screen.queryByText("tool call update")).not.toBeInTheDocument();
  });

  it("truncates long output and expands on demand", () => {
    const output = Array.from({ length: 15 }, (_, index) => `line ${index + 1}`).join("\n");

    render(
      <TranscriptCommandOutput
        detail={{
          id: "cmd-1",
          kind: "command",
          label: "npm view dive",
          status: "completed",
          command: {
            displayCommand: "npm view dive",
            output,
          },
        }}
      />
    );

    expect(screen.getAllByText((_, element) =>
      element?.textContent?.includes("line 12") ?? false
    ).length).toBeGreaterThan(0);
    expect(screen.queryByText("line 15")).not.toBeInTheDocument();
    expect(screen.getAllByText((_, element) =>
      element?.textContent?.includes("... 3 lines omitted") ?? false
    ).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Show 3 more lines" }));

    expect(screen.getAllByText((_, element) =>
      element?.textContent?.includes("line 15") ?? false
    ).length).toBeGreaterThan(0);
    expect(screen.queryByText("... 3 lines omitted")).not.toBeInTheDocument();
  });

  it("renders an empty-output state for commands without captured output", () => {
    render(
      <TranscriptCommandOutput
        detail={{
          id: "cmd-1",
          kind: "command",
          label: "git status",
          status: "completed",
          command: {
            displayCommand: "git status",
          },
        }}
      />
    );

    expect(screen.getByText("$ git status")).toBeInTheDocument();
    expect(screen.getByText("No output captured.")).toBeInTheDocument();
  });

  it("copies command text and full output", () => {
    const copyText = vi.fn(async () => undefined);
    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        copyText,
      },
    });

    render(
      <TranscriptCommandOutput
        detail={{
          id: "cmd-1",
          kind: "command",
          label: "npm view dive",
          status: "completed",
          command: {
            displayCommand: "npm view dive",
            output: "line 1\nline 2",
          },
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy output" }));

    expect(copyText).toHaveBeenNthCalledWith(1, "npm view dive");
    expect(copyText).toHaveBeenNthCalledWith(2, "line 1\nline 2");
  });
});
