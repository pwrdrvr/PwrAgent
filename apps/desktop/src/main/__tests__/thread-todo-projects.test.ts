import { describe, expect, it } from "vitest";
import {
  findPeerThreadTodoProject,
  matchThreadTodoProject,
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
      message: 'No project named "Notes". Known projects: PwrAgent, PwrSnap, pwrgit, pwrgit (fork).',
    });
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
