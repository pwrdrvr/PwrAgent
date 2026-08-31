import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerTiptapInput } from "../ComposerTiptapInput";
import type { ComposerInputHandle, ComposerSkillToken } from "../ComposerInputTypes";

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
  "We reproduced and fixed the \"Pour cereal does nothing after switching between several cereal boxes\" bug.",
  "",
  "Root cause:",
  "",
  "After selecting multiple cereal boxes, the visible editor bottom-bar `POUR CEREAL` button still had a delegate and received mouseUp, but `BreakfastEditorViewController.pourCerealButtonClicked(_:)` only handled the click when `button === pourButton`. In the cereal-switch path, the clicked button could be a different styled `CerealActionButton` instance than the controller's stored `pourButton`, so the delegate method silently fell through and did nothing.",
  "",
  "Fix:",
  "",
  "In `BreakfastEditorViewController.pourCerealButtonClicked(_:)`, handle cereal pouring by command/title as well as object identity:",
  "",
  "```swift",
  "} else if button === pourButton || button.titleText == \"POUR CEREAL\" {",
  "    pourCerealIntoBowl()",
  "}",
  "```",
  "",
  "Regression test:",
  "",
  "Add a test that:",
  "1. Creates several cereal boxes.",
  "2. Adds them to `BreakfastPantry`.",
  "3. Opens `CerealShelfWindowController`.",
  "4. Selects multiple cereal boxes in sequence, reusing the existing editor.",
  "5. Finds the visible editor `POUR CEREAL` button.",
  "6. Sends mouseDown/mouseUp to that button.",
  "7. Asserts `editor.window?.attachedSheet?.windowController` is `ServingSizeWindowController`.",
  "8. Asserts `selectedCereal` is the currently selected cereal box.",
  "",
  "Important observation:",
  "",
  "The editor Pour button should only open the serving-size sheet. It should not dispense or remove cereal from inventory. The actual cereal serving happens later from `ServingSizeWindowController.serve()` when clicking Pour inside that sheet.",
  "",
  "Related hardening from this investigation:",
  "- Add diagnostic logs for pour button mouseUp, delegate dispatch, pour path entry, blocked early returns, and serving-size sheet opening.",
  "- Make `ServingSizeWindowController.close()`/window close/Cancel/Done end the attached sheet consistently.",
  "- Clear the retained serving-size window controller when the sheet ends.",
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
  "We reproduced and fixed the \"Pour cereal does nothing after switching between several cereal boxes\" bug.",
  "",
  "Root cause:",
  "After selecting multiple cereal boxes, the visible editor bottom-bar `POUR CEREAL` button still had a delegate and received mouseUp, but `BreakfastEditorViewController.pourCerealButtonClicked(_:)` only handled the click when `button === pourButton`. In the cereal-switch path, the clicked button could be a different styled `CerealActionButton` instance than the controller's stored `pourButton`, so the delegate method silently fell through and did nothing.",
  "",
  "Fix:",
  "In `BreakfastEditorViewController.pourCerealButtonClicked(_:)`, handle cereal pouring by command/title as well as object identity:",
].join("\n");

const handoffPrefixWithCodeBlock = [
  handoffPrefixWithoutCodeBlock,
  "",
  "```swift",
  "} else if button === pourButton || button.titleText == \"POUR CEREAL\" {",
  "    pourCerealIntoBowl()",
  "}",
  "```",
].join("\n");

const canonicalHandoffPrefix = [
  "We reproduced and fixed the \"Pour cereal does nothing after switching between several cereal boxes\" bug.",
  "",
  "Root cause:",
  "",
  "After selecting multiple cereal boxes, the visible editor bottom-bar `POUR CEREAL` button still had a delegate and received mouseUp, but `BreakfastEditorViewController.pourCerealButtonClicked(_:)` only handled the click when `button === pourButton`. In the cereal-switch path, the clicked button could be a different styled `CerealActionButton` instance than the controller's stored `pourButton`, so the delegate method silently fell through and did nothing.",
  "",
  "Fix:",
  "",
  "In `BreakfastEditorViewController.pourCerealButtonClicked(_:)`, handle cereal pouring by command/title as well as object identity:",
].join("\n");

const canonicalHandoffPrefixWithCodeBlock = [
  canonicalHandoffPrefix,
  "",
  "```swift",
  "} else if button === pourButton || button.titleText == \"POUR CEREAL\" {",
  "    pourCerealIntoBowl()",
  "}",
  "```",
].join("\n");

const nestedOrderedMarkdown = [
  "1. Discord-specific fixes",
  "   1. Timestamp inbound immediately",
  "   2. Move breadcrumb lookups off the critical path",
  "   3. Add stage timings through startTurn",
  "2. Busted thread info cache",
  "   1. Resolve occupancy from cached thread state",
  "      1. Change the admission path as described",
  "   2. Keep Git enrichment out of reply admission",
  "      1. Do not wait on a 3 second full cache refresh",
].join("\n");

const pastedCatalogSql = [
  "SELECT s.item_code, m.category, aisle, SUM(units) AS _units",
  "",
  "FROM \"orcharddb\".\"catalog_sales_by_aisle\" s",
  "",
  "  LEFT JOIN catalog_item_metadata m",
  "",
  "    ON s.item_code = m.item_code",
  "",
  "WHERE aisle LIKE '%seasonal%'",
  "",
  "  AND date(day) = date '2024-08-05'",
  "",
  "GROUP BY s.item_code, aisle, m.category",
  "",
  "ORDER BY 4 DESC",
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

  it("pastes copied transcript text that nests code inside bold text", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <ComposerTiptapInput
        editorDocument={{
          type: "doc",
          content: [
            {
              type: "blockquote",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Context:" }],
                },
              ],
            },
          ],
        }}
        id="reply"
        label="Reply"
        markdownConversion
        onChange={onChange}
        placeholder="Ask anything"
        skillTokens={[]}
        value="> Context:"
      />,
    );
    const textbox = await screen.findByRole("textbox", { name: "Reply" });
    setComposerSelection(textbox, "Context:".length);

    fireEvent.paste(textbox, {
      clipboardData: {
        files: [],
        getData: (type: string) => {
          if (type === "text/html") {
            return "<p><strong>10 <code>Promise.all</code> cells</strong></p>";
          }
          return type === "text/plain" ? "10 Promise.all cells" : "";
        },
        items: [],
        types: ["text/html", "text/plain"],
      },
    });

    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith(
        [
          "> Context:",
          "> ",
          "> **10** `Promise.all` **cells**",
        ].join("\n"),
        [],
        expect.any(Object),
      );
    });
    expect(container.querySelector("code")).toHaveTextContent("Promise.all");
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
        "} else if button === pourButton || button.titleText == \"POUR CEREAL\" {",
        "    pourCerealIntoBowl()",
        "}",
      ].join("\n")
    );
    expect(codeBlock?.textContent).not.toContain("\n\n");

    const orderedItems = [...container.querySelectorAll("ol > li")];
    expect(orderedItems).toHaveLength(8);
    expect(orderedItems[0]).toHaveTextContent("Creates several cereal boxes.");
    expect(orderedItems[7]).toHaveTextContent(
      "Asserts selectedCereal is the currently selected cereal box.",
    );

    const bulletItems = [...container.querySelectorAll("ul > li")];
    expect(bulletItems).toHaveLength(3);
    expect(bulletItems[0]).toHaveTextContent(
      "Add diagnostic logs for pour button mouseUp",
    );
    const paragraphs = [...container.querySelectorAll(".composer-tiptap-input__editor > p")];
    expect(
      paragraphs.some((paragraph) =>
        paragraph.textContent?.startsWith("1. Creates several cereal boxes.")
      ),
    ).toBe(false);
  });

  it("keeps a copied rendered table as Markdown source", async () => {
    const markdown = [
      "## Quick matrix",
      "",
      "| Harness | Exe | Auth |",
      "|-|--|---|",
      "| Alpha | `alpha` | Browser sign-in |",
      "| Beta | `beta` | API key |",
    ].join("\n");
    const html = [
      "<h2>Quick matrix</h2>",
      "<table>",
      "<thead><tr><th>Harness</th><th>Exe</th><th>Auth</th></tr></thead>",
      "<tbody>",
      "<tr><td>Alpha</td><td><code>alpha</code></td><td>Browser sign-in</td></tr>",
      "<tr><td>Beta</td><td><code>beta</code></td><td>API key</td></tr>",
      "</tbody>",
      "</table>",
    ].join("");
    const { container, onChange } = renderTiptapInput();
    const textbox = await screen.findByRole("textbox", { name: "Reply" });

    fireEvent.paste(textbox, {
      clipboardData: {
        files: [],
        getData: (type: string) => {
          if (type === "text/html") {
            return html;
          }
          return type === "text/plain" ? markdown : "";
        },
        items: [],
        types: ["text/html", "text/plain"],
      },
    });

    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith(markdown, []);
    });
    expect(container.querySelector("table")).not.toBeInTheDocument();
    expect(container.querySelector(".composer-tiptap-input__editor"))
      .toHaveTextContent("|-|--|---|");
  });

  it("keeps a one-column rendered table as Markdown source", async () => {
    const markdown = [
      "| Harness |",
      "| - |",
      "| Alpha |",
    ].join("\n");
    const { container, onChange } = renderTiptapInput();
    const textbox = await screen.findByRole("textbox", { name: "Reply" });

    fireEvent.paste(textbox, {
      clipboardData: {
        files: [],
        getData: (type: string) => {
          if (type === "text/html") {
            return [
              "<table>",
              "<thead><tr><th>Harness</th></tr></thead>",
              "<tbody><tr><td>Alpha</td></tr></tbody>",
              "</table>",
            ].join("");
          }
          return type === "text/plain" ? markdown : "";
        },
        items: [],
        types: ["text/html", "text/plain"],
      },
    });

    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith(markdown, []);
    });
    expect(container.querySelector("table")).not.toBeInTheDocument();
  });

  it("does not treat a setext heading as a one-column table", async () => {
    const { container } = renderTiptapInput();
    const textbox = await screen.findByRole("textbox", { name: "Reply" });

    fireEvent.paste(textbox, {
      clipboardData: {
        files: [],
        getData: (type: string) => {
          if (type === "text/html") {
            return "<h2>Quick matrix</h2>";
          }
          return type === "text/plain" ? "Quick matrix\n-" : "";
        },
        items: [],
        types: ["text/html", "text/plain"],
      },
    });

    await waitFor(() => {
      expect(container.querySelector("h2")).toHaveTextContent("Quick matrix");
    });
  });

  it("keeps HTML-only double-blank-line SQL paste inside an active code block", async () => {
    const { container, onChange } = renderTiptapInput({ value: "```\n```" });
    const textbox = await screen.findByRole("textbox", { name: "Reply" });
    setComposerSelection(textbox, "```\n".length);

    fireEvent.paste(textbox, {
      clipboardData: {
        files: [],
        getData: (type: string) => {
          if (type === "text/html") {
            return pastedCatalogSql
              .split("\n")
              .map((line) => line ? `<div>${line}</div>` : "<div><br></div>")
              .join("");
          }
          return "";
        },
        items: [],
        types: ["text/html"],
      },
    });

    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith(
        `\`\`\`\n${pastedCatalogSql}\n\`\`\``,
        [],
      );
    });
    expect(container.querySelectorAll(".composer-tiptap-input__editor > pre"))
      .toHaveLength(1);
    expect(
      [...container.querySelectorAll(".composer-tiptap-input__editor > p")]
        .filter((paragraph) => /SELECT|FROM|WHERE|ORDER BY/.test(
          paragraph.textContent ?? "",
        )),
    )
      .toHaveLength(0);
  });

  it("keeps HTML-only double-blank-line SQL paste inside an active blockquote", async () => {
    const onChange = vi.fn();
    render(
      <ComposerTiptapInput
        editorDocument={{
          type: "doc",
          content: [
            {
              type: "blockquote",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Query:" }],
                },
              ],
            },
          ],
        }}
        id="reply"
        label="Reply"
        markdownConversion
        onChange={onChange}
        placeholder="Ask anything"
        skillTokens={[]}
        value="> Query:"
      />,
    );
    const textbox = await screen.findByRole("textbox", { name: "Reply" });
    setComposerSelection(textbox, "Query:".length);

    fireEvent.paste(textbox, {
      clipboardData: {
        files: [],
        getData: (type: string) => {
          if (type === "text/html") {
            return pastedCatalogSql
              .split("\n")
              .map((line) => line ? `<div>${line}</div>` : "<div><br></div>")
              .join("");
          }
          return "";
        },
        items: [],
        types: ["text/html"],
      },
    });

    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith(
        [
          "> Query:",
          "> ",
          ...pastedCatalogSql.split("\n").map((line) => `> ${line}`),
        ].join("\n"),
        [],
        expect.any(Object),
      );
    });
  });

  it("preserves paragraph-only rich HTML pasted inside a blockquote", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <ComposerTiptapInput
        editorDocument={{
          type: "doc",
          content: [
            {
              type: "blockquote",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Source:" }],
                },
              ],
            },
          ],
        }}
        id="reply"
        label="Reply"
        markdownConversion
        onChange={onChange}
        placeholder="Ask anything"
        skillTokens={[]}
        value="> Source:"
      />,
    );
    const textbox = await screen.findByRole("textbox", { name: "Reply" });
    setComposerSelection(textbox, "Source:".length);

    fireEvent.paste(textbox, {
      clipboardData: {
        files: [],
        getData: (type: string) => {
          if (type === "text/html") {
            return [
              "<p><strong>Note</strong></p>",
              "<p>Follow-up paragraph</p>",
            ].join("");
          }
          return type === "text/plain" ? "Note\n\nFollow-up paragraph" : "";
        },
        items: [],
        types: ["text/html", "text/plain"],
      },
    });

    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith(
        [
          "> Source:",
          "> ",
          "> **Note**",
          "> ",
          "> Follow-up paragraph",
        ].join("\n"),
        [],
        expect.any(Object),
      );
    });
    expect(container.querySelector("blockquote strong")).toHaveTextContent("Note");
    expect(container.querySelectorAll("blockquote > p")).toHaveLength(3);
  });

  it("preserves rich web-page lists when pasting inside a blockquote", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <ComposerTiptapInput
        editorDocument={{
          type: "doc",
          content: [
            {
              type: "blockquote",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Release notes:" }],
                },
              ],
            },
          ],
        }}
        id="reply"
        label="Reply"
        markdownConversion
        onChange={onChange}
        placeholder="Ask anything"
        skillTokens={[]}
        value="> Release notes:"
      />,
    );
    const textbox = await screen.findByRole("textbox", { name: "Reply" });
    setComposerSelection(textbox, "Release notes:".length);

    fireEvent.paste(textbox, {
      clipboardData: {
        files: [],
        getData: (type: string) => {
          if (type === "text/html") {
            return [
              "<ul>",
              "<li>Improved composer paste handling.</li>",
              "<li>Added Escape-key handling.</li>",
              "</ul>",
            ].join("");
          }
          if (type === "text/plain") {
            return [
              "Improved composer paste handling.",
              "Added Escape-key handling.",
            ].join("\n");
          }
          return "";
        },
        items: [],
        types: ["text/html", "text/plain"],
      },
    });

    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith(
        [
          "> Release notes:",
          "> ",
          "> - Improved composer paste handling.",
          "> - Added Escape-key handling.",
        ].join("\n"),
        [],
        expect.any(Object),
      );
    });

    const quoteListItems = [
      ...container.querySelectorAll("blockquote ul > li"),
    ];
    expect(quoteListItems).toHaveLength(2);
    expect(quoteListItems[0]).toHaveTextContent(
      "Improved composer paste handling.",
    );
    expect(quoteListItems[1]).toHaveTextContent("Added Escape-key handling.");
  });

  it("preserves text around inline marks in rich lists pasted inside a blockquote", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <ComposerTiptapInput
        editorDocument={{
          type: "doc",
          content: [
            {
              type: "blockquote",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Checklist:" }],
                },
              ],
            },
          ],
        }}
        id="reply"
        label="Reply"
        markdownConversion
        onChange={onChange}
        placeholder="Ask anything"
        skillTokens={[]}
        value="> Checklist:"
      />,
    );
    const textbox = await screen.findByRole("textbox", { name: "Reply" });
    setComposerSelection(textbox, "Checklist:".length);

    fireEvent.paste(textbox, {
      clipboardData: {
        files: [],
        getData: (type: string) => {
          if (type === "text/html") {
            return "<ul><li>Use <strong>bold</strong> text</li></ul>";
          }
          if (type === "text/plain") {
            return "Use bold text";
          }
          return "";
        },
        items: [],
        types: ["text/html", "text/plain"],
      },
    });

    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith(
        [
          "> Checklist:",
          "> ",
          "> - Use **bold** text",
        ].join("\n"),
        [],
        expect.any(Object),
      );
    });

    const quoteListItem = container.querySelector("blockquote ul > li");
    expect(quoteListItem).toHaveTextContent("Use bold text");
    expect(quoteListItem?.querySelector("strong")).toHaveTextContent("bold");
  });

  it("preserves nested rich list items pasted inside a blockquote", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <ComposerTiptapInput
        editorDocument={{
          type: "doc",
          content: [
            {
              type: "blockquote",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Tasks:" }],
                },
              ],
            },
          ],
        }}
        id="reply"
        label="Reply"
        markdownConversion
        onChange={onChange}
        placeholder="Ask anything"
        skillTokens={[]}
        value="> Tasks:"
      />,
    );
    const textbox = await screen.findByRole("textbox", { name: "Reply" });
    setComposerSelection(textbox, "Tasks:".length);

    fireEvent.paste(textbox, {
      clipboardData: {
        files: [],
        getData: (type: string) => {
          if (type === "text/html") {
            return [
              "<ul>",
              "<li>",
              "Parent task",
              "<ul><li>Nested task</li></ul>",
              "</li>",
              "</ul>",
            ].join("");
          }
          if (type === "text/plain") {
            return "Parent task\nNested task";
          }
          return "";
        },
        items: [],
        types: ["text/html", "text/plain"],
      },
    });

    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith(
        [
          "> Tasks:",
          "> ",
          "> - Parent task",
          ">   - Nested task",
        ].join("\n"),
        [],
        expect.any(Object),
      );
    });

    const parentItem = container.querySelector("blockquote > ul > li");
    const nestedItem = container.querySelector("blockquote ul ul > li");
    expect(parentItem).toHaveTextContent("Parent task");
    expect(nestedItem).toHaveTextContent("Nested task");
  });

  it("preserves prose and rich lists pasted together inside a blockquote", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <ComposerTiptapInput
        editorDocument={{
          type: "doc",
          content: [
            {
              type: "blockquote",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Source:" }],
                },
              ],
            },
          ],
        }}
        id="reply"
        label="Reply"
        markdownConversion
        onChange={onChange}
        placeholder="Ask anything"
        skillTokens={[]}
        value="> Source:"
      />,
    );
    const textbox = await screen.findByRole("textbox", { name: "Reply" });
    setComposerSelection(textbox, "Source:".length);

    fireEvent.paste(textbox, {
      clipboardData: {
        files: [],
        getData: (type: string) => {
          if (type === "text/html") {
            return [
              "<p>I’ll retry discovery now that the thread setup changed, then call the PwrAgent management tool if it’s exposed.</p>",
              "<p><strong>AssistantJun 18, 8:27 AM</strong></p>",
              "<p>No separate lazy-loaded PwrAgent app tool appeared.</p>",
              "<p><strong>AssistantJun 18, 8:28 AM</strong></p>",
              "<p>Current PwrAgent status:</p>",
              "<ul>",
              "<li>No active goal is set for this thread.</li>",
              "<li>No token budget is active.</li>",
              "<li>No completion budget report is available.</li>",
              "</ul>",
              "<p>I also retried app-tool discovery.</p>",
            ].join("");
          }
          if (type === "text/plain") {
            return [
              "I’ll retry discovery now that the thread setup changed, then call the PwrAgent management tool if it’s exposed.",
              "",
              "AssistantJun 18, 8:27 AM",
              "",
              "No separate lazy-loaded PwrAgent app tool appeared.",
              "",
              "AssistantJun 18, 8:28 AM",
              "",
              "Current PwrAgent status:",
              "",
              "No active goal is set for this thread.",
              "No token budget is active.",
              "No completion budget report is available.",
              "",
              "I also retried app-tool discovery.",
            ].join("\n");
          }
          return "";
        },
        items: [],
        types: ["text/html", "text/plain"],
      },
    });

    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith(
        [
          "> Source:",
          "> ",
          "> I’ll retry discovery now that the thread setup changed, then call the PwrAgent management tool if it’s exposed.",
          "> ",
          "> **AssistantJun 18, 8:27 AM**",
          "> ",
          "> No separate lazy-loaded PwrAgent app tool appeared.",
          "> ",
          "> **AssistantJun 18, 8:28 AM**",
          "> ",
          "> Current PwrAgent status:",
          "> ",
          "> - No active goal is set for this thread.",
          "> - No token budget is active.",
          "> - No completion budget report is available.",
          "> ",
          "> I also retried app-tool discovery.",
        ].join("\n"),
        [],
        expect.any(Object),
      );
    });

    expect(container.querySelectorAll("blockquote > p")).toHaveLength(7);
    expect(container.querySelectorAll("blockquote ul > li")).toHaveLength(3);
    expect(container.querySelector("blockquote strong")).toHaveTextContent(
      "AssistantJun 18, 8:27 AM",
    );
  });

  it("falls back to plain text for unsupported rich blocks pasted inside a blockquote", async () => {
    const onChange = vi.fn();
    render(
      <ComposerTiptapInput
        editorDocument={{
          type: "doc",
          content: [
            {
              type: "blockquote",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Table:" }],
                },
              ],
            },
          ],
        }}
        id="reply"
        label="Reply"
        markdownConversion
        onChange={onChange}
        placeholder="Ask anything"
        skillTokens={[]}
        value="> Table:"
      />,
    );
    const textbox = await screen.findByRole("textbox", { name: "Reply" });
    setComposerSelection(textbox, "Table:".length);

    fireEvent.paste(textbox, {
      clipboardData: {
        files: [],
        getData: (type: string) => {
          if (type === "text/html") {
            return "<table><tr><td>A</td><td>B</td></tr></table>";
          }
          if (type === "text/plain") {
            return "A\tB";
          }
          return "";
        },
        items: [],
        types: ["text/html", "text/plain"],
      },
    });

    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith(
        "> Table:A\tB",
        [],
        expect.any(Object),
      );
    });
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

  it("round-trips thematic breaks as markdown horizontal rules", async () => {
    const original = [
      "- One",
      "- Two",
      "---",
      "- Second List - One",
      "- Second List - Two",
    ].join("\n");
    const inputRef = createRef<ComposerInputHandle>();
    const { container } = render(
      <ComposerTiptapInput
        ref={inputRef}
        id="reply"
        label="Reply"
        markdownConversion
        onChange={() => undefined}
        placeholder="Ask anything"
        skillTokens={[]}
        value={original}
      />,
    );

    await screen.findByRole("textbox", { name: "Reply" });

    expect(container.querySelector("hr")).toBeInTheDocument();
    expect(inputRef.current?.value).toBe(
      [
        "- One",
        "- Two",
        "",
        "---",
        "",
        "- Second List - One",
        "- Second List - Two",
      ].join("\n"),
    );
  });

  it("serializes restored horizontalRule editor nodes instead of dropping them", async () => {
    const inputRef = createRef<ComposerInputHandle>();

    render(
      <ComposerTiptapInput
        ref={inputRef}
        id="reply"
        label="Reply"
        markdownConversion
        editorDocument={{
          type: "doc",
          content: [
            {
              type: "bulletList",
              content: [
                {
                  type: "listItem",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "One" }] }],
                },
              ],
            },
            { type: "horizontalRule" },
            {
              type: "bulletList",
              content: [
                {
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "Second List - One" }],
                    },
                  ],
                },
              ],
            },
          ],
        }}
        onChange={() => undefined}
        placeholder="Ask anything"
        skillTokens={[]}
        value={"- One\n\n---\n\n- Second List - One"}
      />,
    );

    await screen.findByRole("textbox", { name: "Reply" });

    expect(inputRef.current?.value).toBe("- One\n\n---\n\n- Second List - One");
  });

  it("keeps hyphen-only bullet items as list text", async () => {
    const original = ["- One", "- Two", "- --", "- Three"].join("\n");
    const inputRef = createRef<ComposerInputHandle>();
    const { container } = render(
      <ComposerTiptapInput
        ref={inputRef}
        id="reply"
        label="Reply"
        markdownConversion
        onChange={() => undefined}
        placeholder="Ask anything"
        skillTokens={[]}
        value={original}
      />,
    );

    await screen.findByRole("textbox", { name: "Reply" });

    expect(container.querySelector("hr")).toBeNull();
    expect(container.querySelectorAll("li")).toHaveLength(4);
    expect(inputRef.current?.value).toBe(original);
  });

  it("serializes every nested ordered-list sibling with indent", async () => {
    const inputRef = createRef<ComposerInputHandle>();

    render(
      <ComposerTiptapInput
        ref={inputRef}
        editorDocument={{
          type: "doc",
          content: [
            {
              type: "orderedList",
              attrs: { start: 1 },
              content: [
                {
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "Discord-specific fixes" }],
                    },
                    {
                      type: "orderedList",
                      attrs: { start: 1 },
                      content: [
                        {
                          type: "listItem",
                          content: [{
                            type: "paragraph",
                            content: [{ type: "text", text: "Timestamp inbound immediately" }],
                          }],
                        },
                        {
                          type: "listItem",
                          content: [{
                            type: "paragraph",
                            content: [{
                              type: "text",
                              text: "Move breadcrumb lookups off the critical path",
                            }],
                          }],
                        },
                        {
                          type: "listItem",
                          content: [{
                            type: "paragraph",
                            content: [{
                              type: "text",
                              text: "Add stage timings through startTurn",
                            }],
                          }],
                        },
                      ],
                    },
                  ],
                },
                {
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "Busted thread info cache" }],
                    },
                    {
                      type: "orderedList",
                      attrs: { start: 1 },
                      content: [
                        {
                          type: "listItem",
                          content: [
                            {
                              type: "paragraph",
                              content: [{
                                type: "text",
                                text: "Resolve occupancy from cached thread state",
                              }],
                            },
                            {
                              type: "orderedList",
                              attrs: { start: 1 },
                              content: [{
                                type: "listItem",
                                content: [{
                                  type: "paragraph",
                                  content: [{
                                    type: "text",
                                    text: "Change the admission path as described",
                                  }],
                                }],
                              }],
                            },
                          ],
                        },
                        {
                          type: "listItem",
                          content: [
                            {
                              type: "paragraph",
                              content: [{
                                type: "text",
                                text: "Keep Git enrichment out of reply admission",
                              }],
                            },
                            {
                              type: "orderedList",
                              attrs: { start: 1 },
                              content: [{
                                type: "listItem",
                                content: [{
                                  type: "paragraph",
                                  content: [{
                                    type: "text",
                                    text: "Do not wait on a 3 second full cache refresh",
                                  }],
                                }],
                              }],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        }}
        id="reply"
        label="Reply"
        markdownConversion
        onChange={() => undefined}
        placeholder="Ask anything"
        skillTokens={[]}
        value={nestedOrderedMarkdown}
      />,
    );

    await screen.findByRole("textbox", { name: "Reply" });

    await waitFor(() => {
      expect(inputRef.current?.value).toBe(nestedOrderedMarkdown);
    });
  });

  it("parses an indented three-level numbered list instead of flattening it", async () => {
    const inputRef = createRef<ComposerInputHandle>();
    const { container } = render(
      <ComposerTiptapInput
        ref={inputRef}
        id="reply"
        label="Reply"
        markdownConversion
        onChange={() => undefined}
        placeholder="Ask anything"
        skillTokens={[]}
        value={nestedOrderedMarkdown}
      />,
    );

    await screen.findByRole("textbox", { name: "Reply" });

    const editor = container.querySelector(".composer-tiptap-input__editor");
    expect(editor).not.toBeNull();
    await waitFor(() => {
      expect(editor?.querySelectorAll(":scope > ol")).toHaveLength(1);
      expect(editor?.querySelectorAll(":scope > ol > li")).toHaveLength(2);
      expect(editor?.querySelectorAll(":scope > ol > li:first-child > ol > li")).toHaveLength(3);
      expect(editor?.querySelectorAll(":scope > ol > li:last-child > ol > li")).toHaveLength(2);
      expect(
        editor?.querySelectorAll(":scope > ol > li:last-child > ol > li:first-child > ol > li"),
      ).toHaveLength(1);
      expect(
        editor?.querySelectorAll(":scope > ol > li:last-child > ol > li:last-child > ol > li"),
      ).toHaveLength(1);
      expect(inputRef.current?.value).toBe(nestedOrderedMarkdown);
    });
  });

  it("serializes every nested bullet sibling with indent", async () => {
    const inputRef = createRef<ComposerInputHandle>();
    const nestedBulletMarkdown = [
      "- Parent task",
      "  - Nested one",
      "  - Nested two",
      "    - Grandchild",
    ].join("\n");

    render(
      <ComposerTiptapInput
        ref={inputRef}
        editorDocument={{
          type: "doc",
          content: [
            {
              type: "bulletList",
              content: [
                {
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "Parent task" }],
                    },
                    {
                      type: "bulletList",
                      content: [
                        {
                          type: "listItem",
                          content: [{
                            type: "paragraph",
                            content: [{ type: "text", text: "Nested one" }],
                          }],
                        },
                        {
                          type: "listItem",
                          content: [
                            {
                              type: "paragraph",
                              content: [{ type: "text", text: "Nested two" }],
                            },
                            {
                              type: "bulletList",
                              content: [{
                                type: "listItem",
                                content: [{
                                  type: "paragraph",
                                  content: [{ type: "text", text: "Grandchild" }],
                                }],
                              }],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        }}
        id="reply"
        label="Reply"
        markdownConversion
        onChange={() => undefined}
        placeholder="Ask anything"
        skillTokens={[]}
        value={nestedBulletMarkdown}
      />,
    );

    await screen.findByRole("textbox", { name: "Reply" });

    await waitFor(() => {
      expect(inputRef.current?.value).toBe(nestedBulletMarkdown);
    });
  });

  it("serializes marked trailing spaces outside delimiters before plain text", async () => {
    const boldText = "Allow detaching the only attached project - ";
    const plainText =
      "Wait... No.. we don't want to allow detaching the only directory.";
    const inputRef = createRef<ComposerInputHandle>();

    render(
      <ComposerTiptapInput
        ref={inputRef}
        id="reply"
        label="Reply"
        markdownConversion
        editorDocument={{
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: boldText,
                  marks: [{ type: "bold" }],
                },
                {
                  type: "text",
                  text: plainText,
                },
              ],
            },
          ],
        }}
        onChange={() => undefined}
        placeholder="Ask anything"
        skillTokens={[]}
        value={`${boldText}${plainText}`}
      />,
    );

    await screen.findByRole("textbox", { name: "Reply" });

    expect(inputRef.current?.value).toBe(
      `**Allow detaching the only attached project -** ${plainText}`,
    );
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
