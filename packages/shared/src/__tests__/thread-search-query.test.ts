import { describe, expect, it } from "vitest";
import { matchesThreadSearchProjects, parseThreadSearchQuery, threadSearchTextTerms } from "../thread-search-query";

describe("project search mentions", () => {
  it("extracts either syntax, deduplicates names and preserves text", () => {
    expect(parseThreadSearchQuery('m4 build @disk in:@PwrSnap @DISK')).toEqual({
      query: "m4 build", projects: ["disk", "pwrsnap"],
    });
    expect(parseThreadSearchQuery('in:@"My Project" build')).toEqual({
      query: "build", projects: ["my project"],
    });
  });

  it("preserves literal mentions, email addresses and unfinished syntax", () => {
    for (const query of ['"@disk"', 'user@example.com', '@', 'in:@', '@"unfinished']) {
      expect(parseThreadSearchQuery(query)).toEqual({ query, projects: [] });
    }
  });

  it("matches prefixes across projects and linked directories on either platform", () => {
    expect(matchesThreadSearchProjects({ projectKey: "C:\\repos\\DiskHound" }, ["disk"])).toBe(true);
    expect(matchesThreadSearchProjects({ projectKey: "/repos/PwrSnap/" }, ["disk", "pwrsnap"])).toBe(true);
    expect(matchesThreadSearchProjects({ projectKey: "/repos/Other" }, ["disk"])).toBe(false);
    expect(matchesThreadSearchProjects({}, ["missing"])).toBe(false);
    expect(matchesThreadSearchProjects({ linkedDirectories: [{
      id: "d", kind: "worktree", label: "My Project", path: "/repos/source",
      worktreePath: "/worktrees/feature",
    }] }, ["my project"])).toBe(true);
  });
});

describe("threadSearchTextTerms", () => {
  it("decodes phrases after extracting projects without reinterpreting literals", () => {
    const parsed = parseThreadSearchQuery('fix "ad hoc" "@disk" @other');
    expect(parsed.projects).toEqual(["other"]);
    expect(threadSearchTextTerms(parsed.query)).toEqual([
      { text: "fix", quoted: false },
      { text: "ad hoc", quoted: true },
      { text: "@disk", quoted: true },
    ]);
  });
});
