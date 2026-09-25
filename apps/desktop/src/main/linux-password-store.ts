import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Chromium reads `--password-store` once, in PostCreateMainMessageLoop,
 * after the main module has finished its initial evaluation. A desktop it
 * does not know how to handle gets `basic_text`, and PwrAgent will not write
 * secrets there.
 *
 * The store is chosen by asking the session bus which service is actually
 * there, not by copying Chromium's desktop list. A backend that is already
 * usable is left alone, so a KWallet user is not switched onto libsecret
 * (that would mint a new key and strand existing ciphertext).
 */
export const LINUX_PASSWORD_STORE_ENV = "PWRAGENT_LINUX_PASSWORD_STORE";
export const LINUX_PASSWORD_STORE_FILE = "linux-password-store";

const PASSWORD_STORE_SWITCH = "--password-store";
const BUS_TIMEOUT_MS = 1_000;

const LINUX_SECRET_STORES = [
  "gnome-libsecret",
  "kwallet",
  "kwallet5",
  "kwallet6",
] as const;

export type LinuxSecretStore = (typeof LINUX_SECRET_STORES)[number];

const SECRET_SERVICES = [
  ["org.freedesktop.secrets", "gnome-libsecret"],
  ["org.kde.kwalletd6", "kwallet6"],
  ["org.kde.kwalletd5", "kwallet5"],
  ["org.kde.kwalletd", "kwallet"],
] as const satisfies ReadonlyArray<readonly [string, LinuxSecretStore]>;

type BusTool = {
  command: string;
  listArgs: readonly string[];
  activatableArgs: readonly string[];
};

const BUS_TOOLS: readonly BusTool[] = [
  {
    command: "busctl",
    listArgs: [
      "--user",
      "--no-pager",
      "call",
      "org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus",
      "ListNames",
    ],
    activatableArgs: [
      "--user",
      "--no-pager",
      "call",
      "org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus",
      "ListActivatableNames",
    ],
  },
  {
    command: "dbus-send",
    listArgs: [
      "--session",
      "--print-reply",
      "--dest=org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus.ListNames",
    ],
    activatableArgs: [
      "--session",
      "--print-reply",
      "--dest=org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus.ListActivatableNames",
    ],
  },
  {
    command: "gdbus",
    listArgs: [
      "call",
      "--session",
      "--dest",
      "org.freedesktop.DBus",
      "--object-path",
      "/org/freedesktop/DBus",
      "--method",
      "org.freedesktop.DBus.ListNames",
    ],
    activatableArgs: [
      "call",
      "--session",
      "--dest",
      "org.freedesktop.DBus",
      "--object-path",
      "/org/freedesktop/DBus",
      "--method",
      "org.freedesktop.DBus.ListActivatableNames",
    ],
  },
];

export type CommandResult =
  | { status: 0; stdout: string }
  | { status: number; stdout: string; stderr: string }
  | { missing: true };

export type CommandExec = (
  command: string,
  args: readonly string[],
) => CommandResult;

export type SecretServiceProbe =
  | { status: "ok"; owned: readonly string[]; activatable: readonly string[] }
  | { status: "unavailable"; reason: string };

export function parseDbusNameList(stdout: string): string[] {
  const names = new Set<string>();
  for (const match of stdout.matchAll(/["']([A-Za-z_][\w.-]*)["']/g)) {
    const name = match[1];
    if (name?.includes(".")) names.add(name);
  }
  return [...names];
}

export function linuxPasswordStorePath(userDataDir: string): string {
  return join(userDataDir, LINUX_PASSWORD_STORE_FILE);
}

function isLinuxSecretStore(value: string): value is LinuxSecretStore {
  return LINUX_SECRET_STORES.some((store) => store === value);
}

function argvSelectsPasswordStore(argv: readonly string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === PASSWORD_STORE_SWITCH) return true;
    if (arg?.startsWith(`${PASSWORD_STORE_SWITCH}=`)) return true;
  }
  return false;
}

function forcedStore(
  env: NodeJS.ProcessEnv,
): LinuxSecretStore | "basic" | "auto" | undefined {
  const raw = env[LINUX_PASSWORD_STORE_ENV]?.trim();
  if (!raw || raw === "auto") return raw === "auto" ? "auto" : undefined;
  if (raw === "basic") return "basic";
  return isLinuxSecretStore(raw) ? raw : undefined;
}

function readStoreFile(userDataDir: string): LinuxSecretStore | undefined {
  try {
    const text = readFileSync(linuxPasswordStorePath(userDataDir), "utf8").trim();
    return isLinuxSecretStore(text) ? text : undefined;
  } catch {
    return undefined;
  }
}

function writeStoreFile(userDataDir: string, store: LinuxSecretStore): void {
  writeFileSync(linuxPasswordStorePath(userDataDir), `${store}\n`, "utf8");
}

function storeForNames(names: readonly string[]): LinuxSecretStore | undefined {
  for (const [service, store] of SECRET_SERVICES) {
    if (names.includes(service)) return store;
  }
  return undefined;
}

function storeFromProbe(probe: SecretServiceProbe): LinuxSecretStore | undefined {
  if (probe.status !== "ok") return undefined;
  return storeForNames(probe.owned) ?? storeForNames(probe.activatable);
}

function backendIsUsable(
  encryptionAvailable: boolean,
  backend: string | null,
): boolean {
  if (backend === "basic_text") return false;
  return encryptionAvailable;
}

function argsWithPasswordStore(
  argv: readonly string[],
  store: LinuxSecretStore,
): string[] {
  const args: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === PASSWORD_STORE_SWITCH) {
      index += 1;
      continue;
    }
    if (arg?.startsWith(`${PASSWORD_STORE_SWITCH}=`)) continue;
    if (arg !== undefined) args.push(arg);
  }
  args.push(`${PASSWORD_STORE_SWITCH}=${store}`);
  return args;
}

function defaultExec(command: string, args: readonly string[]): CommandResult {
  try {
    return {
      status: 0,
      stdout: execFileSync(command, args, {
        encoding: "utf8",
        timeout: BUS_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (error) {
    const failed = error as NodeJS.ErrnoException & {
      status?: number;
      stdout?: unknown;
      stderr?: unknown;
    };
    if (failed.code === "ENOENT") return { missing: true };
    return {
      status: typeof failed.status === "number" ? failed.status : 1,
      stdout: typeof failed.stdout === "string" ? failed.stdout : "",
      stderr: typeof failed.stderr === "string"
        ? failed.stderr
        : failed.code ?? "dbus client failed",
    };
  }
}

export function probeSecretServices(
  exec: CommandExec = defaultExec,
): SecretServiceProbe {
  let missingTools = 0;
  for (const tool of BUS_TOOLS) {
    const listed = exec(tool.command, tool.listArgs);
    if ("missing" in listed) {
      missingTools += 1;
      continue;
    }
    if (listed.status !== 0) {
      return {
        status: "unavailable",
        reason: `${tool.command} ListNames exited ${listed.status}`,
      };
    }
    const owned = parseDbusNameList(listed.stdout);
    const activatableResult = exec(tool.command, tool.activatableArgs);
    const activatable = "missing" in activatableResult || activatableResult.status !== 0
      ? []
      : parseDbusNameList(activatableResult.stdout);
    return { status: "ok", owned, activatable };
  }
  return {
    status: "unavailable",
    reason: missingTools === BUS_TOOLS.length
      ? "no dbus client (busctl, dbus-send, gdbus)"
      : "session bus name list failed",
  };
}

/**
 * Apply an operator override or a store remembered from a previous launch.
 * Must run synchronously before the main module yields, so Chromium sees the
 * switch. Returns the store that was appended.
 */
export function applyRememberedLinuxPasswordStore(options: {
  platform: NodeJS.Platform;
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  userDataDir: string;
  appendSwitch: (store: LinuxSecretStore) => void;
}): LinuxSecretStore | undefined {
  if (options.platform !== "linux") return undefined;
  if (argvSelectsPasswordStore(options.argv)) return undefined;

  const forced = forcedStore(options.env);
  if (forced === "basic") return undefined;
  const store = forced && forced !== "auto"
    ? forced
    : readStoreFile(options.userDataDir);
  if (!store) return undefined;
  options.appendSwitch(store);
  return store;
}

/**
 * When this process already came up on basic_text, relaunch once with the
 * service that is on the bus. A usable backend is not replaced.
 * Returns true when the process is exiting for that relaunch.
 */
export function relaunchForLinuxSecretStore(options: {
  platform: NodeJS.Platform;
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  userDataDir: string;
  encryptionAvailable: boolean;
  backend: string | null;
  probe?: SecretServiceProbe;
  exec?: CommandExec;
  relaunch: (args: string[]) => void;
  exit: (code: number) => void;
  info: (message: string, fields: Record<string, unknown>) => void;
  warn: (message: string, fields: Record<string, unknown>) => void;
}): boolean {
  if (options.platform !== "linux") return false;
  if (options.env.PWRAGENT_E2E === "1") return false;
  if (argvSelectsPasswordStore(options.argv)) return false;

  const forced = forcedStore(options.env);
  if (forced === "basic" || (forced && forced !== "auto")) return false;
  if (backendIsUsable(options.encryptionAvailable, options.backend)) return false;

  const probe = options.probe ?? probeSecretServices(options.exec);
  if (probe.status === "unavailable") {
    options.warn("linux secret service probe failed", { reason: probe.reason });
    return false;
  }

  const store = storeFromProbe(probe);
  if (!store) return false;

  try {
    writeStoreFile(options.userDataDir, store);
  } catch (error) {
    options.warn("failed to remember linux secret store", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  options.info("relaunching to select a linux secret store", { backend: store });
  options.relaunch(argsWithPasswordStore(options.argv, store));
  options.exit(0);
  return true;
}
