import fc from "fast-check";
import { expect, it } from "vitest";
import { classifyDirectory } from "../directory-navigation";
import { findRemoteHomeDirectoryIndex } from "../federation-project-match";
import { buildNavigationSnapshot } from "../navigation-state";
import type { AppServerThreadSummary } from "../contracts/normalized-app-server";

it("groups scratch links using the owner's configured profile roots", () => {
  fc.assert(fc.property(fc.nat(), fc.boolean(), (suffix, windows) => {
    const home = windows ? `C:/Outpost-${suffix}` : `/outpost-${suffix}`;
    const root = `${home}/profiles/Work/projects`;
    const directoryPath = (path: string) => windows ? path.toUpperCase().replaceAll("/", "\\") : path;
    const thread = (id: string, path: string): AppServerThreadSummary => ({
      id, source: "codex", title: id, titleSource: "explicit",
      linkedDirectories: [{ id: path, label: id, kind: "local", path }],
    });
    const snapshot = buildNavigationSnapshot({
      backend: "all", fetchedAt: 0, firstSnapshot: true, unchanged: false,
      overlayByThreadKey: {}, previousKnownThreadKeys: [], workspaceRoots: [root],
      threads: [
        thread("scratch", directoryPath(`${root}/2026-11-22-a1b2c3`)),
        thread("inactive", directoryPath(`${home}/profiles/Other/projects/2026-11-22-d4e5f6`)),
        thread("external", directoryPath(`${root}-extra/2026-11-22-000001`)),
      ],
    });
    expect(snapshot.directories.map(({ kind, threadKeys }) => ({ kind, threadKeys }))).toEqual([
      { kind: "directory", threadKeys: ["codex:external"] },
      { kind: "workspace", threadKeys: ["codex:scratch"] },
    ]);
    const scratch = snapshot.threads[0]!;
    expect(scratch.linkedDirectories[0]?.path).toBe(directoryPath(`${root}/2026-11-22-a1b2c3`));
    expect(classifyDirectory(scratch.linkedDirectories[0]!)).toMatchObject({ key: `workspace:${root}`, path: root });
    const viewerDirectories = [
      { kind: "directory", key: "directory:/elsewhere", label: "scratch", path: "/elsewhere" },
      { kind: "workspace", key: "workspace:/viewer/projects", label: "Workspaces", path: "/viewer/projects" },
    ] as const;
    expect(findRemoteHomeDirectoryIndex(viewerDirectories, scratch)).toBe(1);
    expect(findRemoteHomeDirectoryIndex(viewerDirectories, snapshot.threads[1]!)).toBeUndefined();
  }));
});
