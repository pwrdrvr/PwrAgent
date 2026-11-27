import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { bundledGitLfsExecutable } from "../bundled-git";
import { isGitConfigNoMatch, nextRemoteSampleOrder, parseForgeRemote, readSshHost, REMOTE_CONFIG_KEYS, type InventoryRemoteConfigReader } from "./git-remote";
import { parseGitRemoteConfigRecords, type GitRemoteConfiguration } from "./git-remote-config";
import { canReadSingleBranchOrigin, parsePrConfigWithOrigins, readPrConfigInputs } from "./pr-config-observation";
import { runPrMetadataGit, SharedPrMetadataRead, type PrMetadataDemand } from "./pr-metadata-process";
import { observeLinkedPrCheckout, observePrCheckoutConfigFiles, observePrGitExecutable } from "./pr-remote-heads";

const CONFIG_KEYS = `${REMOTE_CONFIG_KEYS}|^include\\.|^core\\.(bare|worktree|repositoryformatversion)$|^extensions\\.`;

function currentInputs(cwd: string) {
  try {
    const inputs = readPrConfigInputs(cwd, "inventory");
    if (!inputs || inputs === "native-only") return undefined;
    return { ...inputs, paths: [...inputs.paths, bundledGitLfsExecutable()] };
  } catch {
    return undefined;
  }
}

type InventoryInputs = NonNullable<ReturnType<typeof currentInputs>>;

function runInventoryGit(
  cwd: string, args: string[], inputs: InventoryInputs, demand: PrMetadataDemand, onSpawn?: (executable: string) => void,
) {
  return runPrMetadataGit(cwd, args, {
    env: inputs.env, purpose: "pr-remotes", maxBuffer: 64 * 1024, timeout: 2_000,
    beforeSpawn: (executable, env) => {
      if (executable !== inputs.executable || !isDeepStrictEqual(env, inputs.runtime)
        || !isDeepStrictEqual(inputs, currentInputs(cwd))) throw new Error("Git config inputs changed");
      onSpawn?.(executable);
    },
  }, demand);
}

async function observeSystemConfig(cwd: string, inputs: InventoryInputs, demand: PrMetadataDemand) {
  try {
    // The explicitly selected command can use Git's compiled-in system path.
    // Watch the binary before asking Git for that path, even if it is absent.
    const executableUnchanged = await observePrGitExecutable(inputs.executable, demand);
    if (!executableUnchanged) return undefined;
    const { stdout, stderr } = await runInventoryGit(cwd, ["var", "GIT_CONFIG_SYSTEM"], inputs, demand);
    const file = stdout.endsWith("\n") ? stdout.slice(0, -1) : "";
    if (stderr || !path.isAbsolute(file) || /[\0\r\n\uFFFD]/.test(file) || file.split(path.sep).includes("..")) return undefined;
    if (!await executableUnchanged(demand)) return undefined;
    return { file: path.normalize(file), executableUnchanged };
  } catch {
    demand.signal?.throwIfAborted();
    return undefined;
  }
}

function shareableConfig(parsed: ReturnType<typeof parsePrConfigWithOrigins>, commonDir: string) {
  if (!parsed) return undefined;
  const { configuration, sources, records } = parsed;
  const remote = configuration?.remotes[0];
  if (!sources?.localOrigins.has(path.join(commonDir, "config")) || configuration?.hasConditionalIncludes
    || configuration?.remotes.length !== 1 || remote?.name !== "origin"
    || (!remote.url.startsWith("https://") && !readSshHost(remote.url)) || !parseForgeRemote(remote.url)) return undefined;
  // Share the raw URL. Each lookup still resolves its SSH hostname through
  // the same resolver used when the checkout supplies its own config.
  let ordinaryFormat = false;
  for (let i = 0; i < records.length; i += 2) {
    const record = records[i + 1];
    const newline = record.indexOf("\n");
    const key = newline < 0 ? record : record.slice(0, newline);
    const value = newline < 0 ? undefined : record.slice(newline + 1);
    if (records[i] === "worktree" || records[i] === "command" || key.startsWith("url.") || key === "core.worktree"
      || key === "core.bare" && value !== "false"
      || key === "core.repositoryformatversion" && value !== "0"
      || key.startsWith("extensions.") && (key !== "extensions.worktreeconfig" || (value !== "true" && value !== "false"))) return undefined;
    if (records[i] === "local" && key === "core.repositoryformatversion") ordinaryFormat = true;
  }
  return ordinaryFormat ? sources : undefined;
}

type LinkedCheckout = NonNullable<Awaited<ReturnType<typeof observeLinkedPrCheckout>>>;
type ConfigSample = { configuration?: GitRemoteConfiguration; sampleOrder: number };
type SystemConfigObservation = Awaited<ReturnType<typeof observeSystemConfig>>;

/** A seed is a normal per-checkout read. Its positive config can stand in
 * for a sibling only while both checkout and config witnesses still hold. */
async function sampleConfig(cwd: string, checkout: LinkedCheckout, inputs: InventoryInputs, system: SystemConfigObservation, demand: PrMetadataDemand) {
  const inputsUnchanged = () => isDeepStrictEqual(inputs, currentInputs(cwd));
  const paths = system ? [...inputs.paths, system.file] : inputs.paths;
  const read = async (reader: PrMetadataDemand) => {
    let sampleOrder: number | undefined;
    let allowSingleBranchOrigin = false;
    const result = await runInventoryGit(cwd,
      ["config", "--null", "--show-scope", "--show-origin", "--includes", "--get-regexp", CONFIG_KEYS],
      inputs, reader, (executable) => {
        sampleOrder = nextRemoteSampleOrder();
        allowSingleBranchOrigin = canReadSingleBranchOrigin(executable, inputs.env);
      });
    return { ...result, sampleOrder: sampleOrder ?? nextRemoteSampleOrder(), allowSingleBranchOrigin };
  };
  try {
    const roots = await observePrCheckoutConfigFiles(cwd, paths, demand);
    const result = await read(demand);
    const parsed = parsePrConfigWithOrigins(checkout.directory, result.stdout);
    if (!parsed) return undefined;
    // Single-branch evidence belongs to this checkout's Git invocation.
    const configuration = parsed.configuration ?? (result.allowSingleBranchOrigin && !result.stderr
      ? parseGitRemoteConfigRecords(parsed.records, true) : undefined);
    const exact: ConfigSample = { configuration, sampleOrder: result.sampleOrder };
    const sources = shareableConfig(parsed, checkout.commonDir);
    if (!roots || roots.gitDir !== checkout.gitDir || result.stderr || !sources) return { exact };
    const includes = [...sources.includes].filter((file) => !roots.paths.has(file));
    const trackedPaths = new Set([...roots.paths, ...includes]);
    if ([...sources.origins].some((file) => !trackedPaths.has(file))) return { exact };
    type ConfigWitness = { files: typeof roots; sampleOrder: number };
    let completed: ConfigWitness | undefined = includes.length ? undefined : { files: roots, sampleOrder: result.sampleOrder };
    let confirming: Promise<ConfigWitness | undefined> | undefined;
    // Only a sibling needs the second Git read. Watch the discovered includes
    // before confirming the seed's config with Git again.
    const confirmIncludes = async (reader: PrMetadataDemand) => {
      try {
        const files = await observePrCheckoutConfigFiles(cwd, [...paths, ...includes], reader);
        if (!files || files.gitDir !== checkout.gitDir) return undefined;
        const confirmed = await read(reader);
        if (confirmed.stderr || confirmed.stdout !== result.stdout) return undefined;
        completed = { files, sampleOrder: confirmed.sampleOrder };
        return completed;
      } catch {
        if (reader.signal?.aborted) confirming = undefined;
        return undefined;
      }
    };
    const unchanged = async (reader: PrMetadataDemand, confirm = true) => {
      // A page can recheck completed evidence while inventory is busy.
      const witness = completed ?? (confirm ? await (confirming ??= confirmIncludes(reader)) : undefined);
      if (!witness) return undefined;
      const [seed, config, executable] = await Promise.all([
        checkout.unchanged(reader), witness.files.unchanged(reader), system?.executableUnchanged(reader) ?? true,
      ]);
      return seed && config && executable && inputsUnchanged() ? witness.sampleOrder : undefined;
    };
    return { exact, unchanged };
  } catch (error) {
    demand.signal?.throwIfAborted();
    if (isGitConfigNoMatch(error)) return { exact: { configuration: { names: [], remotes: [] }, sampleOrder: nextRemoteSampleOrder() } };
    return undefined;
  }
}

export function createInventoryRemoteConfigReader(): InventoryRemoteConfigReader | undefined {
  if (process.platform === "win32") return undefined;
  const groups = new Map<string, {
    seed: string;
    sample: SharedPrMetadataRead<Awaited<ReturnType<typeof sampleConfig>>>;
    checking?: { startedAfterObservation: number; result: SharedPrMetadataRead<number | undefined> };
  }>();
  let checkoutObservations = 0;
  const pendingCheckouts = new Set<Promise<unknown>>();
  let inputs: ReturnType<typeof currentInputs>;
  let initialized = false;
  let systemRead: SharedPrMetadataRead<SystemConfigObservation> | undefined;
  let systemResult: { observation: SystemConfigObservation } | undefined;
  const readSystem = async (cwd: string, batchInputs: InventoryInputs, demand: PrMetadataDemand) => {
    if (systemResult) return systemResult.observation;
    if (!systemRead || systemRead.signal.aborted) {
      systemRead = new SharedPrMetadataRead(async (shared) => {
        const observation = await observeSystemConfig(cwd, batchInputs, shared);
        shared.signal?.throwIfAborted();
        systemResult = { observation };
        return observation;
      });
    }
    return await systemRead.read(demand);
  };
  return async (cwd, demand) => {
    if (!path.isAbsolute(cwd) || cwd.split(path.sep).includes("..")) return undefined;
    if (!initialized) {
      inputs = currentInputs(cwd);
      initialized = true;
    }
    if (!inputs) return undefined;
    const pending = observeLinkedPrCheckout(cwd, demand).then((checkout) =>
      checkout ? { checkout, observation: ++checkoutObservations, sampleOrder: nextRemoteSampleOrder() } : undefined);
    pendingCheckouts.add(pending);
    const observed = await pending.finally(() => { pendingCheckouts.delete(pending); });
    if (!observed) return undefined;
    const { checkout, observation } = observed;
    const batchInputs = inputs;
    const system = batchInputs.discoverSystemConfig ? await readSystem(cwd, batchInputs, demand) : undefined;
    if (batchInputs.discoverSystemConfig && !system) return undefined;
    let group = groups.get(checkout.commonDir);
    if (!group) {
      group = { seed: cwd, sample: new SharedPrMetadataRead((shared) => sampleConfig(cwd, checkout, batchInputs, system, shared)) };
      groups.set(checkout.commonDir, group);
    }
    const sample = await group.sample.read(demand);
    const verify = sample?.unchanged;
    if (group.seed === cwd) {
      return sample && verify ? {
        ...sample.exact,
        remoteNamesStillMatch: async (reader) => await verify(reader, false) !== undefined,
      } : sample?.exact;
    }
    if (!sample || !verify) return undefined;
    // The shared verification must start after this checkout was observed.
    // Recheck the checkout afterward so both proofs cover the same interval.
    let checking = group.checking;
    if (!checking || checking.result.signal.aborted || checking.startedAfterObservation < observation) {
      const current = group;
      const next: NonNullable<typeof checking> = {
        startedAfterObservation: Infinity,
        result: new SharedPrMetadataRead(async (shared) => {
          try {
            // Let the already queued first-pass probes share one verification.
            // A later checkout cannot join after that verification starts.
            await Promise.allSettled(pendingCheckouts);
            shared.signal?.throwIfAborted();
            next.startedAfterObservation = checkoutObservations;
            return await verify(shared);
          } finally {
            if (current.checking === next) current.checking = undefined;
          }
        }),
      };
      checking = current.checking = next;
    }
    const sampleOrder = await checking.result.read(demand);
    if (sampleOrder === undefined || !await checkout.unchanged() || !isDeepStrictEqual(batchInputs, currentInputs(cwd))) return undefined;
    return {
      ...sample.exact,
      sampleOrder: Math.max(sampleOrder, observed.sampleOrder),
      remoteNamesStillMatch: async (reader) => await checkout.unchanged(reader) === true && await verify(reader, false) !== undefined,
    };
  };
}
