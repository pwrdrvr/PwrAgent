import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerTiptapInput } from "../ComposerTiptapInput";
import type { ComposerSkillToken } from "../ComposerRichInput";

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

describe("ComposerTiptapInput", () => {
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
});
