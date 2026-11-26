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

it("keeps same-session Chrome steps unambiguous when browserFamily is omitted on a later step", () => {
  const activity: AppServerThreadActivityEntry = {
    type: "activity",
    id: "act-chrome",
    summary: "Browsed example.com",
    status: "completed",
    turn: { id: "turn-chrome", status: "completed" },
    details: [
      {
        id: "step-1",
        kind: "command",
        label: "Open page",
        status: "completed",
        browserUse: {
          backend: "chrome",
          browserFamily: "chrome",
          browserId: "chrome-ext-1",
          url: "https://example.com/start",
        },
      },
      {
        id: "step-2",
        kind: "command",
        label: "Verify heading",
        status: "completed",
        browserUse: {
          backend: "chrome",
          browserId: "chrome-ext-1",
          url: "https://example.com/done",
        },
      },
    ],
  };

  const projected = projectCodexBrowserUseEntries(
    [activity, commentary(directive("Verified example.com"), "bc-chrome", "turn-chrome")],
    "codex",
  );
  expect(projected).toHaveLength(1);
  const enriched = projected[0] as AppServerThreadActivityEntry;
  expect(enriched.summary).toBe("Verified example.com");
  expect(enriched.browserUse?.ambiguousSurface).toBeUndefined();
  expect(enriched.browserUse?.surfaceLabel).toBe("Chrome");
  expect(enriched.browserUse?.browserFamily).toBe("chrome");
  expect(enriched.browserUse?.browserId).toBe("chrome-ext-1");
});

it("preserves unambiguous batch surface identity when the final browser step omits toolSurface fields", () => {
  const activity: AppServerThreadActivityEntry = {
    type: "activity",
    id: "act-iab-minimal-tail",
    summary: "Browsed localhost:3000",
    status: "completed",
    turn: { id: "turn-iab", status: "completed" },
    details: [
      {
        id: "step-1",
        kind: "command",
        label: "Open checkout",
        status: "completed",
        browserUse: {
          backend: "iab",
          browserId: "iab",
          url: "http://localhost:3000/cart",
        },
      },
      {
        id: "step-2",
        kind: "command",
        label: "Read confirmation",
        status: "completed",
        browserUse: {
          url: "http://localhost:3000/confirmation",
        },
      },
    ],
  };

  const projected = projectCodexBrowserUseEntries(
    [activity, commentary(directive("Verified order confirmation"), "bc-iab", "turn-iab")],
    "codex",
  );
  expect(projected).toHaveLength(1);
  const enriched = projected[0] as AppServerThreadActivityEntry;
  expect(enriched.summary).toBe("Verified order confirmation");
  expect(enriched.browserUse?.ambiguousSurface).toBeUndefined();
  expect(enriched.browserUse?.surfaceLabel).toBe("In-app browser");
  expect(enriched.browserUse?.backend).toBe("iab");
  expect(enriched.browserUse?.browserId).toBe("iab");
  expect(enriched.browserUse?.url).toBe("http://localhost:3000/confirmation");
});

it("replaces the browser summary segment anywhere in a mixed activity summary without duplication", () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom("Ran 1 command", "Read 2 files", "Used 1 tool"), { maxLength: 2 }),
      fc.array(fc.constantFrom("Spawned 1 agent", "Waited on 1 agent"), { minLength: 1, maxLength: 2 }),
      (prefixParts, suffixParts) => {
        const browserTitle = "Browsed localhost:3000";
        const matchedTitle = "Verified checkout";
        const summary = [...prefixParts, browserTitle, ...suffixParts].join(" · ");
        const activity: AppServerThreadActivityEntry = {
          type: "activity",
          id: "act-mixed-collab",
          summary,
          status: "completed",
          turn: { id: "turn-mixed", status: "completed" },
          details: [
            {
              id: "browser-1",
              kind: "command",
              label: "In-app browser · localhost:3000",
              status: "completed",
              browserUse: {
                backend: "iab",
                browserId: "iab",
                url: "http://localhost:3000",
              },
            },
            {
              id: "collab-1",
              kind: "command",
              label: "Spawned helper agent",
              status: "completed",
            },
          ],
        };

        const projected = projectCodexBrowserUseEntries(
          [activity, commentary(directive(matchedTitle), "bc-mixed", "turn-mixed")],
          "codex",
        );
        expect(projected).toHaveLength(1);
        const enriched = projected[0] as AppServerThreadActivityEntry;
        expect(enriched.summary).toBe([...prefixParts, matchedTitle, ...suffixParts].join(" · "));
        expect(enriched.summary).not.toContain(browserTitle);
      },
    ),
  );
});

it("is strictly idempotent across re-projection, including handoff titles and duplicate standalone markers (MBT shrunk counterexamples)", () => {
  // Counterexample 1: re-projecting a claimed handoff activity must preserve the matched title.
  const handoffActivity: AppServerThreadActivityEntry = {
    type: "activity",
    id: "act-handoff",
    summary: "Paused for sign-in",
    status: "completed",
    turn: { id: "turn-1", status: "completed" },
    details: [
      {
        id: "step-1",
        kind: "command",
        label: "In-app browser · example.com/a",
        status: "completed",
        browserUse: {
          backend: "iab",
          browserId: "iab",
          url: "https://example.com/a",
          handoffReason: "authentication",
        },
      },
    ],
  };
  const pass1 = projectCodexBrowserUseEntries(
    [
      handoffActivity,
      commentary(directive("Verified page"), "bc-1", "turn-1"),
      commentary(directive("Verified page"), "bc-2", "turn-1"),
    ],
    "codex",
  );
  // First marker claims the activity; second marker stays standalone.
  expect(pass1.map((entry) => entry.id)).toEqual(["act-handoff", "bc-2"]);
  expect((pass1[0] as AppServerThreadActivityEntry).browserUse?.title).toBe("Verified page");

  // Counterexample 2: a second pass must neither revert browserUse.title nor swallow bc-2.
  const pass2 = projectCodexBrowserUseEntries(pass1, "codex");
  expect(pass2).toEqual(pass1);
});

it("preserves exact object references for unchanged historical Browser Use cards across streaming deltas", () => {
  const historical: AppServerThreadEntry[] = [
    browserActivity("act-1", "turn-1", {
      backend: "iab",
      browserId: "iab",
      url: "https://example.com/1",
    }),
    commentary(directive("Checked page 1"), "bc-1", "turn-1"),
    browserActivity("act-2", "turn-2", {
      backend: "chrome",
      browserId: "chrome-1",
      url: "https://example.com/2",
    }),
  ];

  const first = projectCodexBrowserUseEntries(
    [...historical, commentary("Streaming chunk 1", "live-1", "turn-3")],
    "codex",
  );
  const second = projectCodexBrowserUseEntries(
    [...historical, commentary("Streaming chunk 1 + chunk 2", "live-1", "turn-3")],
    "codex",
  );

  expect(second[0]).toBe(first[0]);
  expect(second[1]).toBe(first[1]);
});

it("handles Unicode whitespace around ::browser-complete and bounds runaway open markers", () => {
  // MBT shrunk counterexample: trailing EM SPACE (\u2003) around a valid directive.
  const unicodeMsg = commentary('\u2003::browser-complete{title="a"}\u2003', "bc-uni", "turn-1");
  expect(isPendingCodexBrowserCompletion(unicodeMsg, "codex")).toBe(true);
  expect(codexBrowserCompletionActivity(unicodeMsg, "codex")?.summary).toBe("a");

  // Runaway unclosed directive beyond MAX_BROWSER_COMPLETION_CHARS stops buffering
  // instead of holding indefinitely or scanning quadratically on every delta.
  const runaway = commentary(`::browser-complete{title="${"a".repeat(2_100)}`, "bc-huge", "turn-1");
  expect(isPendingCodexBrowserCompletion(runaway, "codex")).toBe(false);
});

it("keeps projectCodexBrowserUseEntries idempotent and deferred-replay-equivalent across generated turns", () => {
  const stepArb = fc.record({
    backend: fc.constantFrom("iab", "chrome", "edge"),
    browserId: fc.constantFrom("iab", "c1", "c2"),
    url: fc.constantFrom("https://example.com/a", "http://localhost:3000/b"),
    handoffReason: fc.constantFrom("authentication" as const, undefined),
  });
  const opArb = fc.oneof(
    fc.record({ kind: fc.constant("browser" as const), steps: fc.array(stepArb, { minLength: 1, maxLength: 3 }) }),
    fc.record({ kind: fc.constant("marker" as const), title: fc.constantFrom("Verified page", "Signed in") }),
    fc.record({ kind: fc.constant("commentary" as const) }),
    fc.record({ kind: fc.constant("final" as const) }),
  );

  fc.assert(
    fc.property(fc.array(opArb, { minLength: 1, maxLength: 12 }), (ops) => {
      const entries: AppServerThreadEntry[] = ops.map((op, index) => {
        if (op.kind === "marker") return commentary(directive(op.title), `m-${index}`, "turn-1");
        if (op.kind === "commentary") return commentary("Working...", `c-${index}`, "turn-1");
        if (op.kind === "final") {
          return {
            type: "message",
            id: `f-${index}`,
            role: "assistant",
            phase: "final",
            text: "Done.",
            turn: { id: "turn-1", status: "completed" },
          };
        }
        return {
          type: "activity",
          id: `b-${index}`,
          summary: "Browsed example.com",
          status: "completed",
          turn: { id: "turn-1", status: "completed" },
          details: op.steps.map((step, si) => ({
            id: `d-${index}-${si}`,
            kind: "command" as const,
            label: "Browser step",
            status: "completed" as const,
            command: { displayCommand: "cua_repl/js", rawCommand: "cua_repl/js", source: "tool" as const },
            browserUse: {
              backend: step.backend,
              browserId: step.browserId,
              url: step.url,
              ...(step.handoffReason ? { handoffReason: step.handoffReason } : {}),
            },
          })),
        };
      });

      const projected1 = projectCodexBrowserUseEntries(entries, "codex");
      const projected2 = projectCodexBrowserUseEntries(projected1, "codex");
      expect(projected2).toEqual(projected1);

      const deferred = entries.map((entry) =>
        entry.type === "activity"
          ? {
              ...entry,
              details: entry.details.map((detail) => ({
                ...detail,
                command: detail.command
                  ? { ...detail.command, displayCommand: "", rawCommand: undefined, output: undefined }
                  : undefined,
              })),
            }
          : entry,
      );
      const projectedDeferred = projectCodexBrowserUseEntries(deferred, "codex");
      expect(
        projectedDeferred.map((e) => (e.type === "activity" ? { id: e.id, summary: e.summary, browserUse: e.browserUse } : { id: e.id })),
      ).toEqual(
        projected1.map((e) => (e.type === "activity" ? { id: e.id, summary: e.summary, browserUse: e.browserUse } : { id: e.id })),
      );
    }),
  );
});
