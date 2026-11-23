import { expect, test, vi } from "vitest";
import type { GhStack } from "@pwragent/shared/stacks/catalog";
import { completeStackPublication, readStackPublishTarget } from "../stacks/github-stack-publish";
import type { GithubRequest } from "../pr-status/forge-ci-client";
import { ForgeReadError } from "../pr-status/forge-tool-contract";

const repository = { provider: "github" as const, host: "github.com", owner: "fixture", repo: "observatory" };
const head = "a".repeat(40);
const parentTip = "b".repeat(40);
const squash = "c".repeat(40);
const stack: GhStack = {
  trunk: { branch: "main" },
  branches: [
    { branch: "capture", pullRequest: { number: 41 } },
    { branch: "export", pullRequest: { number: 42 } },
  ],
};

function fakeForge(options: { linked?: boolean; base?: string; failRetarget?: boolean; race?: boolean; stackApiUnavailable?: boolean } = {}) {
  const log: string[] = [];
  let base = options.base ?? "capture";
  let reads = 0;
  const child = () => ({
    state: "open", head: { ref: "export", sha: options.race && reads > 1 ? "d".repeat(40) : head,
      repo: { full_name: "fixture/observatory" } },
    base: { ref: base },
  });
  const request = vi.fn(async (_repo: typeof repository, args: GithubRequest) => {
    if (args.path.includes("/stacks?")) {
      if (options.stackApiUnavailable) throw new ForgeReadError("not_found", "Stack API unavailable");
      return options.linked ? [{ number: 3, pull_requests: [{ number: 42 }] }] : [];
    }
    if (args.path.endsWith("/41")) return {
      state: "closed", merged: true, merge_commit_sha: squash,
      head: { ref: "capture", sha: parentTip, repo: { full_name: "fixture/observatory" } },
    };
    if (args.method === "PATCH") {
      log.push("retarget export to main");
      if (!options.failRetarget) base = "main";
    } else {
      reads++;
    }
    return child();
  });
  // A caller which later prunes the old base can proceed only after both
  // effects finish. A real GitHub deletion must never be attempted by sync.
  async function publishThenDeleteOldBase(catalog = stack) {
    const target = await readStackPublishTarget(repository, catalog, 1, 42, request);
    expect(target.merged).toEqual({ number: 41, head: parentTip, commit: squash });
    await completeStackPublication(target.retarget, async () => { log.push("push export"); });
    log.push("caller may now delete capture");
  }
  return { log, publishThenDeleteOldBase, request };
}

test("an unlinked child's retarget is confirmed before push or base cleanup", async () => {
  const forge = fakeForge();
  await forge.publishThenDeleteOldBase();
  expect(forge.log).toEqual(["retarget export to main", "push export", "caller may now delete capture"]);
  expect(forge.request.mock.calls.find(([, args]) => args.method === "PATCH")?.[1].body).toEqual({ base: "main" });
});

test("a retarget failure leaves the old base and child head untouched", async () => {
  const forge = fakeForge({ failRetarget: true });
  await expect(forge.publishThenDeleteOldBase()).rejects.toThrow("did not confirm");
  expect(forge.log).toEqual(["retarget export to main"]);
});

test("a linked stack waits for GitHub and proceeds when GitHub retargets it", async () => {
  const old = fakeForge({ linked: true });
  await expect(old.publishThenDeleteOldBase()).rejects.toThrow("Waiting for GitHub");
  expect(old.log).toEqual([]);
  const moved = fakeForge({ linked: true, base: "main" });
  await moved.publishThenDeleteOldBase();
  expect(moved.log).toEqual(["push export", "caller may now delete capture"]);
});

test("a stale catalog link prevents retarget if the Stack API cannot confirm it", async () => {
  const forge = fakeForge({ stackApiUnavailable: true });
  await expect(forge.publishThenDeleteOldBase({ ...stack, number: 3 })).rejects.toThrow("Stack API unavailable");
  expect(forge.log).toEqual([]);
});

test("a child head change after membership lookup prevents retarget and push", async () => {
  const forge = fakeForge({ race: true });
  await expect(forge.publishThenDeleteOldBase()).rejects.toThrow("changed before retargeting");
  expect(forge.log).toEqual([]);
});
