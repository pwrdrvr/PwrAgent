import { sandboxerStub } from "./helpers/sandboxer-stub";
import { connect } from "node:net";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpConnectionGatewayService } from "../mcp-connections/mcp-connection-gateway-service";
import { ElicitationWireChannel } from "../mcp-connections/mcp-upstream-elicitation";
import { pwrSuiteInstall, removePwrSuiteInstalls } from "./helpers/pwrsuite-install-fixture";

/*
 * Rule: a line on the gateway's bridge socket can only ever be answered or
 * ignored. Whatever a peer writes, nothing it sends throws out of a socket
 * listener (an uncaught main-process exception) or out of the line handler
 * (an unhandled rejection that leaves the peer waiting).
 */

/** One line of text, without the newline that would end it. */
const lines = fc.oneof(fc.json(), fc.string(), fc.constantFrom("null", "[]", "0", "\"op\"", "true"))
  .map((line) => line.replaceAll("\n", " "));

const services: McpConnectionGatewayService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => await service.close()));
  removePwrSuiteInstalls();
});

describe("ElicitationWireChannel.receive", () => {
  it("ignores any line that is not an answer to an open form, without throwing", () => {
    fc.assert(fc.property(lines, (line) => {
      const channel = new ElicitationWireChannel(() => true);
      expect(() => channel.receive(line)).not.toThrow();
    }));
  });
});

describe.skipIf(process.platform === "win32")("the gateway bridge socket", () => {
  it("answers every first line exactly once, whatever it holds", async () => {
    const service = new McpConnectionGatewayService({
      sandboxer: sandboxerStub(),
      bridgeEntryPath: "/test/mcp-connection-bridge.js",
      settings: {
        clearMcpConnectionCredentials: vi.fn(async () => undefined),
        clearPwrSnapMcpCredential: vi.fn(async () => undefined),
        resolveMcpConnectionCredentials: vi.fn(async () => undefined),
        resolvePwrSnapMcpCredential: vi.fn(async () => undefined),
        resolvePwrGitMcpCredential: vi.fn(async () => undefined),
        clearPwrGitMcpCredential: vi.fn(async () => undefined),
        saveMcpConnectionCredentials: vi.fn(async () => undefined),
        savePwrSnapMcpCredential: vi.fn(async () => undefined),
      },
      resolveInstallPaths: () => [pwrSuiteInstall("pwrsnap")],
      leaseManager: null,
    });
    services.push(service);
    const socketPath = (await service.registerBridge("pwrsnap", "thread-1")).server.env.PWRAGENT_MCP_CONNECTION_SOCKET!;

    await fc.assert(fc.asyncProperty(lines, async (line) => {
      const answer = await new Promise<string>((resolve, reject) => {
        const socket = connect(socketPath);
        let received = "";
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error(`No answer to ${JSON.stringify(line)}`));
        }, 2_000);
        socket.setEncoding("utf8");
        socket.on("connect", () => socket.write(`${line}\n`));
        socket.on("data", (chunk: string) => { received += chunk; });
        socket.on("error", () => undefined);
        socket.on("close", () => {
          clearTimeout(timer);
          resolve(received);
        });
      });
      const answers = answer.split("\n").filter(Boolean);
      expect(answers).toHaveLength(1);
      expect(JSON.parse(answers[0]!)).toMatchObject({ ok: false });
    }), { numRuns: 40 });
  });
});
