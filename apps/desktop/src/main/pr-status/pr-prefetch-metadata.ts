import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { bundledGitExecutable } from "../bundled-git";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";
import { getSelectedManagedGit } from "../git-command";
import { gitCommandPreference, gitRuntimeEnvironment } from "../git-runtime";
import { readFreshGitHubReposForPrefetch, REMOTE_CONFIG_KEYS, type GitHubRepoRef } from "./git-remote";
import { parseGitRemoteConfiguration } from "./git-remote-config";
import { runPrMetadataGit } from "./pr-metadata-process";
import { confirmPrFilesCheckout, observePrCheckoutConfigFiles, observeProvenRemoteHeads } from "./pr-remote-heads";

const MAX_CONFIG_INCLUDES = 16;

type PrefetchMetadata = {
  repos: GitHubRepoRef[];
  refreshedRemoteNames: string[];
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
  if (global === undefined && (!home || !path.isAbsolute(home) || (xdg && !path.isAbsolute(xdg)))) return undefined;
  if (global !== undefined && !path.isAbsolute(global)) return undefined;

  const paths = global !== undefined
    ? [global]
    : [path.join(xdg || path.join(home!, ".config"), "git/config"), path.join(home!, ".gitconfig")];
  if (noSystem !== "1") paths.push(system!);
  paths.push(bundledGitExecutable());
  if (paths.some((file) => /[\r\n\uFFFD]/.test(file) || file.split("/").includes(".."))) return undefined;
  return { env, paths: paths.map((file) => path.normalize(file)) };
}

function configPath(directory: string, value: string): string | undefined {
  // Leave interpolation and paths crossing a parent component to Git.
  if (!value || /^[~%]/.test(value) || /[\r\n\uFFFD]/.test(value) || value.split("/").includes("..")) return undefined;
  return path.resolve(directory, value);
}

function parseConfigWithOrigins(cwd: string, stdout: string) {
  const records = stdout.split("\0");
  if (records.pop() !== "" || records.length % 3 !== 0) return undefined;
  const origins = new Set<string>();
  const includes = new Set<string>();
  const config: string[] = [];
  let canTrackIncludes = true;
  for (let index = 0; index < records.length; index += 3) {
    const [scope, origin, record] = records.slice(index, index + 3);
    const file = origin.startsWith("file:") ? configPath(cwd, origin.slice("file:".length)) : undefined;
    if (file) origins.add(file);
    else canTrackIncludes = false;
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
    sources: canTrackIncludes && includes.size <= MAX_CONFIG_INCLUDES ? { origins, includes } : undefined,
  };
}

export async function observeScheduledPrPrefetchMetadata(cwd: string): Promise<PrefetchMetadata | undefined> {
  const currentInputs = () => {
    try { return prefetchGitInputs(cwd); } catch { return undefined; }
  };
  try {
    const inputs = currentInputs();
    if (!inputs) return undefined;
    const roots = await observePrCheckoutConfigFiles(cwd, inputs.paths);
    if (!roots) return undefined;
    const readConfig = () => runPrMetadataGit(cwd, [
      "config", "--null", "--show-scope", "--show-origin", "--includes", "--get-regexp", `${REMOTE_CONFIG_KEYS}|^include\\.|^includeif\\.`,
    ], { purpose: "pr-remotes", env: inputs.env, maxBuffer: 64 * 1024, timeout: 2_000 });
    const { stdout, stderr } = await readConfig();
    const parsed = stderr === "" ? parseConfigWithOrigins(roots.directory, stdout) : undefined;
    if (!parsed) return undefined;
    const { configuration, sources } = parsed;
    // Resolve identities from the config Git already sampled. OpenSSH aliases
    // use one expansion per observation, bounded by the scheduled batch.
    const { repos } = await readFreshGitHubReposForPrefetch(cwd, configuration);
    const remoteNames = configuration.names;
    const sample = { repos, refreshedRemoteNames: remoteNames };
    const inputsUnchanged = () => isDeepStrictEqual(inputs, currentInputs());
    const currentSample = async () => await roots.unchanged() && inputsUnchanged() ? sample : undefined;
    // Keep Git's current config answer for the ordinary branch path even
    // when it cannot support reuse of the checkout observation.
    if (!sources || !repos.length) return await currentSample();

    // The first Git read discovers include paths, even absent ones. Before
    // retaining that answer, bracket a second read with all those inputs.
    const extra = [...sources.includes].filter((file) => !roots.paths.has(file));
    const files = extra.length ? await observePrCheckoutConfigFiles(cwd, [...inputs.paths, ...extra]) : roots;
    if (!files || [...sources.origins].some((file) => !files.paths.has(file))) return await currentSample();
    if (extra.length) {
      const confirmed = await readConfig();
      if (confirmed.stderr !== "" || confirmed.stdout !== stdout || !await roots.unchanged()) return undefined;
    }

    const proof = await observeProvenRemoteHeads(cwd, remoteNames);
    if (proof && (proof.gitDir !== files.gitDir || proof.commonDir !== files.commonDir)) return undefined;
    // For a single remote, Git still resolves HEAD per branch. Confirm the
    // checkout once so later branches can reuse just its remote configuration.
    if (!proof && (remoteNames.length !== 1 || !await confirmPrFilesCheckout(cwd, files, inputs.env))) {
      return await files.unchanged() && inputsUnchanged() ? sample : undefined;
    }
    const unchanged = async () => Boolean(await files.unchanged() && (!proof || await proof.unchanged()) && inputsUnchanged());
    return await unchanged() ? { ...sample, proof: { heads: proof?.heads, unchanged } } : undefined;
  } catch {
    // Let the ordinary Git commands decide unsupported or unstable reads.
    return undefined;
  }
}
