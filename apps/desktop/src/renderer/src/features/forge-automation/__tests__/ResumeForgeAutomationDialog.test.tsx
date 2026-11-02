import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ProjectHeldWakeup,
  ResolveProjectHeldWakeupsRequest,
  ResolveProjectHeldWakeupsResponse,
} from "@pwragent/shared";
import { pressEscape, tabEscapes } from "../../../test/tab-walk";
import {
  ResumeForgeAutomationDialog,
  type ResumeForgeAutomationDialogProps,
} from "../ResumeForgeAutomationDialog";

afterEach(() => {
  cleanup();
});

const NOW = new Date(2026, 10, 1, 15, 30).getTime();

const WAKEUPS: ProjectHeldWakeup[] = [
  {
    entryId: "entry-1",
    backend: "codex",
    threadId: "thread-1",
    threadTitle: "Block GitHub access from ordinary tests",
    source: "monitor",
    summary: "Monitor finished: \"Watch the nightly offline tripwire run\"",
    createdAt: new Date(2026, 10, 1, 10, 15).getTime(),
  },
  {
    entryId: "entry-2",
    backend: "codex",
    threadId: "thread-2",
    threadTitle: "Shared GitHub rate limits",
    source: "dependency",
    summary: "Continue After: \"Inspect test guard installation policy\" finished",
    createdAt: new Date(2026, 10, 1, 11, 2).getTime(),
  },
];

function settleAll(
  resolutions: ResolveProjectHeldWakeupsRequest["resolutions"],
): ResolveProjectHeldWakeupsResponse {
  return {
    results: resolutions.map((resolution) => ({
      entryId: resolution.entryId,
      status: resolution.action === "send" ? "sent" as const : "discarded" as const,
    })),
  };
}

function renderDialog(overrides: Partial<ResumeForgeAutomationDialogProps> = {}) {
  const props: ResumeForgeAutomationDialogProps = {
    projectLabel: "openclaw",
    wakeups: WAKEUPS,
    now: () => NOW,
    onResolve: vi.fn(async (resolutions) => settleAll(resolutions)),
    onCancel: vi.fn(),
    onResume: vi.fn(async () => undefined),
    ...overrides,
  };
  render(<ResumeForgeAutomationDialog {...props} />);
  return {
    props,
    dialog: screen.getByRole("dialog", { name: "Resume forge activity in openclaw?" }),
  };
}

function rows(): HTMLElement[] {
  return within(screen.getByRole("list", { name: "Held wake-ups" })).getAllByRole("listitem");
}

describe("ResumeForgeAutomationDialog", () => {
  it("lists each held wake-up with its thread, summary and time", () => {
    renderDialog();
    expect(rows()).toHaveLength(2);
    const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
      .format(WAKEUPS[0]!.createdAt);
    expect(rows()[0]).toHaveTextContent("Block GitHub access from ordinary tests");
    expect(rows()[0]).toHaveTextContent(`Monitor finished: "Watch the nightly offline tripwire run" · ${time}`);
    expect(screen.getByText(
      "Anything you leave stays held in its thread, under the Held chip, until you send or delete it there.",
    )).toBeInTheDocument();
  });

  it("sends or discards one wake-up at once and removes its row", async () => {
    const { props } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Send wake-up to Block GitHub access from ordinary tests" }));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(props.onResolve).toHaveBeenCalledWith([
      { entryId: "entry-1", backend: "codex", threadId: "thread-1", action: "send" },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Discard wake-up for Shared GitHub rate limits" }));
    await waitFor(() => expect(screen.queryByRole("list", { name: "Held wake-ups" })).not.toBeInTheDocument());
    expect(props.onResolve).toHaveBeenLastCalledWith([
      { entryId: "entry-2", backend: "codex", threadId: "thread-2", action: "discard" },
    ]);
    expect(props.onResume).not.toHaveBeenCalled();
  });

  it("moves focus to the next row's same action, then to Resume, as rows settle", async () => {
    renderDialog();
    const send = screen.getByRole("button", { name: "Send wake-up to Block GitHub access from ordinary tests" });
    send.focus();
    fireEvent.click(send);
    await waitFor(() => expect(rows()).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send wake-up to Shared GitHub rate limits" })).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "Send wake-up to Shared GitHub rate limits" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Resume" })).toHaveFocus());
  });

  it("keeps a row the owner could not settle and says why", async () => {
    renderDialog({
      onResolve: vi.fn(async () => ({
        results: [{ entryId: "entry-1", status: "failed" as const, error: "The thread is busy." }],
      })),
    });
    fireEvent.click(screen.getByRole("button", { name: "Send wake-up to Block GitHub access from ordinary tests" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The thread is busy.");
    expect(rows()).toHaveLength(2);
  });

  it("resumes and leaves what is left held", async () => {
    const { props } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(props.onResume).toHaveBeenCalledTimes(1));
    expect(props.onResolve).not.toHaveBeenCalled();
  });

  it("discards everything held, then resumes", async () => {
    const { props } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Discard All and Resume" }));
    await waitFor(() => expect(props.onResume).toHaveBeenCalledTimes(1));
    expect(props.onResolve).toHaveBeenCalledWith(WAKEUPS.map((wakeup) => ({
      entryId: wakeup.entryId,
      backend: wakeup.backend,
      threadId: wakeup.threadId,
      action: "discard",
    })));
  });

  it("does not resume when a discard fails", async () => {
    const { props } = renderDialog({
      onResolve: vi.fn(async (resolutions: ResolveProjectHeldWakeupsRequest["resolutions"]) => ({
        results: resolutions.map((resolution, index) => index === 0
          ? { entryId: resolution.entryId, status: "failed" as const, error: "Could not discard." }
          : { entryId: resolution.entryId, status: "discarded" as const }),
      })),
    });
    fireEvent.click(screen.getByRole("button", { name: "Discard All and Resume" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not discard.");
    expect(rows()).toHaveLength(1);
    expect(props.onResume).not.toHaveBeenCalled();
  });

  it("traps Tab and cancels on Escape", () => {
    const { dialog, props } = renderDialog();
    expect(tabEscapes(dialog)).toEqual({ forward: [], backward: [] });
    pressEscape();
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onResume).not.toHaveBeenCalled();
  });
});
