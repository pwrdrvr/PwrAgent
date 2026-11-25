import { act, fireEvent, render, screen } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { CompactComposer } from "../CompactComposer";

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
