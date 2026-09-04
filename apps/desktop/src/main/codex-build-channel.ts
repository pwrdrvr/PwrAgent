import path from "node:path";
import { resolvePwragentRoot } from "./profile.js";

/** `agents/codex` under the PwrAgent root — the machine-wide managed root. */
export const MANAGED_CODEX_ROOT_SEGMENTS = ["agents", "codex"] as const;

export type CodexBuildChannelOptions = {
  /** Overrides `<pwragent root>/agents/codex`. Tests and alternate roots. */
  managedRoot?: string;
};

export function managedCodexRoot(options?: CodexBuildChannelOptions): string {
  return options?.managedRoot
    ?? path.join(resolvePwragentRoot(), ...MANAGED_CODEX_ROOT_SEGMENTS);
}

/**
 * The release tag a Codex command was installed under, or `undefined` when the
 * command is not a managed install. `installRelease` lays every download out as
 * `<managed root>/versions/<tag>/<executable>`, so the tag is recoverable from
 * the path alone — which is what lets an *older* managed version still be
 * recognized as one after the channel has moved on.
 *
 * Deliberately decided from the path rather than from equality with whatever
 * command the current release check resolved: provenance is a property of the
 * binary, while "is it the newest one" is a separate question.
 */
export function managedCodexTagForCommand(
  command: string | undefined,
  options?: CodexBuildChannelOptions,
): string | undefined {
  if (!command) {
    return undefined;
  }
  const relative = path.relative(
    path.resolve(managedCodexRoot(options), "versions"),
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
