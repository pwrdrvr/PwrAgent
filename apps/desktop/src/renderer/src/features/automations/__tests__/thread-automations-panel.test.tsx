import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AutomationDetail,
  NavigationThreadSummary,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { ThreadAutomationsPanel } from "../ThreadAutomationsPanel";

const thread: NavigationThreadSummary = {
  agent: {
    name: "Search/Signals Agent",
    instructionLineCount: 0,
    instructionsTooLong: false,
    updatedAt: 1,
  },
  executionMode: "default",
  id: "thread-1",
  inbox: { inInbox: false },
  linkedDirectories: [],
  source: "codex",
  title: "Search/Signals Agent",
  titleSource: "explicit",
  updatedAt: 1,
};

const inboundAutomation: AutomationDetail = {
  backend: "codex",
  backlogPolicy: "coalesce",
  costTodayMicros: 480_000,
  createdAt: 1,
  executionProfile: {
    backend: "codex",
    cwd: "/Users/dev/pwrdrvr/search-signals",
    executionMode: "full-access",
    model: "gpt-5.6-luna",
    reasoningEffort: "xhigh",
  },
  id: "automation-1",
  name: "Search Bots",
  outputActions: [{ id: "agent-context", kind: "agent_context" }],
  scheduleSummary: "inbound: sender is spinnaker or Datadog",
  status: "enabled",
  taskPrompt: "Investigate.",
  threadId: "thread-1",
  triggers: [
    {
      id: "inbound-message",
      kind: "inbound_message",
      conversation: { channel: "slack", conversationId: "C2LE02620" },
    },
  ],
  updatedAt: 1,
};

function desktopApiFor(automation: AutomationDetail): DesktopApi {
  return {
    listAutomations: vi.fn(async () => ({ automations: [automation] })),
    listAutomationRuns: vi.fn(async () => ({ runs: [] })),
    onAgentEvent: () => () => undefined,
  } as unknown as DesktopApi;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ThreadAutomationsPanel", () => {
  it("states the runtime and today's cost, matching the Automations screen", async () => {
    render(
      <ThreadAutomationsPanel
        desktopApi={desktopApiFor(inboundAutomation)}
        thread={thread}
      />,
    );

    expect(await screen.findByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByText("gpt-5.6-luna · xhigh")).toBeInTheDocument();
    expect(screen.getByText("Full Access")).toBeInTheDocument();
    expect(screen.getByText("…/pwrdrvr/search-signals")).toBeInTheDocument();
    expect(screen.getByText("$0.48 today")).toBeInTheDocument();
  });

  it("does not claim a next run or a backlog policy for an inbound automation", async () => {
    render(
      <ThreadAutomationsPanel
        desktopApi={desktopApiFor(inboundAutomation)}
        thread={thread}
      />,
    );

    await screen.findByText("Search Bots");
    // The rail used to read "next never - Coalesce missed runs": one claim
    // that is not true and one that only applies to scheduled runs.
    expect(screen.queryByText(/next never/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Coalesce missed runs/)).not.toBeInTheDocument();
  });

  it("links out to the Automations screen when there is somewhere to go", async () => {
    const onOpenAutomations = vi.fn();
    render(
      <ThreadAutomationsPanel
        desktopApi={desktopApiFor(inboundAutomation)}
        thread={thread}
        onOpenAutomations={onOpenAutomations}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open all ↗" }));
    expect(onOpenAutomations).toHaveBeenCalledTimes(1);

    cleanup();
    render(
      <ThreadAutomationsPanel
        desktopApi={desktopApiFor(inboundAutomation)}
        thread={thread}
      />,
    );
    await screen.findByText("Search Bots");
    expect(
      screen.queryByRole("button", { name: "Open all ↗" }),
    ).not.toBeInTheDocument();
  });
});
