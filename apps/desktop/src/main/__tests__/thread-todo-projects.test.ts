import { describe, expect, it } from "vitest";
import {
  findPeerThreadTodoProject,
  matchThreadTodoProject,
  threadTodoProjectChoices,
  type ThreadTodoProjectCandidate,
} from "../thread-todos/thread-todo-projects";

const CANDIDATES: ThreadTodoProjectCandidate[] = [
  { key: "directory:/src/pwragent", label: "PwrAgent", kind: "directory", path: "/src/pwragent" },
  { key: "directory:/src/PwrSnap", label: "PwrSnap", kind: "directory", path: "/src/PwrSnap" },
  { key: "directory:/src/pwrgit", label: "pwrgit", kind: "directory", path: "/src/pwrgit" },
  { key: "directory:/forks/pwrgit", label: "pwrgit (fork)", kind: "directory", path: "/forks/pwrgit" },
  { key: "workspace:notes", label: "Notes", kind: "workspace" },
];

describe("matchThreadTodoProject", () => {
  it("matches a name without regard to case", () => {
    expect(matchThreadTodoProject("pwrsnap", CANDIDATES)).toEqual({
      ok: true,
      project: { key: "directory:/src/PwrSnap", label: "PwrSnap", path: "/src/PwrSnap" },
    });
  });

  it("prefers an exact path or key over a name", () => {
    const byPath = matchThreadTodoProject("/forks/pwrgit/", CANDIDATES);
    expect(byPath).toMatchObject({ ok: true, project: { key: "directory:/forks/pwrgit" } });
    const byKey = matchThreadTodoProject("directory:/src/pwrgit", CANDIDATES);
    expect(byKey).toMatchObject({ ok: true, project: { key: "directory:/src/pwrgit" } });
  });

  it("refuses a name two projects share instead of guessing", () => {
    const match = matchThreadTodoProject("pwrgit", CANDIDATES);
    expect(match.ok).toBe(false);
    expect(!match.ok && match.message).toContain("/src/pwrgit, /forks/pwrgit");
  });

  it("names the known projects when nothing matches, and never a workspace", () => {
    expect(matchThreadTodoProject("Notes", CANDIDATES)).toEqual({
      ok: false,
      message: 'No project named "Notes". Known projects: PwrAgent, PwrSnap, pwrgit, pwrgit (fork). Call list_projects for their paths.',
    });
  });

  it("resolves a path inside a project to that project", () => {
    expect(matchThreadTodoProject("/src/PwrSnap/apps/agent", CANDIDATES)).toMatchObject({
      ok: true,
      project: { key: "directory:/src/PwrSnap" },
    });
    // A sibling whose name only starts with the root is not inside it.
    expect(matchThreadTodoProject("/src/pwragent-docs", CANDIDATES).ok).toBe(false);
  });

  it("prefers the deepest project when one holds another", () => {
    const nested: ThreadTodoProjectCandidate[] = [
      ...CANDIDATES,
      { key: "directory:/src/pwragent/vendor/lib", label: "lib", kind: "directory", path: "/src/pwragent/vendor/lib" },
    ];
    expect(matchThreadTodoProject("/src/pwragent/vendor/lib/src", nested)).toMatchObject({
      ok: true,
      project: { key: "directory:/src/pwragent/vendor/lib" },
    });
  });

  it("resolves a worktree outside the project by its folder name", () => {
    expect(matchThreadTodoProject("~/.codex/worktrees/k3p/PwrSnap", CANDIDATES)).toMatchObject({
      ok: true,
      project: { key: "directory:/src/PwrSnap" },
    });
    expect(matchThreadTodoProject("C:\\worktrees\\k3p\\pwragent", CANDIDATES)).toMatchObject({
      ok: true,
      project: { key: "directory:/src/pwragent" },
    });
    // Two clones share the folder name: refused, as a bare name would be.
    const match = matchThreadTodoProject("/tmp/worktrees/abc/pwrgit", CANDIDATES);
    expect(match.ok).toBe(false);
  });
});

describe("threadTodoProjectChoices", () => {
  it("lists directories once each, without workspaces", () => {
    expect(threadTodoProjectChoices([...CANDIDATES, CANDIDATES[0]!]).map((project) => project.label))
      .toEqual(["PwrAgent", "PwrSnap", "pwrgit", "pwrgit (fork)"]);
  });
});

describe("findPeerThreadTodoProject", () => {
  const peer: ThreadTodoProjectCandidate[] = [
    { key: "directory:/Users/peer/code/snap", label: "PwrSnap", kind: "directory", path: "/Users/peer/code/snap" },
    { key: "directory:/Users/peer/code/pwragent", label: "agent", kind: "directory", path: "/Users/peer/code/pwragent" },
  ];

  it("matches a peer's project by label, then by folder name", () => {
    expect(findPeerThreadTodoProject(
      { key: "directory:/src/PwrSnap", label: "PwrSnap", path: "/src/PwrSnap" },
      peer,
    )?.key).toBe("directory:/Users/peer/code/snap");
    expect(findPeerThreadTodoProject(
      { key: "directory:/src/pwragent", label: "PwrAgent", path: "/src/pwragent" },
      peer,
    )?.key).toBe("directory:/Users/peer/code/pwragent");
  });

  it("finds nothing for a project the peer does not have", () => {
    expect(findPeerThreadTodoProject(
      { key: "directory:/src/pwrgit", label: "pwrgit", path: "/src/pwrgit" },
      peer,
    )).toBeUndefined();
  });
});
