import fc from "fast-check";
import { expect, it } from "vitest";
import type { AppServerThreadMessageEntry } from "@pwragent/shared/contracts/normalized-app-server";
import { codexBrowserCompletionActivity, isPendingCodexBrowserCompletion } from "../codex-browser-completion";

function commentary(text: string): AppServerThreadMessageEntry {
  return { type: "message", id: "browser-completion", role: "assistant", phase: "commentary", text };
}

function directive(title: string): string {
  return `::browser-complete{title=${JSON.stringify(title)}}`;
}

const titleVariants = fc.string({ maxLength: 24, unit: fc.constantFrom("a", " ", '"', "\\", "<", ">") })
  .map((suffix) => `Verified preview${suffix}`.trimEnd());

it("parses generated headlines without mounting a transcript", () => {
  fc.assert(fc.property(titleVariants, (title) => {
    expect(codexBrowserCompletionActivity(commentary(directive(title)), "codex"))
      .toMatchObject({ id: "browser-completion", summary: title });
  }));
});

it("buffers every nonempty directive prefix after leading whitespace", () => {
  fc.assert(fc.property(titleVariants, fc.constantFrom("\n", "\r\n  ", "  "), (title, leading) => {
    const marker = directive(title);
    for (let length = 1; length <= marker.length; length += 1) {
      expect(isPendingCodexBrowserCompletion(commentary(leading + marker.slice(0, length)), "codex"))
        .toBe(true);
    }
  }));
});

it("releases commentary once a closed title is followed by anything other than a brace", () => {
  fc.assert(fc.property(titleVariants, fc.constantFrom("x", " needs a closing brace", "\t}", "\n}"), (title, suffix) => {
    const text = directive(title).slice(0, -1) + suffix;
    expect(isPendingCodexBrowserCompletion(commentary(text), "codex")).toBe(false);
  }));
});

it("buffers the marker after a leading blank line", () => {
  expect(isPendingCodexBrowserCompletion(commentary('\n::browser-complete{title="Verified'), "codex")).toBe(true);
});

it("streams a character immediately after the closing quote when the brace is missing", () => {
  expect(isPendingCodexBrowserCompletion(commentary('::browser-complete{title="Verified preview"x'), "codex")).toBe(false);
});

const marker = directive("Verified preview");
it.each([
  { name: "a user message", message: { ...commentary(marker), role: "user" as const }, backend: "codex" as const },
  { name: "a final reply", message: { ...commentary(marker), phase: "final" as const }, backend: "codex" as const },
  { name: "another backend", message: commentary(marker), backend: "claude" as const },
  { name: "a fenced example", message: commentary("```\n" + marker + "\n```"), backend: "codex" as const },
  { name: "a message with prose", message: commentary(marker + "\n\nStill checking."), backend: "codex" as const },
  { name: "an incomplete marker", message: commentary('::browser-complete{title="Verified'), backend: "codex" as const },
])("keeps $name as text on completion", ({ message, backend }) => {
  expect(codexBrowserCompletionActivity(message, backend)).toBeUndefined();
});
