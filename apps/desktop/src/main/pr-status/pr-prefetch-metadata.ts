import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { bundledGitExecutable } from "../bundled-git";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";
import { getSelectedManagedGit } from "../git-command";
import { gitCommandPreference, gitRuntimeEnvironment } from "../git-runtime";
import { isGitConfigNoMatch, REMOTE_CONFIG_KEYS, type createScheduledPrefetchRemoteReader, type GitHubRepoRef } from "./git-remote";
import { parseGitRemoteConfiguration } from "./git-remote-config";
import { runPrMetadataGit } from "./pr-metadata-process";
import { confirmPrFilesCheckout, observePrCheckoutConfigFiles, observeProvenRemoteHeads } from "./pr-remote-heads";

const MAX_CONFIG_INCLUDES = 16;

type PrefetchMetadata = {
  repos: GitHubRepoRef[];
  refreshedRemoteNames: string[];
  refreshRemoteNames?: boolean;
  publish?: () => void;
  nativeHeadReads?: true;
  proof?: { heads?: ReadonlyMap<string, string>; unchanged: () => Promise<boolean> };
};

export type ScheduledPrPrefetchMetadataScope = {
  branchCount: number;
  repositories: ReturnType<typeof createScheduledPrefetchRemoteReader>;
  configOutputTooLarge?: true;
  includePaths?: string[];
};

function prefetchGitInputs(cwd: string) {
  const env = buildPwrAgentChildProcessEnv(process.env);
  if (process.platform === "win32" || gitCommandPreference(env) || getSelectedManagedGit()) return "native-only" as const;
  if (!path.isAbsolute(cwd) || Object.keys(env).some((key) =>
    /^(GIT_(DIR|WORK_TREE|COMMON_DIR|IMPLICIT_WORK_TREE|OBJECT_DIRECTORY|NAMESPACE|CONFIG|CONFIG_COUNT|CONFIG_PARAMETERS|TEST_.*))$/i.test(key))) {
    return undefined;
  }
  const runtime = gitRuntimeEnvironment(env);
  const { GIT_CONFIG_SYSTEM: system, GIT_CONFIG_NOSYSTEM: noSystem, GIT_CONFIG_GLOBAL: global, HOME: home, XDG_CONFIG_HOME: xdg } = runtime;
  if (noSystem !== undefined && noSystem !== "0" && noSystem !== "1") return undefined;
  if (noSystem !== "1" && (!system || !path.isAbsolute(system))) return undefined;
  // Joining a path removes parent components before the filesystem can
  // follow any symlinks. Git can reach a different config with the raw path.
  if (global === undefined && (!home || !path.isAbsolute(home) || hasParentComponent(home)
    || (xdg && (!path.isAbsolute(xdg) || hasParentComponent(xdg))))) return undefined;
  if (global !== undefined && !path.isAbsolute(global)) return undefined;

  const paths = global !== undefined
    ? [global]
    : [path.join(xdg || path.join(home!, ".config"), "git/config"), path.join(home!, ".gitconfig")];
  if (noSystem !== "1") paths.push(system!);
  paths.push(bundledGitExecutable());
  if (paths.some((file) => /[\r\n\uFFFD]/.test(file) || hasParentComponent(file))) return undefined;
  return { env, paths: paths.map((file) => path.normalize(file)) };
}

function hasParentComponent(file: string): boolean {
  return file.split("/").includes("..");
}

function configPath(directory: string, value: string): string | undefined {
  // Leave interpolation and paths crossing a parent component to Git.
  if (!value || /^[~%]/.test(value) || /[\r\n\uFFFD]/.test(value) || hasParentComponent(value)) return undefined;
  return path.resolve(directory, value);
}

function parseConfigWithOrigins(cwd: string, stdout: string) {
  const records = stdout.split("\0");
  if (records.pop() !== "" || records.length % 3 !== 0) return undefined;
  const origins = new Set<string>();
  const localOrigins = new Set<string>();
  const includes = new Set<string>();
  const config: string[] = [];
  let canTrackIncludes = true;
  for (let index = 0; index < records.length; index += 3) {
    const [scope, origin, record] = records.slice(index, index + 3);
    const file = origin.startsWith("file:") ? configPath(cwd, origin.slice("file:".length)) : undefined;
    if (file) {
      origins.add(file);
      if (scope === "local") localOrigins.add(file);
    } else {
      canTrackIncludes = false;
    }
    if (record.startsWith("include.") || record.startsWith("includeif.")) {
      // Conditional includes can change without a write to the including file.
      const included = file && record.startsWith("include.path\n")
        ? configPath(path.dirname(file), record.slice("include.path\n".length)) : undefined;
      if (included) includes.add(included);
      else canTrackIncludes = false;
      if (record.startsWith("includeif.")) config.push(scope, record);
    } else {
      config.push(scope, record);
    }
  }
  const configuration = parseGitRemoteConfiguration([...config, ""].join("\0"));
  return configuration && {
    configuration,
    sources: canTrackIncludes && includes.size <= MAX_CONFIG_INCLUDES ? { origins, localOrigins, includes } : undefined,
  };
}

export async function observeScheduledPrPrefetchMetadata(
  cwd: string, scope: ScheduledPrPrefetchMetadataScope,
): Promise<PrefetchMetadata | undefined> {
  const { repositories, branchCount } = scope;
  const currentInputs = () => {
    try { return prefetchGitInputs(cwd); } catch { return undefined; }
  };
  const readFallback = async (options: { useGitRemote?: true; preferCachedIdentity?: true }) => {
    const observation = await repositories.read(undefined, options);
    return { ...observation, refreshedRemoteNames: observation.refreshedRemoteNames ?? [] };
  };
  try {
    if (repositories.shouldSkipLookup()) return { repos: [], refreshedRemoteNames: [] };
    if (scope.configOutputTooLarge || repositories.usesGitRemote()) return undefined;
    const inputs = currentInputs();
    if (inputs === "native-only") return await readFallback({ preferCachedIdentity: true });
    if (!inputs) return undefined;
    const roots = await observePrCheckoutConfigFiles(cwd, inputs.paths);
    if (!roots) return undefined;
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
    const parsed = config ? parseConfigWithOrigins(roots.directory, config.stdout)
      : { configuration: { names: [], remotes: [] }, sources: undefined };
    if (!parsed) return await readFallback({ useGitRemote: true });
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
    const verifyHeadsBeforeConfirming = extra.length > 0 && Boolean(files) && originsWatched
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
    // Resolve identities from the config Git already sampled. OpenSSH aliases
    // use one expansion per observation, bounded by the scheduled batch.
    const { repos, sshIdentityUnchanged, publish } = await repositories.read(configuration, {
      configSampleOrder,
      validateNegative: async () => Boolean((!config || sources) && await configUnchanged()),
    });
    const sample = {
      repos, refreshedRemoteNames: remoteNames, refreshRemoteNames: !sources,
      publish: sources ? publish : undefined,
    };
    const currentSample = async () => await configUnchanged() ? sample : undefined;
    // Keep Git's current config answer for the ordinary branch path even
    // when it cannot support reuse of the checkout observation.
    if (!sources || !repos.length) return await currentSample();

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
