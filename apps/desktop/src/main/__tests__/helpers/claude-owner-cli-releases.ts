import { writeFile } from "node:fs/promises";
import { createServer, type AddressInfo, type Socket } from "node:net";
import path from "node:path";

/** The file in the fixture's folder that names the release server's port. */
const CLAUDE_OWNER_CLI_RELEASE_PORT_FILE = "claude-release-port";

export interface ClaudeOwnerCliReleases {
  /** Release turn `index` (1-based), before or after it reaches the fixture. */
  release(index: number): void;
  close(): Promise<void>;
}

/**
 * Releases `fixtures/claude-owner-cli.cjs` turns over a loopback socket the
 * test owns. Each turn connects once it has recorded its prompt and names its
 * index, then holds until a release arrives on that connection.
 *
 * The fixture used to wait for a `release-<n>` file through `fs.watch`. On
 * macOS, libuv arms a directory watch on its FSEvents thread after
 * `fs.watch` returns, and the stream reports only later changes, so a
 * release written in that gap was never seen and the turn never completed.
 * Under full-suite load that gap outlasted the test's next step. A socket
 * delivers a byte written at any point, and a release made before the
 * fixture connects is held here until it does.
 */
export async function openClaudeOwnerCliReleases(fixtureDir: string): Promise<ClaudeOwnerCliReleases> {
  const connections = new Map<number, Socket>();
  const released = new Set<number>();
  const sent = new Set<number>();
  const send = (index: number): void => {
    const socket = connections.get(index);
    if (!socket || !released.has(index) || sent.has(index)) return;
    sent.add(index);
    socket.end("release\n");
  };
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const index = Number(buffer.slice(0, newline));
      buffer = "";
      connections.set(index, socket);
      send(index);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  await writeFile(path.join(fixtureDir, CLAUDE_OWNER_CLI_RELEASE_PORT_FILE), String(port));
  return {
    release: (index) => {
      released.add(index);
      send(index);
    },
    close: async () => {
      for (const socket of connections.values()) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
