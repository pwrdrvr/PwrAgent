import { expect, it } from "vitest";
import fc from "fast-check";
import type { AgentEvent, NavigationThreadSummary } from "@pwragent/shared";
import { buildThreadIdentityKey, NAVIGATION_DIRECTORY_SCOPE_MAX_BYTES, readNavigationDirectoryScope } from "@pwragent/shared";
import { NavigationDirectoryScope } from "../navigation-directory-scope";
import { projectNavigationQuery, type NavigationQueryIndex } from "../navigation-query-projection";

function population(memberships: number[]): NavigationQueryIndex {
  const threads: NavigationThreadSummary[] = memberships.map((_, i) => ({
    id: `thread-${Math.floor(i / 2)}`, source: i % 2 ? "claude" : "codex", title: `Row ${i}`, titleSource: "explicit",
    ...(i >= 4 ? { parentThreadId: "thread-0", parentThreadBackend: "codex" as const } : {}),
    // Deliberately unrelated to membership: aliases, worktrees and directory
    // relationships are resolved by the owner index, not by a viewer's paths.
    linkedDirectories: [], projectKey: `/worktree-${i % 3}`, inbox: { inInbox: false },
  }));
  return { coverage: { state: "complete" }, threads, directories: Array.from({ length: 8 }, (_, i) => ({
    key: `project-${i}`, label: `Project ${i}`, kind: "directory", needsAttentionCount: 0,
    threadKeys: threads.filter((_, j) => memberships[j]! & (1 << i)).map((t) => buildThreadIdentityKey(t.source, t.id)),
  })) };
}
const change = (thread: NavigationThreadSummary, method = "thread/backgroundTasks/updated"): AgentEvent => ({
  backend: thread.source, notification: { method, params: { threadId: thread.id, worktreePath: thread.projectKey } },
} as AgentEvent);

it("scopes exactly the complete owner's changed directory counts across providers and overlapping memberships", () => {
  fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 2, maxLength: 16 }), (memberships) => {
    const index = population(memberships);
    const scopes = new NavigationDirectoryScope();
    scopes.remember(index, scopes.checkpoint());
    for (const thread of index.threads) {
      const after = { ...index, threads: index.threads.map((t) => t === thread ? { ...t, hasBackgroundTasks: true } : t) };
      const changed = index.directories.filter((directory) => {
        const request = { protocol: 2 as const, consumer: "main-sidebar" as const,
          query: { kind: "directory" as const, directoryKey: directory.key } };
        return projectNavigationQuery({ index, request }).counts.active !== projectNavigationQuery({ index: after, request }).counts.active;
      }).map((directory) => directory.key);
      expect(scopes.forEvent(change(thread))?.directoryKeys).toEqual(changed);
      const pathMembers = index.threads.filter((t) => t.projectKey === thread.projectKey);
      const gitChanged = index.directories.filter((d) => pathMembers.some((t) => d.threadKeys.includes(buildThreadIdentityKey(t.source, t.id))));
      expect(new Set(scopes.forEvent(change(thread, "navigation/threadGitWorkingState/updated"))?.directoryKeys))
        .toEqual(new Set(gitChanged.map((d) => d.key)));
    }
  }), { numRuns: 50 });
});

it("withdraws authority at membership ingress and never revives it from an overtaken scan", () => {
  fc.assert(fc.property(fc.array(fc.constantFrom("row", "membership", "old-scan", "scan", "degraded"), { maxLength: 40 }), (ops) => {
    const scopes = new NavigationDirectoryScope();
    const index = population([1, 2]);
    const row = change(index.threads[0]!);
    const old = scopes.checkpoint();
    let valid = false;
    let crossedBoundary = false;
    for (const op of ops) {
      if (op === "membership") {
        scopes.invalidate(change(index.threads[0]!, "navigation/threadDirectories/updated"));
        valid = false; crossedBoundary = true;
      } else if (op === "row") scopes.invalidate(row);
      else if (op === "scan") { scopes.remember(index, scopes.checkpoint()); valid = true; }
      else if (op === "old-scan") { scopes.remember(index, old); if (!crossedBoundary) valid = true; }
      else { scopes.remember({ ...index, coverage: { state: "degraded" } }, scopes.checkpoint()); valid = false; }
      expect(scopes.forEvent(row)).toEqual(valid ? { version: 1, directoryKeys: ["project-0"] } : undefined);
    }
  }));
});

it("omits unknown identities, membership changes, foreign owners and scopes over the exact UTF-8 wire budget", () => {
  const index = population([1]);
  const scopes = new NavigationDirectoryScope();
  scopes.remember(index, scopes.checkpoint());
  expect(scopes.forEvent(change({ ...index.threads[0]!, id: "unknown" }))).toBeUndefined();
  expect(scopes.forEvent(change(index.threads[0]!, "thread/parent/set"))).toBeUndefined();
  expect(scopes.forEvent({ ...change(index.threads[0]!), federationTarget: { scope: "remote", instanceId: "peer" } })).toBeUndefined();
  for (const glyph of ["a", "é", "😀", '"', "\\", "\ud800"]) {
    for (const count of [15, 16, 17, 100, 101]) {
      const value = { version: 1, directoryKeys: Array.from({ length: count }, () => glyph.repeat(1_000 / glyph.length)) };
      const admitted = count <= 100 && Buffer.byteLength(JSON.stringify(value), "utf8") <= NAVIGATION_DIRECTORY_SCOPE_MAX_BYTES;
      expect(Boolean(readNavigationDirectoryScope(value))).toBe(admitted);
      const large = { ...index, directories: value.directoryKeys.map((key, i) => ({ ...index.directories[0]!, key: `${i}:${key}` })) };
      scopes.remember(large, scopes.checkpoint());
      const result = scopes.forEvent(change(index.threads[0]!));
      const wire = { version: 1, directoryKeys: large.directories.map((d) => d.key) };
      expect(Boolean(result)).toBe(count <= 100 && Buffer.byteLength(JSON.stringify(wire), "utf8") <= NAVIGATION_DIRECTORY_SCOPE_MAX_BYTES);
    }
  }
  expect(readNavigationDirectoryScope({ version: 2, directoryKeys: [] })).toBeUndefined();
  expect(readNavigationDirectoryScope({ version: 1, directoryKeys: [null] })).toBeUndefined();
});

it("agrees with the independent UTF-8 oracle at the exact admission boundary", () => {
  fc.assert(fc.property(fc.constantFrom("a", "é", "😀", "\ud800", '"', "\\"), fc.integer({ min: 0, max: 4 }), (glyph, extra) => {
    // Keep every individual key below 1,024 code units while filling the wire
    // to within one encoded glyph of the 16 KiB limit.
    const key = glyph.repeat(Math.floor(900 / glyph.length));
    const keys: string[] = [];
    const bytes = () => Buffer.byteLength(JSON.stringify({ version: 1, directoryKeys: keys }), "utf8");
    while (bytes() + Buffer.byteLength(JSON.stringify(key), "utf8") + 1 < NAVIGATION_DIRECTORY_SCOPE_MAX_BYTES) keys.push(key);
    keys.push("");
    while (bytes() + Buffer.byteLength(JSON.stringify(glyph), "utf8") - 2 <= NAVIGATION_DIRECTORY_SCOPE_MAX_BYTES) keys[keys.length - 1] += glyph;
    keys[keys.length - 1] += glyph.repeat(extra);
    const value = { version: 1, directoryKeys: keys };
    expect(Boolean(readNavigationDirectoryScope(value))).toBe(bytes() <= NAVIGATION_DIRECTORY_SCOPE_MAX_BYTES);
  }));
});
