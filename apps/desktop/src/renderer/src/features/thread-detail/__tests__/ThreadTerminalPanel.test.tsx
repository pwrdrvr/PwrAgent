import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IntegratedTerminalPane, IntegratedTerminalsController } from "../../../lib/useIntegratedTerminals";

vi.mock("../IntegratedTerminal", () => ({
  IntegratedTerminal: (props: { sessionId: string; visible?: boolean; onHiddenOutput?: () => void }) => (
    <section aria-label="Integrated terminal" data-session-id={props.sessionId} hidden={props.visible === false}>
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

    fireEvent.click(screen.getByRole("button", { name: "New shell here" }));
    expect(terminals.createTerminal).toHaveBeenCalledWith("codex:thread-a", "/Users/dev/orbit", undefined);
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
});
