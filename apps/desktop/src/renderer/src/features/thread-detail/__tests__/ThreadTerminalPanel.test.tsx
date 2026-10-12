import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IntegratedTerminalPane, IntegratedTerminalsController } from "../../../lib/useIntegratedTerminals";

vi.mock("../IntegratedTerminal", () => ({
  IntegratedTerminal: (props: {
    sessionId: string; visible?: boolean; onHiddenOutput?: () => void; focusRequest?: number; resume?: boolean;
  }) => (
    <section aria-label="Integrated terminal" data-session-id={props.sessionId} data-focus-request={props.focusRequest ?? ""}
      data-resume={props.resume ? "true" : "false"} hidden={props.visible === false}>
      <button type="button" onClick={props.onHiddenOutput}>Simulate hidden output {props.sessionId}</button>
    </section>
  ),
}));

import { ThreadTerminalPanel } from "../ThreadTerminalPanel";

function controller(selected?: string): IntegratedTerminalsController {
  return {
    sessions: [],
    liveThreadKeys: new Set(),
    hiddenThreadKeys: new Set(),
    panes: [],
    heightByThread: {},
    selectedByThread: selected ? { "codex:thread-a": selected } : {},
    selectTerminal: vi.fn(),
    createTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    isPanelOpen: () => true,
    togglePanel: vi.fn(),
    openPanel: vi.fn(),
    closeTerminal: vi.fn(),
    handleExit: vi.fn(),
    setHeight: vi.fn(),
  };
}

function pane(sessionId: string, extra: Partial<IntegratedTerminalPane> = {}): IntegratedTerminalPane {
  return { threadKey: "codex:thread-a", sessionId, shell: "/bin/zsh", cwd: "/Users/dev/orbit", status: "running", ...extra };
}

function renderPanel(terminals: IntegratedTerminalsController, panes: IntegratedTerminalPane[]) {
  return render(
    <ThreadTerminalPanel terminals={terminals} threadKey="codex:thread-a" panes={panes} visible />,
  );
}

describe("ThreadTerminalPanel", () => {
  afterEach(() => cleanup());

  it("keeps default names when a sibling closes", () => {
    const terminals = controller("a");
    const view = renderPanel(terminals, [pane("a"), pane("b"), pane("c")]);
    expect(screen.getAllByRole("tab").map((tab) => tab.querySelector(".thread-terminal-panel__name")?.textContent))
      .toEqual(["zsh", "zsh 2", "zsh 3"]);

    view.rerender(<ThreadTerminalPanel terminals={terminals} threadKey="codex:thread-a" panes={[pane("b"), pane("c")]} visible />);
    expect(screen.getAllByRole("tab").map((tab) => tab.querySelector(".thread-terminal-panel__name")?.textContent))
      .toEqual(["zsh 2", "zsh 3"]);

    view.rerender(<ThreadTerminalPanel terminals={terminals} threadKey="codex:thread-a" panes={[pane("b"), pane("c"), pane("d")]} visible />);
    expect(screen.getByRole("tab", { name: /^zsh\b(?! \d)/ })).toHaveAttribute("id", "terminal-tab-d");
  });

  it("shows the working directory for a live shell and the exit code for a failed one", () => {
    const terminals = controller("b");
    renderPanel(terminals, [pane("a"), pane("b", { name: "Tests", status: "exited", exitCode: 1 })]);

    expect(screen.getByRole("tab", { name: /zsh/ })).toHaveTextContent("~/orbit");
    expect(screen.getByRole("tab", { name: /zsh/ })).toHaveTextContent("Running");
    expect(screen.getByRole("tab", { name: /Tests/ })).toHaveTextContent("Exited · code 1");
    expect(screen.getByText("Exited with code 1")).toBeVisible();
    const tests = () => document.querySelector('[data-session-id="b"]')!;
    expect(tests()).toHaveAttribute("data-resume", "false");

    // Restart happens in place: the same tab asks for a shell under its own id.
    fireEvent.click(screen.getByRole("button", { name: "Restart shell" }));
    expect(terminals.createTerminal).not.toHaveBeenCalled();
    expect(tests()).toHaveAttribute("data-resume", "true");
    expect(tests()).toHaveAttribute("data-focus-request", "1");
  });

  it("resumes saved history the first time it is shown, and not before", () => {
    const terminals = controller("a");
    const view = renderPanel(terminals, [pane("a"), pane("b", { status: "restored" })]);
    const saved = () => document.querySelector('[data-session-id="b"]')!;
    expect(screen.getByRole("tab", { name: /zsh 2/ })).toHaveTextContent("Resumes when opened");
    expect(saved()).toHaveAttribute("data-resume", "false");

    view.rerender(<ThreadTerminalPanel terminals={controller("b")} threadKey="codex:thread-a"
      panes={[pane("a"), pane("b", { status: "restored" })]} visible />);
    expect(saved()).toHaveAttribute("data-resume", "true");
    expect(screen.queryByRole("button", { name: /New shell here|Restart shell/ })).not.toBeInTheDocument();
  });

  it("marks output from a terminal that is not on screen until it is selected", () => {
    const terminals = controller("a");
    const view = renderPanel(terminals, [pane("a"), pane("b")]);
    const dot = () => screen.getByRole("tab", { name: /zsh 2/ }).querySelector(".thread-terminal-panel__dot");
    expect(dot()).toHaveClass("is-running");

    act(() => { fireEvent.click(screen.getByText("Simulate hidden output b")); });
    expect(dot()).toHaveClass("is-unseen");
    expect(screen.getByRole("tab", { name: /zsh 2/ })).toHaveTextContent("Running, new output");

    const selectB = controller("b");
    view.rerender(<ThreadTerminalPanel terminals={selectB} threadKey="codex:thread-a" panes={[pane("a"), pane("b")]} visible />);
    expect(dot()).toHaveClass("is-running");
  });

  it("renames in place from F2 and cancels on Escape", () => {
    const terminals = controller("a");
    renderPanel(terminals, [pane("a")]);

    fireEvent.keyDown(screen.getByRole("tab"), { key: "F2" });
    const input = screen.getByRole("textbox", { name: "Terminal name" });
    fireEvent.change(input, { target: { value: "Build" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Terminal name" })).not.toBeInTheDocument();
    expect(terminals.renameTerminal).not.toHaveBeenCalled();

    fireEvent.doubleClick(screen.getByRole("tab"));
    fireEvent.change(screen.getByRole("textbox", { name: "Terminal name" }), { target: { value: "Build" } });
    fireEvent.submit(screen.getByRole("textbox", { name: "Terminal name" }));
    expect(terminals.renameTerminal).toHaveBeenCalledWith("a", "Build");
    expect(screen.queryByRole("button", { name: "Rename terminal" })).not.toBeInTheDocument();
  });

  it("puts the keyboard in a terminal when its tab is clicked, but not on arrow keys", () => {
    const terminals = controller("a");
    renderPanel(terminals, [pane("a"), pane("b")]);
    const terminal = (sessionId: string) => document.querySelector(`[data-session-id="${sessionId}"]`)!;

    fireEvent.keyDown(screen.getByRole("tab", { name: /^zsh(?! 2)/ }), { key: "ArrowDown" });
    expect(terminals.selectTerminal).toHaveBeenCalledWith("codex:thread-a", "b");
    expect(terminal("b")).toHaveAttribute("data-focus-request", "");

    fireEvent.click(screen.getByRole("tab", { name: /zsh 2/ }));
    expect(terminals.selectTerminal).toHaveBeenLastCalledWith("codex:thread-a", "b");
    expect(terminal("b")).toHaveAttribute("data-focus-request", "1");
    expect(terminal("a")).toHaveAttribute("data-focus-request", "");
  });

  it("is a strip of tiles that flies out with names on hover and keyboard focus", () => {
    vi.useFakeTimers();
    try {
      const terminals = controller("a");
      renderPanel(terminals, [pane("a", { name: "Build" }), pane("b", { name: "Tests", status: "exited", exitCode: 1 })]);
      const rail = () => document.querySelector(".thread-terminal-panel__rail")!;

      expect(rail()).not.toHaveClass("is-open");
      expect(screen.getByRole("tab", { name: /Build/ }).querySelector(".thread-terminal-panel__tile")).toHaveTextContent("B");
      expect(screen.getByRole("tab", { name: /Tests/ })).toHaveTextContent("Exited · code 1");
      expect(screen.queryByRole("button", { name: /Expand|Collapse|Hide terminals/ })).not.toBeInTheDocument();

      fireEvent.pointerEnter(rail());
      expect(rail()).not.toHaveClass("is-open");
      act(() => { vi.advanceTimersByTime(150); });
      expect(rail()).toHaveClass("is-open");
      fireEvent.pointerLeave(rail());
      act(() => { vi.advanceTimersByTime(250); });
      expect(rail()).not.toHaveClass("is-open");

      act(() => { screen.getByRole("tab", { name: /Build/ }).focus(); });
      expect(rail()).toHaveClass("is-open");
    } finally {
      vi.useRealTimers();
    }
  });
});
