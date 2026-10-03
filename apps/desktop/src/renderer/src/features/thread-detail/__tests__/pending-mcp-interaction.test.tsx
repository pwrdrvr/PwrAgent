import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PendingMcpInteraction } from "../PendingMcpInteraction";
import { createMcpElicitationState } from "../mcp-elicitation";
import type { AppServerMcpElicitationRequestNotification } from "@pwragent/shared";

afterEach(() => {
  cleanup();
});

describe("PendingMcpInteraction", () => {
  it.each([
    { persist: ["session", "always"], always: true },
    { persist: ["session"], always: false },
  ])("respects advertised Computer Use app grants: $persist", ({ persist, always }) => {
    const onSubmit = vi.fn();
    const state = createMcpElicitationState({
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1", turnId: "turn-1", requestId: "app-approval",
        serverName: "cua_repl", mode: "form", message: 'Allow Computer Use to use "Electron"?',
        requestedSchema: { type: "object", properties: {} },
        _meta: {
          codex_approval_kind: "mcp_tool_call", connector_id: "computer-use",
          tool_params: { app: "Electron" }, persist,
        },
      },
    })!;
    const { rerender } = render(
      <PendingMcpInteraction state={state} onChange={vi.fn()} onSubmit={onSubmit} />
    );

    fireEvent.click(screen.getByRole("button", { name: "Allow this conversation" }));
    expect(onSubmit).toHaveBeenLastCalledWith(state, "accept", "session");
    if (always) {
      fireEvent.click(screen.getByRole("button", { name: "Always allow" }));
      expect(onSubmit).toHaveBeenLastCalledWith(state, "accept", "always");
    } else {
      expect(screen.queryByRole("button", { name: "Always allow" })).not.toBeInTheDocument();
    }

    rerender(<PendingMcpInteraction busy state={state} onChange={vi.fn()} onSubmit={onSubmit} />);
    expect(screen.getByRole("button", { name: "Allow this conversation" })).toBeDisabled();
    if (always) {
      expect(screen.getByRole("button", { name: "Always allow" })).toBeDisabled();
    }
  });

  it("renders metadata, redacts sensitive values, and submits accept", () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    const state = createMcpElicitationState({
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        requestId: "mcp-request-1",
        serverName: "playwright",
        mode: "form",
        message: "Allow the playwright MCP server to run tool \"browser_tabs\"?",
        requestedSchema: {
          type: "object",
          properties: {},
        },
        _meta: {
          tool_description: "List, create, close, or select a browser tab.",
          tool_params_display: [
            { label: "token", value: "Bearer super-secret-token" },
          ],
        },
      },
    } satisfies AppServerMcpElicitationRequestNotification);

    render(
      <PendingMcpInteraction state={state!} onChange={onChange} onSubmit={onSubmit} />
    );

    expect(screen.getByRole("group", { name: "Pending MCP interaction" })).toBeInTheDocument();
    expect(screen.getByText("MCP approval")).toBeInTheDocument();
    expect(screen.getByText(/browser_tabs/)).toBeInTheDocument();
    expect(screen.getByText("[redacted]")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Allow" }));

    expect(onSubmit).toHaveBeenCalledWith(state, "accept");
  });

  it("updates required fields before allowing submit", () => {
    let state = createMcpElicitationState({
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: null,
        requestId: "mcp-request-1",
        serverName: "github",
        mode: "form",
        message: "Provide issue details.",
        requestedSchema: {
          type: "object",
          required: ["title"],
          properties: {
            title: {
              type: "string",
              title: "Title",
            },
          },
        },
        _meta: {},
      },
    } satisfies AppServerMcpElicitationRequestNotification)!;
    const onSubmit = vi.fn();

    const { rerender } = render(
      <PendingMcpInteraction
        state={state}
        onChange={(nextState) => {
          state = nextState;
        }}
        onSubmit={onSubmit}
      />
    );

    expect(screen.getByRole("button", { name: "Allow" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Title/), {
      target: { value: "Fix the tabs flow" },
    });
    rerender(
      <PendingMcpInteraction
        state={state}
        onChange={(nextState) => {
          state = nextState;
        }}
        onSubmit={onSubmit}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Allow" }));

    expect(onSubmit).toHaveBeenCalledWith(state, "accept");
  });
});
