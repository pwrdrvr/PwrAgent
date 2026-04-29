import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TranscriptCommandOutput } from "../TranscriptCommandOutput";

describe("TranscriptCommandOutput", () => {
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
    expect(screen.getByText("Success · ran for 373ms")).toBeInTheDocument();
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
});
