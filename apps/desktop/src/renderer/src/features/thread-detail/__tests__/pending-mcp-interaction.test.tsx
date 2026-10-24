import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PendingMcpInteraction } from "../PendingMcpInteraction";
import { createMcpElicitationState, type PendingMcpInteractionState } from "../mcp-elicitation";
import type { AppServerMcpElicitationRequestNotification } from "@pwragent/shared";

const openExternalUrl = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/open-external-url", () => ({ openExternalUrl }));

function urlState(url: string): PendingMcpInteractionState {
  // 2026-07-28 removed elicitationId, so a current server sends none.
  return createMcpElicitationState({
    method: "mcpServer/elicitation/request",
    params: {
      threadId: "thread-1", turnId: "turn-1", requestId: "mcp-url",
      serverName: "billing", mode: "url", message: "Confirm the refund on the billing site.",
      url, _meta: null,
    },
  })!;
}

function formState(properties: Record<string, unknown>, required: string[] = []): PendingMcpInteractionState {
  return createMcpElicitationState({
    method: "mcpServer/elicitation/request",
    params: {
      threadId: "thread-1", turnId: "turn-1", requestId: "mcp-form",
      serverName: "crm", mode: "form", message: "Fill in the missing contact details.",
      requestedSchema: { type: "object", properties, required }, _meta: null,
    },
  })!;
}

afterEach(() => {
  cleanup();
  openExternalUrl.mockReset();
});

describe("PendingMcpInteraction", () => {
  it("offers only conversation persistence for a PwrAgent gateway tool approval", () => {
    const onSubmit = vi.fn();
    const state = createMcpElicitationState({
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1", turnId: "turn-1", requestId: "mcp-gateway:fixture",
        serverName: "DataDog", mode: "form", message: "Allow DataDog / get_datadog_metric?",
        requestedSchema: { type: "object", properties: {} },
        _meta: { pwragent_approval_kind: "mcp_tool_call", persist: ["session"] },
      },
    })!;
    render(<PendingMcpInteraction state={state} onChange={vi.fn()} onSubmit={onSubmit} />);

    expect(screen.queryByRole("button", { name: "Always allow" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(onSubmit).toHaveBeenLastCalledWith(state, "accept");
    fireEvent.click(screen.getByRole("button", { name: "Allow this conversation" }));
    expect(onSubmit).toHaveBeenLastCalledWith(state, "accept", "session");
  });

  it.each([
    { persist: ["session", "always"], always: true },
    { persist: ["session"], always: false },
  ])("respects advertised Computer Use app grants: $persist", ({ persist, always }) => {
    const onSubmit = vi.fn();
    const state = createMcpElicitationState({
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1", turnId: "turn-1", requestId: "app-approval",
        serverName: "cua_repl", mode: "form", message: "Allow Computer Use to use \"Electron\"?",
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
    // No host approval kind: a server's own confirmation, not a tool grant.
    expect(screen.getByText("MCP confirmation")).toBeInTheDocument();
    expect(screen.getByText(/browser_tabs/)).toBeInTheDocument();
    expect(screen.getByText("[redacted]")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow this conversation" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Always allow" })).not.toBeInTheDocument();

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

    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();

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

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(onSubmit).toHaveBeenCalledWith(state, "accept");
  });

  it("draws the request's connector, display names and warning", () => {
    const state = createMcpElicitationState({
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1", turnId: "turn-1", requestId: "app-approval",
        serverName: "cua_repl", mode: "form", message: "Allow Computer Use to use \"Terminal\"?",
        requestedSchema: { type: "object", properties: {} },
        _meta: {
          codex_approval_kind: "mcp_tool_call", connector_id: "computer-use",
          connector_name: "Computer Use", riskLevel: "high",
          subtitle: "Terminal can run any command with your user permissions.",
          tool_params: { app: "com.example.Terminal" },
          tool_params_display: [
            { name: "app", display_name: "App", value: "Terminal" },
            { name: "window_title", value: "Example" },
          ],
          persist: ["session", "always"],
        },
      },
    })!;

    render(<PendingMcpInteraction state={state} onChange={vi.fn()} onSubmit={vi.fn()} />);

    const card = screen.getByRole("group", { name: "Pending MCP interaction" });
    expect(card).toHaveClass("transcript-mcp--risk");
    expect(screen.getByText("Computer Use")).toHaveClass("transcript-mcp__connector");
    // The server name alone: the elicitation mode is protocol detail.
    expect(screen.getByText("cua_repl")).toHaveClass("transcript-mcp__server");
    expect(screen.queryByText(/\/ form/)).not.toBeInTheDocument();
    expect(screen.getByText(/run any command/)).toHaveClass("transcript-mcp__subtitle");
    // `display_name` wins over the raw `name`; a raw key is kept verbatim.
    expect(screen.getByText("App")).not.toHaveClass("transcript-mcp__param-key");
    expect(screen.queryByText("app")).not.toBeInTheDocument();
    expect(screen.getByText("window_title")).toHaveClass("transcript-mcp__param-key");
    // The persistent grant first, alone; the primary grant last.
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Always allow",
      "Cancel turn",
      "Decline",
      "Allow this conversation",
    ]);
  });

  it("shows the full address as text and opens it only on consent", () => {
    const onSubmit = vi.fn();
    const url = "https://pay.example.com/refunds/confirm?case=4417&state=opaque";
    const state = urlState(url);
    render(<PendingMcpInteraction state={state} onChange={vi.fn()} onSubmit={onSubmit} />);

    expect(screen.getByText("MCP link")).toBeInTheDocument();
    expect(screen.getByText("pay.example.com")).toBeInTheDocument();
    // The whole address, query included, and no link that a click could
    // follow before the operator decides.
    expect(screen.getByLabelText("Full address")).toHaveTextContent(url);
    // A long address scrolls, so keyboard users must be able to reach it.
    expect(screen.getByRole("region", { name: "Full address" })).toHaveAttribute("tabindex", "0");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(openExternalUrl).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open in browser" }));

    expect(openExternalUrl).toHaveBeenCalledWith(screen.getByLabelText("Full address").textContent);
    expect(openExternalUrl).toHaveBeenCalledWith(url);
    expect(onSubmit).toHaveBeenCalledWith(state, "accept");
  });

  it("decline and cancel never open the page", () => {
    const onSubmit = vi.fn();
    const state = urlState("https://pay.example.com/refunds/confirm");
    render(<PendingMcpInteraction state={state} onChange={vi.fn()} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel turn" }));

    expect(onSubmit.mock.calls.map((call) => call[1])).toEqual(["decline", "cancel"]);
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("warns about an international host", () => {
    // Cyrillic "а" in place of the Latin letter; the card names the host the
    // browser will actually contact.
    render(<PendingMcpInteraction state={urlState("https://p\u0430ypal.com/login")} onChange={vi.fn()} onSubmit={vi.fn()} />);

    expect(screen.getByText(/^xn--.*\.com$/)).toBeInTheDocument();
    expect(screen.getByLabelText("Full address").textContent).toMatch(/^https:\/\/xn--/);
    // What opens is the punycode the operator reviewed, not the lookalike.
    fireEvent.click(screen.getByRole("button", { name: "Open in browser" }));
    expect(openExternalUrl.mock.calls[0]?.[0]).toMatch(/^https:\/\/xn--/);
    expect(screen.getByText(/international characters/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open in browser" })).toBeEnabled();
  });

  it.each([
    ["file:///etc/passwd", /only https/],
    ["http://login.example.com/", /only https/],
    ["https://alice:hunter2@login.example.com/", /user name or password/],
  ])("refuses to open %s", (url, reason) => {
    render(<PendingMcpInteraction state={urlState(url)} onChange={vi.fn()} onSubmit={vi.fn()} />);

    expect(screen.getByRole("alert")).toHaveTextContent(reason);
    expect(screen.getByRole("button", { name: "Open in browser" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Decline" })).toBeEnabled();
  });

  it("refuses a form that asks for a credential", () => {
    const state = formState({
      username: { type: "string", title: "Username" },
      api_key: { type: "string", title: "API key" },
    });
    render(<PendingMcpInteraction state={state} onChange={vi.fn()} onSubmit={vi.fn()} />);

    expect(screen.getByRole("alert")).toHaveTextContent(/asks for API key/);
    // No input to type the key into, and nothing to submit.
    expect(screen.queryByRole("textbox", { name: /API key/ })).not.toBeInTheDocument();
    expect(screen.getByText("Not collected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Decline" })).toBeEnabled();
  });

  it("explains a value that does not match its format", () => {
    let state = formState({ email: { type: "string", title: "Email", format: "email" } }, ["email"]);
    const { rerender } = render(
      <PendingMcpInteraction state={state} onChange={(next) => { state = next; }} onSubmit={vi.fn()} />,
    );
    const input = screen.getByRole("textbox", { name: /Email/ });
    expect(input).toHaveAttribute("placeholder", "name@example.com");

    fireEvent.change(input, { target: { value: "not-an-address" } });
    rerender(<PendingMcpInteraction state={state} onChange={(next) => { state = next; }} onSubmit={vi.fn()} />);

    expect(screen.getByRole("textbox", { name: /Email/ })).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("textbox", { name: /Email/ })).toHaveAccessibleDescription("Enter an email address.");
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox", { name: /Email/ }), { target: { value: "pat@example.com" } });
    rerender(<PendingMcpInteraction state={state} onChange={(next) => { state = next; }} onSubmit={vi.fn()} />);

    expect(screen.getByRole("textbox", { name: /Email/ })).not.toHaveAttribute("aria-invalid");
    expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled();
  });
});
