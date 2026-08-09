import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CompactComposer } from "../CompactComposer";

function renderComposer(overrides: Partial<Parameters<typeof CompactComposer>[0]> = {}) {
  const onSend = vi.fn();
  render(
    <CompactComposer onSend={onSend} threadTitle="Thread t1" {...overrides} />,
  );
  return { onSend };
}

describe("CompactComposer", () => {
  it("sends on Enter and clears the draft", () => {
    const { onSend } = renderComposer();
    const input = screen.getByRole("textbox", { name: "Message Thread t1" });
    fireEvent.change(input, { target: { value: "ship it" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("ship it");
    expect((input as HTMLTextAreaElement).value).toBe("");
  });

  it("keeps Shift+Enter as a newline", () => {
    const { onSend } = renderComposer();
    const input = screen.getByRole("textbox", { name: "Message Thread t1" });
    fireEvent.change(input, { target: { value: "line one" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not send whitespace", () => {
    const { onSend } = renderComposer();
    const input = screen.getByRole("textbox", { name: "Message Thread t1" });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows model, effort, and access mode as one ambient string", () => {
    renderComposer({
      executionMode: "full-access",
      model: "gpt-5-codex",
      reasoningEffort: "high",
    });
    expect(screen.getByText("gpt-5-codex · high · Full access")).toBeTruthy();
  });

  it("omits optional ambient and action chrome when unconfigured", () => {
    renderComposer();
    expect(
      screen.getByRole("textbox", { name: "Message Thread t1" }),
    ).toBeTruthy();
    expect(screen.queryByText(/·/)).toBeNull();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
  });

  it("swaps Send for Stop while a turn is running", () => {
    const onInterrupt = vi.fn();
    renderComposer({ busy: true, onInterrupt });
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it("runs a secondary action and closes the menu", () => {
    const onSelect = vi.fn();
    renderComposer({
      secondaryActions: [{ key: "a", label: "Compact thread", onSelect }],
    });
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Compact thread" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes the menu on Escape without running anything", () => {
    const onSelect = vi.fn();
    renderComposer({
      secondaryActions: [{ key: "a", label: "Compact thread", onSelect }],
    });
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("renders a disabled action as unclickable", () => {
    const onSelect = vi.fn();
    renderComposer({
      secondaryActions: [
        { disabled: true, key: "a", label: "Compact thread", onSelect },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Compact thread" }));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
