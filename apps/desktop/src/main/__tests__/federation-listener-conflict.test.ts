import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { assertNoWildcardListener } from "../federation/federation-transport";

const servers: net.Server[] = [];

async function listen(host: string): Promise<number> {
  const server = net.createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen({ host, port: 0 }, resolve));
  return (server.address() as net.AddressInfo).port;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe("federation listener port conflicts", () => {
  it("refuses a loopback listener on a port another process holds on every interface", async () => {
    // On macOS the loopback bind itself would succeed here and quietly take
    // the other listener's local traffic, so the probe is the only guard.
    const port = await listen("0.0.0.0");
    await expect(assertNoWildcardListener("127.0.0.1", port))
      .rejects.toThrow(`Port ${port} is already in use by another process.`);
  });

  it("allows a loopback listener on a free port", async () => {
    const port = await listen("127.0.0.1");
    await new Promise((resolve) => servers.pop()!.close(resolve));
    await expect(assertNoWildcardListener("127.0.0.1", port)).resolves.toBeUndefined();
  });

  it("leaves a wildcard listener to its own bind", async () => {
    // Its own bind reports a conflict; probing would only race it.
    const port = await listen("0.0.0.0");
    await expect(assertNoWildcardListener("0.0.0.0", port)).resolves.toBeUndefined();
  });
});
