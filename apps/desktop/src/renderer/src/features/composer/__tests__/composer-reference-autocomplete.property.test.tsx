import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import type { Editor } from "@tiptap/react";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { CompactComposer } from "../CompactComposer";
import { ComposerTiptapInput } from "../ComposerTiptapInput";
import type { ComposerInputHandle } from "../ComposerInputTypes";

function mountEditor() {
  return render(<CompactComposer threadTitle="Fixture" onSend={vi.fn()} mentionSources={{
    threads: [{
      id: "fixture",
      title: "ship release",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [],
    }],
    directories: [
      { key: "acorn", kind: "directory", label: "acorn", path: "/dev/acorn" },
      { key: "orchard", kind: "directory", label: "orchard", path: "/dev/orchard" },
    ],
  }} />);
}

function textbox(): HTMLElement & { editor: Editor } {
  return screen.getByRole("textbox", { name: "Message Fixture" }) as HTMLElement & { editor: Editor };
}

// Build the editor document from the expected visible text and preserve
// its surrounding nodes no matter how the sigil and query are marked.
it.each(["#", "@"] as const)("picks %s references in rich text without changing adjacent prose", (sigil) => {
  const query = sigil === "#" ? "ship release" : "orchard";
  const expectedLabel = sigil === "#" ? "#ship release" : "orchard";
  const marks = fc.subarray(["bold", "italic", "strike"]);
  fc.assert(fc.property(
    fc.constantFrom("See ", "See (", "See [", "See “"),
    marks,
    marks,
    fc.boolean(),
    (before, sigilMarks, queryMarks, useKeyboard) => {
      const view = mountEditor();
      try {
        const input = textbox();
        const suffix = before.endsWith("(") ? ") is ready" : " and continue";
        const text = (value: string, formatting: string[]) => ({
          type: "text", text: value, marks: formatting.map((type) => ({ type })),
        });
        act(() => {
          input.editor.commands.insertContentAt(1, [
            text(before, ["italic"]), text(sigil, sigilMarks),
            text(query, queryMarks), text(suffix, ["bold"]),
          ], { updateSelection: false });
          input.editor.commands.setTextSelection(1 + before.length + sigil.length + query.length);
        });
        const option = screen.getByRole("option");
        expect(option.textContent).toContain(expectedLabel);
        if (useKeyboard) fireEvent.keyDown(input, { key: "Enter" });
        else fireEvent.click(option);
        const paragraph = input.editor.state.doc.firstChild;
        expect(paragraph?.firstChild?.toJSON()).toEqual(text(before, ["italic"]));
        expect(paragraph?.maybeChild(1)?.type.name).toBe("mention");
        expect(paragraph?.lastChild?.text).toContain(suffix);
        expect(paragraph?.lastChild?.marks.map((mark) => mark.type.name)).toEqual(["bold"]);
        expect(screen.queryByRole("listbox")).toBeNull();
      } finally {
        view.unmount();
      }
    },
  ), { numRuns: 24 });
});

it("reopens a parenthetical thread reference when the caret moves back inside it", () => {
  mountEditor();
  const before = "See (#ship release";
  const input = textbox();
  fireEvent.change(input, { target: { value: before + ") and continue" } });
  expect(screen.queryByRole("listbox")).toBeNull();
  act(() => { input.editor.commands.setTextSelection(before.length + 1); });
  expect(screen.getByRole("option").textContent).toContain("#ship release");
  act(() => { input.editor.commands.setTextSelection(before.length + 2); });
  expect(screen.queryByRole("listbox")).toBeNull();
});

it("refreshes the picker when replacing its selected query with the same text", () => {
  mountEditor();
  const input = textbox();
  fireEvent.change(input, { target: { value: "@orch" } });
  act(() => { input.editor.commands.setTextSelection({ from: 2, to: 6 }); });
  expect(screen.getAllByRole("option")).toHaveLength(2);
  act(() => {
    const transaction = input.editor.state.tr.insertText("orch");
    expect(transaction.docChanged).toBe(true);
    expect(transaction.doc.eq(transaction.before)).toBe(true);
    input.editor.view.dispatch(transaction);
  });
  expect(screen.getByRole("option").textContent).toContain("orchard");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.querySelector(".composer-tiptap-input__mention")?.textContent).toBe("@orchard");
});

it("inserts a picker reference after a fence and preserves every character of code", () => {
  const code = "first line\nsecond line";
  fc.assert(fc.property(fc.integer({ min: 0, max: code.length }), fc.boolean(), (offset, selectNext) => {
    const ref = createRef<ComposerInputHandle>();
    const view = render(<ComposerTiptapInput ref={ref} id="reply" label="Reply"
      value={`\`\`\`text\n${code}\n\`\`\`\n\nNext paragraph`}
      markdownConversion placeholder="Reply" skillTokens={[]} onChange={() => {}} />);
    try {
      const input = view.getByRole("textbox", { name: "Reply" }) as HTMLElement & { editor: Editor };
      const { editor } = input;
      const fence = editor.state.doc.firstChild!;
      expect(fence.type.name).toBe("codeBlock");
      act(() => {
        editor.commands.setTextSelection({ from: offset + 1, to: Math.min(offset + Number(selectNext), code.length) + 1 });
        ref.current!.replaceReference("@", [{ id: "dir", index: 0, kind: "directory", name: "orchard", path: "/dev/orchard" }]);
      });
      const { doc, selection } = editor.state;
      expect(doc.firstChild?.eq(fence)).toBe(true);
      expect(doc.child(1).type.name).toBe("paragraph");
      expect(doc.child(1).firstChild?.type.name).toBe("mention");
      expect(doc.child(2).textContent).toBe("Next paragraph");
      expect(selection.$from.parent.eq(doc.child(1))).toBe(true);
      expect(selection.$from.parentOffset).toBe(doc.child(1).content.size);
    } finally {
      view.unmount();
    }
  }), { numRuns: 24 });
});
