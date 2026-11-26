import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEmojiCatalog } from "../../../lib/emoji-shortcodes";
import { ComposerTiptapInput } from "../ComposerTiptapInput";
import { CompactComposer } from "../CompactComposer";
import { Composer } from "../Composer";
import { navigationQueryFixture } from "../../../test/navigation-query-fixture";
import type { DesktopApi } from "../../../lib/desktop-api";
import type { ComposerInputHandle, ComposerSkillToken } from "../ComposerInputTypes";

afterEach(() => {
  cleanup();
});

function getEditor(textbox: HTMLElement): Editor {
  return (textbox as HTMLElement & { editor: Editor }).editor;
}

function typeTextIntoEditor(editor: Editor, text: string): void {
  for (const char of text) {
    const { from, to } = editor.state.selection;
    const handled = editor.view.someProp("handleTextInput", (fn) =>
      fn(editor.view, from, to, char, () => editor.state.tr.insertText(char, from, to)),
    );
    if (!handled) {
      editor.view.dispatch(editor.state.tr.insertText(char, from, to));
    }
  }
}

function renderControlledTiptap(options?: {
  markdownConversion?: boolean;
  onReferenceSelectionChange?: () => void;
  value?: string;
}) {
  const onChange = vi.fn();
  const inputRef = createRef<ComposerInputHandle>();

  function Harness() {
    const [value, setValue] = useState(options?.value ?? "");
    const [skillTokens, setSkillTokens] = useState<ComposerSkillToken[]>([]);
    return (
      <ComposerTiptapInput
        ref={inputRef}
        id="emoji-composer"
        label="Reply"
        markdownConversion={options?.markdownConversion ?? true}
        onChange={(nextValue, nextTokens = []) => {
          onChange(nextValue, nextTokens);
          setValue(nextValue);
          setSkillTokens(nextTokens);
        }}
        onReferenceSelectionChange={options?.onReferenceSelectionChange}
        placeholder="Reply"
        skillTokens={skillTokens}
        value={value}
      />
    );
  }

  const view = render(<Harness />);
  const textbox = screen.getByRole("textbox", { name: "Reply" });
  return { ...view, textbox, editor: getEditor(textbox), inputRef, onChange };
}

describe("ComposerTiptapInput :shortcode: auto-expansion", () => {
  it("expands exact known shortcodes on closing colon including full-catalog entries", async () => {
    await loadEmojiCatalog();
    const { textbox, editor } = renderControlledTiptap();

    act(() => {
      typeTextIntoEditor(editor, ":+1: :thumbsup: :rocket: :avocado:");
    });

    expect(textbox.textContent).toBe("👍 👍 🚀 🥑");
  });

  it("never corrupts URLs, times, :: operators, unknown shortcodes, inline code, or fenced code", async () => {
    await loadEmojiCatalog();
    const { textbox, editor } = renderControlledTiptap();

    act(() => {
      typeTextIntoEditor(
        editor,
        "12:30 std::vector https://example.com/:rocket:/test foo:rocket:bar :not_real: `:+1:`",
      );
    });

    // Tiptap converts `:+1:` to an inline <code>:+1:</code> span without expanding it.
    expect(textbox.querySelector("code")?.textContent).toBe(":+1:");
    expect(textbox.textContent).toBe(
      "12:30 std::vector https://example.com/:rocket:/test foo:rocket:bar :not_real: :+1:",
    );
    expect(textbox.textContent).not.toContain("👍");
    expect(textbox.textContent).not.toContain("🚀");
  });

  it("does not expand inside a Tiptap codeBlock node", async () => {
    await loadEmojiCatalog();
    const { textbox, editor } = renderControlledTiptap({
      value: "```ts\nconst x = 1;\n```",
    });

    act(() => {
      let codeEndPos = 1;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === "codeBlock") {
          codeEndPos = pos + 1 + node.textContent.length;
          return false;
        }
        return undefined;
      });
      editor.commands.setTextSelection(codeEndPos);
      typeTextIntoEditor(editor, " :+1:");
    });

    expect(textbox.querySelector("pre code")?.textContent).toContain(":+1:");
    expect(textbox.textContent).not.toContain("👍");
  });

  it("tracks fenced code across hardBreak lines and ignores literal fences inside prior codeBlock nodes", async () => {
    await loadEmojiCatalog();
    const { textbox, editor, unmount } = renderControlledTiptap({ markdownConversion: false });

    // 1. Opening fence followed by Shift+Enter (hardBreak) in the same paragraph suppresses expansion.
    act(() => {
      editor.commands.setContent("<p>```ts<br></p>");
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
      typeTextIntoEditor(editor, ":+1:");
    });
    expect(textbox.textContent).toContain(":+1:");
    expect(textbox.textContent).not.toContain("👍");

    // 2. Prior paragraph containing a hardBreak before an opening fence suppresses expansion in the next paragraph.
    act(() => {
      editor.commands.setContent("<p>intro<br>```ts</p><p></p>");
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
      typeTextIntoEditor(editor, ":rocket:");
    });
    expect(textbox.textContent).toContain(":rocket:");
    expect(textbox.textContent).not.toContain("🚀");

    unmount();

    // 3. Prior closed codeBlock with an odd number of literal fence lines does NOT disable expansion afterward.
    const markdownView = renderControlledTiptap({ markdownConversion: true });
    act(() => {
      markdownView.editor.commands.setContent(
        "<pre><code>```md\nexample</code></pre><p></p>",
      );
      markdownView.editor.commands.setTextSelection(
        markdownView.editor.state.doc.content.size - 1,
      );
      typeTextIntoEditor(markdownView.editor, ":+1:");
    });
    expect(markdownView.textbox.textContent).toContain("👍");

    // 4. MBT counterexample: unclosed backticks earlier on the same line before an inline code mark still suppress expansion.
    act(() => {
      markdownView.editor.commands.setContent("<p>``<code> (</code> </p>");
      markdownView.editor.commands.setTextSelection(
        markdownView.editor.state.doc.content.size - 1,
      );
      typeTextIntoEditor(markdownView.editor, ":rocket:");
    });
    expect(markdownView.textbox.textContent).toContain(":rocket:");
    expect(markdownView.textbox.textContent).not.toContain("🚀");

    // 5. MBT counterexample: inline code mark before literal `~~~` on the same line is NOT a column-0 opening fence.
    act(() => {
      markdownView.editor.commands.setContent("<p><code>x</code> ~~~hello</p>");
      markdownView.editor.commands.setTextSelection(
        markdownView.editor.state.doc.content.size - 1,
      );
      typeTextIntoEditor(markdownView.editor, " :+1:");
    });
    expect(markdownView.textbox.textContent).toContain("👍");
  });

  it("skips full-document traversal on caret moves when no emoji trigger exists and caches per-doc fence state", async () => {
    await loadEmojiCatalog();
    const onReferenceSelectionChange = vi.fn();
    const { editor, inputRef } = renderControlledTiptap({
      onReferenceSelectionChange,
      value: "First paragraph\n\nSecond paragraph\n\nThird paragraph",
    });

    const end = editor.state.doc.content.size - 1;
    const $end = editor.state.doc.resolve(end);
    const blockStart = $end.before($end.depth);
    expect(blockStart).toBeGreaterThan(0);
    expect(blockStart).toBeLessThan(editor.state.doc.content.size);

    const nodesBetweenSpy = vi.spyOn(editor.state.doc, "nodesBetween");
    act(() => {
      editor.commands.setTextSelection(end - 5);
      editor.commands.setTextSelection(end - 2);
      editor.commands.setTextSelection(end);
    });
    const parentNodesBetweenSpy = vi.spyOn($end.parent, "nodesBetween");
    expect(inputRef.current?.getEmojiTrigger()).toBeUndefined();
    const priorBlockCallsWithoutTrigger = nodesBetweenSpy.mock.calls.filter(
      ([from, to]) => from === 0 && to === blockStart,
    );
    expect(priorBlockCallsWithoutTrigger).toEqual([]);
    expect(parentNodesBetweenSpy).not.toHaveBeenCalled();
    nodesBetweenSpy.mockRestore();
    parentNodesBetweenSpy.mockRestore();

    // Once a boundary-safe :shortcode candidate exists, onTransaction populates the per-doc
    // fence cache once and subsequent getEmojiTrigger() reads on the same doc avoid re-walking.
    act(() => {
      typeTextIntoEditor(editor, " :thumbs");
    });
    const activeNodesBetweenSpy = vi.spyOn(editor.state.doc, "nodesBetween");
    const trigger = inputRef.current?.getEmojiTrigger();
    expect(trigger?.query).toBe("thumbs");
    const priorBlockCallsAfterCache = activeNodesBetweenSpy.mock.calls.filter(
      ([from, to]) => from === 0 && to === blockStart,
    );
    expect(priorBlockCallsAfterCache).toEqual([]);
    activeNodesBetweenSpy.mockRestore();
  });

  it("respects active IME composition (isComposing, keyCode 229, compositionstart)", () => {
    const { textbox, editor } = renderControlledTiptap();

    act(() => {
      typeTextIntoEditor(editor, ":+1");
    });

    // Simulate IME composition keydown with isComposing before typing ":".
    fireEvent.keyDown(textbox, { key: ":", isComposing: true });
    act(() => {
      typeTextIntoEditor(editor, ":");
    });
    expect(textbox.textContent).toBe(":+1:");

    // IME composition guard must also skip editor shortcuts like Shift+Enter without preventDefault.
    const shiftEnterEvent = new KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(shiftEnterEvent, "isComposing", { value: true });
    act(() => {
      textbox.dispatchEvent(shiftEnterEvent);
    });
    expect(shiftEnterEvent.defaultPrevented).toBe(false);
    expect(textbox.querySelector("br")).toBeNull();

    // Reset and test keyCode 229.
    act(() => {
      editor.commands.setContent("<p>:rocket</p>");
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    });
    fireEvent.keyDown(textbox, { key: ":", keyCode: 229 });
    act(() => {
      typeTextIntoEditor(editor, ":");
    });
    expect(textbox.textContent).toBe(":rocket:");

    // Reset and test compositionstart / compositionend lifecycle.
    act(() => {
      editor.commands.setContent("<p>:fire</p>");
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    });
    fireEvent.compositionStart(textbox);
    act(() => {
      typeTextIntoEditor(editor, ":");
    });
    expect(textbox.textContent).toBe(":fire:");

    fireEvent.compositionEnd(textbox);
    fireEvent.keyDown(textbox, { key: ":" });
    act(() => {
      typeTextIntoEditor(editor, " :fire:");
    });
    expect(textbox.textContent).toBe(":fire: 🔥");
  });
});

describe("CompactComposer :emoji: autocomplete", () => {
  it("opens keyboard-navigable emoji autocomplete, follows ARIA contract, and inserts on Enter/Tab/click", async () => {
    await loadEmojiCatalog();
    const onSend = vi.fn();
    render(<CompactComposer onSend={onSend} threadTitle="Thread t1" />);

    const textbox = screen.getByRole("textbox", { name: "Message Thread t1" });
    const editor = getEditor(textbox);

    act(() => {
      typeTextIntoEditor(editor, "Looks great :thumbs");
    });

    const listbox = await screen.findByRole("listbox", { name: "Emoji" });
    expect(textbox).toHaveAttribute("aria-controls", listbox.id);
    expect(textbox).not.toHaveAttribute("aria-expanded");

    const options = within(listbox).getAllByRole("option");
    expect(options.length).toBeGreaterThanOrEqual(2);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options[0]).toHaveTextContent(":+1:");
    expect(textbox).toHaveAttribute("aria-activedescendant", options[0]!.id);

    // IME composition keys must not move or commit the active option.
    fireEvent.keyDown(textbox, { key: "Enter", isComposing: true });
    fireEvent.keyDown(textbox, { key: "Enter", keyCode: 229 });
    expect(screen.getByRole("listbox", { name: "Emoji" })).toBeInTheDocument();

    // ArrowDown moves highlight to Thumbs down (:-1:).
    fireEvent.keyDown(textbox, { key: "ArrowDown" });
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    expect(textbox).toHaveAttribute("aria-activedescendant", options[1]!.id);

    // ArrowUp returns to Thumbs up (:+1:) and Enter inserts 👍.
    fireEvent.keyDown(textbox, { key: "ArrowUp" });
    fireEvent.keyDown(textbox, { key: "Enter" });

    await waitFor(() => {
      expect(screen.queryByRole("listbox", { name: "Emoji" })).toBeNull();
    });
    expect(textbox.textContent).toBe("Looks great 👍 ");
    expect(onSend).not.toHaveBeenCalled();

    // Tab commits the active option.
    act(() => {
      typeTextIntoEditor(editor, ":fire");
    });
    expect(await screen.findByRole("listbox", { name: "Emoji" })).toBeInTheDocument();
    fireEvent.keyDown(textbox, { key: "Tab" });
    await waitFor(() => {
      expect(screen.queryByRole("listbox", { name: "Emoji" })).toBeNull();
    });
    expect(textbox.textContent).toBe("Looks great 👍 🔥 ");

    // Pointer click (mouseDown) selects a clicked option (including alias search).
    act(() => {
      typeTextIntoEditor(editor, ":rotating_ligh");
    });
    const aliasListbox = await screen.findByRole("listbox", { name: "Emoji" });
    const aliasOption = within(aliasListbox).getAllByRole("option")[0]!;
    expect(aliasOption).toHaveTextContent("🚨");
    fireEvent.mouseDown(aliasOption);
    await waitFor(() => {
      expect(screen.queryByRole("listbox", { name: "Emoji" })).toBeNull();
    });
    expect(textbox.textContent).toBe("Looks great 👍 🔥 🚨 ");

    // Escape dismisses without inserting.
    act(() => {
      typeTextIntoEditor(editor, ":rocket");
    });
    expect(await screen.findByRole("listbox", { name: "Emoji" })).toBeInTheDocument();
    fireEvent.keyDown(textbox, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("listbox", { name: "Emoji" })).toBeNull();
    });
    expect(textbox.textContent).toBe("Looks great 👍 🔥 🚨 :rocket");
  });

  it("auto-expands :+1: on closing colon and closes the autocomplete popup", async () => {
    await loadEmojiCatalog();
    render(<CompactComposer onSend={vi.fn()} threadTitle="Thread t2" />);

    const textbox = screen.getByRole("textbox", { name: "Message Thread t2" });
    const editor = getEditor(textbox);

    act(() => {
      typeTextIntoEditor(editor, ":+1");
    });
    expect(await screen.findByRole("listbox", { name: "Emoji" })).toBeInTheDocument();

    act(() => {
      typeTextIntoEditor(editor, ":");
    });
    await waitFor(() => {
      expect(screen.queryByRole("listbox", { name: "Emoji" })).toBeNull();
    });
    expect(textbox.textContent).toBe("👍");
  });
});

describe("Composer :emoji: autocomplete", () => {
  it("opens EmojiAutocompleteList on :prefix, navigates with keyboard, and inserts via Enter, Tab, and click", async () => {
    await loadEmojiCatalog();
    const desktopApi: DesktopApi = {
      getNavigationQueryPage: async (request) =>
        navigationQueryFixture(request, { directories: [], threads: [] }),
    };

    render(
      <Composer
        backends={[]}
        desktopApi={desktopApi}
        directories={[]}
        skills={[]}
        thread={{
          id: "thread-emoji-1",
          source: "codex",
          title: "Emoji test thread",
          titleSource: "explicit",
          updatedAt: 1795711200000,
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
        threads={[]}
      />,
    );

    const textbox = screen.getByRole("textbox");
    const editor = getEditor(textbox);

    act(() => {
      typeTextIntoEditor(editor, "Ready to ship :rocke");
    });

    const listbox = await screen.findByRole("listbox", { name: "Emoji" });
    expect(listbox).toHaveClass("composer__autocomplete--emoji");
    expect(textbox).toHaveAttribute("aria-controls", listbox.id);
    const firstOption = within(listbox).getAllByRole("option")[0]!;
    expect(firstOption).toHaveTextContent(":rocket:");
    expect(firstOption).toHaveAttribute("aria-selected", "true");
    expect(textbox).toHaveAttribute("aria-activedescendant", firstOption.id);

    fireEvent.keyDown(textbox, { key: "Enter" });

    await waitFor(() => {
      expect(screen.queryByRole("listbox", { name: "Emoji" })).toBeNull();
    });
    expect(textbox.textContent).toBe("Ready to ship 🚀 ");

    // Tab commits the active option in Composer.
    act(() => {
      typeTextIntoEditor(editor, ":avocad");
    });
    expect(await screen.findByRole("listbox", { name: "Emoji" })).toBeInTheDocument();
    fireEvent.keyDown(textbox, { key: "Tab" });
    await waitFor(() => {
      expect(screen.queryByRole("listbox", { name: "Emoji" })).toBeNull();
    });
    expect(textbox.textContent).toBe("Ready to ship 🚀 🥑 ");

    // Batched mouseDown + click on the same option must insert only a single emoji.
    act(() => {
      typeTextIntoEditor(editor, ":thumbs");
    });
    const thumbsListbox = await screen.findByRole("listbox", { name: "Emoji" });
    const thumbsDownOption = within(thumbsListbox).getAllByRole("option")[1]!;
    expect(thumbsDownOption).toHaveTextContent(":-1:");
    act(() => {
      fireEvent.mouseDown(thumbsDownOption);
      fireEvent.click(thumbsDownOption);
    });
    await waitFor(() => {
      expect(screen.queryByRole("listbox", { name: "Emoji" })).toBeNull();
    });
    expect(textbox.textContent).toBe("Ready to ship 🚀 🥑 👎 ");

    // Narrowing results after moving activeIndex down must clamp aria-activedescendant immediately.
    act(() => {
      typeTextIntoEditor(editor, ":t");
    });
    const broadListbox = await screen.findByRole("listbox", { name: "Emoji" });
    expect(within(broadListbox).getAllByRole("option").length).toBeGreaterThan(3);
    fireEvent.keyDown(textbox, { key: "ArrowDown" });
    fireEvent.keyDown(textbox, { key: "ArrowDown" });
    fireEvent.keyDown(textbox, { key: "ArrowDown" });
    act(() => {
      typeTextIntoEditor(editor, "humbsu");
    });
    const narrowedListbox = await screen.findByRole("listbox", { name: "Emoji" });
    const narrowedOptions = within(narrowedListbox).getAllByRole("option");
    expect(narrowedOptions).toHaveLength(1);
    expect(narrowedOptions[0]).toHaveAttribute("aria-selected", "true");
    expect(textbox).toHaveAttribute("aria-activedescendant", narrowedOptions[0]!.id);
    fireEvent.click(narrowedOptions[0]!);
    await waitFor(() => {
      expect(screen.queryByRole("listbox", { name: "Emoji" })).toBeNull();
    });
    expect(textbox.textContent).toBe("Ready to ship 🚀 🥑 👎 👍 ");
  });
});
