import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
  AppServerThreadActivityEntry,
  AppServerThreadEntry,
} from "@pwragent/shared/contracts/normalized-app-server";
import { buildTranscriptRenderItems } from "../transcript-render-items";
import { buildLiveToolDetails, mergeActivityDetails, summarizeLiveActivity } from "../live-transcript-activity";

function edit(id: string, path: string, turnId: string): AppServerThreadActivityEntry {
  return {
    type: "activity",
    id,
    summary: "Edited notes.md",
    turn: { id: turnId, status: "in_progress" },
    status: "completed",
    details: [{
      id,
      kind: "write",
      label: "Edited notes.md",
      path,
      fileDiff: { kind: "update", diff: `patch ${id}`, additions: 1, removals: 1 },
    }],
  };
}

function render(entries: AppServerThreadEntry[]) {
  return buildTranscriptRenderItems({ entries, backend: "acp:antigravity" });
}

describe("Antigravity edit groups", () => {
  it("folds repeated edits to one file into one row and retains both patches", () => {
    const first = edit("first", "/work/notes.md", "turn-1");
    const second = edit("second", "/work/notes.md", "turn-1");
    expect(render([first, second])).toEqual([{
      type: "entry",
      entry: {
        ...first,
        summary: "Edited 1 file · 2 edits",
        details: [...first.details, ...second.details],
      },
    }]);
  });

  it("keeps the same edit identity and patch when a live call completes", () => {
    const replayed = edit("call", "/work/notes.md", "turn-1").details[0]!;
    const item = { id: "call", type: "commandExecution", acpFileEdit: true,
      title: replayed.label, path: replayed.path };
    const [started] = buildLiveToolDetails({ ...item, status: "in_progress" });
    const details = buildLiveToolDetails({ ...item, status: "completed", fileDiff: replayed.fileDiff });
    expect(started?.id).toBe(replayed.id);
    expect(details).toEqual([{ ...replayed, status: "completed" }]);
    expect(summarizeLiveActivity(details)).toBe(replayed.label);
  });

  it("updates the existing live detail when the path arrives after the start", () => {
    const start = buildLiveToolDetails({
      type: "commandExecution", id: "late-path", toolName: "edit",
      command: "Editing file", commandSource: "tool", status: "in_progress",
    });
    const completion = buildLiveToolDetails({
      type: "commandExecution", acpFileEdit: true, id: "late-path",
      title: "Edited notes.md", path: "/work/notes.md", status: "completed",
      fileDiff: { kind: "update", diff: "patch", additions: 1, removals: 1 },
    });
    expect(mergeActivityDetails(start, completion)).toEqual([{
      id: "late-path", kind: "write", label: "Edited notes.md", path: "/work/notes.md",
      status: "completed", fileDiff: { kind: "update", diff: "patch", additions: 1, removals: 1 },
    }]);
  });

  it("folds inline and referenced edits identically inside completed work groups", () => {
    for (const reference of ["diffRef", "diffRefs"] as const) {
      const edits = ["first", "second"].map((id) => ({
        ...edit(id, "/work/notes.md", "turn"),
        turn: { id: "turn", status: "completed" as const, durationMs: 75_000 },
      }));
      const referenced = edits.map((entry) => ({
        ...entry,
        details: entry.details.map((detail) => {
          const ref = { source: "thread" as const, key: detail.id, detailId: detail.id,
            threadId: "demo", entryId: entry.id };
          return {
            ...detail,
            fileDiff: {
              ...detail.fileDiff!, diff: "",
              ...(reference === "diffRef" ? { diffRef: ref } : { diffRefs: [ref] }),
            },
          };
        }),
      }));
      const presentation = (entries: AppServerThreadEntry[]) => render(entries).map((item) =>
        item.type === "workPhaseGroup"
          ? {
              type: item.type,
              label: item.label,
              summaries: item.entries.map((entry) => entry.type === "activity" ? entry.summary : entry.type),
            }
          : item.type);
      expect(presentation(edits)).toEqual([{
        type: "workPhaseGroup",
        label: "Worked for 1m 15s",
        summaries: ["Edited 1 file · 2 edits"],
      }]);
      expect(presentation(referenced)).toEqual(presentation(edits));
    }
  });

  it("property: one row per uninterrupted run, counting files by path and preserving every patch in order", () => {
    const run = fc.array(fc.nat({ max: 5 }), { minLength: 2, maxLength: 20 });
    fc.assert(fc.property(fc.array(run, { minLength: 3, maxLength: 8 }), (runs) => {
      const batches = runs.map((paths, index) => {
        // Alternate a conversational boundary and a bare turn boundary.
        const turnId = `turn-${Math.floor(index / 2)}`;
        const entries = paths.map((file, call) =>
          edit(`edit-${index}-${call}`, `/work/${file}/notes.md`, turnId));
        const message: AppServerThreadEntry | undefined = index % 2 === 0
          ? { type: "message", id: `message-${index}`, role: "assistant", text: "Continuing." }
          : undefined;
        return { entries, message, fileCount: new Set(paths).size };
      });
      const input = batches.flatMap(({ entries, message }) => message ? [...entries, message] : entries);

      const expected = batches.flatMap(({ entries, message, fileCount }) => {
        const group: AppServerThreadEntry = {
          ...entries[0]!,
          summary: `Edited ${fileCount} ${fileCount === 1 ? "file" : "files"}`
            + (fileCount < entries.length ? ` · ${entries.length} edits` : ""),
          details: entries.flatMap((entry) => entry.details),
        };
        return message ? [group, message] : [group];
      });
      expect(render(input)).toEqual(expected.map((entry) => ({ type: "entry", entry })));
    }));
  });
});
