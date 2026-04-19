import os from "node:os";
import path from "node:path";

export const DESKTOP_STATE_ROOT_ENV = "PWRAGNT_STATE_ROOT";

type DesktopStatePathOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  xdgStateHome?: string;
};

export function defaultDesktopStateRoot(
  options?: DesktopStatePathOptions,
): string {
  const env = options?.env ?? process.env;
  const homeDir = options?.homeDir ?? os.homedir();
  const xdgStateHome =
    options?.xdgStateHome?.trim() || env.XDG_STATE_HOME?.trim();

  return path.join(
    xdgStateHome || path.join(homeDir, ".local", "state"),
    "pwragnt",
  );
}

export function resolveDesktopStateRoot(
  options?: DesktopStatePathOptions,
): string {
  const env = options?.env ?? process.env;
  return env[DESKTOP_STATE_ROOT_ENV]?.trim() || defaultDesktopStateRoot(options);
}

export function resolveDesktopOverlayStorePath(
  options?: DesktopStatePathOptions,
): string {
  return path.join(resolveDesktopStateRoot(options), "overlay-state.json");
}
