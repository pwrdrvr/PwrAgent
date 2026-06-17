import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerTiptapInput } from "../ComposerTiptapInput";
import type { ComposerSkillToken } from "../ComposerInputTypes";

afterEach(() => {
  cleanup();
});

function renderTiptapInput(props?: {
  markdownConversion?: boolean;
  value?: string;
}) {
  const onChange = vi.fn();

  function Wrapper() {
    const [value, setValue] = useState(props?.value ?? "");
    const [skillTokens, setSkillTokens] = useState<ComposerSkillToken[]>([]);

    return (
      <ComposerTiptapInput
        id="reply"
        label="Reply"
        markdownConversion={props?.markdownConversion ?? true}
        onChange={(nextValue, nextSkillTokens = []) => {
          onChange(nextValue, nextSkillTokens);
          setValue(nextValue);
          setSkillTokens(nextSkillTokens);
        }}
        placeholder="Ask anything"
        skillTokens={skillTokens}
        value={value}
      />
    );
  }

  const result = render(<Wrapper />);
  return { ...result, onChange };
}

function setComposerSelection(textbox: HTMLElement, index: number): void {
  (
    textbox as HTMLElement & {
      setSelectionRange: (start: number, end?: number) => void;
    }
  ).setSelectionRange(index);
}

const copiedHandoffText = [
  "We reproduced and fixed the \"Upload to GIPHY does nothing after clicking through several reel videos\" bug.",
  "",
  "Root cause:",
  "",
  "After selecting multiple reel items, the visible editor bottom-bar `UPLOAD TO GIPHY` button still had a delegate and received mouseUp, but `GGEditorOptionsViewController.giphyButtonClicked(_:)` only handled the click when `button === uploadButton`. In the reel-switch path, the clicked button could be a different styled `GGGIPHYButton` instance than the controller's stored `uploadButton`, so the delegate method silently fell through and did nothing.",
  "",
  "Fix:",
  "",
  "In `GGEditorOptionsViewController.giphyButtonClicked(_:)`, handle upload by command/title as well as object identity:",
  "",
  "```swift",
  "} else if button === uploadButton || button.titleText == \"UPLOAD TO GIPHY\" {",
  "    uploadButtonClicked()",
  "}",
  "```",
  "",
  "Regression test:",
  "",
  "Add a test that:",
  "1. Creates several ready recordings.",
  "2. Adds them to `GGDataStore`.",
  "3. Opens `GGGIFCollectionWindowController`.",
  "4. Selects multiple reel items in sequence, reusing the existing editor.",
  "5. Finds the visible editor `UPLOAD TO GIPHY` button.",
  "6. Sends mouseDown/mouseUp to that button.",
  "7. Asserts `editor.window?.attachedSheet?.windowController` is `GGUploadWindowController`.",
  "8. Asserts `representedRecording` is the currently selected recording.",
  "",
  "Important observation:",
  "",
  "The editor Upload button should only open the metadata upload sheet. It should not render or POST the GIF. The actual network upload happens later from `GGUploadWindowController.doUpload()` when clicking Upload inside that sheet.",
  "",
  "Related hardening from this investigation:",
  "- Add diagnostic logs for upload button mouseUp, delegate dispatch, upload path entry, blocked early returns, and upload sheet opening.",
  "- Make `GGUploadWindowController.close()`/window close/Cancel/Done end the attached sheet consistently.",
  "- Clear the retained upload window controller when the sheet ends.",
  "",
].join("\n");

const canonicalCopiedHandoffText = copiedHandoffText
  .replace("Add a test that:\n1. Creates", "Add a test that:\n\n1. Creates")
  .replace(
    "Related hardening from this investigation:\n- Add",
    "Related hardening from this investigation:\n\n- Add",
  )
  .trimEnd();

const handoffPrefixWithoutCodeBlock = [
  "We reproduced and fixed the \"Upload to GIPHY does nothing after clicking through several reel videos\" bug.",
  "",
  "Root cause:",
  "After selecting multiple reel items, the visible editor bottom-bar `UPLOAD TO GIPHY` button still had a delegate and received mouseUp, but `GGEditorOptionsViewController.giphyButtonClicked(_:)` only handled the click when `button === uploadButton`. In the reel-switch path, the clicked button could be a different styled `GGGIPHYButton` instance than the controller's stored `uploadButton`, so the delegate method silently fell through and did nothing.",
  "",
  "Fix:",
  "In `GGEditorOptionsViewController.giphyButtonClicked(_:)`, handle upload by command/title as well as object identity:",
].join("\n");

const handoffPrefixWithCodeBlock = [
  handoffPrefixWithoutCodeBlock,
  "",
  "```swift",
  "} else if button === uploadButton || button.titleText == \"UPLOAD TO GIPHY\" {",
  "    uploadButtonClicked()",
  "}",
  "```",
].join("\n");

const canonicalHandoffPrefix = [
  "We reproduced and fixed the \"Upload to GIPHY does nothing after clicking through several reel videos\" bug.",
  "",
  "Root cause:",
  "",
  "After selecting multiple reel items, the visible editor bottom-bar `UPLOAD TO GIPHY` button still had a delegate and received mouseUp, but `GGEditorOptionsViewController.giphyButtonClicked(_:)` only handled the click when `button === uploadButton`. In the reel-switch path, the clicked button could be a different styled `GGGIPHYButton` instance than the controller's stored `uploadButton`, so the delegate method silently fell through and did nothing.",
  "",
  "Fix:",
  "",
  "In `GGEditorOptionsViewController.giphyButtonClicked(_:)`, handle upload by command/title as well as object identity:",
].join("\n");

const canonicalHandoffPrefixWithCodeBlock = [
  canonicalHandoffPrefix,
  "",
  "```swift",
  "} else if button === uploadButton || button.titleText == \"UPLOAD TO GIPHY\" {",
  "    uploadButtonClicked()",
  "}",
  "```",
].join("\n");

describe("ComposerTiptapInput", () => {
  it("keeps Alt+Enter inside the editor instead of routing it to the composer", async () => {
    const onKeyDown = vi.fn();
    render(
      <ComposerTiptapInput
        id="reply"
        label="Reply"
        markdownConversion
        onChange={() => undefined}
        onKeyDown={onKeyDown}
        placeholder="Ask anything"
        skillTokens={[]}
        value="- Some item\n- Second item"
      />
    );

    const textbox = await screen.findByRole("textbox", { name: "Reply" });
    fireEvent.keyDown(textbox, { key: "Enter", altKey: true });

    expect(onKeyDown).not.toHaveBeenCalled();
  });

  it("does not render initial URLs or path-like markdown filenames as links", async () => {
    const { container } = renderTiptapInput({
      value:
        "Use docs/plans/2026-05-02-001-feat-messaging-tool-update-verbosity-plan.md and https://example.com.",
    });

    await screen.findByRole("textbox", { name: "Reply" });

    expect(container.querySelector("a")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        /docs\/plans\/2026-05-02-001-feat-messaging-tool-update-verbosity-plan\.md/
      )
    ).toBeInTheDocument();
    expect(screen.getByText(/https:\/\/example\.com/)).toBeInTheDocument();
  });

  it("pastes HTML anchors into the markdown composer as text instead of link marks", async () => {
    const { container, onChange } = renderTiptapInput();
    const textbox = await screen.findByRole("textbox", { name: "Reply" });

    fireEvent.paste(textbox, {
      clipboardData: {
        files: [],
        getData: (type: string) => {
          if (type === "text/html") {
            return [
              "<p>",
              '<a href="https://example.com/docs">',
              "docs/plans/2026-05-02-001-feat-messaging-tool-update-verbosity-plan.md",
              "</a>",
              "</p>",
            ].join("");
          }
          if (type === "text/plain") {
            return "docs/plans/2026-05-02-001-feat-messaging-tool-update-verbosity-plan.md";
          }
          return "";
        },
        items: [],
        types: ["text/html", "text/plain"],
      },
    });

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(
        "docs/plans/2026-05-02-001-feat-messaging-tool-update-verbosity-plan.md",
        []
      );
    });
    expect(container.querySelector("a")).not.toBeInTheDocument();
  });

  it("pastes copied handoff markdown as fences and lists without extra blank lines", async () => {
    const { container, onChange } = renderTiptapInput();
    const textbox = await screen.findByRole("textbox", { name: "Reply" });

    fireEvent.paste(textbox, {
      clipboardData: {
        files: [],
        getData: (type: string) => type === "text/plain" ? copiedHandoffText : "",
        items: [],
        types: ["text/plain"],
      },
    });

    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith(canonicalCopiedHandoffText, []);
    });

    const codeBlock = container.querySelector("pre code");
    expect(codeBlock?.textContent).toBe(
      [
        "} else if button === uploadButton || button.titleText == \"UPLOAD TO GIPHY\" {",
        "    uploadButtonClicked()",
        "}",
      ].join("\n")
    );
    expect(codeBlock?.textContent).not.toContain("\n\n");

    const orderedItems = [...container.querySelectorAll("ol > li")];
    expect(orderedItems).toHaveLength(8);
    expect(orderedItems[0]).toHaveTextContent("Creates several ready recordings.");
    expect(orderedItems[7]).toHaveTextContent(
      "Asserts representedRecording is the currently selected recording.",
    );

    const bulletItems = [...container.querySelectorAll("ul > li")];
    expect(bulletItems).toHaveLength(3);
    expect(bulletItems[0]).toHaveTextContent(
      "Add diagnostic logs for upload button mouseUp",
    );
    const paragraphs = [...container.querySelectorAll(".composer-tiptap-input__editor > p")];
    expect(
      paragraphs.some((paragraph) =>
        paragraph.textContent?.startsWith("1. Creates several ready recordings.")
      ),
    ).toBe(false);
  });

  it("preserves paragraph separators when pasting a handoff prefix without a code block", async () => {
    const { onChange } = renderTiptapInput();
    const textbox = await screen.findByRole("textbox", { name: "Reply" });

    fireEvent.paste(textbox, {
      clipboardData: {
        files: [],
        getData: (type: string) =>
          type === "text/plain" ? handoffPrefixWithoutCodeBlock : "",
        items: [],
        types: ["text/plain"],
      },
    });

    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith(canonicalHandoffPrefix, []);
    });
  });

  it("preserves paragraph separators when pasting a handoff prefix with a code block", async () => {
    const { onChange } = renderTiptapInput();
    const textbox = await screen.findByRole("textbox", { name: "Reply" });

    fireEvent.paste(textbox, {
      clipboardData: {
        files: [],
        getData: (type: string) =>
          type === "text/plain" ? handoffPrefixWithCodeBlock : "",
        items: [],
        types: ["text/plain"],
      },
    });

    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith(canonicalHandoffPrefixWithCodeBlock, []);
    });
  });

  it("renders multi-paragraph markdown without phantom empty paragraphs", async () => {
    const original =
      "Hi Mom! New Thread Launchpad\n\n`abc123` is probably the best ID I can come up with";
    const { container } = renderTiptapInput({ value: original });

    await screen.findByRole("textbox", { name: "Reply" });

    // The blank line between the two text blocks is a markdown
    // paragraph SEPARATOR, not its own empty <p>. If we created an empty
    // paragraph node for it, every round trip would double-space the doc
    // (1 → 3 → 7 blank lines after each reopen).
    const paragraphs = container.querySelectorAll(".composer-tiptap-input__editor > p");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]?.textContent).toContain("Hi Mom!");
    expect(paragraphs[1]?.textContent).toContain("abc123");
  });

  it("preserves inline marks on markdown round trip", async () => {
    const original =
      "Look at **this bold word** and *this italic* and `inline code`.";
    const { container } = renderTiptapInput({ value: original });

    await screen.findByRole("textbox", { name: "Reply" });

    expect(container.querySelector("strong")).toHaveTextContent("this bold word");
    expect(container.querySelector("em")).toHaveTextContent("this italic");
    expect(container.querySelector("code")).toHaveTextContent("inline code");
  });

  it("pressing ArrowRight at the end of a bold run exits the mark with a plain space", async () => {
    const original = "**GitHub PR title**";
    const { container, onChange } = renderTiptapInput({ value: original });
    const textbox = await screen.findByRole("textbox", { name: "Reply" });

    setComposerSelection(textbox, original.length);
    fireEvent.keyDown(textbox, { key: "ArrowRight" });

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(`${original} `, []);
    });
    expect(container.querySelector("strong")).toHaveTextContent("GitHub PR title");
    expect(container.querySelector("strong")).not.toHaveTextContent(
      "GitHub PR title ",
    );
  });

  it("pressing ArrowRight after a pasted path-like token inserts an escape space", async () => {
    const path =
      "docs/brainstorms/2026-05-22-messaging-full-access-approval-requirements.md";
    const { onChange } = renderTiptapInput({ value: path });
    const textbox = await screen.findByRole("textbox", { name: "Reply" });

    setComposerSelection(textbox, path.length);
    fireEvent.keyDown(textbox, { key: "ArrowRight" });

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(`${path} `, []);
    });
  });

  it("does not turn ArrowRight at the end of normal prose into a space", async () => {
    const value = "plain prose";
    const { onChange } = renderTiptapInput({ value });
    const textbox = await screen.findByRole("textbox", { name: "Reply" });

    setComposerSelection(textbox, value.length);
    fireEvent.keyDown(textbox, { key: "ArrowRight" });

    expect(onChange).not.toHaveBeenCalledWith(`${value} `, []);
  });

  it("does not insert an escape space inside code blocks ending in paths", async () => {
    const codeContent = "docs/brainstorms/example.md";
    const value = `\`\`\`md\n${codeContent}\n\`\`\``;
    const { container, onChange } = renderTiptapInput({ value });
    const textbox = await screen.findByRole("textbox", { name: "Reply" });

    setComposerSelection(textbox, "```md\n".length + codeContent.length);
    fireEvent.keyDown(textbox, { key: "ArrowRight" });

    expect(onChange).not.toHaveBeenCalledWith(`\`\`\`md\n${codeContent} \n\`\`\``, []);
    expect(container.querySelector("pre code")).toHaveTextContent(codeContent);
    expect(container.querySelector("pre code")).not.toHaveTextContent(
      `${codeContent} `,
    );
  });

  it("pressing ArrowUp at the start of an initial code block creates a paragraph above it", async () => {
    const value = "```ts\nconst answer = 42;\n```";
    const { container, onChange } = renderTiptapInput({ value });
    const textbox = await screen.findByRole("textbox", { name: "Reply" });

    setComposerSelection(textbox, 0);
    fireEvent.keyDown(textbox, { key: "ArrowUp" });

    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith(`\n\n${value}`, []);
    });
    const editorChildren = [
      ...(container.querySelector(".composer-tiptap-input__editor")?.children ?? []),
    ];
    expect(editorChildren[0]?.tagName).toBe("P");
    expect(editorChildren[1]?.tagName).toBe("PRE");
  });

  it("pressing ArrowLeft at the start of an initial code block creates a paragraph above it", async () => {
    const value = "```ts\nconst answer = 42;\n```";
    const { container, onChange } = renderTiptapInput({ value });
    const textbox = await screen.findByRole("textbox", { name: "Reply" });

    setComposerSelection(textbox, 0);
    fireEvent.keyDown(textbox, { key: "ArrowLeft" });

    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith(`\n\n${value}`, []);
    });
    const editorChildren = [
      ...(container.querySelector(".composer-tiptap-input__editor")?.children ?? []),
    ];
    expect(editorChildren[0]?.tagName).toBe("P");
    expect(editorChildren[1]?.tagName).toBe("PRE");
  });

  // The `is-empty` class on `.composer-tiptap-input` is the contract
  // hook for empty-state styling — currently used for the placeholder
  // appearance, but reserved for any future CSS that distinguishes
  // "no content yet" from "user is typing". The class flips off as
  // soon as either text content OR a skill chip lands in the
  // composer; both code paths are tested here so a future refactor
  // of the conditional in `ComposerTiptapInput.tsx` doesn't silently
  // break the contract.
  describe("is-empty class contract", () => {
    it("applies is-empty when value is empty and no skill tokens are present", async () => {
      const { container } = renderTiptapInput({ value: "" });
      await screen.findByRole("textbox", { name: "Reply" });

      const wrapper = container.querySelector(".composer-tiptap-input");
      expect(wrapper).toHaveClass("is-empty");
    });

    it("removes is-empty as soon as the user types content", async () => {
      const { container } = renderTiptapInput({ value: "hello" });
      await screen.findByRole("textbox", { name: "Reply" });

      const wrapper = container.querySelector(".composer-tiptap-input");
      expect(wrapper).not.toHaveClass("is-empty");
    });

    it("removes is-empty when only skill tokens are present (no text)", () => {
      // Render the underlying component directly so we can supply
      // skillTokens without the wrapping default state. Mirrors the
      // wrapper used by the other tests but holds skill tokens
      // immutable rather than tracking onChange.
      const skillTokens = [
        {
          id: "skill-1",
          index: 0,
          name: "ce:plan",
          description: "Plan a thread",
          source: "user" as const,
          path: "/skills/ce-plan.md",
        },
      ];
      const { container } = render(
        <ComposerTiptapInput
          id="reply"
          label="Reply"
          markdownConversion
          onChange={() => undefined}
          placeholder="Ask anything"
          skillTokens={skillTokens}
          value=""
        />,
      );

      const wrapper = container.querySelector(".composer-tiptap-input");
      expect(wrapper).not.toHaveClass("is-empty");
    });
  });
});
