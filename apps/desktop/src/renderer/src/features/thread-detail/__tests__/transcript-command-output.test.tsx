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
