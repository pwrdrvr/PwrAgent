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
  publish?: () => void;
  nativeHeadReads?: true;
  proof?: { heads?: ReadonlyMap<string, string>; unchanged: () => Promise<boolean> };
};

function prefetchGitInputs(cwd: string) {
  const env = buildPwrAgentChildProcessEnv(process.env);
  if (process.platform === "win32" || !path.isAbsolute(cwd) || gitCommandPreference(env) || getSelectedManagedGit()
    || Object.keys(env).some((key) => /^(GIT_(DIR|WORK_TREE|COMMON_DIR|IMPLICIT_WORK_TREE|OBJECT_DIRECTORY|NAMESPACE|CONFIG|CONFIG_COUNT|CONFIG_PARAMETERS|TEST_.*))$/i.test(key))) {
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
  cwd: string, repositories: ReturnType<typeof createScheduledPrefetchRemoteReader>, branchCount: number,
): Promise<PrefetchMetadata | undefined> {
  const currentInputs = () => {
    try { return prefetchGitInputs(cwd); } catch { return undefined; }
  };
  try {
    if (repositories.shouldSkipLookup()) return { repos: [], refreshedRemoteNames: [] };
    if (repositories.usesGitRemote()) return undefined;
    const inputs = currentInputs();
    if (!inputs) return undefined;
    const roots = await observePrCheckoutConfigFiles(cwd, inputs.paths);
    if (!roots) return undefined;
    const readConfig = () => runPrMetadataGit(cwd, [
      "config", "--null", "--show-scope", "--show-origin", "--includes", "--get-regexp", `${REMOTE_CONFIG_KEYS}|^include\\.|^includeif\\.`,
    ], { purpose: "pr-remotes", env: inputs.env, maxBuffer: 64 * 1024, timeout: 2_000 });
    const config = await readConfig().catch((error: unknown) => {
      if (isGitConfigNoMatch(error)) return undefined;
      throw error;
    });
    if (config?.stderr) return undefined;
    const parsed = config ? parseConfigWithOrigins(roots.directory, config.stdout)
      : { configuration: { names: [], remotes: [] }, sources: undefined };
    if (!parsed) {
      const { repos, refreshedRemoteNames, publish } = await repositories.read(undefined, { useGitRemote: true });
      return { repos, refreshedRemoteNames: refreshedRemoteNames ?? [], publish };
    }
    const { configuration, sources } = parsed;
    const inputsUnchanged = () => isDeepStrictEqual(inputs, currentInputs());
    // A discovered include could have changed before we could observe its
    // file. Confirm the first answer with the complete graph watched before
    // retaining either a positive or a negative result.
    const extra = sources ? [...sources.includes].filter((file) => !roots.paths.has(file)) : [];
    const files = extra.length ? await observePrCheckoutConfigFiles(cwd, [...inputs.paths, ...extra]) : roots;
    if (!files || (sources && [...sources.origins].some((file) => !files.paths.has(file)))) {
      // Git can read includes we cannot watch, such as symlinks. Use its
      // answer for this branch without retaining a negative or publishing it.
      const { repos } = await repositories.read(configuration, { validateNegative: async () => false });
      if (!await roots.unchanged() || !inputsUnchanged()) return undefined;
      return { repos, refreshedRemoteNames: configuration.names };
    }
    if (extra.length) {
      const confirmed = await readConfig();
      if (confirmed.stderr !== "" || confirmed.stdout !== config?.stdout) return undefined;
    }
    const configUnchanged = async () => Boolean(await files.unchanged()
      && (files === roots || await roots.unchanged()) && inputsUnchanged());
    // Resolve identities from the config Git already sampled. OpenSSH aliases
    // use one expansion per observation, bounded by the scheduled batch.
    const { repos, sshIdentityUnchanged, publish } = await repositories.read(configuration, {
      validateNegative: async () => Boolean((!config || sources) && await configUnchanged()),
    });
    const remoteNames = configuration.names;
    const sample = { repos, refreshedRemoteNames: remoteNames, publish: sources ? publish : undefined };
    const currentSample = async () => await configUnchanged() ? sample : undefined;
    // Keep Git's current config answer for the ordinary branch path even
    // when it cannot support reuse of the checkout observation.
    if (!sources || !repos.length) return await currentSample();

    // A single remote still needs one native HEAD read per branch.
    if (remoteNames.length === 1 && !extra.length && branchCount <= 2) return await currentSample();

    const proof = await observeProvenRemoteHeads(cwd, remoteNames);
    if (proof && (proof.gitDir !== files.gitDir || proof.commonDir !== files.commonDir)) return undefined;
    // Git's exact local config origin can establish config reuse without a
    // HEAD proof. Native HEAD and tracking reads still run for each branch.
    const configOnly = !proof && (Boolean(extra.length && sources.localOrigins.has(path.join(files.commonDir, "config")))
      || (remoteNames.length === 1 && branchCount > (extra.length ? 3 : 2) && await confirmPrFilesCheckout(cwd, files, inputs.env)));
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
