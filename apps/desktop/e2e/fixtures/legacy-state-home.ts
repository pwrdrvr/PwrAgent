import path from "node:path";

/**
 * Launch environment for a fixture that seeds PwrAgent's pre-profile state
 * and relies on the migration importing it.
 *
 * Those fixtures write `<root>/.local/state/pwragnt/overlay-state.json` and
 * `<root>/.config/pwragnt/config.toml` — the XDG-shaped paths
 * `findLegacyPaths` looks under. Passing `HOME` alone is not enough to point
 * it there. It derives the XDG defaults from `os.homedir()`, which on Windows
 * reads `USERPROFILE` and ignores `HOME` entirely, so the app went looking in
 * the real operator profile, imported nothing, and every assertion downstream
 * of the seeded state failed for reasons that named neither the seed nor the
 * migration.
 *
 * `XDG_STATE_HOME` / `XDG_CONFIG_HOME` are read ahead of that fallback on
 * every platform, which is what makes them the seam: they name the directory
 * the fixture actually wrote instead of arguing with Windows about what "home"
 * means. `HOME` stays because the rest of the harness still keys off it.
 *
 * Overriding both is deliberate even though today's fixtures seed only state.
 * Leaving `XDG_CONFIG_HOME` unset would let a Windows run keep reading the
 * operator's own `~/.config/pwragnt/config.toml`, which is exactly the
 * cross-contamination the temp root exists to prevent.
 */
export function legacyStateHomeEnv(rootDir: string): Record<string, string> {
  return {
    HOME: rootDir,
    XDG_STATE_HOME: path.join(rootDir, ".local", "state"),
    XDG_CONFIG_HOME: path.join(rootDir, ".config"),
  };
}
