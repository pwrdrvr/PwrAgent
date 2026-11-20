import { act, fireEvent, render } from "@testing-library/react";
import type { Editor, JSONContent } from "@tiptap/react";
import fc from "fast-check";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import type { ComposerSkillToken } from "../ComposerInputTypes";
import { ComposerTiptapInput } from "../ComposerTiptapInput";

function exerciseTyping(keys: string[]): void {
  const onKey = vi.fn();
  const publish = vi.fn();
  function Draft() {
    const [draft, setDraft] = useState<{ value: string; tokens: ComposerSkillToken[]; document?: JSONContent }>({
      value: "",
      tokens: [],
    });
    return <ComposerTiptapInput
      id="draft"
      label="Draft"
      placeholder="Draft"
      markdownConversion
      value={draft.value}
      skillTokens={draft.tokens}
      editorDocument={draft.document}
      onKeyDown={() => onKey(draft.value)}
      onChange={(value, tokens = [], metadata) => {
        publish(value);
        setDraft({ value, tokens, document: metadata?.editorDocument });
      }}
    />;
  }

  const screen = render(<Draft />);
  const textbox = screen.getByRole("textbox", { name: "Draft" });
  const { editor } = textbox as HTMLElement & { editor: Editor };
  const setOptions = vi.spyOn(editor, "setOptions");
  try {
    let expected = "";
    for (const key of keys) {
      fireEvent.keyDown(textbox, { key });
      expect(onKey).toHaveBeenLastCalledWith(expected);
      act(() => editor.view.dispatch(editor.state.tr.insertText(key)));
      expected += key;
      expect(publish).toHaveBeenLastCalledWith(expected);
      expect(editor.state.selection.head).toBe(expected.length + 1);
    }
    expect(publish).toHaveBeenCalledTimes(keys.length);
    expect(onKey).toHaveBeenCalledTimes(keys.length);
    expect(editor.getText()).toBe(expected);
    // Draft content, selection and new callback closures are not view options.
    expect(setOptions.mock.calls.length).toBe(0);
  } finally {
    setOptions.mockRestore();
    screen.unmount();
    editor.destroy();
  }
}

it("publishes a typed character without reapplying the editor options", () => {
  exerciseTyping(["a"]);
});

it("keeps view options stable and uses the latest callbacks throughout typing", () => {
  fc.assert(fc.property(
    fc.array(fc.constantFrom("a", "b", "c"), { minLength: 2, maxLength: 12, size: "max" }),
    exerciseTyping,
  ), { numRuns: 25 });
});

it("applies new view attributes to the same editor without publishing a draft", () => {
  const onChange = vi.fn();
  const props = { id: "draft", label: "Draft", value: "Hello", skillTokens: [], onChange };
  const screen = render(<ComposerTiptapInput {...props} placeholder="Draft" />);
  const textbox = screen.getByRole("textbox", { name: "Draft" });
  const { editor } = textbox as HTMLElement & { editor: Editor };
  try {
    screen.rerender(<ComposerTiptapInput {...props} id="reply" label="Reply"
      placeholder="Write a reply" ariaControls="commands" ariaActiveDescendant="help" />);
    expect(screen.getByRole("textbox", { name: "Reply" })).toBe(textbox);
    expect(textbox.id).toBe("reply");
    expect(textbox.getAttribute("data-placeholder")).toBe("Write a reply");
    expect(textbox.getAttribute("aria-controls")).toBe("commands");
    expect(textbox.getAttribute("aria-activedescendant")).toBe("help");
    expect(editor.getText()).toBe("Hello");
    expect(onChange).not.toHaveBeenCalled();
  } finally {
    screen.unmount();
    editor.destroy();
  }
});
