import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { StackEngine } from "../index";
import { StackGit } from "../git";
import { pushStackLayers } from "../publish";
import { commit, git, memoryStore, repository, runner, withRepo } from "./fixture.test-support";

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

type PublishFixture = {
  local: StackGit;
  remote: string;
  bottom: string;
  nextBottom: string;
  top: string;
  racedTop: string;
  nextTop: string;
};

async function withPublishRepos(
  remoteTop: "nextBottom" | "racedTop" | "nextTop",
  testPublish: (fixture: PublishFixture) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "pwragent-stack-publish-"));
  try {
    const cwd = join(dir, "local.git");
    const remote = join(dir, "remote.git");
    await git(dir, "init", "-q", "--bare", "-b", "bottom", cwd);
    const local = new StackGit(runner, cwd);
    // Import the real commit graph and local branch tips in one Git process.
    const commits = [
      { branch: "bottom", message: "bottom" },
      { branch: "top", message: "top", parent: 1 },
      { branch: "bottom", message: "next bottom", parent: 1 },
      { branch: "top", message: "collaborator", parent: 2 },
      { branch: "top", message: "next top", parent: 4 },
    ];
    const commands = commits.flatMap(({ branch, message, parent }, index) => [
      `commit refs/heads/${branch}`, `mark :${index + 1}`,
      "committer Fixture <fixture@example.invalid> 1 +0000",
      "data <<END", message, "END",
      ...(parent === undefined ? [] : [`from :${parent}`]),
      "",
    ]);
    commands.push(...commits.map((_, index) => `get-mark :${index + 1}`), "done", "");
    const [bottom, top, nextBottom, racedTop, nextTop] =
      (await local.output(["fast-import", "--quiet", "--done"], commands.join("\n"))).trim().split(/\r?\n/);
    const tips = { bottom, top, nextBottom, racedTop, nextTop };

    // Give the remote independent refs and access to the fixture's objects.
    await git(dir, "init", "-q", "--bare", "-b", "bottom", remote);
    await writeFile(join(remote, "objects", "info", "alternates"), "../../local.git/objects\n");
    await new StackGit(runner, remote).output(["update-ref", "--stdin"],
      `create refs/heads/bottom ${bottom}\ncreate refs/heads/top ${tips[remoteTop]}\n`);
    await testPublish({ local, remote, ...tips });
  } finally {
    await rm(dir, { force: true, recursive: true, maxRetries: 5 });
  }
}

test("publishes when the second ref is already at its intended tip", async () =>
  withPublishRepos("nextTop", async ({ local, remote, bottom, nextBottom, top, nextTop }) => {
    await pushStackLayers(local, remote, [
      { branch: "bottom", previous: bottom, expected: bottom, next: nextBottom },
      { branch: "top", previous: top, expected: top, next: nextTop },
    ]);
    expect(await git(remote, "show-ref", "--heads"))
      .toBe(`${nextBottom} refs/heads/bottom\n${nextTop} refs/heads/top`);
  }));

test("publishes an ahead layer and preserves a collaborator's divergent tip", async () =>
  withPublishRepos("nextBottom", async ({ local, remote, bottom, nextBottom, nextTop }) => {
    await pushStackLayers(local, remote, [
      { branch: "bottom", previous: nextBottom, expected: bottom, next: nextBottom },
      { branch: "top", previous: nextTop, expected: nextTop, next: nextTop },
    ]);
    expect(await git(remote, "show-ref", "--heads"))
      .toBe(`${nextBottom} refs/heads/bottom\n${nextBottom} refs/heads/top`);
  }));

test("an exact lease makes a raced multi-ref push all-or-nothing", async () =>
  withPublishRepos("racedTop", async ({ local, remote, bottom, nextBottom, top, racedTop, nextTop }) => {
    // The remote is at racedTop but the caller observed top. An unleased push
    // could fast-forward it, so Git's fast-forward check alone passes.
    await expect(pushStackLayers(local, remote, [
      { branch: "bottom", previous: bottom, expected: bottom, next: nextBottom },
      { branch: "top", previous: top, expected: top, next: nextTop },
    ])).rejects.toThrow();
    expect(await git(remote, "show-ref", "--heads"))
      .toBe(`${bottom} refs/heads/bottom\n${racedTop} refs/heads/top`);
  }));

test("rejects rewriting a remote tip missing from the local input", async () =>
  withPublishRepos("nextBottom", async ({ local, remote, top, nextBottom, nextTop }) => {
    await expect(pushStackLayers(local, remote, [
      { branch: "top", previous: top, expected: nextBottom, next: nextTop },
    ])).rejects.toThrow("history changed");
  }));
