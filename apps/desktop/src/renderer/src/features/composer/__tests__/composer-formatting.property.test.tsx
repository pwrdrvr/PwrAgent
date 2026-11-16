import { act, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import type { Editor } from "@tiptap/react";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { ComposerTiptapInput } from "../ComposerTiptapInput";

const bridge = vi.hoisted(() => ({ paste: undefined as ((text: string) => boolean) | undefined, request: vi.fn() }));
vi.mock("../../../lib/desktop-api", () => ({
  getDesktopApi: () => ({
    pasteWithoutFormatting: bridge.request,
    onPasteWithoutFormattingRequested: (callback: (text: string) => boolean) => {
      bridge.paste = callback;
      return () => { bridge.paste = undefined; };
    },
  }),
}));

function mount(value: string) {
  function Wrapper() {
    const [draft, setDraft] = useState(value);
    return <ComposerTiptapInput id="formatting" label="Draft" value={draft} skillTokens={[]}
      markdownConversion placeholder="Draft" onChange={setDraft} />;
  }
  const view = render(<Wrapper />);
  const textbox = view.getByRole("textbox", { name: "Draft" });
  const editor = (textbox as HTMLElement & { editor: Editor }).editor;
  act(() => {
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.view.focus();
  });
  return { view, textbox, editor };
}

// Rule: a new paragraph starts without inline marks, whatever combination
// of supported marks the copied text used. Existing text keeps its marks.
it("Shift+Enter leaves all inline formatting behind at the end of pasted prose", () => {
  fc.assert(fc.property(fc.oneof(fc.constant(["code"]), fc.subarray(["bold", "italic", "strike"], { minLength: 1 })), (marks) => {
    const { view, textbox, editor } = mount("");
    try {
      act(() => {
        editor.commands.insertContent({ type: "paragraph", content: [
          { type: "text", text: "Copied heading", marks: marks.map((type) => ({ type })) },
        ] });
      });
      fireEvent.keyDown(textbox, { key: "Enter", shiftKey: true });
      act(() => { editor.view.dispatch(editor.state.tr.insertText("Plain continuation")); });
      expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
      expect(editor.state.doc.lastChild?.firstChild?.marks).toEqual([]);
      expect(editor.state.doc.firstChild?.firstChild?.marks.map((mark) => mark.type.name).sort()).toEqual([...marks].sort());
    } finally { view.unmount(); }
  }), { numRuns: 15 });
});

it.each(["MacIntel", "Win32", "Linux x86_64"])("claims the plain-paste shortcut in a focused %s composer", (platform) => {
  const { view, textbox } = mount("");
  vi.spyOn(window.navigator, "platform", "get").mockReturnValue(platform);
  bridge.request.mockClear();
  try {
    const mac = platform === "MacIntel";
    expect(fireEvent.keyDown(textbox, { key: "V", shiftKey: true, metaKey: mac, ctrlKey: !mac })).toBe(false);
    expect(bridge.request).toHaveBeenCalledOnce();
  } finally { view.unmount(); vi.restoreAllMocks(); }
});

// The clipboard's plain text is the oracle. Markdown-looking source must
// remain literal, without paste rules or reference-chip conversion.
it("Paste Without Formatting inserts literal clipboard text for every Markdown delimiter", () => {
  fc.assert(fc.property(fc.constantFrom("# Heading", "**bold**", "_italic_", "~~strike~~", "`code`", "- item", "```js\ncode\n```"), (text) => {
    const { view, editor } = mount("");
    try {
      act(() => { expect(bridge.paste?.(text)).toBe(true); });
      expect(editor.getText({ blockSeparator: "\n" })).toBe(text);
      editor.state.doc.descendants((node) => {
        expect(["paragraph", "text", "hardBreak"]).toContain(node.type.name);
        expect(node.marks).toEqual([]);
      });
    } finally { view.unmount(); }
  }), { numRuns: 15 });
});

it("Shift+Enter exits a copied bold heading into an unmarked paragraph", () => {
  const { view, textbox, editor } = mount("");
  try {
    fireEvent.paste(textbox, { clipboardData: {
      getData: (type: string) => type === "text/html" ? "<h2><strong>Copied heading</strong></h2>"
        : type === "text/plain" ? "Copied heading" : "",
      types: ["text/plain", "text/html"], files: [], items: [],
    } });
    fireEvent.keyDown(textbox, { key: "Enter", shiftKey: true });
    act(() => { editor.view.dispatch(editor.state.tr.insertText("Plain continuation")); });
    expect(editor.state.doc.firstChild?.type.name).toBe("heading");
    expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
    expect(editor.getJSON().content?.slice(0, 2)).toEqual([
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Copied heading", marks: [{ type: "bold" }] }] },
      { type: "paragraph", content: [{ type: "text", text: "Plain continuation" }] },
    ]);
  } finally { view.unmount(); }
});

it("literal paste replaces the selection without inherited marks and undoes as one edit", () => {
  const { view, textbox, editor } = mount("**Before replace after**");
  try {
    act(() => {
      editor.commands.setTextSelection({ from: 8, to: 15 });
      expect(bridge.paste?.("**literal**\r\nnext")).toBe(true);
    });
    expect(editor.getText({ blockSeparator: "\n" })).toBe("Before **literal**\nnext after");
    const literal = editor.state.doc.firstChild?.content.content.find((node) => node.text === "**literal**");
    expect(literal?.marks).toEqual([]);
    fireEvent.keyDown(textbox, { key: "z", metaKey: true });
    expect(editor.getText()).toBe("Before replace after");
    expect(editor.state.doc.firstChild?.firstChild?.marks.map((mark) => mark.type.name)).toEqual(["bold"]);
  } finally { view.unmount(); }
});
