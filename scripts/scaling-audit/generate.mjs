import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const topology = JSON.parse(readFileSync(new URL("./shape.json", import.meta.url), "utf8"));

export function generate({ copies = 1, archived = 2807, folds = "open" } = {}) {
  if (!Number.isSafeInteger(copies) || copies < 1 || !Number.isSafeInteger(archived) || archived < 0)
    throw new Error("Provide a positive integer copy count and a nonnegative integer archive count.");
  if (!["open", "focus", "mixed"].includes(folds)) throw new Error("Use open, focus, or mixed.");
  const threads = [], directoryOverlays = [], archivedOverlays = [], unresolvedParents = [];
  for (let copy = 0; copy < copies; copy++) {
    const base = "/fixture/copy-" + copy + "/d-";
    const ids = new Set();
    const id = index => "t-" + copy + "-" + index;
    const parents = new Set(topology.flatMap(r => r.parent == null ? [] : [r.parent]));
    const parentFolds = new Set([...parents].sort((a,b)=>a-b).slice(0,21));
    for (const [index, row] of topology.entries()) {
      const thread = { id: id(index), source: row.backend, title: "Thread " + id(index), titleSource: "explicit",
        updatedAt: 10000000 - threads.length, threadStatus: "idle", inbox: {inInbox: false},
        linkedDirectories: row.dirs.map(([dir, wt, kind]) => {
          ids.add(dir);
          return { id: base + dir, path: base + dir, kind, label: "Directory " + dir,
            ...(wt == null ? {} : {worktreePath: base + wt}) };
        }),
        ...(row.project == null ? {} : { projectKey: base + row.project }),
        ...(row.pin ? {pinnedRank: String(threads.length + 1).padStart(9,"0")} : {}),
        ...(row.parent == null ? {} : {parentThreadId: id(row.parent), parentThreadBackend: topology[row.parent].backend}),
        ...(folds === "mixed" && parentFolds.has(index) ? {subthreadsCollapsed: true} : {}),
        prs: Array.from({length: row.prs}, (_, j) => {
          const number = 100 * (threads.length + 1) + j;
          return {number, org:"fixture", repo:"project", provider:"github.com", url:"https://github.com/fixture/project/pull/" + number, lifecycleState:"open", state:"passing"};
        }) };
      if (row.hasParent && row.parent == null) unresolvedParents.push(thread.id);
      threads.push(thread);
    }
    const order = [...ids].sort((a,b) => Number(b===1)-Number(a===1) || a-b);
    for (const [index, dir] of order.entries()) {
      const collapsed = folds === "mixed" ? index < 13 : folds === "focus" && dir === 1;
      directoryOverlays.push({directoryKey: base + dir, directoryThreadsCollapsed: collapsed});
    }
  }
  for (let i=0; i<archived; i++) archivedOverlays.push({backend:"codex", threadId:"archived-"+i,archiveRetentionStartedAt:1,archiveTombstonedAt:1});
  return {threads, directoryOverlays, archivedOverlays, unresolvedParents};
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify(generate({copies:Number(process.argv[2] ?? 1), archived:Number(process.argv[3] ?? 2807), folds:process.argv[4] ?? "open"}))+"\n");
}
