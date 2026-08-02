/**
 * electron-vite uses this to tell PwrAgent's own Electron main process where
 * its development renderer lives. Passing that endpoint to an unrelated
 * Electron app makes that app load PwrAgent's renderer instead of its bundle.
 */
export const ELECTRON_RENDERER_URL_ENV = "ELECTRON_RENDERER_URL";

/**
 * Merge environment layers for a process outside PwrAgent. Later layers keep
 * their normal override behavior, then PwrAgent-private renderer state is
 * removed last so no merge order can reintroduce it.
 *
 * Mutates `target` to support the long-lived hydrated environment objects in
 * DesktopSettingsService. Call `buildPwrAgentChildProcessEnv` for a new object.
 */
export function mergePwrAgentChildProcessEnv(
  target: NodeJS.ProcessEnv,
  ...sources: Array<NodeJS.ProcessEnv | undefined>
): NodeJS.ProcessEnv {
  for (const source of sources) {
    if (source) {
      Object.assign(target, source);
    }
  }
  for (const key of Object.keys(target)) {
    // Windows environment names are case-insensitive. Deleting every casing is
    // harmless on POSIX and keeps the boundary correct on all supported hosts.
    if (key.toUpperCase() === ELECTRON_RENDERER_URL_ENV) {
      delete target[key];
    }
  }
  return target;
}

export function buildPwrAgentChildProcessEnv(
  ...sources: Array<NodeJS.ProcessEnv | undefined>
): NodeJS.ProcessEnv {
  return mergePwrAgentChildProcessEnv({}, ...sources);
}
