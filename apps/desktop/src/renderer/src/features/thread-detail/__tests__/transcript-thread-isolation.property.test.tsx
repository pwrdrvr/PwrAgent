import { render } from "@testing-library/react";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { AppServerThreadEntry } from "@pwragent/shared/contracts/normalized-app-server";
import { TranscriptList } from "../TranscriptList";

function message(id: string): AppServerThreadEntry {
  return { type: "message", id, text: id, role: "user" };
}

function usage(turnId: string, originalTurnId: string): AppServerThreadEntry {
  return {
    type: "activity",
    id: `live-turn-usage-${originalTurnId}`,
    summary: `Turn usage: ${originalTurnId}`,
    details: [],
    status: "completed",
    turn: { id: turnId, status: "completed" },
  };
}

function expectDestinationRows(
  source: AppServerThreadEntry[],
  destination: AppServerThreadEntry[],
  sourceIds?: string[],
) {
  const props = { loading: false, loadingMore: false, onLoadOlder: async () => undefined };
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const mounted = render(<TranscriptList {...props} threadId="codex:source" entries={source} />);
  const visibleIds = () => [...mounted.container.querySelectorAll("[data-entry-id]")]
    .map((row) => row.getAttribute("data-entry-id"));
  try {
    const renderedSourceIds = visibleIds();
    mounted.rerender(<TranscriptList {...props} threadId="codex:destination" entries={destination} />);
    expect(visibleIds()).toEqual(destination.map((entry) => entry.id));
    if (sourceIds) expect(renderedSourceIds).toEqual(sourceIds);
    expect(consoleError.mock.calls.filter(([message]) => String(message).includes("same key"))).toEqual([]);
  } finally {
    mounted.unmount();
    consoleError.mockRestore();
  }
}

it("removes both stale usage rows when navigating away from a transcript with colliding row IDs", () => {
  expectDestinationRows([
    message("source-prompt"),
    usage("turn-1", "turn-1"),
    usage("review-1", "turn-1"),
    usage("turn-2", "turn-2"),
    usage("review-2", "turn-2"),
  ], [message("destination-prompt")], ["source-prompt", "live-turn-usage-turn-1", "live-turn-usage-turn-2"]);
});

it("clears the previous thread's DOM even if its replay repeats a valid entry ID", () => {
  expectDestinationRows([
    message("source-prompt"),
    usage("turn-1", "turn-1"),
    usage("turn-1", "turn-1"),
  ], [message("destination-prompt")]);
});

it("renders only the destination's rows regardless of duplicate usage IDs in the source", () => {
  fc.assert(fc.property(
    fc.array(fc.boolean(), { minLength: 1, maxLength: 5 }),
    fc.integer({ min: 1, max: 4 }),
    (duplicateUsageByTurn, destinationCount) => {
      const source = [
        message("source-prompt"),
        ...duplicateUsageByTurn.flatMap((duplicate, index) => {
          const turnId = `turn-${index}`;
          return duplicate ? [usage(turnId, turnId), usage(`review-${index}`, turnId)] : [usage(turnId, turnId)];
        }),
      ];
      const destination = Array.from({ length: destinationCount }, (_, index) => message(`destination-${index}`));
      expectDestinationRows(source, destination, [
        "source-prompt",
        ...duplicateUsageByTurn.map((_duplicate, index) => `live-turn-usage-turn-${index}`),
      ]);
    },
  ), { numRuns: 25 });
});
