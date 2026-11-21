import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { LinkedDirectorySummary } from "@pwragent/shared/contracts/normalized-app-server";
import { matchThreadWorkspacePath, threadWorkspacePaths } from "../app-server/thread-workspace-paths";

// Git is run, and files are replaced, only in a directory a thread works in.
// The model is a small set of directory names; the oracle is plain set
// membership, independent of how either side spells the path.
const NAMES = ["alpha", "beta", "gamma", "delta", "epsilon"];
const ROOT = path.resolve("/workspaces");
const nameArbitrary = fc.constantFrom(...NAMES);

/** The same directory, written the ways a renderer or a provider might. */
const spellingArbitrary = fc.constantFrom(
  (name: string) => path.join(ROOT, name),
  (name: string) => `${path.join(ROOT, name)}${path.sep}`,
  (name: string) => `  ${path.join(ROOT, name)}  `,
  (name: string) => [ROOT, name, "..", name].join(path.sep),
  (name: string) => [ROOT, ".", name].join(path.sep),
);

type Entry = { kind: "worktree" | "local"; name: string };

function directory(entry: Entry): LinkedDirectorySummary {
  const location = path.join(ROOT, entry.name);
  return {
    id: `${entry.kind}:${entry.name}`,
    kind: entry.kind,
    label: entry.name,
    // A worktree row's `path` is its source checkout, which the thread does
    // not work in unless it is linked in its own right.
    path: entry.kind === "worktree" ? path.join(ROOT, "source-of", entry.name) : location,
    ...(entry.kind === "worktree" ? { worktreePath: location } : {}),
  } as LinkedDirectorySummary;
}

const entryArbitrary: fc.Arbitrary<Entry> = fc.record({
  kind: fc.constantFrom("worktree" as const, "local" as const),
  name: nameArbitrary,
});

const threadArbitrary = fc.record({
  project: fc.option(nameArbitrary, { nil: undefined }),
  linked: fc.array(entryArbitrary, { maxLength: 3 }),
  extra: fc.array(entryArbitrary, { maxLength: 2 }),
});

describe("thread workspace paths", () => {
  it("matches a requested path exactly when the thread works in that directory, and answers in the thread's spelling", () => {
    fc.assert(fc.property(
      threadArbitrary,
      nameArbitrary,
      spellingArbitrary,
      (thread, requestedName, spell) => {
        const paths = threadWorkspacePaths(
          {
            projectKey: thread.project && path.join(ROOT, thread.project),
            linkedDirectories: thread.linked.map(directory),
          },
          thread.extra.map(directory),
        );
        const works = new Set([
          ...(thread.project ? [thread.project] : []),
          ...thread.linked.map((entry) => entry.name),
          ...thread.extra.map((entry) => entry.name),
        ]);
        expect(new Set(paths)).toEqual(new Set([...works].map((name) => path.join(ROOT, name))));

        const matched = matchThreadWorkspacePath(paths, spell(requestedName));
        if (!works.has(requestedName)) {
          expect(matched).toBeUndefined();
          return;
        }
        // Never the caller's string: the thread's own record of the directory.
        expect(matched).toBe(path.join(ROOT, requestedName));
      },
    ));
  });

  it("matches nothing for an empty request, or for a directory above, below or beside a workspace", () => {
    const paths = [path.join(ROOT, "alpha")];
    for (const requested of [undefined, "", "   ", ROOT, path.join(ROOT, "alpha", "src"), path.join(ROOT, "alph")]) {
      expect(matchThreadWorkspacePath(paths, requested)).toBeUndefined();
    }
  });
});
