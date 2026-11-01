import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROJECT_FORGE_AUTOMATION,
  type ProjectForgeAutomation,
  type ProjectHeldWakeup,
} from "@pwragent/shared";
import { pressEscape, tabEscapes } from "../../../test/tab-walk";
import { ForgeAutomationDialog, type ForgeAutomationDialogProps } from "../ForgeAutomationDialog";

afterEach(() => {
  cleanup();
});

const NOW = new Date(2026, 10, 1, 15, 30).getTime();
const PAUSED_AT = new Date(2026, 10, 1, 9, 42).getTime();

function heldWakeup(entryId: string): ProjectHeldWakeup {
  return {
    entryId,
    backend: "codex",
    threadId: `thread-${entryId}`,
    threadTitle: "Block GitHub access from ordinary tests",
    source: "monitor",
    summary: "Monitor finished: \"Watch the nightly run\"",
    createdAt: PAUSED_AT,
  };
}

function renderDialog(overrides: Partial<ForgeAutomationDialogProps> = {}) {
  const props: ForgeAutomationDialogProps = {
    projectLabel: "openclaw",
    projectDetail: "github.com/openclaw/openclaw",
    automation: undefined,
    now: () => NOW,
    onCancel: vi.fn(),
    onSubmit: vi.fn(async () => undefined),
    ...overrides,
  };
  render(<ForgeAutomationDialog {...props} />);
  return { props, dialog: screen.getByRole("dialog", { name: "Forge Automation" }) };
}

function save() {
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
}

describe("ForgeAutomationDialog", () => {
  it("opens Active on a project with no stored setting, every kind on", () => {
    const { dialog } = renderDialog();
    expect(dialog).toHaveAccessibleDescription(
      "What this project's pull requests may do to its threads. Your own messages and messaging apps are never blocked.",
    );
    expect(within(dialog).getByText("openclaw · github.com/openclaw/openclaw")).toBeInTheDocument();
    const activity = within(dialog).getByRole("radiogroup", { name: "Forge activity" });
    expect(within(activity).getByRole("radio", { name: "Active" })).toHaveAttribute("aria-checked", "true");
    expect(within(activity).getByRole("radio", { name: "Paused" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("group", { name: "Start turns automatically for" })).toBeInTheDocument();
    for (const name of ["Merge conflicts", "Failing CI", "PR watches"]) {
      expect(screen.getByRole("checkbox", { name })).toBeChecked();
    }
    expect(screen.getByRole("checkbox", { name: "Merge conflicts" })).toHaveAccessibleDescription(
      "Auto-fix rebases a PR that can no longer merge.",
    );
    expect(screen.getByText(
      "These only turn things off for this project. A thread whose own Auto-fix is off stays off.",
    )).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Refuse messages from other threads" })).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("saves the per-kind switches with the project still active", async () => {
    const { props } = renderDialog();
    fireEvent.click(screen.getByRole("checkbox", { name: "Merge conflicts" }));
    save();
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledTimes(1));
    expect(props.onSubmit).toHaveBeenCalledWith({
      ...DEFAULT_PROJECT_FORGE_AUTOMATION,
      autoFixMergeConflicts: false,
    });
  });

  it("pauses with the while-paused choices and stamps when the pause began", async () => {
    const { props } = renderDialog();
    fireEvent.click(screen.getByRole("radio", { name: "Paused" }));
    expect(screen.getByText(
      "PwrAgent stops checking this project's pull requests. PR chips keep their last status, and nothing from the forge starts a turn.",
    )).toBeInTheDocument();
    const refuse = screen.getByRole("checkbox", { name: "Refuse messages from other threads" });
    expect(refuse).toBeChecked();
    const wakeups = screen.getByRole("group", { name: "Wake-ups that still arrive" });
    expect(within(wakeups).getByRole("radio", { name: "Hold for review" })).toBeChecked();
    expect(within(wakeups).getByRole("radio", { name: "Discard" })).not.toBeChecked();
    fireEvent.click(refuse);
    fireEvent.click(within(wakeups).getByRole("radio", { name: "Discard" }));
    save();
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledTimes(1));
    expect(props.onSubmit).toHaveBeenCalledWith({
      ...DEFAULT_PROJECT_FORGE_AUTOMATION,
      paused: true,
      pausedAt: NOW,
      refuseThreadMessages: false,
      wakeupPolicy: "discard",
    });
  });

  it("shows how long a paused project has held wake-ups and keeps its pause time", async () => {
    const automation: ProjectForgeAutomation = {
      ...DEFAULT_PROJECT_FORGE_AUTOMATION,
      autoFixMergeConflicts: false,
      paused: true,
      pausedAt: PAUSED_AT,
    };
    const listHeldWakeups = vi.fn(async () => [heldWakeup("a"), heldWakeup("b")]);
    const { props } = renderDialog({ automation, listHeldWakeups });
    expect(screen.getByRole("radio", { name: "Paused" })).toHaveAttribute("aria-checked", "true");
    const pausedTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(PAUSED_AT);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(
      `Paused since ${pausedTime} · 2 wake-ups held`,
    ));
    expect(listHeldWakeups).toHaveBeenCalledTimes(1);
    save();
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledWith(automation));
  });

  it("resumes with the switches it was paused with", async () => {
    const automation: ProjectForgeAutomation = {
      ...DEFAULT_PROJECT_FORGE_AUTOMATION,
      autoFixCiFailures: false,
      paused: true,
      pausedAt: PAUSED_AT,
    };
    const { props } = renderDialog({ automation });
    fireEvent.click(screen.getByRole("radio", { name: "Active" }));
    expect(screen.getByRole("checkbox", { name: "Failing CI" })).not.toBeChecked();
    save();
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledWith({
      ...DEFAULT_PROJECT_FORGE_AUTOMATION,
      autoFixCiFailures: false,
    }));
  });

  it("keeps the dialog open with the owner's message when saving fails", async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error("The owner could not save Forge Automation.");
    });
    renderDialog({ onSubmit });
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent("The owner could not save Forge Automation.");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("traps Tab and closes on Escape", () => {
    const { dialog, props } = renderDialog();
    expect(tabEscapes(dialog)).toEqual({ forward: [], backward: [] });
    act(() => {
      fireEvent.click(screen.getByRole("radio", { name: "Paused" }));
    });
    expect(tabEscapes(dialog)).toEqual({ forward: [], backward: [] });
    pressEscape();
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });
});
