/**
 * The verified baseline for GPT-6.1-Sol discovery. Our 0.159.0 build lists
 * the model; upstream 0.159.1 also adds it to the bundled catalog. Recommend
 * updating older installations so the picker can offer GPT-6.1-Sol.
 */
export const CODEX_MINIMUM_RECOMMENDED_VERSION = "0.159.0";

const VERSION_CORE = /(\d+)\.(\d+)\.(\d+)/u;

/**
 * The `major.minor.patch` inside a version string, ignoring any prerelease or
 * build suffix. `codex --version` prints `codex-cli 0.152.0`, and discovery
 * may hand back either that or the bare number.
 *
 * A prerelease of the minimum (`0.159.0-alpha.2`) compares equal to it. That is
 * deliberate: the alphas are cut from the same line the release ships from, and
 * warning a developer on one that their Codex is old would be wrong more often
 * than right.
 */
export function parseCodexVersionCore(
  version: string | undefined,
): [number, number, number] | undefined {
  const match = version ? VERSION_CORE.exec(version) : null;
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** False when the version does not parse: unknown is not old. */
export function isCodexVersionBelowMinimum(
  version: string | undefined,
  minimum: string = CODEX_MINIMUM_RECOMMENDED_VERSION,
): boolean {
  const actual = parseCodexVersionCore(version);
  const floor = parseCodexVersionCore(minimum);
  if (!actual || !floor) return false;
  for (let index = 0; index < 3; index += 1) {
    const delta = (actual[index] ?? 0) - (floor[index] ?? 0);
    if (delta !== 0) return delta < 0;
  }
  return false;
}
