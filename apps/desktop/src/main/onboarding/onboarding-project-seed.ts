import fs from "node:fs";
import path from "node:path";

/**
 * Get started runs in the throwaway bootstrap profile, so it cannot register
 * the project folders the operator checked: its state database is deleted on
 * the next boot. Start writes them here, in the new profile's folder, and that
 * profile registers each one the first time it starts.
 */
export const ONBOARDING_PROJECT_SEED_FILE = "onboarding-projects.json";
/** Get started never offers more than this; anything past it is ignored. */
export const ONBOARDING_PROJECT_SEED_LIMIT = 200;

type OnboardingProjectSeed = { version: 1; paths: string[] };

export function writeOnboardingProjectSeed(profileDir: string, paths: readonly string[]): void {
  const unique = [...new Set(paths.map((entry) => entry.trim()).filter(Boolean))]
    .slice(0, ONBOARDING_PROJECT_SEED_LIMIT);
  if (unique.length === 0) return;
  const seed: OnboardingProjectSeed = { version: 1, paths: unique };
  const target = path.join(profileDir, ONBOARDING_PROJECT_SEED_FILE);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(seed, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, target);
}

function readSeedPaths(file: string): string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    // An unreadable seed is dropped below; nothing else can repair it.
    return [];
  }
  const record = parsed as Partial<OnboardingProjectSeed> | null;
  if (record?.version !== 1 || !Array.isArray(record.paths)) return [];
  return record.paths
    .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    .slice(0, ONBOARDING_PROJECT_SEED_LIMIT);
}

export type OnboardingProjectSeedResult = {
  registered: string[];
  failed: Array<{ path: string; message: string }>;
};

/**
 * Registers each seeded folder once, in order, then removes the seed. A
 * folder that fails (moved, deleted) is reported and not retried: the seed
 * is a one-time handoff, and registering an existing folder again is
 * harmless, so a crash before removal only repeats the same registrations.
 */
export async function importOnboardingProjectSeed(
  profileDir: string,
  register: (folder: string) => Promise<{ ok: true } | { ok: false; message: string }>,
): Promise<OnboardingProjectSeedResult | undefined> {
  const file = path.join(profileDir, ONBOARDING_PROJECT_SEED_FILE);
  const paths = readSeedPaths(file);
  if (paths === undefined) return undefined;
  const result: OnboardingProjectSeedResult = { registered: [], failed: [] };
  for (const folder of paths) {
    try {
      const outcome = await register(folder);
      if (outcome.ok) result.registered.push(folder);
      else result.failed.push({ path: folder, message: outcome.message });
    } catch (error) {
      result.failed.push({ path: folder, message: error instanceof Error ? error.message : String(error) });
    }
  }
  fs.rmSync(file, { force: true });
  return result;
}
