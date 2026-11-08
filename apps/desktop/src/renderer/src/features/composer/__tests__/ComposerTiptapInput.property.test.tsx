import { act, render } from "@testing-library/react";
import { useState } from "react";
import { expect, it } from "vitest";
import fc from "fast-check";
import { ComposerTiptapInput } from "../ComposerTiptapInput";
import type { ComposerSkillToken } from "../ComposerInputTypes";

type Accessibility = { disabled: boolean; readOnly: boolean; expanded: boolean };
const accessibility = fc.record({ disabled: fc.boolean(), readOnly: fc.boolean(), expanded: fc.boolean() });
const draft = fc.tuple(fc.constantFrom("/", "@", "$"),
  fc.array(fc.constantFrom("a", "b", "c", "x", "y", "z"), { minLength: 1, maxLength: 8 }))
  .map(([prefix, letters]) => prefix + letters.join(""));

function checkFixpoint(draft: string, updates: Accessibility[]) {
  const changes: string[] = [];
  let restore!: (value: string) => void;
  function Window(props: Accessibility) {
    const [value, setValue] = useState("");
    const [tokens, setTokens] = useState<ComposerSkillToken[]>([]);
    restore = setValue;
    const expanded = value.length > 0 && props.expanded;
    return <ComposerTiptapInput id="fixpoint-editor" label="Draft" value={value} skillTokens={tokens} markdownConversion
      placeholder="Draft" disabled={props.disabled} readOnly={props.readOnly} ariaExpanded={expanded}
      ariaControls={expanded ? "commands" : undefined} ariaActiveDescendant={expanded ? "command" : undefined}
      onChange={(next, nextTokens = []) => {
        changes.push(next);
        // Bound a historical feedback loop without hiding it: every callback
        // is recorded and the oracle below requires none after initialization.
        if (changes.length <= 4) { setValue(next); setTokens(nextTokens); }
      }} />;
  }
  const initial = { disabled: false, readOnly: false, expanded: true };
  const view = render(<Window {...initial} />);
  try {
    const textbox = view.getByRole("textbox", { name: "Draft" });
    changes.length = 0;
    act(() => restore(draft));
    expect(textbox.textContent).toBe(draft);
    expect(changes).toEqual([]);
    for (const update of updates) {
      view.rerender(<Window {...update} />);
      expect(textbox.textContent).toBe(draft);
      expect(changes).toEqual([]);
      view.rerender(<Window {...update} />);
      expect(textbox.textContent).toBe(draft);
      expect(changes).toEqual([]);
    }
  } finally { view.unmount(); }
}

it("restoring autocomplete and replaying accessibility inputs reaches a silent draft fixpoint", () => {
  fc.assert(fc.property(draft, fc.array(accessibility, { minLength: 1, maxLength: 4 }), checkFixpoint), { numRuns: 25 });
});

it("does not replay stale content while restoring /a (shrunk #2281 regression)", () => {
  checkFixpoint("/a", [{ disabled: false, readOnly: false, expanded: false }]);
});
