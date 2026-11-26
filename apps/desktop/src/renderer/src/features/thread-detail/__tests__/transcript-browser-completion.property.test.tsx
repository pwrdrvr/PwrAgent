import "@testing-library/jest-dom/vitest";
import { fireEvent, render, within } from "@testing-library/react";
import fc from "fast-check";
import { expect, it } from "vitest";
import type { AppServerThreadMessageEntry } from "@pwragent/shared/contracts/normalized-app-server";
import { TranscriptList } from "../TranscriptList";

function completion(text: string): AppServerThreadMessageEntry {
  return {
    type: "message",
    id: "browser-completion",
    role: "assistant",
    phase: "commentary",
    text,
    turn: { id: "browser-turn", status: "in_progress" },
  };
}

const listProps = { loading: false, loadingMore: false, onLoadOlder: async () => undefined };

it("shows the headline of each Codex browser completion as activity at the original message ID", () => {
  fc.assert(fc.property(fc.string({ maxLength: 24, unit: fc.constantFrom("a", " ", '"', "\\", "<", ">") }), (suffix) => {
    const title = `Verified preview${suffix}`.trimEnd();
    const marker = `::browser-complete{title=${JSON.stringify(title)}}`;
    const view = render(
      <TranscriptList {...listProps} activeTurnId="browser-turn"
        entries={[completion(marker)]} parentThreadBackend="codex" />,
    );
    try {
      const row = within(view.getByRole("listitem"));
      expect(row.getByText(title, { exact: true, normalizer: (text) => text }))
        .toHaveClass("transcript-activity__label");
      expect(row.queryByText(marker)).toBeNull();
      expect(view.getByRole("listitem")).toHaveAttribute("data-entry-id", "browser-completion");
    } finally {
      view.unmount();
    }
  }), { numRuns: 5 });
});

it("shows the completed browser headline without flashing streamed directive syntax", () => {
  const marker = '::browser-complete{title="Checked the preview"}';
  const view = render(
    <TranscriptList {...listProps} activeTurnId="browser-turn" entries={[]} parentThreadBackend="codex"
      pendingAssistantMessage={completion('::browser-complete{title="Checked')} />,
  );
  try {
    expect(view.queryByText(/::browser-complete/)).toBeNull();
    view.rerender(
      <TranscriptList {...listProps} entries={[{
        ...completion(marker),
        turn: { id: "browser-turn", status: "completed" },
      }]} parentThreadBackend="codex" />,
    );
    fireEvent.click(view.getByRole("button", { name: "1 previous message" }));
    expect(view.getByText("Checked the preview")).toHaveClass("transcript-activity__label");
    expect(view.queryByText(marker)).toBeNull();
  } finally {
    view.unmount();
  }
});

const literalMarker = '::browser-complete{title="Checked the preview"}';

it.each([
  { name: "a user message", message: { ...completion(literalMarker), role: "user" as const }, backend: "codex" as const },
  { name: "a final reply", message: { ...completion(literalMarker), phase: "final" as const }, backend: "codex" as const },
  { name: "another backend", message: completion(literalMarker), backend: "claude" as const },
  { name: "a fenced example", message: completion("```\n" + literalMarker + "\n```"), backend: "codex" as const },
  { name: "a message with prose", message: completion(literalMarker + "\n\nStill checking."), backend: "codex" as const },
  { name: "an incomplete marker", message: completion('::browser-complete{title="Checked'), backend: "codex" as const },
])("keeps directive-like text in $name", ({ message, backend }) => {
  const view = render(
    <TranscriptList {...listProps} activeTurnId="browser-turn"
      entries={[message]} parentThreadBackend={backend} />,
  );
  try {
    expect(view.getByRole("listitem")).toHaveTextContent("::browser-complete");
    expect(view.container.querySelector(".transcript-activity")).toBeNull();
  } finally {
    view.unmount();
  }
});
