import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CompactComposer } from "../CompactComposer";

function renderComposer(overrides: Partial<Parameters<typeof CompactComposer>[0]> = {}) {
  const onSend = vi.fn();
  const view = render(
    <CompactComposer onSend={onSend} threadTitle="Thread t1" {...overrides} />,
  );
  return { ...view, onSend };
}

/**
 * Paste is how the Tiptap suite drives markdown in: jsdom does not run the
 * `beforeinput` machinery typing-based input rules need, and the paste rules
 * exercise the same markdown parser.
 */
function pasteMarkdown(input: HTMLElement, text: string): void {
  fireEvent.paste(input, {
    clipboardData: {
      files: [],
      getData: (type: string) => (type === "text/plain" ? text : ""),
      items: [],
      types: ["text/plain"],
    },
  });
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

  it("offers Steer alongside Stop while a turn is running", () => {
    const onInterrupt = vi.fn();
    renderComposer({ busy: true, onInterrupt });
    // Stop used to be the only control, which read as "you cannot say
    // anything until this finishes".
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.getByRole("button", { name: "Steer" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it("steers the typed text into the running turn", async () => {
    const { onSend } = renderComposer({ busy: true, onInterrupt: vi.fn() });
    const input = screen.getByRole("textbox", { name: "Message Thread t1" });
    fireEvent.change(input, { target: { value: "also check the logs" } });
    fireEvent.click(screen.getByRole("button", { name: "Steer" }));
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith("also check the logs");
    });
  });

  it("disables Steer when the running turn cannot take one", () => {
    renderComposer({ busy: true, canSteer: false, onInterrupt: vi.fn() });
    const input = screen.getByRole("textbox", { name: "Message Thread t1" });
    fireEvent.change(input, { target: { value: "no route for this" } });
    // Better a dead button than a send that is guaranteed to bounce.
    expect(
      (screen.getByRole("button", { name: "Steer" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("keeps Stop hidden when the host offers no way to interrupt", () => {
    renderComposer({ busy: true });
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
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

describe("CompactComposer markdown", () => {
  it("formats inline code rather than leaving the backticks literal", async () => {
    const { container } = renderComposer();
    const input = screen.getByRole("textbox", { name: "Message Thread t1" });
    pasteMarkdown(input, "Can you deploy `pr-13598-3f3b862d1163`");

    // The card renders a fully formatted transcript; a reply box that
    // cannot format teaches the operator that markdown does not work here.
    await waitFor(() => {
      expect(container.querySelector("code")?.textContent).toBe(
        "pr-13598-3f3b862d1163",
      );
    });
  });

  it("sends the markdown source, not the rendered text", async () => {
    const { onSend } = renderComposer();
    const input = screen.getByRole("textbox", { name: "Message Thread t1" });
    pasteMarkdown(input, "run `pnpm test` first");

    await waitFor(() => {
      expect(input.textContent).toContain("pnpm test");
    });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      // The backend reads markdown, so the backticks have to survive the
      // trip through the editor.
      expect(onSend).toHaveBeenCalledWith("run `pnpm test` first");
    });
  });

  it("keeps a fenced block intact across the send", async () => {
    const { onSend } = renderComposer();
    const input = screen.getByRole("textbox", { name: "Message Thread t1" });
    pasteMarkdown(input, "```sh\npnpm lint\n```");

    await waitFor(() => {
      expect(input.querySelector("pre code")?.textContent).toContain(
        "pnpm lint",
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith("```sh\npnpm lint\n```");
    });
  });
});
