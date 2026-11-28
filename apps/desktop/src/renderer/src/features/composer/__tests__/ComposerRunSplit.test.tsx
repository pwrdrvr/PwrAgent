import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerRunSplit, type ComposerRunSplitProps } from "../ComposerRunSplit";
import { ComposerWhere } from "../ComposerWhere";

afterEach(() => {
  cleanup();
});

function renderRunSplit(overrides: Partial<ComposerRunSplitProps> = {}) {
  const props: ComposerRunSplitProps = {
    environmentId: "demo",
    environments: [
      { id: "demo", name: "Demo" },
      { id: "gone", name: "Gone", unavailableReason: "Not found in this workspace" },
    ],
    commands: [
      { id: "work", name: "Work" },
      { id: "test", name: "Test" },
    ],
    selectedCommandId: "work",
    onRun: vi.fn(),
    onSelectCommand: vi.fn(),
    onSelectEnvironment: vi.fn(),
    ...overrides,
  };
  render(<ComposerRunSplit {...props} />);
  return props;
}

function openMenu(): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: /^Environment:/ }));
  return screen.getByRole("menu", { name: "Environment and commands" });
}

describe("ComposerRunSplit", () => {
  it("names the run half for the selected command and runs it", () => {
    const props = renderRunSplit();
    const run = screen.getByRole("button", { name: "Run Work" });
    expect(run).toHaveTextContent("Work");
    expect(screen.getByRole("button", { name: "Environment: Demo" })).toBeEnabled();
    fireEvent.click(run);
    expect(props.onRun).toHaveBeenCalledWith();
  });

  it("selects a command without running it, and runs another from its own ▶", () => {
    const props = renderRunSplit();
    const commands = within(openMenu()).getByRole("group", { name: "Command" });
    fireEvent.click(within(commands).getByRole("menuitemradio", { name: "Test" }));
    expect(props.onSelectCommand).toHaveBeenCalledWith("test");
    expect(props.onRun).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: "Run Test" }));
    expect(props.onRun).toHaveBeenCalledWith(expect.objectContaining({ id: "test" }));
    expect(props.onSelectCommand).toHaveBeenCalledTimes(1);
  });

  it("lists an environment the workspace no longer has without choosing it", () => {
    const props = renderRunSplit();
    const environments = within(openMenu()).getByRole("group", { name: "Environment" });
    expect(within(environments).getByRole("menuitemradio", { name: "Demo" }))
      .toHaveAttribute("aria-checked", "true");
    const gone = within(environments).getByRole("menuitemradio", { name: "Gone" });
    expect(gone).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(gone);
    expect(props.onSelectEnvironment).not.toHaveBeenCalled();
    fireEvent.click(within(environments).getByRole("menuitemradio", { name: "No environment" }));
    expect(props.onSelectEnvironment).toHaveBeenCalledWith("");
  });

  it("shows only the menu half without an environment", () => {
    renderRunSplit({ environmentId: "", commands: [] });
    expect(screen.queryByRole("button", { name: /^Run / })).not.toBeInTheDocument();
    const menu = openMenu();
    expect(within(menu).queryByRole("group", { name: "Command" })).not.toBeInTheDocument();
    expect(within(menu).getByRole("menuitemradio", { name: "No environment" }))
      .toHaveAttribute("aria-checked", "true");
  });

  it("holds both halves while the environment switches", () => {
    renderRunSplit({ busy: true });
    expect(screen.getByRole("button", { name: "Run Work" })).toBeDisabled();
    const menuButton = screen.getByRole("button", { name: "Environment: Demo" });
    expect(menuButton).toBeDisabled();
    expect(menuButton).toHaveAttribute("aria-busy", "true");
  });

  it("offers Edit environments after the environments", () => {
    const onSelect = vi.fn();
    renderRunSplit({ editAction: { label: "Edit environments…", onSelect } });
    const menu = openMenu();
    const environments = within(menu).getByRole("group", { name: "Environment" });
    const edit = within(menu).getByRole("menuitem", { name: "Edit environments…" });
    expect(environments.compareDocumentPosition(edit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(edit);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe("ComposerWhere", () => {
  it.each([
    { mode: "local" as const, directoryCount: 1, count: null },
    { mode: "worktree" as const, directoryCount: 1, count: null },
    { mode: "worktree" as const, directoryCount: 3, count: "3" },
    { mode: "local" as const, directoryCount: 12, count: "9+" },
  ])("draws $mode with $directoryCount directories as one icon", ({ mode, directoryCount, count }) => {
    render(
      <ComposerWhere directoryCount={directoryCount} label="Where: Demo, local checkout" mode={mode}
        panelLabel="Where this thread runs">
        <p>Panel</p>
      </ComposerWhere>,
    );
    const trigger = screen.getByRole("button", { name: "Where: Demo, local checkout" });
    expect(trigger).toHaveAttribute("data-mode", mode);
    if (mode === "worktree") expect(trigger).toHaveClass("composer-where__trigger--worktree");
    else expect(trigger).not.toHaveClass("composer-where__trigger--worktree");
    expect(trigger.querySelector(".composer__toggle-count")?.textContent ?? null).toBe(count);
    // The words are the name and the tooltip, never drawn in the row.
    expect(trigger).not.toHaveTextContent("Demo");
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Where this thread runs" })).toHaveTextContent("Panel");
  });
});
