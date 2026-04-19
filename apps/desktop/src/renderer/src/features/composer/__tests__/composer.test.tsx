import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../Composer";

afterEach(() => {
  cleanup();
});

describe("Composer", () => {
  it("shows thread access in the composer and updates it from the select", async () => {
    const onSetExecutionMode = vi.fn(async () => undefined);

    render(
      <Composer
        backends={[
          {
            kind: "codex",
            label: "Codex app server",
            available: true,
            methods: [],
            capabilities: {
              listThreads: true,
              createThread: false,
              resumeThread: true,
              readThread: true,
              startTurn: true,
              interruptTurn: true,
              steerTurn: false,
              transcriptPagination: true,
              toolUse: false,
              approvalRequests: false,
              multiDirectoryThreads: true,
            },
            executionModes: [
              {
                mode: "default",
                label: "Default Access",
                available: true,
                isDefault: true,
              },
              {
                mode: "full-access",
                label: "Full Access",
                available: true,
              },
            ],
          },
        ]}
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-1",
            runId: "turn-1",
          }),
        }}
        disabled={false}
        onSetExecutionMode={onSetExecutionMode}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Build Codex client",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          gitBranch: "main",
          linkedDirectories: [
            {
              id: "dir-1",
              label: "PwrAgnt",
              path: "/Users/huntharo/pwrdrvr/PwrAgnt",
              kind: "local",
            },
          ],
          inbox: { inInbox: false },
        }}
      />
    );

    expect(screen.getByLabelText("Access mode")).toHaveValue("default");
    expect(screen.getByLabelText("Workspace mode")).toHaveValue("Local (main)");
    expect(screen.getByLabelText("Workspace mode")).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Access mode"), {
      target: { value: "full-access" },
    });

    await waitFor(() => {
      expect(onSetExecutionMode).toHaveBeenCalledWith("full-access");
    });
  });

  it("inserts skill markdown from autocomplete and sends it through startTurn", async () => {
    const startTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      runId: "turn-1",
    }));
    render(
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startTurn,
        }}
        disabled={false}
        skills={[
          {
            name: "frontend-design",
            description: "Design and verify renderer UI work.",
            path: "/Users/huntharo/.codex/skills/frontend-design/SKILL.md",
            enabled: true,
          },
        ]}
        thread={{
          id: "thread-1",
          title: "Build Codex client",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "Use $fr" } });

    expect(screen.getByRole("listbox", { name: "Skills" })).toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(screen.getAllByText("$frontend-design").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Reply")).toHaveValue("Use $frontend-design ");

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        input: [
          {
            type: "text",
            text: "Use [$frontend-design](/Users/huntharo/.codex/skills/frontend-design/SKILL.md)",
          },
        ],
      });
    });
  });

  it("sends the reply when Enter is pressed without Shift", async () => {
    const startTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      runId: "turn-1",
    }));

    render(
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startTurn,
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Build Codex client",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "Ship it" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        input: [{ type: "text", text: "Ship it" }],
      });
    });
  });

  it("keeps Shift+Enter available for a newline", () => {
    const startTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      runId: "turn-1",
    }));

    render(
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startTurn,
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Build Codex client",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "Line one" } });

    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });

    const defaultWasPrevented = !textarea.dispatchEvent(event);

    expect(defaultWasPrevented).toBe(false);
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("applies the focused skill option when activated from the keyboard", async () => {
    render(
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-1",
            runId: "turn-1",
          }),
        }}
        disabled={false}
        skills={[
          {
            name: "ce:plan",
            description: "Turn feature descriptions into implementation plans.",
            path: "/Users/huntharo/.codex/skills/ce-plan/SKILL.md",
            enabled: true,
          },
        ]}
        thread={{
          id: "thread-1",
          title: "Build Codex client",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "$ce:pl" } });

    const option = screen.getByRole("button", { name: /\$ce:plan/i });
    option.focus();
    fireEvent.click(option);

    expect(screen.getByLabelText("Reply")).toHaveValue("$ce:plan ");
  });

  it("shows a stop button for an active run and interrupts it", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex";
          notification: {
            method: "turn/cancelled";
            params: {
              threadId: string;
              runId: string;
              turn: {
                id: string;
                status: "cancelled";
              };
            };
          };
        }) => void)
      | undefined;
    const interruptTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      runId: "turn-1",
    }));

    render(
      <Composer
        desktopApi={{
          interruptTurn,
          onAgentEvent: (callback) => {
            agentEventHandler = callback as typeof agentEventHandler;
            return () => undefined;
          },
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-1",
            runId: "turn-1",
          }),
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Build Codex client",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "stop this turn if needed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => {
      expect(interruptTurn).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        runId: "turn-1",
      });
    });

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/cancelled",
          params: {
            threadId: "thread-1",
            runId: "turn-1",
            turn: {
              id: "turn-1",
              status: "cancelled",
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    });
  });

  it("updates the stop target when turn/started provides the real run id", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex";
          notification:
            | {
                method: "turn/started";
                params: {
                  threadId: string;
                  turn: {
                    id: string;
                    status: string;
                  };
                };
              }
            | {
                method: "thread/status/changed";
                params: {
                  threadId: string;
                  status: {
                    type: string;
                  };
                };
              };
        }) => void)
      | undefined;
    const interruptTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      runId: "turn-99",
    }));
    render(
      <Composer
        desktopApi={{
          interruptTurn,
          onAgentEvent: (callback) => {
            agentEventHandler = callback as typeof agentEventHandler;
            return () => undefined;
          },
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-1",
            runId: "pending:thread-1",
          }),
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Build Codex client",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "send then stop" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turn: {
              id: "turn-99",
              status: "inProgress",
            },
          },
        },
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => {
      expect(interruptTurn).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        runId: "turn-99",
      });
    });

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/status/changed",
          params: {
            threadId: "thread-1",
            status: {
              type: "idle",
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    });
  });
});
