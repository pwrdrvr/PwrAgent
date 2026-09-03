import path from "node:path";
import { resolvePwragentRoot } from "../profile.js";
import { BUNDLED_GROK_RELATIVE_PATH } from "./acp-bundled-agent.js";

/** `agents/grok` under the PwrAgent root — the machine-wide managed root. */
export const MANAGED_GROK_ROOT_SEGMENTS = ["agents", "grok"] as const;

export type GrokBuildChannelOptions = {
  /** Overrides `<pwragent root>/agents/grok`. Tests and alternate roots. */
  managedRoot?: string;
  /** Overrides `process.resourcesPath` for the packaged bundle copy. */
  resourcesPath?: string;
};

export function managedGrokRoot(options?: GrokBuildChannelOptions): string {
  return options?.managedRoot
    ?? path.join(resolvePwragentRoot(), ...MANAGED_GROK_ROOT_SEGMENTS);
}

/**
 * The release tag a Grok command was installed under, or `undefined` when the
 * command is not a managed install. `installRelease` lays every download out as
 * `<managed root>/versions/<tag>/<executable>`, so the tag is recoverable from
 * the path alone — which is what lets an *older* managed version still be
 * recognized as one after the channel has moved on.
 */
export function managedGrokTagForCommand(
  command: string | undefined,
  options?: GrokBuildChannelOptions,
): string | undefined {
  if (!command) {
    return undefined;
  }
  const relative = path.relative(
    path.resolve(managedGrokRoot(options), "versions"),
    path.resolve(command),
  );
  if (
    relative === ""
    || relative.startsWith("..")
    || path.isAbsolute(relative)
  ) {
    return undefined;
  }
  const [tag, ...rest] = relative.split(path.sep);
  // `versions/<tag>` alone is the directory, not an executable inside it.
  return tag && rest.length > 0 ? tag : undefined;
}

/**
 * Whether this command is a Grok build PwrAgent supplied — a managed download
 * under `versions/`, or the copy inside the packaged app.
 *
 * Deliberately decided from the path rather than from equality with whatever
 * command the current release check resolved. Provenance is a property of the
 * binary; "is it the newest one" is a separate question. Conflating the two is
 * how a pinned older managed build — or any build present while a check failed
 * — used to change channel and collect an xAI update notice.
 */
export function isPwrAgentSuppliedGrokCommand(
  command: string | undefined,
  options?: GrokBuildChannelOptions,
): boolean {
  if (!command) {
    return false;
  }
  if (managedGrokTagForCommand(command, options) !== undefined) {
    return true;
  }
  const resourcesPath = options?.resourcesPath ?? process.resourcesPath;
  if (!resourcesPath) {
    return false;
  }
  const relative = path.relative(
    path.resolve(resourcesPath, ...BUNDLED_GROK_RELATIVE_PATH),
    path.resolve(command),
  );
  return (
    relative !== ""
    && !relative.startsWith("..")
    && !path.isAbsolute(relative)
  );
}
