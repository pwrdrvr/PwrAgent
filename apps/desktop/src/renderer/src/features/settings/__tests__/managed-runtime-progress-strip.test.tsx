import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagedRuntimeProgress } from "../../../../../shared/managed-runtime-progress";
import {
  ManagedRuntimeProgressStrip,
  useManagedRuntimeProgress,
} from "../ManagedRuntimeProgress";
import { ToggleField } from "../SettingsLayout";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function progress(patch: Partial<ManagedRuntimeProgress>): ManagedRuntimeProgress {
  return { runtime: "codex", phase: "downloading", updatedAt: Date.now(), ...patch };
}

describe("ManagedRuntimeProgressStrip", () => {
  it("exposes a measurable download as a progress bar with the byte meter", () => {
    render(
      <ManagedRuntimeProgressStrip
        progress={progress({
          tag: "v1",
          receivedBytes: 50,
          totalBytes: 200,
        })}
      />,
    );

    expect(screen.getByRole("progressbar", { name: "Download 25%" })).toHaveAttribute(
      "aria-valuenow",
      "25",
    );
    expect(screen.getByText("Downloading")).toBeInTheDocument();
    expect(screen.getByText("v1")).toBeInTheDocument();
    expect(screen.getByRole("listitem", { current: "step" })).toHaveAccessibleName(
      "Download, in progress",
    );
  });

  it("gives a sweep no progressbar role when nothing is measurable", () => {
    render(<ManagedRuntimeProgressStrip progress={progress({ phase: "unpacking", tag: "v1" })} />);

    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByRole("listitem", { name: "Verify, done" })).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: "Unpack, in progress" })).toBeInTheDocument();
  });

  it("offers Try again only on a failure", () => {
    const retry = vi.fn();
    const { rerender } = render(
      <ManagedRuntimeProgressStrip progress={progress({})} onRetry={retry} />,
    );
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();

    rerender(
      <ManagedRuntimeProgressStrip
        progress={progress({ phase: "failed", failedPhase: "verifying", error: "Checksum mismatch" })}
        onRetry={retry}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.getByRole("listitem", { name: "Verify, failed" })).toBeInTheDocument();
  });
});

describe("useManagedRuntimeProgress", () => {
  function Probe(props: {
    api: Parameters<typeof useManagedRuntimeProgress>[0];
    runtime: "codex" | "grok";
  }) {
    const current = useManagedRuntimeProgress(props.api, props.runtime);
    return <p data-testid="phase">{current?.phase ?? "none"}</p>;
  }

  it("starts from the current state and follows events for its own runtime only", async () => {
    let emit: (event: ManagedRuntimeProgress) => void = () => undefined;
    const api = {
      onManagedRuntimeProgress: (callback: (event: ManagedRuntimeProgress) => void) => {
        emit = callback;
        return () => undefined;
      },
      readManagedRuntimeProgress: async () => [
        progress({ runtime: "grok", phase: "verifying" }),
        progress({ runtime: "codex", phase: "downloading" }),
      ],
    };
    render(<Probe api={api} runtime="codex" />);
    await screen.findByText("downloading");

    act(() => emit(progress({ runtime: "grok", phase: "unpacking" })));
    expect(screen.getByTestId("phase")).toHaveTextContent("downloading");

    act(() => emit(progress({ runtime: "codex", phase: "unpacking" })));
    expect(screen.getByTestId("phase")).toHaveTextContent("unpacking");

    act(() => emit(progress({ runtime: "codex", phase: "idle" })));
    expect(screen.getByTestId("phase")).toHaveTextContent("none");
  });

  it("lets a finished strip go by itself", async () => {
    vi.useFakeTimers();
    let emit: (event: ManagedRuntimeProgress) => void = () => undefined;
    const api = {
      onManagedRuntimeProgress: (callback: (event: ManagedRuntimeProgress) => void) => {
        emit = callback;
        return () => undefined;
      },
      readManagedRuntimeProgress: async () => [],
    };
    render(<Probe api={api} runtime="codex" />);

    act(() => emit(progress({ phase: "ready", updatedAt: Date.now() })));
    expect(screen.getByTestId("phase")).toHaveTextContent("ready");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_000);
    });
    expect(screen.getByTestId("phase")).toHaveTextContent("none");
  });
});

describe("ToggleField locked", () => {
  it("stays focusable, refuses a click, and points at its reason", () => {
    const onChange = vi.fn(async () => undefined);
    render(
      <ToggleField
        checked
        label="PwrAgent build"
        lockedReason="Token Miser needs this build."
        onChange={onChange}
      />,
    );

    const toggle = screen.getByRole("switch", { name: "PwrAgent build" });
    expect(toggle).not.toBeDisabled();
    expect(toggle).toHaveAttribute("aria-disabled", "true");
    toggle.focus();
    expect(toggle).toHaveFocus();
    fireEvent.click(toggle);
    expect(onChange).not.toHaveBeenCalled();
    expect(toggle).toHaveAccessibleDescription(/Token Miser needs this build\./);
  });

  it("switches normally when it carries no reason", () => {
    const onChange = vi.fn(async () => undefined);
    render(<ToggleField checked={false} label="PwrAgent build" onChange={onChange} />);
    fireEvent.click(screen.getByRole("switch", { name: "PwrAgent build" }));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
