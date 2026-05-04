import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

  it("opens local file links in the configured editor", async () => {
    const openApplication = vi.fn(async () => ({ opened: true as const }));

    render(
      <ThreadMarkdown
        applications={{
          editors: [
            {
              id: "vscode",
              kind: "editor",
              name: "VS Code",
              source: "application",
              appPath: "/Applications/Visual Studio Code.app",
              canOpenWorkspace: true,
            },
            {
              id: "zed",
              kind: "editor",
              name: "Zed",
              source: "application",
              appPath: "/Applications/Zed.app",
              canOpenWorkspace: true,
            },
          ],
          terminals: [],
          preferredEditorId: { value: "zed", source: "config" },
          preferredTerminalId: { value: "", source: "default" },
        }}
        desktopApi={{ openApplication }}
        text={"I updated [AGENTS.md](/repo/PwrAgent/AGENTS.md:17)."}
      />
    );

    fireEvent.click(screen.getByRole("link", { name: "AGENTS.md" }));

    await waitFor(() => {
      expect(openApplication).toHaveBeenCalledWith({
        applicationId: "zed",
        kind: "editor",
        targetPath: "/repo/PwrAgent/AGENTS.md",
      });
    });
  });

  it("keeps bare repo paths and domain-like markdown filenames as plain text", () => {
    const { container } = render(
      <ThreadMarkdown
        text={
          "Open docs/plans/2026-05-02-001-feat-messaging-tool-update-verbosity-plan.md then notes.md and www.example.com."
        }
      />
    );

    expect(container).toHaveTextContent(
      "docs/plans/2026-05-02-001-feat-messaging-tool-update-verbosity-plan.md"
    );
    expect(container).toHaveTextContent("notes.md");
    expect(container).toHaveTextContent("www.example.com");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("keeps explicit safe links clickable and rejects unsafe protocols", () => {
    render(
      <ThreadMarkdown
        text={
          "[Docs](https://example.com/docs) [Local](http://localhost:5173/status) [Plain HTTP](http://example.com) [Bad](javascript:alert(1))"
        }
      />
    );

    expect(screen.getByRole("link", { name: "Docs" })).toHaveAttribute(
      "href",
      "https://example.com/docs"
    );
    expect(screen.getByRole("link", { name: "Local" })).toHaveAttribute(
      "href",
      "http://localhost:5173/status"
    );
    expect(screen.queryByRole("link", { name: "Plain HTTP" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Bad" })).not.toBeInTheDocument();
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
        text={"Still Grok 4.\nWon't change no matter how many times you test.\nBuilt by xAI."}
      />
    );

    expect(container.querySelectorAll("br")).toHaveLength(2);
    expect(container).toHaveTextContent("Still Grok 4.");
    expect(container).toHaveTextContent("Built by xAI.");
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

  it("skips raw html parsing for oversized html-like messages", () => {
    const oversizedHtml = "<em>safe</em>".repeat(2_000);
    const { container } = render(<ThreadMarkdown text={oversizedHtml} />);

    expect(container.querySelector("em")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<em>safe</em>");
  });
});
