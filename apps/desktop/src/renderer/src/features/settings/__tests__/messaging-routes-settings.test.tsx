import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ListMessagingRoutesResponse } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { MessagingRoutesSettings } from "../MessagingRoutesSettings";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function buildRoutes(): ListMessagingRoutesResponse {
  return {
    eligibleAgents: [
      {
        backend: "codex",
        threadId: "agent-1",
        label: "Search Signals Agent",
        backendLabel: "Codex",
        available: true,
      },
      {
        backend: "acp:grok",
        threadId: "agent-2",
        label: "Grok Project Agent",
        backendLabel: "Grok Build",
        available: true,
      },
    ],
    defaultAgents: [
      {
        assignmentId: "assignment-1",
        scope: {
          kind: "conversation",
          platform: "slack",
          conversation: {
            id: "C13056",
            kind: "channel",
            title: "p-search-signals-project",
            workspaceId: "T1",
          },
        },
        target: {
          backend: "codex",
          threadId: "agent-1",
          label: "Search Signals Agent",
          backendLabel: "Codex",
          available: true,
        },
        createdAt: 1000,
        updatedAt: 2000,
      },
      {
        assignmentId: "assignment-stale",
        scope: { kind: "profile" },
        target: {
          backend: "acp:missing",
          threadId: "missing-agent",
          label: "Missing Agent",
          backendLabel: "Missing",
          available: false,
        },
        createdAt: 1000,
        updatedAt: 1500,
      },
    ],
    bindings: [
      {
        bindingId: "binding-1",
        platform: "slack",
        conversation: {
          id: "1700000000.000100",
          kind: "thread",
          title: "13056 investigation",
          parentTitle: "p-search-signals-project",
        },
        target: {
          backend: "codex",
          threadId: "work-1",
          label: "Issue 13056",
          kind: "thread",
        },
        createdAt: 1000,
        updatedAt: 2000,
      },
    ],
  };
}

function buildDesktopApi(routes = buildRoutes()) {
  const listMessagingRoutes = vi.fn<
    NonNullable<DesktopApi["listMessagingRoutes"]>
  >(async () => routes);
  const setMessagingDefaultAgent = vi.fn<
    NonNullable<DesktopApi["setMessagingDefaultAgent"]>
  >(async (request) => ({
    assignmentId: request.assignmentId ?? "assignment-new",
  }));
  const clearMessagingDefaultAgent = vi.fn<
    NonNullable<DesktopApi["clearMessagingDefaultAgent"]>
  >(async (request) => ({ ...request, cleared: true }));
  const unbindMessagingThread = vi.fn<
    NonNullable<DesktopApi["unbindMessagingThread"]>
  >(async (request) => ({ ...request, revoked: true }));
  const desktopApi: DesktopApi = {
    listMessagingRoutes,
    setMessagingDefaultAgent,
    clearMessagingDefaultAgent,
    unbindMessagingThread,
    onMessagingBindingsChanged: () => () => undefined,
  };
  return {
    desktopApi,
    listMessagingRoutes,
    setMessagingDefaultAgent,
    clearMessagingDefaultAgent,
    unbindMessagingThread,
  };
}

describe("MessagingRoutesSettings", () => {
  it("shows an empty inventory when no messaging routes exist", async () => {
    const { desktopApi } = buildDesktopApi({
      eligibleAgents: [],
      defaultAgents: [],
      bindings: [],
    });

    render(<MessagingRoutesSettings desktopApi={desktopApi} />);

    expect(
      await screen.findByText("No default Agents configured."),
    ).toBeInTheDocument();
    expect(screen.getByText("No active bindings.")).toBeInTheDocument();
    expect(screen.getByText("0 active")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add default" })).toBeDisabled();
  });

  it("shows a complete default and binding inventory", async () => {
    const { desktopApi } = buildDesktopApi();

    render(<MessagingRoutesSettings desktopApi={desktopApi} />);

    expect(
      await screen.findByText("Slack / p-search-signals-project"),
    ).toBeInTheDocument();
    expect(screen.getByText("Search Signals Agent")).toBeInTheDocument();
    expect(screen.getByText("Missing unavailable")).toBeInTheDocument();
    expect(screen.getByText(/13056 investigation/)).toBeInTheDocument();
    expect(screen.getByText("Issue 13056")).toBeInTheDocument();
    expect(screen.getByText("3 active")).toBeInTheDocument();
  });

  it("opens default Agent and binding target threads", async () => {
    const { desktopApi } = buildDesktopApi();
    const onOpenThread = vi.fn();

    render(
      <MessagingRoutesSettings
        desktopApi={desktopApi}
        onOpenThread={onOpenThread}
      />,
    );
    await screen.findByText("Issue 13056");

    fireEvent.click(
      screen.getByRole("button", { name: "Open thread Search Signals Agent" }),
    );
    expect(onOpenThread).toHaveBeenLastCalledWith({
      backend: "codex",
      threadId: "agent-1",
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Open thread Issue 13056" }),
    );
    expect(onOpenThread).toHaveBeenLastCalledWith({
      backend: "codex",
      threadId: "work-1",
    });
  });

  it("adds a conversation default from Settings", async () => {
    const api = buildDesktopApi();
    render(<MessagingRoutesSettings desktopApi={api.desktopApi} />);
    await screen.findByText("Search Signals Agent");

    fireEvent.click(screen.getByRole("button", { name: "Add default" }));
    fireEvent.change(screen.getByLabelText("Conversation ID"), {
      target: { value: "C200" },
    });
    fireEvent.change(screen.getByLabelText("Display name (optional)"), {
      target: { value: "incident-response" },
    });
    fireEvent.change(screen.getByLabelText("Default Agent"), {
      target: { value: JSON.stringify(["acp:grok", "agent-2"]) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save default" }));

    await waitFor(() => {
      expect(api.setMessagingDefaultAgent).toHaveBeenCalledWith({
        scope: {
          kind: "conversation",
          platform: "slack",
          conversation: {
            id: "C200",
            kind: "channel",
            title: "incident-response",
          },
        },
        target: { backend: "acp:grok", threadId: "agent-2" },
      });
    });
  });

  it("retargets and clears defaults and unbinds conversations", async () => {
    const api = buildDesktopApi();
    render(<MessagingRoutesSettings desktopApi={api.desktopApi} />);
    await screen.findByText("Search Signals Agent");

    fireEvent.click(screen.getAllByRole("button", { name: "Change" })[0]!);
    fireEvent.change(screen.getByLabelText("Default Agent"), {
      target: { value: JSON.stringify(["acp:grok", "agent-2"]) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save default" }));
    await waitFor(() => {
      expect(api.setMessagingDefaultAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          assignmentId: "assignment-1",
          target: { backend: "acp:grok", threadId: "agent-2" },
        }),
      );
    });

    fireEvent.click(screen.getAllByRole("button", { name: "Clear" })[0]!);
    await waitFor(() => {
      expect(api.clearMessagingDefaultAgent).toHaveBeenCalledWith({
        assignmentId: "assignment-1",
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Unbind" }));
    await waitFor(() => {
      expect(api.unbindMessagingThread).toHaveBeenCalledWith({
        bindingId: "binding-1",
      });
    });
  });
});
