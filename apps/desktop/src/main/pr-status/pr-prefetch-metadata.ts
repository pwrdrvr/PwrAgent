import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isGitConfigNoMatch, REMOTE_CONFIG_KEYS, type createScheduledPrefetchRemoteReader, type GitHubRepoRef } from "./git-remote";
import { parsePrConfigWithOrigins, readPrConfigInputs } from "./pr-config-observation";
import { runPrMetadataGit } from "./pr-metadata-process";
import { confirmPrFilesCheckout, observePrCheckoutConfigFiles, observeProvenRemoteHeads } from "./pr-remote-heads";

type PrefetchMetadata = {
  repos: GitHubRepoRef[];
  refreshedRemoteNames: string[];
  refreshRemoteNames?: boolean;
  publish?: () => Promise<void>;
  nativeHeadReads?: true;
  proof?: { heads?: ReadonlyMap<string, string>; unchanged: () => Promise<boolean> };
};

export type ScheduledPrPrefetchMetadataScope = {
  branchCount: number;
  repositories: ReturnType<typeof createScheduledPrefetchRemoteReader>;
  configOutputTooLarge?: true;
  includePaths?: string[];
  watchingNativeConfig?: true;
};

export async function observeScheduledPrPrefetchMetadata(
  cwd: string, scope: ScheduledPrPrefetchMetadataScope,
): Promise<PrefetchMetadata | undefined> {
  const { repositories, branchCount } = scope;
  const currentInputs = () => {
    try { return readPrConfigInputs(cwd); } catch { return undefined; }
  };
  const readFallback = async (options: { useGitRemote?: true; preferLiveIdentity?: true; verifyPublication?: () => Promise<boolean> }) => {
    const observation = await repositories.read(undefined, options);
    return { ...observation, refreshedRemoteNames: observation.refreshedRemoteNames ?? [] };
  };
  try {
    if (repositories.shouldSkipLookup()) return { repos: [], refreshedRemoteNames: [] };
    if (scope.configOutputTooLarge || repositories.usesGitRemote()) return undefined;
    const inputs = currentInputs();
    if (inputs === "native-only") return await readFallback({ preferLiveIdentity: true });
    if (!inputs) return undefined;
    if (inputs.nativeOnly && !scope.watchingNativeConfig && repositories.hasLiveIdentity()) return await readFallback({ preferLiveIdentity: true });
    const roots = await observePrCheckoutConfigFiles(cwd, inputs.paths);
    if (!roots) return undefined;
    if (inputs.nativeOnly) scope.watchingNativeConfig = true;
    // Watch known includes before sampling the next branch's config. This
    // remembers only the paths to watch, independent of any previous answer.
    const knownIncludes = scope.includePaths;
    const knownFiles = knownIncludes?.length
      ? await observePrCheckoutConfigFiles(cwd, [...inputs.paths, ...knownIncludes])
      : undefined;
    const readConfig = () => runPrMetadataGit(cwd, [
      "config", "--null", "--show-scope", "--show-origin", "--includes", "--get-regexp", `${REMOTE_CONFIG_KEYS}|^include\\.`,
    ], { purpose: "pr-remotes", env: inputs.env, maxBuffer: 64 * 1024, timeout: 2_000 }).then((output) => ({
      ...output, sampleOrder: repositories.nextSampleOrder(),
    })).catch((error: unknown) => {
      if (isGitConfigNoMatch(error)) return undefined;
      if (error && typeof error === "object" && "code" in error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        // Keep reading current config through the ordinary path for this batch.
        scope.configOutputTooLarge = true;
      }
      throw error;
    });
    const config = await readConfig();
    let configSampleOrder = config?.sampleOrder ?? repositories.nextSampleOrder();
    if (config?.stderr) return undefined;
    const parsed = config ? parsePrConfigWithOrigins(roots.directory, config.stdout)
      : { configuration: { names: [], remotes: [] }, sources: undefined };
    const rootsUnchanged = async () => Boolean(await roots.unchanged() && isDeepStrictEqual(inputs, currentInputs()));
    if (!parsed?.configuration) {
      const sources = parsed?.sources;
      // A rejected config layout can still give Git's effective source files.
      // Only publish native URL reads when that entire graph was watched.
      const verifyPublication = sources && !sources.includes.size && sources.localOrigins.has(path.join(roots.commonDir, "config"))
        && [...sources.origins].every((file) => roots.paths.has(file)) ? rootsUnchanged : undefined;
      return await readFallback({ useGitRemote: true, verifyPublication });
    }
    const { configuration, sources } = parsed;
    const remoteNames = configuration.names;
    const inputsUnchanged = () => isDeepStrictEqual(inputs, currentInputs());
    // A discovered include could have changed before we could observe its
    // file. Confirm the first answer with the complete graph watched before
    // retaining either a positive or a negative result.
    const extra = sources ? [...sources.includes].filter((file) => !roots.paths.has(file)) : [];
    const singleRemote = remoteNames.length === 1;
    const canReuseConfig = Boolean(extra.length && sources?.localOrigins.has(path.join(roots.commonDir, "config")));
    const canConfirmCheckout = singleRemote && branchCount > (extra.length ? 3 : 2);
    const includesWatchedBeforeRead = knownFiles && isDeepStrictEqual(extra, knownIncludes);
    const files = includesWatchedBeforeRead ? knownFiles
      : extra.length ? await observePrCheckoutConfigFiles(cwd, [...inputs.paths, ...extra]) : roots;
    const originsWatched = !sources || [...sources.origins].every((file) => files?.paths.has(file));
    scope.includePaths = files && originsWatched && extra.length ? extra : undefined;
    // With a warm identity and no config-only reuse path, only a remote HEAD
    // proof can pay for confirming the include graph.
    const verifyHeadsBeforeConfirming = !inputs.nativeOnly && extra.length > 0 && Boolean(files) && originsWatched
      && !canReuseConfig && !canConfirmCheckout && repositories.hasGitHubIdentityFor(configuration);
    const earlyHeadProof = verifyHeadsBeforeConfirming ? await observeProvenRemoteHeads(cwd, remoteNames) : undefined;
    if (!files || !originsWatched || (verifyHeadsBeforeConfirming && !earlyHeadProof && !includesWatchedBeforeRead)) {
      // An unverified sample applies only to the current branch. It cannot
      // establish a reusable negative or warm the live cache.
      const { repos } = await repositories.read(configuration, { configSampleOrder, validateNegative: async () => false });
      if (!await roots.unchanged() || !inputsUnchanged()) return undefined;
      // Git must list the current names when we cannot verify the config sample.
      return {
        repos, refreshedRemoteNames: remoteNames, refreshRemoteNames: true,
        nativeHeadReads: verifyHeadsBeforeConfirming ? true : undefined,
      };
    }
    if (extra.length && !includesWatchedBeforeRead) {
      const confirmed = await readConfig();
      if (confirmed?.stderr !== "" || confirmed.stdout !== config?.stdout) return undefined;
      configSampleOrder = confirmed.sampleOrder;
    }
    const configUnchanged = async () => Boolean(await files.unchanged()
      && (files === roots || await roots.unchanged()) && inputsUnchanged());
    const nativeConfigVerified = inputs.nativeOnly && sources?.localOrigins.has(path.join(files.commonDir, "config"));
    // Resolve identities from the config Git already sampled. OpenSSH aliases
    // use one expansion per observation, bounded by the scheduled batch.
    const { repos, sshIdentityUnchanged, publish } = await repositories.read(configuration, {
      configSampleOrder,
      validateNegative: async () => Boolean((!config || sources) && await configUnchanged()),
      verifyPublication: nativeConfigVerified ? configUnchanged : undefined,
    });
    const sample = {
      repos, refreshedRemoteNames: remoteNames, refreshRemoteNames: inputs.nativeOnly || !sources,
      publish: sources ? publish : undefined,
    };
    const currentSample = async () => await configUnchanged() ? sample : undefined;
    // Keep Git's current config answer for the ordinary branch path even
    // when it cannot support reuse of the checkout observation.
    if (!sources || !repos.length) return await currentSample();

    if (inputs.nativeOnly) {
      const unchanged = async () => Boolean(await configUnchanged() && (!sshIdentityUnchanged || sshIdentityUnchanged()));
      if (!await unchanged()) return undefined;
      // Git still owns the branch's remote-list and ref reads. Reuse only
      // the effective config tied to this checkout's watched local origin.
      return {
        ...sample, nativeHeadReads: true,
        proof: nativeConfigVerified ? { unchanged } : undefined,
      };
    }

    // A single remote still needs one native HEAD read per branch.
    if (singleRemote && !extra.length && !canConfirmCheckout) return await currentSample();

    const proof = verifyHeadsBeforeConfirming ? earlyHeadProof : await observeProvenRemoteHeads(cwd, remoteNames);
    if (proof && (proof.gitDir !== files.gitDir || proof.commonDir !== files.commonDir)) return undefined;
    // Git's exact local config origin can establish config reuse without a
    // HEAD proof. Native HEAD and tracking reads still run for each branch.
    const configOnly = !proof && (canReuseConfig || (canConfirmCheckout && await confirmPrFilesCheckout(cwd, files, inputs.env)));
    const unchanged = async () => Boolean((!proof || await proof.unchanged()) && await configUnchanged()
      && (!sshIdentityUnchanged || sshIdentityUnchanged()));
    if (!await unchanged()) return undefined;
    return {
      ...sample,
      nativeHeadReads: proof ? undefined : true,
      proof: proof || configOnly ? { heads: proof?.heads, unchanged } : undefined,
    };
  } catch {
    // Let the ordinary Git commands decide unsupported or unstable reads.
    return undefined;
  }
}
