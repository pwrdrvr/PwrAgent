import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import type { Editor } from "@tiptap/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEmojiCatalog } from "../../../lib/emoji-shortcodes";
import { ComposerTiptapInput } from "../ComposerTiptapInput";
import { CompactComposer } from "../CompactComposer";
import { Composer } from "../Composer";
import { navigationQueryFixture } from "../../../test/navigation-query-fixture";
import type { DesktopApi } from "../../../lib/desktop-api";
import type { ComposerSkillToken } from "../ComposerInputTypes";

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

function renderControlledTiptap(options?: { markdownConversion?: boolean; value?: string }) {
  const onChange = vi.fn();

  function Harness() {
    const [value, setValue] = useState(options?.value ?? "");
    const [skillTokens, setSkillTokens] = useState<ComposerSkillToken[]>([]);
    return (
      <ComposerTiptapInput
        id="emoji-composer"
        label="Reply"
        markdownConversion={options?.markdownConversion ?? true}
        onChange={(nextValue, nextTokens = []) => {
          onChange(nextValue, nextTokens);
          setValue(nextValue);
          setSkillTokens(nextTokens);
        }}
        placeholder="Reply"
        skillTokens={skillTokens}
        value={value}
      />
    );
  }

  const view = render(<Harness />);
  const textbox = screen.getByRole("textbox", { name: "Reply" });
  return { ...view, textbox, editor: getEditor(textbox), onChange };
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

    // Escape dismisses without inserting.
    act(() => {
      typeTextIntoEditor(editor, ":rocket");
    });
    expect(await screen.findByRole("listbox", { name: "Emoji" })).toBeInTheDocument();
    fireEvent.keyDown(textbox, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("listbox", { name: "Emoji" })).toBeNull();
    });
    expect(textbox.textContent).toBe("Looks great 👍 :rocket");
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
  it("opens EmojiAutocompleteList on :prefix, navigates with keyboard, and inserts the chosen emoji", async () => {
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
  });
});
