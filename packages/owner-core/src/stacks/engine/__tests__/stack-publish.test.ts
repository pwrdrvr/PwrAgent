import { join } from "node:path";
import { expect, test } from "vitest";
import { StackEngine } from "../index";
import { StackGit } from "../git";
import { pushStackLayers } from "../publish";
import { commit, git, memoryStore, repository, runner, withRepo, withStack } from "./fixture.test-support";

test.each(["last parent tip", "already retargeted", "earlier parent tip"])("sync excludes the merged parent using %s", async (scenario) =>
  withRepo(async (cwd, old) => {
    await git(cwd, "switch", "-qc", "parent");
    const earlier = await commit(cwd, "parent.txt", "one\n");
    const parent = await commit(cwd, "parent.txt", "two\n");
    const fork = scenario === "earlier parent tip" ? earlier : parent;
    await git(cwd, "switch", "-qc", "child", fork);
    await commit(cwd, "child.txt", "child\n");
    await git(cwd, "switch", "-q", "main");
    await git(cwd, "merge", "--squash", "parent");
    await git(cwd, "commit", "-qm", "squash parent");
    const squash = await git(cwd, "rev-parse", "main");
    const integrated = await commit(cwd, "integration.txt", "integrated\n");
    if (scenario === "already retargeted") await git(cwd, "rebase", "--onto", "main", parent, "child");
    const child = await git(cwd, "rev-parse", "child");
    await git(cwd, "branch", "upper", child);
    await git(cwd, "switch", "-q", "main");
    const trunk = await commit(cwd, "parent.txt", "three\n");
    // Build the oracle with real rebase using the proper Git boundary.
    await git(cwd, "branch", "oracle", child);
    const anchor = scenario === "already retargeted" ? integrated : fork;
    await git(cwd, "rebase", "--onto", trunk, anchor, "oracle");
    const common = join(cwd, ".git");
    const store = memoryStore({ schemaVersion: 1, repository, stacks: [{
      trunk: { branch: "main", head: integrated },
      branches: [
        { branch: "parent", head: parent, base: old, pullRequest: { number: 41 } },
        { branch: "child", head: child, base: fork === earlier ? earlier : old, pullRequest: { number: 42 } },
        { branch: "upper", head: child, base: child, pullRequest: { number: 43 } },
      ],
    }] });
    const engine = new StackEngine(runner, store, cwd, common);
    const plan = await engine.plan({ kind: "sync", root: "parent", branch: "child", onto: trunk,
      merged: { number: 41, head: parent, commit: squash } });
    expect(plan.steps.map(({ oldBase }) => oldBase)).toEqual([anchor]);
    expect(plan.steps[0]?.proof).toEqual({ preserved: 1, dropped: [] });
    expect(plan.moves.map(({ branch }) => branch)).toEqual(["child"]);
    await engine.apply(plan, "sync", 1);
    expect(await git(cwd, "diff", "oracle", "child", "--")).toBe("");
    expect(await git(cwd, "log", "--format=%s", `${trunk}..child`)).toBe("child.txt");
    expect(await git(cwd, "rev-parse", "upper")).toBe(child);
    expect((await store.read(common)).catalog.stacks[0]?.branches[0]?.pullRequest).toMatchObject({ merged: true, mergedHead: parent });
  }));

test("an exact lease makes a raced multi-ref push all-or-nothing", async () =>
  withStack(async ({ cwd, bottom, top }) => {
    const remote = join(cwd, "remote.git");
    await git(cwd, "init", "-q", "--bare", remote);
    await git(cwd, "push", remote, "bottom", "top");
    const ref = new StackGit(runner, cwd);
    await git(cwd, "switch", "-q", "bottom");
    const newerBottom = await commit(cwd, "fix.txt", "fix\n");
    await git(cwd, "switch", "-q", "top");
    const newerTop = await commit(cwd, "top-fix.txt", "fix\n");
    await git(cwd, "push", remote, "top");
    await expect(pushStackLayers(ref, remote, [
      { branch: "bottom", previous: bottom, expected: bottom, next: newerBottom },
      { branch: "top", previous: top, expected: top, next: newerTop },
    ])).resolves.toBeUndefined();
    // Git considers the second branch already up to date. A divergent head,
    // however, must reject both ref updates even when the first lease matches.
    await git(cwd, "switch", "-q", "main");
    const outside = await commit(cwd, "outside.txt", "collaborator\n");
    await git(cwd, "push", remote, `+${outside}:refs/heads/top`);
    await git(cwd, "switch", "-q", "bottom");
    const latestBottom = await commit(cwd, "next.txt", "next\n");
    await expect(pushStackLayers(ref, remote, [
      { branch: "bottom", previous: latestBottom, expected: newerBottom, next: latestBottom },
      { branch: "top", previous: newerTop, expected: newerTop, next: newerTop },
    ])).resolves.toBeUndefined();
    await git(cwd, "switch", "-q", "top");
    const latestTop = await commit(cwd, "another.txt", "another\n");
    await git(cwd, "switch", "-q", "bottom");
    const finalBottom = await commit(cwd, "final.txt", "final\n");
    await expect(pushStackLayers(ref, remote, [
      { branch: "bottom", previous: finalBottom, expected: latestBottom, next: finalBottom },
      { branch: "top", previous: latestTop, expected: newerTop, next: latestTop },
    ])).rejects.toThrow();
    expect(await git(cwd, "ls-remote", remote, "refs/heads/bottom", "refs/heads/top"))
      .toBe(`${latestBottom}\trefs/heads/bottom\n${outside}\trefs/heads/top`);
    await expect(pushStackLayers(ref, remote, [
      { branch: "top", previous: latestTop, expected: outside, next: latestTop },
    ])).rejects.toThrow("history changed");
  }));
