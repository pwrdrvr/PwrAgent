import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PendingMcpInteraction } from "../PendingMcpInteraction";
import {
  buildMcpElicitationResponse,
  createMcpElicitationState,
  type PendingMcpInteractionState,
} from "../mcp-elicitation";
import {
  FORGE_APPROVAL_REMEMBER_CHOICE_META_KEY,
  FORGE_APPROVAL_REMEMBER_OPTIONS_META_KEY,
  type AppServerMcpElicitationRequestNotification,
} from "@pwragent/shared";

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
  it("renders native tool argument objects and long display names without hiding credentials", () => {
    const name = "pwragent-hosted-sandboxer-smoke-fixture";
    const state = createMcpElicitationState({
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1", turnId: "turn-1", requestId: "native-1", serverName: "Sandboxer",
        mode: "form", message: "Create a sandbox?", requestedSchema: { type: "object", properties: {} },
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          tool_params_display: [
            { name: "name", value: name },
            { name: "labels", value: { purpose: "smoke", access_token: "fixture-private-value" } },
          ],
        },
      },
    })!;
    render(<PendingMcpInteraction state={state} onChange={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.getByText(name)).toBeInTheDocument();
    expect(screen.getByText(/"purpose": "smoke"/)).toHaveTextContent('"access_token": "[redacted]"');
    expect(screen.queryByText("[object Object]")).toBeNull();
    expect(screen.queryByText(/fixture-private-value/)).toBeNull();
  });

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
    fireEvent.click(screen.getByRole("button", { name: "Allow this tool for this conversation" }));
    expect(onSubmit).toHaveBeenLastCalledWith(state, "accept", "session");
  });

  it("offers distinct tool and server conversation grants for a gateway request", () => {
    const onSubmit = vi.fn();
    const state = createMcpElicitationState({
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1", turnId: "turn-1", requestId: "mcp-gateway:server",
        serverName: "Sandboxer", mode: "form", message: "Allow the agent to call exec on Sandboxer?",
        requestedSchema: { type: "object", properties: {} },
        _meta: { pwragent_approval_kind: "mcp_tool_call", persist: ["session", "server-session"] },
      },
    })!;
    const { rerender } = render(<PendingMcpInteraction state={state} onChange={vi.fn()} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(onSubmit).toHaveBeenLastCalledWith(state, "accept");
    fireEvent.click(screen.getByRole("button", { name: "Allow this tool for this conversation" }));
    expect(onSubmit).toHaveBeenLastCalledWith(state, "accept", "session");
    fireEvent.click(screen.getByRole("button", { name: "Allow Sandboxer for this conversation" }));
    expect(onSubmit).toHaveBeenLastCalledWith(state, "accept", "server-session");
    rerender(<PendingMcpInteraction busy state={state} onChange={vi.fn()} onSubmit={onSubmit} />);
    expect(screen.getByRole("button", { name: "Allow Sandboxer for this conversation" })).toBeDisabled();
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

describe("PendingMcpInteraction forge remember menu", () => {
  const rememberOptions = [
    {
      id: "agent",
      label: "Always allow Claude in pwrdrvr/PwrAgent",
      description: "Claude can open or update pull requests in pwrdrvr/PwrAgent without asking, with any model.",
    },
    {
      id: "agent_model",
      label: "Always allow claude-opus in pwrdrvr/PwrAgent",
      description: "Claude · claude-opus can open or update pull requests in pwrdrvr/PwrAgent without asking.",
    },
  ];

  function forgeState(meta: Record<string, unknown> = {}): PendingMcpInteractionState {
    return createMcpElicitationState({
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1", turnId: "turn-1", requestId: "forge-tool:fixture",
        serverName: "GitHub", mode: "form", message: "Open a pull request in pwrdrvr/PwrAgent?",
        requestedSchema: { type: "object", properties: {} },
        _meta: { pwragent_approval_kind: "mcp_tool_call", ...meta },
      },
    })!;
  }

  it("keeps a single Allow button when the request offers no rule", () => {
    const onSubmit = vi.fn();
    const state = forgeState();
    render(<PendingMcpInteraction state={state} onChange={vi.fn()} onSubmit={onSubmit} />);

    expect(screen.queryByRole("button", { name: "More approval choices" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(onSubmit).toHaveBeenLastCalledWith(state, "accept");
  });

  it("splits Allow and sends the chosen rule with the accept", () => {
    const onSubmit = vi.fn();
    const state = forgeState({ [FORGE_APPROVAL_REMEMBER_OPTIONS_META_KEY]: rememberOptions });
    render(<PendingMcpInteraction state={state} onChange={vi.fn()} onSubmit={onSubmit} />);

    const toggle = screen.getByRole("button", { name: "More approval choices" });
    expect(toggle).toHaveAttribute("aria-haspopup", "menu");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);

    const menu = screen.getByRole("menu", { name: "Approval choices" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-controls", menu.id);
    const items = screen.getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Allow once"),
      expect.stringContaining(rememberOptions[0]!.label),
      expect.stringContaining(rememberOptions[1]!.label),
    ]);
    expect(items[0]).toHaveFocus();
    const agentItem = screen.getByRole("menuitem", { name: rememberOptions[0]!.label });
    expect(agentItem).toHaveAccessibleDescription(rememberOptions[0]!.description);

    fireEvent.click(agentItem);
    expect(onSubmit).toHaveBeenLastCalledWith(state, "accept", undefined, "agent");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(buildMcpElicitationResponse(state, "accept", undefined, "agent")._meta).toEqual({
      [FORGE_APPROVAL_REMEMBER_CHOICE_META_KEY]: "agent",
    });
  });

  it("portals the menu out of the clipping transcript, keeps it open for presses inside it, and closes it on scroll", () => {
    const onSubmit = vi.fn();
    const state = forgeState({ [FORGE_APPROVAL_REMEMBER_OPTIONS_META_KEY]: rememberOptions });
    const { container } = render(<PendingMcpInteraction state={state} onChange={vi.fn()} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("button", { name: "More approval choices" }));
    const menu = screen.getByRole("menu", { name: "Approval choices" });
    expect(container.contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.visibility).not.toBe("hidden");

    const agentItem = screen.getByRole("menuitem", { name: rememberOptions[0]!.label });
    fireEvent.pointerDown(agentItem);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.click(agentItem);
    expect(onSubmit).toHaveBeenLastCalledWith(state, "accept", undefined, "agent");

    fireEvent.click(screen.getByRole("button", { name: "More approval choices" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.scroll(document);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("allows once from the menu and plainly from the split's main part", () => {
    const onSubmit = vi.fn();
    const state = forgeState({ [FORGE_APPROVAL_REMEMBER_OPTIONS_META_KEY]: rememberOptions });
    render(<PendingMcpInteraction state={state} onChange={vi.fn()} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(onSubmit).toHaveBeenLastCalledWith(state, "accept");

    fireEvent.click(screen.getByRole("button", { name: "More approval choices" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Allow once" }));
    expect(onSubmit).toHaveBeenLastCalledWith(state, "accept");
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("keeps the conversation grant on the main part and moves Allow once into the menu", () => {
    const onSubmit = vi.fn();
    const state = forgeState({
      persist: ["session"],
      [FORGE_APPROVAL_REMEMBER_OPTIONS_META_KEY]: rememberOptions.slice(0, 1),
    });
    render(<PendingMcpInteraction state={state} onChange={vi.fn()} onSubmit={onSubmit} />);

    expect(screen.queryByRole("button", { name: "Allow once" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Allow this tool for this conversation" }));
    expect(onSubmit).toHaveBeenLastCalledWith(state, "accept", "session");

    fireEvent.click(screen.getByRole("button", { name: "More approval choices" }));
    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
    fireEvent.click(screen.getByRole("menuitem", { name: "Allow once" }));
    expect(onSubmit).toHaveBeenLastCalledWith(state, "accept");
  });

  it("closes on Escape and returns focus to the chevron without answering", () => {
    const onSubmit = vi.fn();
    const state = forgeState({ [FORGE_APPROVAL_REMEMBER_OPTIONS_META_KEY]: rememberOptions });
    render(<PendingMcpInteraction state={state} onChange={vi.fn()} onSubmit={onSubmit} />);

    const toggle = screen.getByRole("button", { name: "More approval choices" });
    toggle.focus();
    fireEvent.click(toggle);
    const firstItem = screen.getAllByRole("menuitem")[0]!;
    expect(firstItem).toHaveFocus();
    fireEvent.keyDown(firstItem, { key: "Escape" });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("disables both halves while an answer is in flight", () => {
    const state = forgeState({ [FORGE_APPROVAL_REMEMBER_OPTIONS_META_KEY]: rememberOptions });
    render(<PendingMcpInteraction busy state={state} onChange={vi.fn()} onSubmit={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Allow" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "More approval choices" })).toBeDisabled();
  });

  it("ignores remember options on a request PwrAgent did not raise", () => {
    const state = createMcpElicitationState({
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1", turnId: "turn-1", requestId: "native-remember",
        serverName: "Sandboxer", mode: "form", message: "Create a sandbox?",
        requestedSchema: { type: "object", properties: {} },
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          [FORGE_APPROVAL_REMEMBER_OPTIONS_META_KEY]: rememberOptions,
        },
      },
    })!;
    render(<PendingMcpInteraction state={state} onChange={vi.fn()} onSubmit={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "More approval choices" })).not.toBeInTheDocument();
    expect(() => buildMcpElicitationResponse(state, "accept", undefined, "agent")).toThrow(/rule/);
  });
});
