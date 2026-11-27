import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import * as git from "../app-server/git-executable";
import { bundledGitDirectory, bundledGitExecutable, configureBundledGit } from "../bundled-git";
import { prGitSubprocessCaller } from "../diagnostics/git-subprocess-diagnostics";
import { setGitCommandResolver } from "../git-command";
import { clearGitHubRemoteCache, observeForgeRepositoriesForDirectory, parseForgeRemote, resolveGitHubRepoForDirectory } from "../pr-status/git-remote";
import { createInventoryRemoteConfigReader } from "../pr-status/git-remote-inventory";
import { filterStoredDiscoveredPullRequests } from "../pr-status/pr-detection";
import { PR_METADATA_PRIORITY } from "../pr-status/pr-metadata-process";
import * as checkoutConfig from "../pr-status/pr-remote-heads";
import { isolateProcessGitEnvironment } from "./helpers/isolated-git";

const origin = "https://github.com/fixture/original.git";
const editedOrigin = "https://github.com/fixture/edited.git";

it.skipIf(process.platform === "win32").each(["wrapper", "command override", "repository override", "remotes", "branches"] as const)(
  "keeps Git's origin authority for a narrow fetch with %s",
  async (scenario) => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-narrow-remote-oracle-")));
    const restore = isolateProcessGitEnvironment(root);
    onTestFinished(async () => {
      clearGitHubRemoteCache();
      restore();
      await rm(root, { recursive: true, force: true });
    });
    await git.runGitCommand(root, ["init", "-b", "main"]);
    await git.runGitCommand(root, ["config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main"]);
    if (scenario === "repository override") {
      const other = path.join(root, "override");
      await git.runGitCommand(root, ["init", "-b", "main", other]);
      await git.runGitCommand(other, ["config", "remote.origin.url", editedOrigin]);
      await git.runGitCommand(other, ["config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main"]);
      process.env.GIT_DIR = path.join(other, ".git");
    } else if (scenario === "wrapper" || scenario === "command override") {
      await git.runGitCommand(root, ["config", "remote.origin.url", origin]);
      if (scenario === "wrapper") {
        // The wrapper supplies a different answer only to the native URL read.
        const wrapper = path.join(root, "git-wrapper");
        await writeFile(wrapper, [
          "#!/bin/sh",
          `if [ "$3 $4 $5 $6" = "remote get-url --all origin" ]; then printf '%s\\n' '${editedOrigin}'; exit; fi`,
          `exec '${bundledGitExecutable()}' "$@"`,
        ].join("\n"), { mode: 0o755 });
        process.env.PWRAGENT_GIT_PATH = wrapper;
      } else {
        process.env.GIT_CONFIG_COUNT = "1";
        process.env.GIT_CONFIG_KEY_0 = `url.${editedOrigin}.insteadOf`;
        process.env.GIT_CONFIG_VALUE_0 = origin;
      }
    } else {
      const legacyDir = path.join(root, ".git", scenario);
      await mkdir(legacyDir, { recursive: true });
      await writeFile(path.join(legacyDir, "origin"), scenario === "remotes" ? `URL: ${editedOrigin}\n` : `${editedOrigin}#main\n`);
    }
    expect((await git.runGitCommand(root, ["remote"])).stdout.trim()).toBe("origin");
    const native = parseForgeRemote((await git.runGitCommand(root, ["remote", "get-url", "--all", "origin"])).stdout);
    expect(native).toEqual(parseForgeRemote(editedOrigin));

    const runner = vi.spyOn(git, "runGitCommand");
    onTestFinished(() => { runner.mockRestore(); });
    const inventoryConfig = createInventoryRemoteConfigReader();
    await expect(resolveGitHubRepoForDirectory(root, { inventoryConfig })).resolves.toEqual(native);
    expect(runner.mock.calls.map(([, args]) => args[0])).toEqual(["config", "remote", "remote"]);
  },
);

async function ordinaryWorktrees(checkoutCount = 6) {
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
  for (let index = 0; index < checkoutCount; index++) {
    const checkout = path.join(root, `worktree-${index}`);
    await git.runGitCommand(clone, ["worktree", "add", "--detach", checkout]);
    checkouts.push(checkout);
  }
  return { root, clone, checkouts };
}

it.skipIf(process.platform === "win32").each([
  { policy: "die", url: "https://fixture:placeholder@github.com/fixture/original.git", error: /plaintext credentials/ },
  { policy: "invalid", url: origin, error: /unrecognized value transfer.credentialsInUrl/ },
])("preserves Git's origin rejection under the $policy credential policy", async ({ policy, url, error }) => {
  const { clone, checkouts: [linked] } = await ordinaryWorktrees(1);
  await git.runGitCommand(clone, ["config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main"]);
  await git.runGitCommand(clone, ["config", "remote.origin.url", url]);
  await git.runGitCommand(clone, ["config", "transfer.credentialsInUrl", policy]);

  const inventoryConfig = createInventoryRemoteConfigReader();
  // A failed native URL read cannot establish an owner repository identity.
  for (const cwd of [clone, linked]) {
    await expect(git.runGitCommand(cwd, ["remote", "get-url", "--all", "origin"])).rejects.toThrow(error);
    await expect.soft(resolveGitHubRepoForDirectory(cwd, { inventoryConfig })).resolves.toBeUndefined();
  }
});

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

it.skipIf(process.platform === "win32").each(["common", "global", "worktree", "system"] as const)(
  "keeps per-checkout Git authority when %s config changes during the seed read",
  async (scope) => {
    const { root, clone, checkouts } = await ordinaryWorktrees();
    if (scope === "system") {
      configureBundledGit(path.dirname(bundledGitDirectory()));
      onTestFinished(() => { configureBundledGit(); });
      process.env.PWRAGENT_GIT_PATH = bundledGitExecutable();
      process.env.GIT_CONFIG_SYSTEM = path.join(root, "system-config");
      delete process.env.GIT_CONFIG_NOSYSTEM;
      await writeFile(process.env.GIT_CONFIG_SYSTEM, "");
    }
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

it.skipIf(process.platform === "win32")("rechecks the selected Git before sharing a packaged config sample", async () => {
  const { root, checkouts: [seed, sibling] } = await ordinaryWorktrees(2);
  configureBundledGit(path.dirname(bundledGitDirectory()));
  const executable = bundledGitExecutable();
  const wrapper = path.join(root, "git-wrapper");
  await writeFile(wrapper, [
    "#!/bin/sh",
    'cwd=$2; shift 2',
    `exec '${executable}' -C "$cwd" -c 'url.${editedOrigin}.insteadOf=${origin}' "$@"`,
  ].join("\n"), { mode: 0o755 });
  let selected = executable;
  setGitCommandResolver(() => selected);
  onTestFinished(() => { setGitCommandResolver(undefined); configureBundledGit(); });

  const runGit = git.runGitCommand;
  const runner = vi.spyOn(git, "runGitCommand").mockImplementation(async (cwd, args, options) => {
    if (cwd === seed && args.includes("--show-origin")) selected = wrapper;
    return await runGit(cwd, args, options);
  });
  onTestFinished(() => { runner.mockRestore(); });

  const inventoryConfig = createInventoryRemoteConfigReader();
  for (const cwd of [seed, sibling]) {
    const observed = await resolveGitHubRepoForDirectory(cwd, { inventoryConfig });
    const native = await runGit(cwd, ["remote", "get-url", "origin"]);
    expect(observed).toEqual(parseForgeRemote(native.stdout));
    expect(observed).toEqual(parseForgeRemote(editedOrigin));
  }
});

async function usePackagedGitWithCompiledSystemConfig(root: string) {
  configureBundledGit(path.dirname(bundledGitDirectory()));
  onTestFinished(() => { configureBundledGit(); });
  process.env.PWRAGENT_GIT_PATH = bundledGitExecutable();
  delete process.env.GIT_CONFIG_NOSYSTEM;
  const system = path.join(root, "compiled-system-config");
  await writeFile(system, "[core]\n\tabbrev = 12\n");
  const runGit = git.runGitCommand;
  return (cwd: string, args: string[], options?: Parameters<typeof runGit>[2]) => runGit(cwd, args, {
    ...options, env: { ...process.env, ...options?.env, GIT_CONFIG_SYSTEM: system },
    // Simulate a compiled path while letting Git report and read the file.
    beforeSpawn: (executable, { GIT_CONFIG_SYSTEM: _system, ...env }) => options?.beforeSpawn?.(executable, env),
  });
}

it.skipIf(process.platform === "win32")("shares healthy checkout config after a malformed checkout asks first", async () => {
  const { root, checkouts } = await ordinaryWorktrees(2);
  const broken = path.join(root, "broken");
  const brokenCheckout = path.join(root, "broken-worktree");
  await git.runGitCommand(root, ["init", "-b", "main", broken]);
  await git.runGitCommand(broken, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "--allow-empty", "-m", "fixture"]);
  await git.runGitCommand(broken, ["worktree", "add", "--detach", brokenCheckout]);
  await writeFile(path.join(broken, ".git", "config"), "[unterminated\n");
  const runGit = await usePackagedGitWithCompiledSystemConfig(root);
  await expect(runGit(brokenCheckout, ["var", "GIT_CONFIG_SYSTEM"])).rejects.toThrow(/bad config line/);
  const expected = await Promise.all(checkouts.map(async (cwd) =>
    parseForgeRemote((await runGit(cwd, ["remote", "get-url", "origin"])).stdout)));

  const runner = vi.spyOn(git, "runGitCommand").mockImplementation(runGit);
  onTestFinished(() => { runner.mockRestore(); });
  const inventoryConfig = createInventoryRemoteConfigReader();
  const read = (cwd: string) => resolveGitHubRepoForDirectory(cwd, { inventoryConfig });
  await expect(read(brokenCheckout)).resolves.toBeUndefined();
  await expect(Promise.all(checkouts.map(read))).resolves.toEqual(expected);
  // The first checkout's local error cannot consume the healthy group's sample.
  expect(runner.mock.calls.filter(([cwd, [verb]]) => checkouts.includes(cwd) && verb === "config")).toHaveLength(1);
});

it.skipIf(process.platform === "win32")("retries a canceled packaged Git system config probe for the next inventory reader", async () => {
  const { root, checkouts: [seed, sibling] } = await ordinaryWorktrees(2);
  const runGit = await usePackagedGitWithCompiledSystemConfig(root);
  const paused = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const drained = Promise.withResolvers<void>();
  let probes = 0;
  let configs = 0;
  const runner = vi.spyOn(git, "runGitCommand").mockImplementation(async (cwd, args, options) => {
    const canceledProbe = args.includes("GIT_CONFIG_SYSTEM") && ++probes === 1;
    try {
      if (canceledProbe) {
        paused.resolve();
        await release.promise;
      }
      if (args[0] === "config") configs++;
      return await runGit(cwd, args, options);
    } finally {
      if (canceledProbe) drained.resolve();
    }
  });
  onTestFinished(() => { runner.mockRestore(); });

  const inventoryConfig = createInventoryRemoteConfigReader();
  const abort = new AbortController();
  const canceled = resolveGitHubRepoForDirectory(seed, { inventoryConfig, demand: { signal: abort.signal } });
  try {
    await Promise.race([paused.promise, canceled.then(() => { throw new Error("Inventory skipped the system config probe"); })]);
    abort.abort();
    await expect(canceled).rejects.toBe(abort.signal.reason);
    const read = (cwd: string) => resolveGitHubRepoForDirectory(cwd, { inventoryConfig });
    await expect(Promise.all([read(seed), read(sibling)])).resolves.toEqual([parseForgeRemote(origin), parseForgeRemote(origin)]);
    expect(probes).toBe(2);
    expect(configs).toBe(1);
  } finally {
    release.resolve();
    if (probes > 0) await drained.promise;
  }
});

it.skipIf(process.platform === "win32").each(["wildcard", "single-branch"] as const)(
  "keeps an inactive branch include from supplying sibling config for a %s fetch",
  async (fetch) => {
    const { root, clone, checkouts } = await ordinaryWorktrees();
    configureBundledGit(path.dirname(bundledGitDirectory()));
    onTestFinished(() => { configureBundledGit(); });
    process.env.PWRAGENT_GIT_PATH = bundledGitExecutable();
    const changed = checkouts.at(-1)!;
    const include = path.join(root, "branch-config");
    if (fetch === "single-branch") {
      await git.runGitCommand(clone, ["config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main"]);
    }
    await writeFile(include, `[url "${editedOrigin}"]\n\tinsteadOf = ${origin}\n`);
    await git.runGitCommand(changed, ["switch", "-c", "edited-worktree"]);
    await git.runGitCommand(clone, ["config", "includeIf.onbranch:edited-worktree.path", include]);
    const runner = vi.spyOn(git, "runGitCommand");
    onTestFinished(() => { runner.mockRestore(); });
    const inventoryConfig = createInventoryRemoteConfigReader();
    const actual = await Promise.all(checkouts.map((cwd) => resolveGitHubRepoForDirectory(cwd, { inventoryConfig })));
    for (const checkout of checkouts) {
      const commands = runner.mock.calls.flatMap(([cwd, [verb], options]) =>
        cwd === checkout && options?.purpose === "pr-remotes" ? [verb] : []);
      expect(commands).toEqual(fetch === "single-branch" ? ["config", "remote", "remote"] : ["config"]);
    }
    const expected = await Promise.all(checkouts.map(async (cwd) =>
      parseForgeRemote((await git.runGitCommand(cwd, ["remote", "get-url", "origin"])).stdout),
    ));
    expect(expected.at(-1)).toEqual(parseForgeRemote(editedOrigin));
    expect(actual).toEqual(expected);
  },
);

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

it.skipIf(process.platform === "win32")("validates the seed's page while sibling include confirmation is pending", async () => {
  const { root, clone, checkouts: [seed, sibling] } = await ordinaryWorktrees();
  const include = path.join(root, "included-config");
  await writeFile(include, "[core]\n\tautocrlf = false\n");
  await git.runGitCommand(root, ["config", "--global", "include.path", include]);
  await git.runGitCommand(clone, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  const confirming = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = git.runGitCommand;
  let configReads = 0;
  const runner = vi.spyOn(git, "runGitCommand").mockImplementation(async (cwd, args, options) => {
    if (cwd === seed && options?.purpose === "pr-remotes" && args.includes("--show-origin") && ++configReads === 2) {
      confirming.resolve();
      await release.promise;
    }
    return await original(cwd, args, options);
  });
  onTestFinished(() => { runner.mockRestore(); });
  const inventoryConfig = createInventoryRemoteConfigReader();
  const read = (cwd: string) => resolveGitHubRepoForDirectory(cwd, { inventoryConfig });
  await expect(read(seed)).resolves.toEqual(parseForgeRemote(origin));
  const pending = read(sibling);
  try {
    await Promise.race([confirming.promise, pending.then(() => { throw new Error("No include confirmation"); })]);
    const attachments = [{
      number: 1, provider: "github.com" as const, org: "fixture", repo: "original",
      lifecycleState: "open" as const, state: "passing" as const,
      url: "https://github.com/fixture/original/pull/1", headRefName: "topic", linkedDirectoryPaths: [seed],
    }];
    const page = filterStoredDiscoveredPullRequests(attachments, {
      demand: { signal: AbortSignal.timeout(2_000), priority: () => PR_METADATA_PRIORITY.page },
    });
    // The foreground page must complete before we release the background Git read.
    await expect(page).resolves.toEqual(attachments);
    expect(runner.mock.calls.filter(([cwd, [verb], options]) =>
      cwd === seed && verb === "remote" && options?.purpose === "pr-discovery")).toHaveLength(1);
  } finally {
    release.resolve();
    await pending;
  }
  await expect(observeForgeRepositoriesForDirectory(seed, undefined, { verifyCachedRemoteNames: true }))
    .resolves.toMatchObject({ refreshedRemoteNames: ["origin"] });
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
