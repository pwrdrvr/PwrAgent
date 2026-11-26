import fc from "fast-check";
import { expect, it } from "vitest";
import type {
  AppServerThreadActivityEntry,
  AppServerThreadBrowserUseDetail,
  AppServerThreadEntry,
  AppServerThreadMessageEntry,
} from "@pwragent/shared/contracts/normalized-app-server";
import {
  codexBrowserCompletionActivity,
  isPendingCodexBrowserCompletion,
  projectCodexBrowserUseEntries,
} from "../codex-browser-completion";

function commentary(text: string, id = "browser-completion", turnId = "turn-1"): AppServerThreadMessageEntry {
  return {
    type: "message",
    id,
    role: "assistant",
    phase: "commentary",
    text,
    turn: { id: turnId, status: "completed" },
  };
}

function directive(title: string): string {
  return `::browser-complete{title=${JSON.stringify(title)}}`;
}

function browserActivity(
  id: string,
  turnId: string,
  browserUse: AppServerThreadBrowserUseDetail,
  overrides: Partial<AppServerThreadActivityEntry> = {},
): AppServerThreadActivityEntry {
  return {
    type: "activity",
    id,
    summary: "Browsed localhost:3000",
    status: "completed",
    turn: { id: turnId, status: "completed" },
    details: [
      {
        id: `${id}-call`,
        kind: "command",
        label: "In-app browser · localhost:3000",
        status: "completed",
        browserUse,
      },
    ],
    ...overrides,
  };
}

const titleVariants = fc.string({ maxLength: 24, unit: fc.constantFrom("a", " ", '"', "\\", "<", ">") })
  .map((suffix) => `Verified preview${suffix}`.trimEnd());

it("parses generated headlines without mounting a transcript", () => {
  fc.assert(fc.property(titleVariants, (title) => {
    expect(codexBrowserCompletionActivity(commentary(directive(title)), "codex"))
      .toMatchObject({ id: "browser-completion", summary: title, browserUse: { standalone: true, title } });
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

it("preserves original item order for all surviving entries across arbitrary turns", () => {
  type EventKind =
    | "user"
    | "browser-iab"
    | "browser-ambiguous"
    | "shell"
    | "commentary"
    | "marker"
    | "final";
  const eventArb = fc.array(
    fc.record({
      kind: fc.constantFrom<EventKind>(
        "user",
        "browser-iab",
        "browser-ambiguous",
        "shell",
        "commentary",
        "marker",
        "final",
      ),
      turnIndex: fc.integer({ min: 1, max: 3 }),
    }),
    { minLength: 1, maxLength: 16 },
  );

  fc.assert(
    fc.property(eventArb, (events) => {
      const entries: AppServerThreadEntry[] = events.map((event, index) => {
        const id = `entry-${index}`;
        const turnId = `turn-${event.turnIndex}`;
        switch (event.kind) {
          case "user":
            return { type: "message", id, role: "user", text: `Prompt ${index}`, turn: { id: turnId, status: "completed" } };
          case "browser-iab":
            return browserActivity(id, turnId, { backend: "iab", browserId: "iab", url: "http://localhost:3000" });
          case "browser-ambiguous":
            return {
              type: "activity",
              id,
              summary: "Browsed localhost:3000",
              status: "completed",
              turn: { id: turnId, status: "completed" },
              details: [
                { id: `${id}-a`, kind: "command", label: "In-app browser", status: "completed", browserUse: { backend: "iab", browserId: "iab" } },
                { id: `${id}-b`, kind: "command", label: "Chrome", status: "completed", browserUse: { backend: "chrome", browserId: "chrome-1", browserFamily: "chrome" } },
              ],
            };
          case "shell":
            return {
              type: "activity",
              id,
              summary: "Ran 1 command",
              status: "completed",
              turn: { id: turnId, status: "completed" },
              details: [{ id: `${id}-cmd`, kind: "command", label: "git status", status: "completed" }],
            };
          case "commentary":
            return commentary(`Progress note ${index}`, id, turnId);
          case "marker":
            return commentary(directive(`Headline ${index}`), id, turnId);
          case "final":
            return {
              type: "message",
              id,
              role: "assistant",
              phase: "final",
              text: `Answer ${index}`,
              turn: { id: turnId, status: "completed" },
            };
        }
      });

      const projected = projectCodexBrowserUseEntries(entries, "codex");
      const originalIndexById = new Map(entries.map((entry, idx) => [entry.id, idx]));

      // Surviving entries stay strictly in original subsequence order.
      let lastIndex = -1;
      for (const entry of projected) {
        const originalIndex = originalIndexById.get(entry.id);
        expect(originalIndex).toBeDefined();
        expect(originalIndex!).toBeGreaterThan(lastIndex);
        lastIndex = originalIndex!;
      }

      // Every non-marker entry survives untouched in position.
      for (const [index, event] of events.entries()) {
        if (event.kind !== "marker") {
          expect(projected.some((entry) => entry.id === `entry-${index}`)).toBe(true);
        }
      }

      // Ambiguous multi-surface batches never claim a marker headline.
      for (const entry of projected) {
        if (entry.type === "activity" && entry.browserUse?.ambiguousSurface) {
          expect(entry.summary).not.toMatch(/^Headline /);
        }
      }
    }),
  );
});

it("never associates a ::browser-complete marker across turn, user, final-answer, or already-claimed boundaries", () => {
  const crossTurn = projectCodexBrowserUseEntries(
    [
      browserActivity("act-t1", "turn-1", { backend: "iab", browserId: "iab", url: "http://localhost:3000" }),
      commentary(directive("Turn 2 headline"), "bc-t2", "turn-2"),
    ],
    "codex",
  );
  expect(crossTurn.map((entry) => entry.id)).toEqual(["act-t1", "bc-t2"]);
  expect((crossTurn[0] as AppServerThreadActivityEntry).summary).toBe("Browsed localhost:3000");

  const afterFinal = projectCodexBrowserUseEntries(
    [
      browserActivity("act-1", "turn-1", { backend: "iab", browserId: "iab", url: "http://localhost:3000" }),
      { type: "message", id: "final-1", role: "assistant", phase: "final", text: "Done", turn: { id: "turn-1", status: "completed" } },
      commentary(directive("Late headline"), "bc-late", "turn-1"),
    ],
    "codex",
  );
  expect(afterFinal.map((entry) => entry.id)).toEqual(["act-1", "final-1", "bc-late"]);

  const duplicateMarkers = projectCodexBrowserUseEntries(
    [
      browserActivity("act-1", "turn-1", { backend: "iab", browserId: "iab", url: "http://localhost:3000" }),
      commentary(directive("Opened login page"), "bc-1", "turn-1"),
      commentary(directive("Paused for a sign-in code"), "bc-2", "turn-1"),
    ],
    "codex",
  );
  expect(duplicateMarkers.map((entry) => entry.id)).toEqual(["act-1", "bc-2"]);
  expect((duplicateMarkers[0] as AppServerThreadActivityEntry).summary).toBe("Opened login page");
});
