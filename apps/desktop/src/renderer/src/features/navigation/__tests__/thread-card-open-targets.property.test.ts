import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { DesktopApplicationDiscoveryCandidate } from "@pwragent/shared/contracts/settings";
import {
  THREAD_CARD_OPEN_ICON_LIMIT,
  threadCardOpenTargets,
} from "../thread-card-open-targets";

const app = (kind: "editor" | "terminal") => (id: string) => ({
  id, kind, name: id, source: "discovered", canOpenWorkspace: true,
}) as unknown as DesktopApplicationDiscoveryCandidate;
// A small id pool, so editors and terminals sometimes name the same app.
const ids = fc.uniqueArray(fc.constantFrom("vscode", "cursor", "zed", "ghostty", "iterm", "warp"), {
  maxLength: 6,
  size: "max",
});

const input = fc.record({
  editors: ids.map((list) => list.map(app("editor"))),
  terminals: ids.map((list) => list.map(app("terminal"))),
  preferredEditorId: fc.option(fc.constantFrom("vscode", "zed", "missing"), { nil: undefined }),
  preferredTerminalId: fc.option(fc.constantFrom("ghostty", "warp", "missing"), { nil: undefined }),
  integratedTerminal: fc.boolean(),
  fileManagerLabel: fc.option(fc.constant("Show in Finder"), { nil: undefined }),
}, { requiredKeys: ["editors", "terminals", "integratedTerminal"] });

describe("threadCardOpenTargets", () => {
  it("fills at most four icons and moves every other target to Open in…", () => {
    fc.assert(fc.property(input, (options) => {
      const { row, more } = threadCardOpenTargets(options);
      const all = [...row, ...more].map((target) => target.id);
      expect(row.length).toBeLessThanOrEqual(THREAD_CARD_OPEN_ICON_LIMIT);
      if (more.length) expect(row).toHaveLength(THREAD_CARD_OPEN_ICON_LIMIT);
      // Every app once, plus the two built-in targets when offered.
      expect(new Set(all).size).toBe(all.length);
      expect(new Set(all)).toEqual(new Set([
        ...options.editors.map((candidate) => candidate.id),
        ...options.terminals.map((candidate) => candidate.id),
        ...(options.integratedTerminal ? ["integrated-terminal"] : []),
        ...(options.fileManagerLabel ? ["file-manager"] : []),
      ]));
      // The built-in targets never fall to the menu.
      expect(more.every((target) => target.kind === "application")).toBe(true);
      // The preferred editor (else the first) leads.
      const editor = options.editors.find((candidate) => candidate.id === options.preferredEditorId)
        ?? options.editors[0];
      if (editor) expect(row[0]!.id).toBe(editor.id);
    }));
  });
});
