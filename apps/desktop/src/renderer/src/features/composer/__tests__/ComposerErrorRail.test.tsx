import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerErrorRail, type ComposerErrorEntry } from "../ComposerErrorRail";
import {
  cleanComposerErrorMessage,
  summarizeComposerError,
} from "../composer-error-message";

afterEach(cleanup);

const CLIXML =
  '#< CLIXML\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T></TN></Obj></Objs>';

describe("composer error message cleanup", () => {
  it("drops the IPC wrapper and PowerShell progress stream", () => {
    const raw =
      `Error invoking remote method 'agent:set-codex-thread-environment': Error: handler_failed: Codex environment command exited with 1: check-node-version\n${CLIXML}`;
    expect(cleanComposerErrorMessage(raw)).toBe(
      "Codex environment command exited with 1: check-node-version",
    );
  });

  it("keeps a short single-line message as its own summary", () => {
    expect(summarizeComposerError("Choose a project to review.")).toEqual({
      summary: "Choose a project to review.",
    });
  });

  it("offers the whole message when more than the first line exists", () => {
    const result = summarizeComposerError("Setup failed\nnpm ERR! network timeout");
    expect(result.summary).toBe("Setup failed");
    expect(
      summarizeComposerError("Command exited with 1:\n. step").summary,
    ).toBe("Command exited with 1");
    expect(result.detail).toBe("Setup failed\nnpm ERR! network timeout");
  });
});

describe("ComposerErrorRail", () => {
  const entry = (
    overrides: Partial<ComposerErrorEntry> = {},
  ): ComposerErrorEntry => ({
    id: "environment",
    label: "Environment error",
    message: "Setup failed\nnpm ERR! network timeout",
    ...overrides,
  });

  it("renders nothing without a message", () => {
    const { container } = render(
      <ComposerErrorRail entries={[entry({ message: undefined })]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("dismisses one error without hiding another", () => {
    render(
      <ComposerErrorRail
        entries={[
          entry(),
          entry({ id: "action", label: "Action failed", message: "Nope." }),
        ]}
      />,
    );
    const rows = screen.getAllByRole("alert");
    expect(rows).toHaveLength(2);

    fireEvent.click(rows[0]!.querySelector("button.composer__queued-env-action-dismiss")!);

    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByText("Nope.")).toBeInTheDocument();
  });

  it("shows a dismissed source again when it reports a new message", () => {
    const { rerender } = render(<ComposerErrorRail entries={[entry()]} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();

    rerender(<ComposerErrorRail entries={[entry({ message: "Different failure." })]} />);
    expect(screen.getByText("Different failure.")).toBeInTheDocument();
  });

  it("shows the same message again after the source cleared in between", () => {
    const { rerender } = render(<ComposerErrorRail entries={[entry()]} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    rerender(<ComposerErrorRail entries={[entry({ message: undefined })]} />);
    rerender(<ComposerErrorRail entries={[entry()]} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("copies the raw message, not the cleaned one", () => {
    const copyText = vi.fn().mockResolvedValue(undefined);
    const raw = "Error invoking remote method 'x': Error: Boom";
    render(
      <ComposerErrorRail
        desktopApi={{ copyText }}
        entries={[entry({ message: raw })]}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Copy error: Environment error" }),
    );
    expect(copyText).toHaveBeenCalledWith(raw);
  });

  it("has no disclosure button for a message with nothing more to show", () => {
    render(
      <ComposerErrorRail entries={[entry({ message: "Choose a project to review." })]} />,
    );
    expect(screen.queryByRole("button", { expanded: false })).toBeNull();
  });

  it("does not toggle the row when the copy or dismiss buttons are used", () => {
    render(<ComposerErrorRail entries={[entry()]} />);
    const toggle = screen.getByRole("button", { expanded: false });
    fireEvent.click(screen.getByRole("button", { name: /Copy error/ }));
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/npm ERR! network timeout/)).toBeInTheDocument();
  });
});
