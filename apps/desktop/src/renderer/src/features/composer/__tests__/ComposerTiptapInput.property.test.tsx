import { act, fireEvent, render } from "@testing-library/react";
import { createRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { expect, it } from "vitest";
import fc from "fast-check";
import { fromMarkdown } from "mdast-util-from-markdown";
import {
  ComposerTiptapInput,
  getDraftIndexAtDocumentPosition,
  getPositionAtDocumentDraftIndex,
} from "../ComposerTiptapInput";
import type { ComposerInputHandle, ComposerSkillToken } from "../ComposerInputTypes";

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

it("restores fenced code and its surrounding paragraphs as parsed by CommonMark", () => {
  const codeLines = fc.oneof(
    fc.constant([""]),
    fc.array(fc.constantFrom("", " ", "  at src/example.test.ts:1:2", "FAIL"), { maxLength: 5 }),
  );
  fc.assert(fc.property(fc.constantFrom("", "text", "console"), codeLines, (language, lines) => {
    const source = ["Check the tests", "", `\`\`\`${language}`, ...lines, "```", "", "Keep this too"].join("\n");
    const code = fromMarkdown(source).children.find((node) => node.type === "code");
    const tokens: ComposerSkillToken[] = [];
    const onChange = (): void => {};
    const editor = (value: string) => <ComposerTiptapInput id="restore-code" label="Reply"
      value={value} skillTokens={tokens} placeholder="Reply" markdownConversion onChange={onChange} />;
    const view = render(editor(""));
    try {
      view.rerender(editor(source));
      const textbox = view.getByRole("textbox", { name: "Reply" });
      expect(Array.from(textbox.querySelectorAll("p"), (paragraph) => paragraph.textContent))
        .toEqual(["Check the tests", "Keep this too"]);
      expect(textbox.querySelector("pre code")?.textContent).toBe(code?.value);
    } finally {
      view.unmount();
    }
  }), { numRuns: 25 });
});

it("preserves the active selection anywhere in the existing draft when appending dictation", () => {
  const value = "Keep editing this draft";
  const position = fc.integer({ min: 1, max: value.length + 1 });
  fc.assert(fc.property(position, position, (anchor, head) => {
    const input = createRef<ComposerInputHandle>();
    const view = render(<ComposerTiptapInput ref={input} id="reply" label="Reply"
      value={value} skillTokens={[]} placeholder="Reply" onChange={() => {}} />);
    try {
      const textbox = view.getByRole("textbox", { name: "Reply" });
      const editor = (textbox as HTMLElement & { editor: Editor }).editor;
      act(() => {
        editor.commands.setTextSelection({ from: anchor, to: head });
      });
      const before = editor.state.selection.toJSON();
      act(() => {
        expect(input.current?.appendPlainText("Spoken text")).toBe(true);
      });
      expect(editor.state.selection.toJSON()).toEqual(before);
    } finally {
      view.unmount();
    }
  }), { numRuns: 25 });
});

it("pastes plain-text Markdown blocks containing inline code nested in any emphasis without dropping the paste", () => {
  const token = fc.stringMatching(/^[a-z][a-z0-9_/-]{1,8}$/);
  const emphasisDelimiter = fc.constantFrom("**", "*", "~~");
  const blockPrefix = fc.constantFrom("- ", "1. ", "### ", "> ");
  const wrappedCodeLine = fc.record({
    prefix: blockPrefix,
    outer: emphasisDelimiter,
    inner: fc.option(emphasisDelimiter, { nil: undefined }),
    before: token,
    code: token,
    after: token,
  });

  fc.assert(fc.property(fc.array(wrappedCodeLine, { minLength: 1, maxLength: 4 }), (entries) => {
    const markdown = entries
      .map(({ prefix, outer, inner, before, code, after }) => {
        const body = inner
          ? `${before} ${inner}\`${code}\`${inner} ${after}`
          : `${before} \`${code}\` ${after}`;
        return `${prefix}${outer}${body}${outer}`;
      })
      .join("\n");

    const changes: string[] = [];
    const view = render(
      <ComposerTiptapInput
        id="paste-inline-code-prop"
        label="Reply"
        markdownConversion
        onChange={(next) => changes.push(next)}
        placeholder="Reply"
        skillTokens={[]}
        value=""
      />,
    );
    try {
      const textbox = view.getByRole("textbox", { name: "Reply" });
      act(() => {
        fireEvent.paste(textbox, {
          clipboardData: {
            files: [],
            getData: (type: string) => type === "text/plain" ? markdown : "",
            items: [],
            types: ["text/plain"],
          },
        });
      });

      expect(changes.length).toBeGreaterThan(0);
      const codeTexts = Array.from(textbox.querySelectorAll("code"), (node) => node.textContent);
      for (const entry of entries) {
        expect(codeTexts).toContain(entry.code);
        expect(textbox.textContent).toContain(entry.before);
        expect(textbox.textContent).toContain(entry.after);
      }
    } finally {
      view.unmount();
    }
  }), { numRuns: 25 });
});

function typeTextWithInputRules(editor: Editor, text: string): void {
  for (const char of text) {
    const { from, to } = editor.state.selection;
    let handled = false;
    editor.view.someProp("handleTextInput", (handler) => {
      if (handler(editor.view, from, to, char, () => editor.state.tr.insertText(char, from, to))) {
        handled = true;
        return true;
      }
      return false;
    });
    if (!handled) {
      editor.view.dispatch(editor.state.tr.insertText(char, from, to));
    }
  }
}

function withTypedFence(opener: string, check: (editor: Editor, readMarkdown: () => string) => void): void {
  let markdown = "";
  const view = render(
    <ComposerTiptapInput
      id="code-fence-input-rule"
      label="Reply"
      markdownConversion
      onChange={(next) => { markdown = next; }}
      placeholder="Reply"
      skillTokens={[]}
      value=""
    />,
  );
  try {
    const textbox = view.getByRole("textbox", { name: "Reply" });
    const editor = (textbox as HTMLElement & { editor: Editor }).editor;
    act(() => typeTextWithInputRules(editor, opener));
    check(editor, () => markdown);
  } finally {
    view.unmount();
  }
}

function checkCodeFenceRoundTrip(fenceLength: number, language: string, body: string): void {
  withTypedFence(`${"`".repeat(fenceLength)}${language} `, (editor, readMarkdown) => {
    act(() => {
      editor.commands.insertContent({ type: "text", text: body });
    });

    const { doc } = editor.state;
    const block = doc.firstChild;
    expect(block?.type.name).toBe("codeBlock");
    expect(block?.textContent).toBe(body);
    const markdown = readMarkdown();
    expect(fromMarkdown(markdown).children).toEqual([
      expect.objectContaining({ type: "code", lang: block?.attrs.language, value: block?.textContent }),
    ]);
    const bodyStart = markdown.indexOf("\n") + 1;
    expect(getDraftIndexAtDocumentPosition(doc, 1, "markdown")).toBe(bodyStart);
    expect(getPositionAtDocumentDraftIndex(doc, bodyStart + body.length, "markdown"))
      .toBe(1 + body.length);
  });
}

it("sends typed fenced blocks as one CommonMark code block even with closing fences in the body", () => {
  const bodyFence = fc.record({
    length: fc.integer({ min: 3, max: 8 }),
    indent: fc.integer({ min: 0, max: 3 }),
    trailing: fc.constantFrom("", " ", "\t"),
  });
  fc.assert(fc.property(
    fc.integer({ min: 3, max: 8 }),
    fc.constantFrom("", "markdown", "c++"),
    fc.array(bodyFence, { minLength: 1, maxLength: 4 }),
    (fenceLength, language, fences) => {
      const lines = fences.map(({ length, indent, trailing }) =>
        `${" ".repeat(indent)}${"`".repeat(length)}${trailing}`,
      );
      checkCodeFenceRoundTrip(fenceLength, language, ["before", ...lines, "after"].join("\n"));
    },
  ), { numRuns: 25 });
});

it("sends a four-backtick block containing bare triple-backtick lines intact", () => {
  checkCodeFenceRoundTrip(4, "", "```\nexample\n```");
});

function checkLiteralTildeOpener(fenceLength: number, language: string): void {
  const opener = `${"~".repeat(fenceLength)}${language} `;
  withTypedFence(opener, (editor, readMarkdown) => {
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    const markdown = readMarkdown();
    expect(markdown).toBe(opener);
    expect(fromMarkdown(markdown).children).toEqual([
      expect.objectContaining({ type: "code", lang: language, value: "" }),
    ]);
  });
}

it("keeps tilde openers literal when a backtick in the info string prevents conversion", () => {
  fc.assert(fc.property(
    fc.integer({ min: 3, max: 8 }),
    fc.constantFrom("js`", "`ruby", "json`5"),
    checkLiteralTildeOpener,
  ), { numRuns: 25 });
});

it("keeps the typed ~~~js` opener in the emitted Markdown", () => {
  checkLiteralTildeOpener(3, "js`");
});

it("starts a code block on space for any 3+ backtick or tilde fence and leaves shorter runs as prose", () => {
  const marker = fc.constantFrom("`", "~");
  const fenceLength = fc.integer({ min: 1, max: 8 });
  const language = fc.constantFrom("", "ts", "markdown", "c++", "json5");

  fc.assert(fc.property(marker, fenceLength, language, (fenceChar, count, lang) => {
    withTypedFence(`${fenceChar.repeat(count)}${lang} `, (editor) => {
      const codeBlock = editor.view.dom.querySelector("pre code");
      if (count >= 3) {
        expect(codeBlock).not.toBeNull();
        expect(editor.state.doc.firstChild?.type.name).toBe("codeBlock");
        expect(editor.state.doc.firstChild?.attrs.language ?? "").toBe(lang);
      } else {
        expect(codeBlock).toBeNull();
        expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
      }
    });
  }), { numRuns: 30 });
});
