import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerTerminalToggle } from "../ComposerTerminalToggle";

afterEach(() => {
  cleanup();
});

describe("ComposerTerminalToggle", () => {
  it.each([
    { open: false, running: false, label: "Open integrated terminal" },
    { open: true, running: false, label: "Hide integrated terminal" },
    { open: false, running: true, label: "Show running integrated terminal" },
    { open: true, running: true, label: "Hide integrated terminal" },
  ])("shows $label", ({ open, running, label }) => {
    const onToggle = vi.fn();
    render(<ComposerTerminalToggle open={open} running={running} onToggle={onToggle} />);
    const toggle = screen.getByRole("button", { name: label });
    expect(toggle).toHaveAttribute("aria-pressed", String(open));
    expect(toggle).not.toHaveAttribute("aria-disabled");
    expect(toggle.classList.contains("is-active")).toBe(open);
    expect(toggle.classList.contains("is-running")).toBe(running && !open);
    expect(toggle).toHaveTextContent("");
    fireEvent.mouseEnter(toggle);
    expect(screen.getByRole("tooltip")).toHaveTextContent(label);
    expect(document.body.querySelector(":scope > .viewport-tooltip")).toBe(screen.getByRole("tooltip"));
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledOnce();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("keeps an unavailable remote terminal focusable and explains why on hover and focus", () => {
    const onToggle = vi.fn();
    const disabledReason = "Remote terminal not granted by Demo peer.";
    render(<ComposerTerminalToggle open={false} disabledReason={disabledReason} onToggle={onToggle} />);
    const toggle = screen.getByRole("button", { name: disabledReason });
    expect(toggle).toHaveClass("is-disabled");
    expect(toggle).toHaveAttribute("aria-disabled", "true");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toBeEnabled();
    fireEvent.mouseEnter(toggle);
    expect(screen.getByRole("tooltip")).toHaveTextContent(disabledReason);
    fireEvent.mouseLeave(toggle);
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => toggle.focus());
    expect(toggle).toHaveFocus();
    expect(screen.getByRole("tooltip")).toHaveTextContent(disabledReason);
    fireEvent.click(toggle);
    expect(onToggle).not.toHaveBeenCalled();
  });
});
