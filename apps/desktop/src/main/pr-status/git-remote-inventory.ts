import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { bundledGitLfsExecutable } from "../bundled-git";
import { isGitConfigNoMatch, parseForgeRemote, REMOTE_CONFIG_KEYS, type InventoryRemoteConfigReader } from "./git-remote";
import type { GitRemoteConfiguration } from "./git-remote-config";
import { parsePrConfigWithOrigins, readPrConfigInputs } from "./pr-config-observation";
import { runPrMetadataGit, SharedPrMetadataRead, type PrMetadataDemand } from "./pr-metadata-process";
import { observeLinkedPrCheckout, observePrCheckoutConfigFiles } from "./pr-remote-heads";

const CONFIG_KEYS = `${REMOTE_CONFIG_KEYS}|^include\\.|^core\\.(bare|worktree|repositoryformatversion)$|^extensions\\.`;

function currentInputs(cwd: string) {
  try {
    const inputs = readPrConfigInputs(cwd);
    if (!inputs || inputs === "native-only" || inputs.nativeOnly || Object.keys(inputs.env).some((key) =>
      /^(?:SUDO_UID|GIT_(?:CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|CONFIG_KEY_.*|CONFIG_VALUE_.*))$/i.test(key))) return undefined;
    return { env: inputs.env, paths: [...inputs.paths, bundledGitLfsExecutable()] };
  } catch {
    return undefined;
  }
}

function shareableConfig(parsed: ReturnType<typeof parsePrConfigWithOrigins>, commonDir: string) {
  if (!parsed) return undefined;
  const { configuration, sources, records } = parsed;
  const remote = configuration?.remotes[0];
  if (!sources?.localOrigins.has(path.join(commonDir, "config")) || configuration?.hasConditionalIncludes
    || configuration?.remotes.length !== 1 || !remote?.url.startsWith("https://")
    || remote.name !== "origin" || !parseForgeRemote(remote.url)) return undefined;
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
type ConfigSample = { configuration?: GitRemoteConfiguration };

/** A seed is a normal per-checkout read. Its positive config can stand in
 * for a sibling only while both checkout and config witnesses still hold. */
async function sampleConfig(cwd: string, checkout: LinkedCheckout, inputs: NonNullable<ReturnType<typeof currentInputs>>, demand: PrMetadataDemand) {
  const inputsUnchanged = () => isDeepStrictEqual(inputs, currentInputs(cwd));
  const read = (reader: PrMetadataDemand) => runPrMetadataGit(cwd,
    ["config", "--null", "--show-scope", "--show-origin", "--includes", "--get-regexp", CONFIG_KEYS],
    { env: inputs.env, purpose: "pr-remotes", maxBuffer: 64 * 1024, timeout: 2_000, beforeSpawn: () => {
      if (!inputsUnchanged()) throw new Error("Git config inputs changed");
    } }, reader);
  try {
    const roots = await observePrCheckoutConfigFiles(cwd, inputs.paths, demand);
    const result = await read(demand);
    const parsed = parsePrConfigWithOrigins(checkout.directory, result.stdout);
    if (!parsed) return undefined;
    const exact: ConfigSample = { configuration: parsed.configuration };
    const sources = shareableConfig(parsed, checkout.commonDir);
    if (!roots || roots.gitDir !== checkout.gitDir || result.stderr || !sources) return { exact };
    const includes = [...sources.includes].filter((file) => !roots.paths.has(file));
    const trackedPaths = new Set([...roots.paths, ...includes]);
    if ([...sources.origins].some((file) => !trackedPaths.has(file))) return { exact };
    let watched = includes.length ? undefined : Promise.resolve<typeof roots | undefined>(roots);
    // Only a sibling needs the second Git read. Watch the discovered includes
    // before confirming the seed's config with Git again.
    const confirmIncludes = async (reader: PrMetadataDemand) => {
      try {
        const files = await observePrCheckoutConfigFiles(cwd, [...inputs.paths, ...includes], reader);
        if (!files || files.gitDir !== checkout.gitDir) return undefined;
        const confirmed = await read(reader);
        return !confirmed.stderr && confirmed.stdout === result.stdout ? files : undefined;
      } catch {
        if (reader.signal?.aborted) watched = undefined;
        return undefined;
      }
    };
    const unchanged = async (reader: PrMetadataDemand) => {
      const files = await (watched ??= confirmIncludes(reader));
      if (!files) return false;
      const [seed, config] = await Promise.all([checkout.unchanged(reader), files.unchanged(reader)]);
      return seed && config && inputsUnchanged();
    };
    return { exact, unchanged };
  } catch (error) {
    demand.signal?.throwIfAborted();
    if (isGitConfigNoMatch(error)) return { exact: { configuration: { names: [], remotes: [] } } };
    return undefined;
  }
}

export function createInventoryRemoteConfigReader(): InventoryRemoteConfigReader | undefined {
  if (process.platform === "win32") return undefined;
  const groups = new Map<string, {
    seed: string;
    sample: SharedPrMetadataRead<Awaited<ReturnType<typeof sampleConfig>>>;
    checking?: { startedAfterObservation: number; result: SharedPrMetadataRead<boolean | undefined> };
  }>();
  let checkoutObservations = 0;
  const pendingCheckouts = new Set<Promise<unknown>>();
  let inputs: ReturnType<typeof currentInputs>;
  let initialized = false;
  return async (cwd, demand) => {
    if (!path.isAbsolute(cwd) || cwd.split(path.sep).includes("..")) return undefined;
    if (!initialized) {
      inputs = currentInputs(cwd);
      initialized = true;
    }
    if (!inputs) return undefined;
    const pending = observeLinkedPrCheckout(cwd, demand).then((checkout) =>
      checkout ? { checkout, observation: ++checkoutObservations } : undefined);
    pendingCheckouts.add(pending);
    const observed = await pending.finally(() => { pendingCheckouts.delete(pending); });
    if (!observed) return undefined;
    const { checkout, observation } = observed;
    let group = groups.get(checkout.commonDir);
    if (!group) {
      const batchInputs = inputs;
      group = { seed: cwd, sample: new SharedPrMetadataRead((shared) => sampleConfig(cwd, checkout, batchInputs, shared)) };
      groups.set(checkout.commonDir, group);
    }
    const sample = await group.sample.read(demand);
    if (group.seed === cwd) return sample?.exact;
    const verify = sample?.unchanged;
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
    return await checking.result.read(demand) && await checkout.unchanged() ? sample.exact : undefined;
  };
}
