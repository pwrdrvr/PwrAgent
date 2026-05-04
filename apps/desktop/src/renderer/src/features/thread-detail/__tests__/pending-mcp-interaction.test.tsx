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
