import { dialog, shell } from "electron";
import { lookup } from "node:dns/promises";
import fs from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import { release } from "node:os";
import path from "node:path";
import { resolveDesktopConfigPath } from "../settings/desktop-config";
import { getMainLogger } from "../log";

const internalAddresses = new BlockList();
internalAddresses.addSubnet("10.0.0.0", 8);
internalAddresses.addSubnet("172.16.0.0", 12);
internalAddresses.addSubnet("192.168.0.0", 16);
internalAddresses.addSubnet("169.254.0.0", 16);
internalAddresses.addSubnet("fc00::", 7, "ipv6");
internalAddresses.addSubnet("fe80::", 10, "ipv6");

// This is a conservative explanation heuristic, NOT a macOS permission query.
// Apple defines local networks by directly attached interfaces, not RFC 1918.
export function isInternalFederationAddress(address: string): boolean {
  const family = isIP(address);
  return family !== 0 && internalAddresses.check(address, family === 6 ? "ipv6" : "ipv4");
}

export const LOCAL_NETWORK_RECOVERY =
  "If this gateway is on your local network, check System Settings → Privacy & Security → Local Network and allow PwrAgent. "
  + "macOS may have blocked access; this error can also indicate a routing or firewall problem.";

export function federationLocalNetworkFailureHint(message: string, platform = process.platform): string {
  return platform === "darwin" && /\b(EHOSTUNREACH|ENETUNREACH|EACCES|EPERM)\b/.test(message)
    ? ` ${LOCAL_NETWORK_RECOVERY}`
    : "";
}

interface LocalNetworkNoticeDependencies {
  enabled: () => boolean;
  acknowledged: () => Promise<boolean>;
  acknowledge: () => Promise<void>;
  resolve: (hostname: string) => Promise<string[]>;
  explain: (hostname: string) => Promise<void>;
  warn: (error: unknown) => void;
}

export class FederationLocalNetworkNotice {
  private done = false;
  private pending?: Promise<void>;

  constructor(private readonly deps: LocalNetworkNoticeDependencies) {}

  async beforeConnect(endpoint: string, isCurrent: () => boolean): Promise<void> {
    if (!this.deps.enabled() || !isCurrent()) return;
    // Serialise concurrent/restarted dials, then reconsider the new endpoint.
    while (this.pending) await this.pending;
    if (this.done || !isCurrent()) return;
    const pending = this.check(endpoint, isCurrent).catch(this.deps.warn);
    this.pending = pending;
    try { await pending; }
    finally { if (this.pending === pending) this.pending = undefined; }
  }

  private async check(endpoint: string, isCurrent: () => boolean): Promise<void> {
    if (await this.deps.acknowledged()) { this.done = true; return; }
    const url = new URL(endpoint);
    if (!["ws:", "wss:", "ssh:"].includes(url.protocol)) return;
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(hostname) ? [hostname] : await this.deps.resolve(hostname);
    if (!addresses.some(isInternalFederationAddress) || !isCurrent()) return;
    // Remember in memory even if persistence fails, so retries cannot spam.
    this.done = true;
    await this.deps.explain(hostname);
    await this.deps.acknowledge();
  }
}

async function resolveAddresses(hostname: string): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookup(hostname, { all: true }).then((addresses) => addresses.map(({ address }) => address)),
      new Promise<string[]>((resolve) => { timer = setTimeout(() => resolve([]), 1_000); }),
    ]);
  } finally { clearTimeout(timer); }
}

const noticeFile = () => path.join(
  path.dirname(resolveDesktopConfigPath()), "state", "federation-local-network-notice-v1",
);

export const federationLocalNetworkNotice = new FederationLocalNetworkNotice({
  enabled: () => process.platform === "darwin" && Number(release().split(".")[0]) >= 24,
  acknowledged: async () => {
    try { await fs.access(noticeFile()); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  },
  acknowledge: async () => {
    const file = noticeFile();
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, "Explained local network access for Federation.\n", { mode: 0o600 });
  },
  resolve: resolveAddresses,
  explain: async (hostname) => {
    const { response } = await dialog.showMessageBox({
      type: "info",
      title: "Federation local network access",
      message: "Federation may need local network access",
      detail: `Your configured gateway (${hostname}) resolves to an internal network address. `
        + "When PwrAgent connects, macOS may ask to allow local network access. Choose Allow so Federation can reach your gateway.\n\n"
        + "If access was denied previously, macOS will not ask again. Enable PwrAgent in System Settings → Privacy & Security → Local Network. "
        + "Private addresses reached through a router or VPN may not need this permission.",
      buttons: ["Continue", "Open System Settings"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response === 1) {
      await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork");
    }
  },
  warn: (error) => getMainLogger("pwragent:federation-runtime").warn(
    "could not show or save Federation local network explanation", { error: String(error) },
  ),
});
