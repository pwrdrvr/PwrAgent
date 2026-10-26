import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadTodo } from "@pwragent/shared";
import { ComposerTiptapInput } from "../../composer/ComposerTiptapInput";
import { ThreadTodoCard } from "../ThreadTodoCard";

const prompt = [
  "## Goal",
  "",
  "Inspect **heap usage** with `pnpm build`.",
  "",
  "- Measure the peak",
  "- Read [the guide](https://example.com/guide)",
  "",
  "> Keep the original evidence.",
  "",
  "```sh",
  "printf '<fixture>'",
  "```",
].join("\n");

const todo: ThreadTodo = {
  id: "markdown-prompt",
  backend: "codex",
  threadId: "fixture-thread",
  kind: "handoff",
  status: "open",
  title: "Investigate build memory",
  detail: "Find a **safe** reduction.",
  action: { type: "start_thread", prompt },
  createdAt: 0,
  updatedAt: 0,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderCard() {
  return render(<ThreadTodoCard todo={todo} running={false} now={0}
    onRun={vi.fn()} onStartReview={vi.fn()} onResolve={vi.fn()} onSetItemChecked={vi.fn()} />);
}

function Composer() {
  const [value, setValue] = useState("");
  return <ComposerTiptapInput id="paste-target" label="Paste target" value={value} markdownConversion
    onChange={setValue} skillTokens={[]} placeholder="Ask anything" />;
}

describe("to-do prompt Markdown", () => {
  it("renders semantic Markdown outside the expansion button", () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Show the whole proposed prompt" }));
    const region = screen.getByRole("region", { name: "Proposed prompt" });
    expect(within(region).getByRole("heading", { name: "Goal" }).closest("button")).toBeNull();
    expect(region.querySelector("strong")?.textContent).toBe("heap usage");
    expect(region.querySelector("pre code")?.textContent).toContain("printf '<fixture>'");
    expect(within(region).getByRole("link", { name: "the guide" }).closest("button")).toBeNull();
    const collapse = screen.getByRole("button", { name: "Collapse proposed prompt" });
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    expect(collapse.getAttribute("aria-controls")).toBe(region.id);
    fireEvent.click(collapse);
    expect(screen.getByRole("button", { name: "Show the whole proposed prompt" }).getAttribute("aria-expanded")).toBe("false");
  });

  it.each(["title button", "context menu"])("copies a quoted prompt with semantic HTML from the %s", async (source) => {
    const copyRichText = vi.fn(async (_payload: { text: string; html: string }) => undefined);
    vi.stubGlobal("pwragent", { copyRichText, copyText: vi.fn(async () => undefined) });
    renderCard();
    if (source === "context menu") {
      fireEvent.contextMenu(screen.getByRole("heading", { name: todo.title }));
    }
    await act(async () => {
      if (source === "title button") {
        fireEvent.click(screen.getByRole("button", { name: "Copy to-do" }));
      } else {
        fireEvent.click(screen.getByRole("menuitem", { name: /Copy to-do/ }));
      }
    });
    expect(copyRichText).toHaveBeenCalledOnce();
    const clipboard = copyRichText.mock.calls[0][0];
    expect(clipboard.text).toContain("### Prompt\n\n> ## Goal\n>\n> Inspect **heap usage**");
    const html = new DOMParser().parseFromString(clipboard.html, "text/html");
    expect(html.querySelector("blockquote h2")?.textContent).toBe("Goal");
    expect(html.querySelector("blockquote pre code")?.textContent).toContain("printf '<fixture>'");
    expect(html.querySelector("fixture")).toBeNull();
  });

  it.each(["rich", "plain fallback"])("pastes the full card into the composer with a quoted Markdown prompt (%s)", async (format) => {
    let clipboard = { text: "", html: "" };
    vi.stubGlobal("pwragent", {
      copyText: vi.fn(async (text: string) => { clipboard = { text, html: "" }; }),
      ...(format === "rich" ? {
        copyRichText: vi.fn(async (payload: typeof clipboard) => { clipboard = payload; }),
      } : {}),
    });
    renderCard();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy to-do" })); });
    render(<Composer />);
    const textbox = screen.getByRole("textbox", { name: "Paste target" });
    fireEvent.paste(textbox, { clipboardData: {
      files: [], items: [], types: clipboard.html ? ["text/plain", "text/html"] : ["text/plain"],
      getData: (type: string) => type === "text/html" ? clipboard.html : type === "text/plain" ? clipboard.text : "",
    } });
    await waitFor(() => expect(textbox.innerHTML).toContain("<h2>Goal</h2>"));
    expect(textbox.querySelector("blockquote h2")?.textContent).toBe("Goal");
    expect(textbox.querySelector("blockquote strong")?.textContent).toBe("heap usage");
    expect(textbox.querySelector("blockquote pre code")?.textContent).toContain("printf '<fixture>'");
    expect(textbox.querySelector("blockquote blockquote")?.textContent).toContain("Keep the original evidence.");
  });

  it("copies just the prompt as formatted content while retaining its exact Markdown source", async () => {
    const copyRichText = vi.fn(async (_payload: { text: string; html: string }) => undefined);
    vi.stubGlobal("pwragent", { copyRichText, copyText: vi.fn(async () => undefined) });
    renderCard();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy prompt" })); });
    expect(copyRichText).toHaveBeenCalledOnce();
    const clipboard = copyRichText.mock.calls[0][0];
    expect(clipboard.text).toBe(prompt);
    expect(clipboard.html).toContain("<h2>Goal</h2>");
    expect(clipboard.html).toContain("<strong>heap usage</strong>");
    expect(screen.getByRole("button", { name: "Prompt copied" })).toBeTruthy();
  });
});
