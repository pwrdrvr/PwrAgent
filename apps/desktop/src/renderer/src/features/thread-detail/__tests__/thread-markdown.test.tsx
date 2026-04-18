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

  it("sanitizes unsafe raw html while keeping safe inline markup", () => {
    const { container } = render(
      <ThreadMarkdown
        text={'Trusted? <em>safe</em> <img src="x" onerror="alert(1)" /><script>alert("x")</script>'}
      />
    );

    expect(screen.getByText("safe", { selector: "em" })).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).not.toHaveAttribute("onerror");
  });

  it("skips raw html parsing for oversized html-like messages", () => {
    const oversizedHtml = "<em>safe</em>".repeat(2_000);
    const { container } = render(<ThreadMarkdown text={oversizedHtml} />);

    expect(container.querySelector("em")).toBeNull();
    expect(container.textContent).toContain("<em>safe</em>");
  });
});
