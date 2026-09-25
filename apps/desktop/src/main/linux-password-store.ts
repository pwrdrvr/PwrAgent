import { execFileSync } from "node:child_process";

/**
 * Chromium reads `--password-store` once, in
 * `PostCreateMainMessageLoop`, after this process has evaluated its main
 * module. On a desktop it does not recognize it selects `basic_text`.
 * PwrAgent will not write bot tokens or API keys into that store.
 *
 * Desktop tokens that already get a real backend match `base/nix/xdg_util.cc`.
 * Hyprland, sway, niri, river, and Omarchy are absent there. LXQt and COSMIC
 * are named and still use basic_text.
 */
export const LINUX_PASSWORD_STORE_ENV = "PWRAGENT_LINUX_PASSWORD_STORE";

const PASSWORD_STORE_SWITCH = "--password-store";
const BUSCTL_TIMEOUT_MS = 1_000;

// Desktops for which Chromium already selects libsecret or KWallet.
// LXQt and COSMIC are named in xdg_util.cc and still fall through to
// basic_text, so they stay out of this set and get the same probe as
// Hyprland or sway.
const REAL_BACKEND_XDG_DESKTOPS = new Set([
  "Unity",
  "Deepin",
  "GNOME",
  "X-Cinnamon",
  "KDE",
  "Pantheon",
  "XFCE",
  "UKUI",
]);

const LINUX_PASSWORD_STORES = [
  "gnome-libsecret",
  "kwallet",
  "kwallet5",
  "kwallet6",
  "basic",
] as const;

export type LinuxPasswordStore = (typeof LINUX_PASSWORD_STORES)[number];

const SECRET_SERVICE_NAMES = [
  ["org.freedesktop.secrets", "gnome-libsecret"],
  ["org.kde.kwalletd6", "kwallet6"],
  ["org.kde.kwalletd5", "kwallet5"],
  ["org.kde.kwalletd", "kwallet"],
] as const satisfies ReadonlyArray<readonly [string, LinuxPasswordStore]>;

export type DbusNameProbe = (name: string) => boolean;

export function argvAlreadySelectsPasswordStore(
  argv: readonly string[],
): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === PASSWORD_STORE_SWITCH) return true;
    if (arg?.startsWith(`${PASSWORD_STORE_SWITCH}=`)) return true;
  }
  return false;
}

/**
 * True when Chromium's own desktop detection would land on `BASIC_TEXT`.
 * A recognized desktop keeps Chromium's choice.
 */
export function chromiumSelectsBasicText(env: NodeJS.ProcessEnv): boolean {
  const xdg = env.XDG_CURRENT_DESKTOP;
  if (xdg) {
    for (const token of xdg.split(":")) {
      if (REAL_BACKEND_XDG_DESKTOPS.has(token.trim())) return false;
    }
  }

  const session = env.DESKTOP_SESSION ?? "";
  if (
    session === "deepin"
    || session === "gnome"
    || session === "mate"
    || session === "kde4"
    || session === "kde-plasma"
    || session === "kde"
    || session.includes("xfce")
    || session === "xubuntu"
    || session === "ukui"
  ) {
    return false;
  }
  if (env.GNOME_DESKTOP_SESSION_ID !== undefined) return false;
  if (env.KDE_FULL_SESSION !== undefined) return false;
  return true;
}

function readForcedStore(env: NodeJS.ProcessEnv): LinuxPasswordStore | undefined {
  const raw = env[LINUX_PASSWORD_STORE_ENV]?.trim();
  if (!raw || raw === "auto") return undefined;
  return LINUX_PASSWORD_STORES.find((store) => store === raw);
}

function storeFromRunningServices(nameOwned: DbusNameProbe): LinuxPasswordStore | undefined {
  for (const [name, store] of SECRET_SERVICE_NAMES) {
    if (nameOwned(name)) return store;
  }
  return undefined;
}

/**
 * Store name to pass to `--password-store`, or undefined to leave Chromium
 * alone. `basic` in the environment is an explicit opt-out.
 */
export function selectLinuxPasswordStore(options: {
  platform: NodeJS.Platform;
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  nameOwned: DbusNameProbe;
}): Exclude<LinuxPasswordStore, "basic"> | undefined {
  if (options.platform !== "linux") return undefined;
  if (argvAlreadySelectsPasswordStore(options.argv)) return undefined;

  const forced = readForcedStore(options.env);
  if (forced === "basic") return undefined;
  if (forced) return forced;
  if (!chromiumSelectsBasicText(options.env)) return undefined;

  const selected = storeFromRunningServices(options.nameOwned);
  if (selected === "basic") return undefined;
  return selected;
}

export function dbusNameIsOwned(name: string): boolean {
  try {
    execFileSync("busctl", ["--user", "status", name], {
      timeout: BUSCTL_TIMEOUT_MS,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

export function installLinuxPasswordStore(options: {
  platform?: NodeJS.Platform;
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  nameOwned?: DbusNameProbe;
  appendSwitch: (value: string) => void;
}): Exclude<LinuxPasswordStore, "basic"> | undefined {
  const store = selectLinuxPasswordStore({
    platform: options.platform ?? process.platform,
    argv: options.argv ?? process.argv,
    env: options.env ?? process.env,
    nameOwned: options.nameOwned ?? dbusNameIsOwned,
  });
  if (store) options.appendSwitch(store);
  return store;
}
