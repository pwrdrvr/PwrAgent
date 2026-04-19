import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ThreadMarkdown } from "../ThreadMarkdown";

describe("ThreadMarkdown", () => {
  it("renders markdown formatting and local file links", () => {
    render(
      <ThreadMarkdown
        text={"Use **bold** text and open [`ce:work`](/Users/huntharo/.codex/skills/ce-work/SKILL.md)."}
      />
    );

    expect(screen.getByText("bold", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ce:work" })).toHaveAttribute(
      "href",
      "file:///Users/huntharo/.codex/skills/ce-work/SKILL.md"
    );
  });

  it("renders skill links as chips", () => {
    render(
      <ThreadMarkdown
        skills={[
          {
            name: "frontend-design",
            description: "Design and verify renderer UI work.",
            path: "/Users/huntharo/.codex/skills/frontend-design/SKILL.md",
            enabled: true,
          },
        ]}
        text={"Load [$frontend-design](/Users/huntharo/.codex/skills/frontend-design/SKILL.md)"}
      />
    );

    expect(screen.getByText("$frontend-design")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "$frontend-design" })).not.toBeInTheDocument();
  });

  it("renders emoji, italic, strikethrough, and inline code", () => {
    render(
      <ThreadMarkdown
        text={"Calmer 😎 with *italic*, ~~struck~~, and `inline code`."}
      />
    );

    expect(screen.getByText("😎", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("italic", { selector: "em" })).toBeInTheDocument();
    expect(screen.getByText("struck", { selector: "del" })).toBeInTheDocument();
    expect(
      screen.getByText("inline code", { selector: "code.transcript-message__code" })
    ).toBeInTheDocument();
  });

  it("preserves single newlines as visible line breaks", () => {
    const { container } = render(
      <ThreadMarkdown
        text={"Still Grok 4.\nWon't change no matter how many times you test."}
      />
    );

    expect(container.querySelector("br")).not.toBeNull();
    expect(container).toHaveTextContent("Still Grok 4.");
    expect(container).toHaveTextContent("Won't change no matter how many times you test.");
  });

  it("renders html-looking transcript text literally", () => {
    const { container } = render(
      <ThreadMarkdown
        text={"Use <em>safe</em> markup and <table><tr><td>x</td></tr></table> literally."}
      />
    );

    expect(container.querySelector("em")).toBeNull();
    expect(container.querySelector("table")).toBeNull();
    expect(container.textContent).toContain("<em>safe</em>");
    expect(container.textContent).toContain("<table><tr><td>x</td></tr></table>");
  });

  it("keeps markdown-looking syntax literal inside fenced code blocks", () => {
    const { container } = render(
      <ThreadMarkdown
        skills={[
          {
            name: "frontend-design",
            description: "Design and verify renderer UI work.",
            path: "/Users/huntharo/.codex/skills/frontend-design/SKILL.md",
            enabled: true,
          },
        ]}
        text={
          "````md\n```ts\nconst marker = \"**not bold**\";\n```\n[$frontend-design](/Users/huntharo/.codex/skills/frontend-design/SKILL.md)\n![Preview](https://example.com/inside-code.png)\n````"
        }
      />
    );

    const codeBlock = container.querySelector("pre code");
    expect(codeBlock).not.toBeNull();
    expect(codeBlock?.textContent).toContain("**not bold**");
    expect(codeBlock?.textContent).toContain("[$frontend-design]");
    expect(codeBlock?.textContent).toContain("![Preview](https://example.com/inside-code.png)");
    expect(container.querySelector("pre strong")).toBeNull();
    expect(container.querySelector("pre .skill-chip")).toBeNull();
    expect(container.querySelector("pre img")).toBeNull();
  });

  it("renders markdown image syntax as literal text instead of an image", () => {
    const { container } = render(
      <ThreadMarkdown
        text={"Keep ![Transcript preview](https://example.com/preview.png) inert for now."}
      />
    );

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain(
      "![Transcript preview](https://example.com/preview.png)"
    );
  });
});
