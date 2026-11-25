import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import * as git from "../app-server/git-executable";
import { prGitSubprocessCaller } from "../diagnostics/git-subprocess-diagnostics";
import { clearGitHubRemoteCache, parseForgeRemote, resolveGitHubRepoForDirectory } from "../pr-status/git-remote";
import { createInventoryRemoteConfigReader } from "../pr-status/git-remote-inventory";
import { filterStoredDiscoveredPullRequests } from "../pr-status/pr-detection";
import { PR_METADATA_PRIORITY } from "../pr-status/pr-metadata-process";
import * as checkoutConfig from "../pr-status/pr-remote-heads";
import { isolateProcessGitEnvironment } from "./helpers/isolated-git";

const origin = "https://github.com/fixture/original.git";
const editedOrigin = "https://github.com/fixture/edited.git";

async function ordinaryWorktrees() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-owner-remote-oracle-")));
  const restoreEnv = isolateProcessGitEnvironment(root);
  onTestFinished(async () => {
    clearGitHubRemoteCache();
    restoreEnv();
    await rm(root, { recursive: true, force: true });
  });
  const clone = path.join(root, "clone");
  await git.runGitCommand(root, ["init", "-b", "main", clone]);
  await git.runGitCommand(clone, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "--allow-empty", "-m", "fixture"]);
  await git.runGitCommand(clone, ["config", "extensions.worktreeConfig", "true"]);
  await git.runGitCommand(clone, ["remote", "add", "origin", origin]);
  const checkouts: string[] = [];
  for (let index = 0; index < 6; index++) {
    const checkout = path.join(root, `worktree-${index}`);
    await git.runGitCommand(clone, ["worktree", "add", "--detach", checkout]);
    checkouts.push(checkout);
  }
  return { root, clone, checkouts };
}

it.skipIf(process.platform === "win32")("shares a conventional SSH origin's Git config while retaining SSH and action authority", async () => {
  const { clone, checkouts } = await ordinaryWorktrees();
  const sshOrigin = "git@fixture-alias:fixture/original.git";
  await git.runGitCommand(clone, ["remote", "set-url", "origin", sshOrigin]);
  const expected = await Promise.all(checkouts.map(async (cwd) => {
    const remote = parseForgeRemote((await git.runGitCommand(cwd, ["remote", "get-url", "origin"])).stdout);
    return { ...remote, host: "github.com" };
  }));
  const runner = vi.spyOn(git, "runGitCommand");
  onTestFinished(() => { runner.mockRestore(); });

  const inventoryConfig = createInventoryRemoteConfigReader();
  const resolveSshHostname = vi.fn(async () => "github.com");
  const read = (cwd: string, fresh = false) => resolveGitHubRepoForDirectory(cwd, { inventoryConfig, resolveSshHostname, fresh });
  const configStarts = () => runner.mock.calls.filter(([, args, options]) =>
    options?.purpose === "pr-remotes" && args[0] === "config");
  expect(await Promise.all(checkouts.map((cwd) => read(cwd)))).toEqual(expected);
  expect(resolveSshHostname).toHaveBeenCalledWith("fixture-alias");
  // Checkout-independent config gets one Git sample. The raw SSH URL still
  // goes through the same resolver that a per-checkout read would use.
  expect(configStarts()).toHaveLength(1);

  const [selected] = checkouts;
  await git.runGitCommand(selected, ["config", "--worktree", `url.${editedOrigin}.insteadOf`, sshOrigin]);
  const current = await git.runGitCommand(selected, ["remote", "get-url", "origin"]);
  expect(parseForgeRemote(current.stdout)).toEqual(parseForgeRemote(editedOrigin));
  expect(await read(selected, true)).toEqual(parseForgeRemote(current.stdout));
  expect(configStarts()).toHaveLength(2);
});

it.skipIf(process.platform === "win32")("refreshes stored default branches without listing proved remote names again", async () => {
  const { clone, checkouts } = await ordinaryWorktrees();
  await git.runGitCommand(clone, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  const epoch = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(epoch);
  const runner = vi.spyOn(git, "runGitCommand");
  onTestFinished(() => { clock.mockRestore(); runner.mockRestore(); });
  const inventoryConfig = createInventoryRemoteConfigReader();
  await Promise.all(checkouts.map((cwd) => resolveGitHubRepoForDirectory(cwd, { inventoryConfig })));
  const attachments = checkouts.map((cwd, index) => ({
    number: index + 1, provider: "github.com" as const, org: "fixture", repo: "original",
    lifecycleState: "open" as const, state: "passing" as const,
    url: `https://github.com/fixture/original/pull/${index + 1}`,
    linkedDirectoryPaths: [cwd], headRefName: "topic",
  }));
  const read = () => filterStoredDiscoveredPullRequests(attachments);
  const lists = () => runner.mock.calls.filter(([, args, options]) => options?.purpose === "pr-discovery" && args[0] === "remote");
  expect(await read()).toEqual(attachments);

  runner.mockClear();
  clock.mockReturnValue(epoch + 62_000);
  expect(await read()).toEqual(attachments);
  expect(lists()).toHaveLength(0);

  // Git's current default still governs expiry when remote names remain the
  // same. A changed config must return name authority to native Git as well.
  await git.runGitCommand(clone, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/topic"]);
  expect((await git.runGitCommand(clone, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).stdout.trim()).toBe("origin/topic");
  clock.mockReturnValue(epoch + 124_000);
  expect(await read()).toEqual([]);
  expect(lists()).toHaveLength(0);

  await git.runGitCommand(clone, ["remote", "rename", "origin", "renamed"]);
  await git.runGitCommand(clone, ["symbolic-ref", "refs/remotes/renamed/HEAD", "refs/remotes/renamed/main"]);
  clock.mockReturnValue(epoch + 186_000);
  expect(await read()).toEqual(attachments);
  expect(lists()).toHaveLength(checkouts.length);
});

it.skipIf(process.platform === "win32").each(["common", "global", "worktree"] as const)(
  "keeps per-checkout Git authority when %s config changes during the seed read",
  async (scope) => {
    const { clone, checkouts } = await ordinaryWorktrees();
    let seed: string | undefined;
    const runGit = git.runGitCommand;
    const runner = vi.spyOn(git, "runGitCommand").mockImplementation(async (cwd, args, options) => {
      const result = await runGit(cwd, args, options);
      if (!seed && options?.purpose === "pr-remotes" && args.includes("--show-origin")) {
        seed = cwd;
        const sibling = checkouts.find((checkout) => checkout !== cwd)!;
        if (scope === "common") await runGit(clone, ["config", "remote.origin.url", editedOrigin]);
        else await runGit(sibling, ["config", `--${scope}`, `url.${editedOrigin}.insteadOf`, origin]);
      }
      return result;
    });
    onTestFinished(() => { runner.mockRestore(); });

    const inventoryConfig = createInventoryRemoteConfigReader();
    const actual = await Promise.all(checkouts.map((cwd) => resolveGitHubRepoForDirectory(cwd, { inventoryConfig })));
    expect(seed).toBeDefined();
    const expected = await Promise.all(checkouts.map(async (cwd) => {
      const current = await runGit(cwd, ["remote", "get-url", "origin"]);
      return parseForgeRemote(current.stdout);
    }));
    expect(expected.filter((repo) => repo?.repo === "edited")).toHaveLength(scope === "worktree" ? 1 : checkouts.length);
    // The seed owns its earlier Git answer. A sibling can borrow it only
    // while its own discovery and the shared config inputs still agree.
    expect(actual).toEqual(expected.map((repo, index) =>
      checkouts[index] === seed ? parseForgeRemote(origin) : repo,
    ));
    await expect(resolveGitHubRepoForDirectory(seed!, { fresh: true }))
      .resolves.toEqual(expected[checkouts.indexOf(seed!)]);
  },
);

it.skipIf(process.platform === "win32")("keeps an inactive branch include from supplying sibling config", async () => {
  const { root, clone, checkouts } = await ordinaryWorktrees();
  const changed = checkouts.at(-1)!;
  const include = path.join(root, "branch-config");
  await writeFile(include, `[url "${editedOrigin}"]\n\tinsteadOf = ${origin}\n`);
  await git.runGitCommand(changed, ["switch", "-c", "edited-worktree"]);
  await git.runGitCommand(clone, ["config", "includeIf.onbranch:edited-worktree.path", include]);
  const runner = vi.spyOn(git, "runGitCommand");
  onTestFinished(() => { runner.mockRestore(); });
  const inventoryConfig = createInventoryRemoteConfigReader();
  const actual = await Promise.all(checkouts.map((cwd) => resolveGitHubRepoForDirectory(cwd, { inventoryConfig })));
  const checks = runner.mock.calls.filter(([, , options]) => options?.purpose === "pr-remotes");
  expect(checks.map(([cwd]) => cwd).sort()).toEqual(checkouts.toSorted());
  const expected = await Promise.all(checkouts.map(async (cwd) =>
    parseForgeRemote((await git.runGitCommand(cwd, ["remote", "get-url", "origin"])).stdout),
  ));
  expect(expected.at(-1)).toEqual(parseForgeRemote(editedOrigin));
  expect(actual).toEqual(expected);
});

it.skipIf(process.platform === "win32")("only confirms shared includes when a sibling requests the config", async () => {
  const { root, checkouts } = await ordinaryWorktrees();
  const include = path.join(root, "included-config");
  await writeFile(include, "[core]\n\tautocrlf = false\n");
  await git.runGitCommand(root, ["config", "--global", "include.path", include]);
  const runner = vi.spyOn(git, "runGitCommand");
  onTestFinished(() => { runner.mockRestore(); });
  const inventoryConfig = createInventoryRemoteConfigReader();
  const read = (cwd: string) => resolveGitHubRepoForDirectory(cwd, { inventoryConfig });
  const probePaths = () => runner.mock.calls.flatMap(([cwd, , options]) => options?.purpose === "pr-remotes" ? [cwd] : []);
  await expect(read(checkouts[0])).resolves.toEqual(parseForgeRemote(origin));
  expect(probePaths()).toEqual([checkouts[0]]);
  await expect(Promise.all(checkouts.slice(1).map(read))).resolves.toEqual(checkouts.slice(1).map(() => parseForgeRemote(origin)));
  expect(probePaths()).toEqual([checkouts[0], checkouts[0]]);
});

it.skipIf(process.platform === "win32")("reaudits shared config for a checkout observed after verification began", async () => {
  const { root, checkouts: [seed, early, late] } = await ordinaryWorktrees();
  const verified = Promise.withResolvers<void>();
  const observedLate = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let held = false;
  const observeConfig = checkoutConfig.observePrCheckoutConfigFiles;
  const configFiles = vi.spyOn(checkoutConfig, "observePrCheckoutConfigFiles").mockImplementation(async (...args) => {
    const files = await observeConfig(...args);
    return files && { ...files, unchanged: async (demand) => {
      const current = await files.unchanged(demand);
      if (!held) {
        held = true;
        verified.resolve();
        await release.promise;
      }
      return current;
    } };
  });
  const observeLinked = checkoutConfig.observeLinkedPrCheckout;
  const checkoutFiles = vi.spyOn(checkoutConfig, "observeLinkedPrCheckout").mockImplementation(async (...args) => {
    const files = await observeLinked(...args);
    if (args[0] === late) observedLate.resolve();
    return files;
  });
  onTestFinished(() => {
    checkoutFiles.mockRestore();
    configFiles.mockRestore();
  });
  const inventoryConfig = createInventoryRemoteConfigReader();
  const read = (cwd: string) => resolveGitHubRepoForDirectory(cwd, { inventoryConfig });
  await expect(read(seed)).resolves.toEqual(parseForgeRemote(origin));
  const reads = [read(early)];
  try {
    await Promise.race([verified.promise, reads[0].then(() => { throw new Error("No shared verification"); })]);
    await git.runGitCommand(root, ["config", "--global", `url.${editedOrigin}.insteadOf`, origin]);
    reads.push(read(late));
    await observedLate.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    release.resolve();
    await expect(Promise.all(reads)).resolves.toEqual([parseForgeRemote(origin), parseForgeRemote(editedOrigin)]);
  } finally {
    release.resolve();
    await Promise.allSettled(reads);
  }
});

it.skipIf(process.platform === "win32")("keeps a bounded page independent of an unfinished owner read", async () => {
  const { checkouts: [cwd] } = await ordinaryWorktrees();
  const queued = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = git.runGitCommand;
  const callers: Array<ReturnType<typeof prGitSubprocessCaller.getStore>> = [];
  const runner = vi.spyOn(git, "runGitCommand").mockImplementation(async (checkout, args, options) => {
    if (options?.purpose === "pr-remotes" && args.includes("--show-origin")) {
      queued.resolve();
      await release.promise;
    }
    if (options?.purpose === "pr-remotes") callers.push(prGitSubprocessCaller.getStore());
    return await original(checkout, args, options);
  });
  onTestFinished(() => { runner.mockRestore(); });
  const reached = (lookup: Promise<unknown>) => Promise.race([queued.promise, lookup.then(() => {
    throw new Error("The owner completed before it requested the seed config");
  })]);
  const inventoryConfig = createInventoryRemoteConfigReader();
  const owner = prGitSubprocessCaller.run("pr-owner-navigation-inventory", () =>
    resolveGitHubRepoForDirectory(cwd, { inventoryConfig, demand: { priority: () => PR_METADATA_PRIORITY.background } }));
  const reads = [owner];
  try {
    await reached(owner);
    // Other inventory callers can join. A page must have its own path to Git
    // while inventory is still waiting for its proof.
    reads.push(resolveGitHubRepoForDirectory(cwd, { inventoryConfig }));
    const page = prGitSubprocessCaller.run("pr-stored-attachment-validation", () =>
      resolveGitHubRepoForDirectory(cwd, { demand: { priority: () => PR_METADATA_PRIORITY.page } }));
    reads.push(page);
    await vi.waitFor(() => expect(callers).toEqual(["pr-stored-attachment-validation"]));
    await expect(page).resolves.toEqual(parseForgeRemote(origin));
    release.resolve();
    await expect(Promise.all(reads)).resolves.toEqual(reads.map(() => parseForgeRemote(origin)));
    expect(callers).toEqual(["pr-stored-attachment-validation", "pr-owner-navigation-inventory"]);
  } finally {
    release.resolve();
    await Promise.allSettled(reads);
  }
});

it.skipIf(process.platform === "win32").each(["native URL", "deleted checkout"] as const)(
  "keeps %s authority independent of a competing inventory sample",
  async (scenario) => {
    const { clone, checkouts: [cwd] } = await ordinaryWorktrees();
    const native = scenario === "native URL";
    const runGit = git.runGitCommand;
    if (native) await runGit(clone, ["config", "remote.origin.tagOpt", "--no-tags"]);
    const inventoryReached = Promise.withResolvers<void>();
    const checkoutReached = Promise.withResolvers<void>();
    const releaseInventory = Promise.withResolvers<void>();
    const releaseCheckout = Promise.withResolvers<void>();
    const runner = vi.spyOn(git, "runGitCommand").mockImplementation(async (directory, args, options) => {
      if (options?.purpose !== "pr-remotes") return runGit(directory, args, options);
      const inventory = prGitSubprocessCaller.getStore() === "pr-owner-navigation-inventory";
      if (!inventory && (native ? args[1] === "get-url" : args[0] === "config")) {
        checkoutReached.resolve();
        await releaseCheckout.promise;
      }
      const result = await runGit(directory, args, options);
      if (inventory && args.includes("--show-origin")) {
        inventoryReached.resolve();
        await releaseInventory.promise;
      }
      return result;
    });
    onTestFinished(() => { runner.mockRestore(); });

    const fromInventory = prGitSubprocessCaller.run("pr-owner-navigation-inventory", () =>
      resolveGitHubRepoForDirectory(cwd, { inventoryConfig: createInventoryRemoteConfigReader() }));
    let fresh: ReturnType<typeof resolveGitHubRepoForDirectory> | undefined;
    let joiningFresh: typeof fresh;
    try {
      await Promise.race([inventoryReached.promise, fromInventory.then(() => { throw new Error("Inventory did not sample Git"); })]);
      const checkoutDemand = { fresh: true, demand: { priority: () => PR_METADATA_PRIORITY.selected } };
      fresh = resolveGitHubRepoForDirectory(cwd, checkoutDemand);
      await Promise.race([checkoutReached.promise, fresh.then(() => { throw new Error("Checkout did not reach Git"); })]);
      joiningFresh = resolveGitHubRepoForDirectory(cwd, checkoutDemand);
      releaseInventory.resolve();
      await expect(fromInventory).resolves.toEqual(parseForgeRemote(origin));
      // The fresh native URL is newer than both earlier reads. A vanished
      // checkout supplies no action authority even if its inventory is warm.
      if (native) await runGit(cwd, ["remote", "set-url", "origin", editedOrigin]);
      else await runGit(clone, ["worktree", "remove", cwd]);
      releaseCheckout.resolve();
      const expected = native ? parseForgeRemote(editedOrigin) : undefined;
      await expect(Promise.all([fresh, joiningFresh])).resolves.toEqual([expected, expected]);
      await expect(resolveGitHubRepoForDirectory(cwd)).resolves.toEqual(parseForgeRemote(native ? editedOrigin : origin));
    } finally {
      releaseInventory.resolve();
      releaseCheckout.resolve();
      await Promise.allSettled([fromInventory, fresh, joiningFresh]);
    }
  },
);

it.skipIf(process.platform === "win32")("orders a borrowed origin after removal of a sibling override", async () => {
  const { checkouts: [seed, sibling] } = await ordinaryWorktrees();
  const inventoryConfig = createInventoryRemoteConfigReader();
  await expect(resolveGitHubRepoForDirectory(seed, { inventoryConfig })).resolves.toEqual(parseForgeRemote(origin));
  const override = `url.${editedOrigin}.insteadOf`;
  await git.runGitCommand(sibling, ["config", "--worktree", override, origin]);
  const config = (await git.runGitCommand(sibling, ["rev-parse", "--path-format=absolute", "--git-path", "config.worktree"])).stdout.trim();

  const checkoutReached = Promise.withResolvers<void>();
  const releaseCheckout = Promise.withResolvers<void>();
  const observeLinked = checkoutConfig.observeLinkedPrCheckout;
  const observe = vi.spyOn(checkoutConfig, "observeLinkedPrCheckout").mockImplementation(async (cwd, demand) => {
    if (cwd === sibling) {
      checkoutReached.resolve();
      await releaseCheckout.promise;
    }
    return observeLinked(cwd, demand);
  });
  onTestFinished(() => { observe.mockRestore(); });
  const inventory = resolveGitHubRepoForDirectory(sibling, { inventoryConfig });
  try {
    await Promise.race([checkoutReached.promise, inventory.then(() => { throw new Error("Inventory did not observe the sibling"); })]);
    await expect(resolveGitHubRepoForDirectory(sibling, { demand: { priority: () => PR_METADATA_PRIORITY.page } }))
      .resolves.toEqual(parseForgeRemote(editedOrigin));
    await rm(config);
    releaseCheckout.resolve();
    await expect(inventory).resolves.toEqual(parseForgeRemote(origin));
    await expect(resolveGitHubRepoForDirectory(sibling)).resolves.toEqual(parseForgeRemote(origin));
  } finally {
    releaseCheckout.resolve();
    await inventory;
  }
});
