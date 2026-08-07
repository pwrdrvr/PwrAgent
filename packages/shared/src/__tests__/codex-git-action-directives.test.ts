import { describe, expect, it } from "vitest";
import { stripCodexGitActionDirectives } from "../codex-git-action-directives";

describe("stripCodexGitActionDirectives", () => {
  it("removes every Codex Desktop git action directive", () => {
    expect(stripCodexGitActionDirectives(`Finished the work.

::git-stage{cwd="/workspace"}
::git-commit{cwd="/workspace"}
::git-create-branch{cwd="/workspace" branch="agent/fix"}
::git-push{cwd="/workspace" branch="agent/fix"}
::git-create-pr{cwd="/workspace" branch="agent/fix" url="https://github.com/acme/repo/pull/1" isDraft=true}`))
      .toBe("Finished the work.");
  });

  it("removes directives between visible paragraphs without leaving extra whitespace", () => {
    expect(stripCodexGitActionDirectives(`Before.

::git-commit{cwd="/workspace"}

After.`)).toBe(`Before.

After.`);
  });

  it("hides an incomplete trailing directive during streaming", () => {
    expect(stripCodexGitActionDirectives(`Finished.

::git-push{cwd="/work`)).toBe("Finished.");
  });

  it("preserves directive examples inside fenced and indented code", () => {
    const markdown = `These are literal examples:

\`\`\`text
::git-stage{cwd="/workspace"}
\`\`\`

    ::git-commit{cwd="/workspace"}`;

    expect(stripCodexGitActionDirectives(markdown)).toBe(markdown);
  });

  it("leaves unrelated double-colon syntax untouched", () => {
    const text = "Rust uses `std::io`, and ::custom{value=1} is ordinary text.";
    expect(stripCodexGitActionDirectives(text)).toBe(text);
  });
});
