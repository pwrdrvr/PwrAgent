import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutomationDetail, NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { AutomationsScreen } from "../AutomationsScreen";

const thread: NavigationThreadSummary = {
  agent: {
    name: "Email Agent",
    instructionLineCount: 0,
    instructionsTooLong: false,
    updatedAt: 1,
  },
  executionMode: "default",
  id: "thread-1",
  inbox: { inInbox: false },
  linkedDirectories: [],
  source: "codex",
  title: "Email triage",
  titleSource: "explicit",
  updatedAt: 1,
};

const automation: AutomationDetail = {
  backend: "codex",
  backlogPolicy: "coalesce",
  createdAt: 1,
  id: "automation-1",
  name: "Check email",
  schedule: {
    every: 5,
    kind: "interval",
    unit: "minutes",
  },
  scheduleSummary: "every 5 minutes",
  status: "enabled",
  taskPrompt: "Check email.",
  threadId: "thread-1",
  updatedAt: 1,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AutomationsScreen", () => {
  it("lists automations without adding a thread lens and navigates to the assigned Agent", async () => {
    const onSelectThread = vi.fn();
    const desktopApi: DesktopApi = {
      listAutomations: vi.fn(async () => ({ automations: [automation] })),
      listAutomationRuns: vi.fn(async () => ({ runs: [] })),
      onAgentEvent: () => () => undefined,
    };

    render(
      <AutomationsScreen
        desktopApi={desktopApi}
        threads={[thread]}
        onClose={() => undefined}
        onSelectThread={onSelectThread}
      />,
    );

    expect(await screen.findByText("Check email")).toBeInTheDocument();
    expect(screen.getByText("every 5 minutes")).toBeInTheDocument();
    expect(screen.queryByRole("tablist", { name: "Thread lenses" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Email Agent" }));

    expect(onSelectThread).toHaveBeenCalledWith(thread);
  });

  it("creates an automation with an assigned Agent from the global editor", async () => {
    const createAutomation = vi.fn(async () => ({ automation }));
    const desktopApi: DesktopApi = {
      createAutomation,
      listAutomations: vi
        .fn()
        .mockResolvedValueOnce({ automations: [] })
        .mockResolvedValue({ automations: [automation] }),
      onAgentEvent: () => () => undefined,
    };

    render(
      <AutomationsScreen
        desktopApi={desktopApi}
        threads={[thread]}
        onClose={() => undefined}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "New Automation" }));
    const editor = screen.getByLabelText("Name").closest("form") as HTMLElement;
    expect(editor).not.toBeNull();
    fireEvent.change(within(editor).getByLabelText("Name"), {
      target: { value: "Check email" },
    });
    fireEvent.change(within(editor).getByLabelText("Agent"), {
      target: { value: "codex:thread-1" },
    });
    fireEvent.change(within(editor).getByLabelText("Task prompt"), {
      target: { value: "Check email." },
    });
    fireEvent.click(within(editor).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createAutomation).toHaveBeenCalledTimes(1));
    expect(createAutomation).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "codex",
        backlogPolicy: "coalesce",
        threadId: "thread-1",
      }),
    );
  });
});
