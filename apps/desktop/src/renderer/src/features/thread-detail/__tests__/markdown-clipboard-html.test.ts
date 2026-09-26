import { describe, expect, it } from "vitest";
import { renderMarkdownToClipboardHtml } from "../markdown-clipboard-html";

describe("renderMarkdownToClipboardHtml", () => {
  it("keeps single tildes literal while copying intentional strikethrough", () => {
    const html = renderMarkdownToClipboardHtml(
      "Bench results ~/github: fixed4~3.49-4.15 CPU7-8;16~3.06-3.59. ~literal~ and ~~deleted~~ and `~~code~~`.",
    );

    expect(html).toContain("Bench results ~/github: fixed4~3.49-4.15 CPU7-8;16~3.06-3.59. ~literal~");
    expect(html).toContain("<del>deleted</del>");
    expect(html).toContain("<code>~~code~~</code>");
    expect((html.match(/<del>/g) ?? []).length).toBe(1);
  });

  it("renders inline emphasis and headings as semantic HTML", () => {
    const html = renderMarkdownToClipboardHtml(
      "## Native support\n\nYes — but **not via** a second `official` path."
    );

    expect(html).toContain("<h2>Native support</h2>");
    expect(html).toContain("<strong>not via</strong>");
    expect(html).toContain("<code>official</code>");
    expect(html).not.toContain("**");
  });

  it("renders GFM tables and fenced code blocks", () => {
    const html = renderMarkdownToClipboardHtml(
      [
        "| Name | Value |",
        "| --- | --- |",
        "| alpha | 1 |",
        "",
        "```ts",
        "const answer = 42;",
        "```",
      ].join("\n")
    );

    expect(html).toContain("<table>");
    expect(html).toContain("<th>Name</th>");
    expect(html).toContain("<td>alpha</td>");
    expect(html).toContain("<pre>");
    expect(html).toContain("const answer = 42;");
  });

  it("keeps list structure for nested bullets", () => {
    const html = renderMarkdownToClipboardHtml(
      "- top level\n  - nested item\n- second"
    );

    expect(html).toContain("<ul>");
    expect(html).toContain("<li>second</li>");
    expect((html.match(/<ul>/g) ?? []).length).toBe(2);
  });
});
