import { record } from "./scaling-audit-results";
import { expect, it } from "vitest";
import type {
  AppServerThreadActivityEntry,
  AppServerThreadEntry,
} from "@pwragent/shared/contracts/normalized-app-server";
import { buildTranscriptRenderItems } from "../transcript-render-items";

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

it.each([8, 16, 32, 64])("streams into %i turns of completed edits", (n) => {
  const historical: AppServerThreadEntry[] = [];
  for (let turn = 0; turn < n; turn += 1) {
    const turnId = `turn-${turn}`;
    historical.push(
      {
        ...edit(`edit-${turn}-a`, "/work/notes.md", turnId),
        turn: { id: turnId, status: "completed", durationMs: 30_000 },
      },
      {
        ...edit(`edit-${turn}-b`, "/work/notes.md", turnId),
        turn: { id: turnId, status: "completed", durationMs: 30_000 },
      },
      {
        type: "message",
        id: `assistant-${turn}`,
        role: "assistant",
        text: `Completed turn ${turn}`,
        turn: { id: turnId, status: "completed", durationMs: 30_000 },
      },
    );
  }

  const edits = (text) => {
    const latest = { type: "message", id: "stream", role: "assistant", text, turn: { id: "live", status: "in_progress" } };
    return render([...historical, latest])
      .flatMap((item) => item.type === "workPhaseGroup" ? item.entries : item.type === "entry" ? [item.entry] : [])
      .filter((entry) => entry.type === "activity" && entry.id.startsWith("edit-") && entry.id.endsWith("-a"));
  };
  let previous = edits("start");
  let replaced = 0;
  for (let i = 0; i < 8; i++) {
    const next = edits("x".repeat(i + 1));
    expect(next).toHaveLength(n);
    replaced += next.filter((entry, index) => entry !== previous[index]).length;
    previous = next;
  }
  record({ kind: "stream", n, deltas: 8, replaced });
});
