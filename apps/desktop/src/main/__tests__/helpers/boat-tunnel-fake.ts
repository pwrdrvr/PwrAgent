import type { BoatTunnelChild, BoatTunnelRuntime } from "../../mcp-connections/boat-port-forward";

export const FAKE_PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakePublicKeyForATunnel pwragent-forward";
export const FAKE_HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKeyOfTheSandbox";

export type FakeTunnel = {
  args: string[];
  alive: boolean;
  /** The process dies on its own: the sandbox stopped, or the network dropped. */
  exit(stderr?: string): void;
};

/**
 * A machine with no `ssh`: it records each command line that would have run
 * and every file written, and a tunnel "listens" while its process lives.
 */
export function fakeTunnelRuntime() {
  const tunnels: FakeTunnel[] = [];
  const files = new Map<string, string>();
  const directories = new Set<string>();
  const state: { failStart?: string } = {};
  let nextPort = 40_000;
  let nextDirectory = 0;
  const runtime: BoatTunnelRuntime = {
    createKey: async (directory) => {
      files.set(`${directory}/key`, "PRIVATE KEY");
      return { publicKey: FAKE_PUBLIC_KEY, privateKeyPath: `${directory}/key` };
    },
    freePort: async () => nextPort++,
    spawn: (args) => {
      let settle: (result: { stderr: string }) => void = () => undefined;
      const exited = new Promise<{ stderr: string }>((resolve) => {
        settle = resolve;
      });
      const tunnel: FakeTunnel = {
        args: [...args],
        alive: state.failStart === undefined,
        exit: (stderr = "") => {
          if (!tunnel.alive) return;
          tunnel.alive = false;
          settle({ stderr });
        },
      };
      if (state.failStart !== undefined) settle({ stderr: state.failStart });
      tunnels.push(tunnel);
      const child: BoatTunnelChild = { kill: () => tunnel.exit(), exited };
      return child;
    },
    listening: async (port) => tunnels.some((tunnel) =>
      tunnel.alive && tunnel.args[tunnel.args.indexOf("-L") + 1]?.startsWith(`127.0.0.1:${port}:`)),
    makeDirectory: async () => {
      const directory = `/fake-tmp/forward-${nextDirectory++}`;
      directories.add(directory);
      return directory;
    },
    removeDirectory: async (directory) => {
      directories.delete(directory);
      for (const file of [...files.keys()]) {
        if (file.startsWith(`${directory}/`)) files.delete(file);
      }
    },
    writeFile: async (file, content) => {
      files.set(file, content);
    },
    sleep: async () => undefined,
  };
  return { runtime, tunnels, files, directories, state };
}
