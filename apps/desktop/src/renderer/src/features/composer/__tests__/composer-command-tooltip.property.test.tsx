import { act, fireEvent, render } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import fc from "fast-check";
import { TextSelection } from "prosemirror-state";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { DataTooltipLayer } from "../../../lib/DataTooltipLayer";
import { ComposerTiptapInput } from "../ComposerTiptapInput";
import type { ComposerInputChangeMetadata, ComposerSkillToken } from "../ComposerInputTypes";

const commandChip = { text: "/review", tooltip: "Review this draft" };
type Action = "type" | "select" | "range" | "close" | "open";

async function exerciseCommandTooltip(
  draftLength: number,
  actions: Action[],
  ownDescription = false,
): Promise<void> {
  const publish = vi.fn();
  const initial = `/review ${"a".repeat(draftLength)}`;
  function Draft() {
    const [draft, setDraft] = useState({
      value: initial,
      tokens: [] as ComposerSkillToken[],
      document: undefined as ComposerInputChangeMetadata["editorDocument"],
    });
    return <>
      <ComposerTiptapInput id="command-draft" label="Draft" value={draft.value}
        skillTokens={draft.tokens} editorDocument={draft.document}
        commandChip={commandChip} markdownConversion placeholder="Draft"
        onChange={(value, tokens = [], metadata) => {
          publish();
          setDraft({ value, tokens, document: metadata?.editorDocument });
        }} />
      <DataTooltipLayer />
    </>;
  }
  const screen = render(<Draft />);
  const textbox = screen.getByRole("textbox", { name: "Draft" });
  const editor = (textbox as HTMLElement & { editor: Editor }).editor;
  const chip = textbox.querySelector<HTMLElement>("[data-command-chip]")!;
  const underlyingUpdate = editor.view.updateState.bind(editor.view);
  let repairDepth = 0;
  const redraw = vi.fn();
  const update = vi.spyOn(editor.view, "updateState").mockImplementation(function (this: Editor["view"], state) {
    // Exclude the option setter and document-changing transactions. Only an
    // observer repairing the current document makes this same-state call.
    if (state === this.state && repairDepth > 0) redraw();
    underlyingUpdate(state);
  });
  const { domObserver: observer } = editor.view as Editor["view"] & {
    domObserver: { flush: () => void };
  };
  const flush = observer.flush.bind(observer);
  const observe = vi.spyOn(observer, "flush").mockImplementation(() => {
    repairDepth += 1;
    try { flush(); } finally { repairDepth -= 1; }
  });
  const rect = Element.prototype.getBoundingClientRect;
  const measure = vi.fn();
  const geometry = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.getAttribute("role") === "tooltip") measure();
    return rect.call(this);
  });
  const collapse = vi.spyOn(Selection.prototype, "collapse");
  let value = initial;
  let head = initial.length + 1;
  let anchor = head;
  let open = false;
  try {
    await act(async () => {
      editor.commands.setTextSelection(head);
      editor.view.focus();
      if (ownDescription) textbox.setAttribute("aria-describedby", "owned-description");
    });
    for (const action of actions) {
      redraw.mockClear();
      collapse.mockClear();
      measure.mockClear();
      publish.mockClear();
      const wasOpen = open;
      await act(async () => {
        if (action === "type") {
          editor.view.dispatch(editor.state.tr.insertText("x"));
          const start = Math.min(anchor, head);
          const end = Math.max(anchor, head);
          value = value.slice(0, start - 1) + "x" + value.slice(end - 1);
          head = anchor = start + 1;
        } else if (action === "select") {
          head = anchor = head === value.length + 1 ? commandChip.text.length + 2 : value.length + 1;
          editor.commands.setTextSelection(head);
        } else if (action === "range") {
          anchor = value.length + 1;
          head = Math.max(commandChip.text.length + 2, anchor - 2);
          const { tr, doc } = editor.state;
          editor.view.dispatch(tr.setSelection(TextSelection.create(doc, anchor, head)));
        } else {
          open = action === "open";
          if (wasOpen !== open) {
            fireEvent(chip, new MouseEvent(open ? "pointerover" : "pointerout", {
              bubbles: true, relatedTarget: document.body,
            }));
          }
        }
      });
      expect(redraw).toHaveBeenCalledTimes(0);
      expect(collapse.mock.calls.length).toBeLessThanOrEqual(wasOpen === open ? 1 : 0);
      expect(measure.mock.calls.length).toBeLessThanOrEqual(open && !wasOpen ? 2 : 0);
      expect(publish).toHaveBeenCalledTimes(action === "type" ? 1 : 0);
      expect(textbox.querySelector("[data-command-chip]")).toBe(chip);
      expect(editor.getText()).toBe(value);
      expect(editor.state.selection.anchor).toBe(anchor);
      expect(editor.state.selection.head).toBe(head);
      expect(document.activeElement).toBe(textbox);
      const tooltip = screen.queryByRole("tooltip");
      expect(Boolean(tooltip)).toBe(open);
      expect(textbox.getAttribute("aria-describedby")).toBe(
        ownDescription ? "owned-description" : tooltip?.id ?? null,
      );
    }
  } finally {
    screen.unmount();
    const remainingDescription = textbox.getAttribute("aria-describedby");
    editor.destroy();
    update.mockRestore();
    observe.mockRestore();
    geometry.mockRestore();
    collapse.mockRestore();
    expect(remainingDescription).toBe(ownDescription ? "owned-description" : null);
  }
}

it("opens and closes a command tooltip without redrawing the editable chip or writing the caret", async () => {
  await exerciseCommandTooltip(16, ["open", "type", "range", "close", "open"]);
});

it("keeps the textbox's own description when hovering the command chip", async () => {
  await exerciseCommandTooltip(16, ["open", "close"], true);
});

it("preserves the editor, viewport tooltip and publication budgets across generated action sequences", async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom(16, 32),
    fc.array(fc.constantFrom<Action>("type", "select", "range", "close", "open"), {
      minLength: 1, maxLength: 12, size: "max",
    }),
    (length, actions) => exerciseCommandTooltip(length, ["open", ...actions, "close"]),
  ), { numRuns: 25 });
});
