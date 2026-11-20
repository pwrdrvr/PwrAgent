import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { projectNavigationQuery } from "../navigation-query-projection";

function thread(id: string, source: AppServerBackendKind, title: string): NavigationThreadSummary {
  return {
    id, source, title, titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false },
    agent: { name: "Coordinator", instructionLineCount: 0, instructionsTooLong: false, updatedAt: 1 },
    updatedAt: id === "target" ? 1 : 100,
  };
}

function search(source: AppServerBackendKind, filter: string, recentCount = 100) {
  const recentSource = source === "codex" ? "claude" : "codex";
  return projectNavigationQuery({
    index: {
      directories: [],
      threads: [
        ...Array.from({ length: recentCount }, (_, id) => thread(`recent-${id}`, recentSource, "Recent work")),
        thread("target", source, "Mail triage"),
      ],
    },
    request: { protocol: 2, consumer: "settings", pageSize: 100,
      query: { kind: "messaging-threads", agentOnly: true, filter } },
  });
}

describe("messaging search matches the automation picker's visible provider metadata", () => {
  it.each(["codex", "claude", "acp:gemini"] as const)("finds an old %s Agent by its displayed provider", (source) => {
    const provider = source.replace(/^acp:/, "");
    expect(search(source, provider).entries.map(({ row }) => row.id)).toEqual(["target"]);
    expect(search(source, `${provider} - Mail`).entries.map(({ row }) => row.id)).toEqual(["target"]);
  });

  it("preserves matches spanning the displayed provider and title before pagination", () => {
    fc.assert(fc.property(
      fc.constantFrom("codex", "claude", "acp:gemini", "acp:qwen"),
      fc.integer({ min: 100, max: 106 }), fc.nat(100), fc.boolean(),
      (source, recentCount, offset, upperCase) => {
        const provider = source.replace(/^acp:/, "");
        const metadata = `${provider} - Mail triage`;
        // Always include provider text; lengths also cross the provider/title boundary.
        const match = metadata.slice(0, 1 + offset % metadata.length);
        const query = ` ${upperCase ? match.toUpperCase() : match} `;
        expect(search(source, query, recentCount).entries.some(({ row }) => row.id === "target")).toBe(true);
      },
    ), { numRuns: 50 });
  });
});
