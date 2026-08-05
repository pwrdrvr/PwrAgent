import { describe, expect, it, vi } from "vitest";
import { FederationTailscaleService } from "../federation/federation-tailscale";

describe("FederationTailscaleService", () => {
  it("reports only sanitized local Tailscale status", async () => {
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "status") {
        return commandResult(JSON.stringify({
          BackendState: "Running",
          Self: {
            Online: true,
            DNSName: "studio.example.ts.net.",
            TailscaleIPs: ["100.64.0.1"],
            NodeKey: "nodekey:secret",
          },
          CurrentTailnet: { Name: "Example Tailnet" },
          Peer: { secret: { HostName: "private-peer" } },
        }));
      }
      if (args[0] === "serve") {
        return commandResult(JSON.stringify({
          Web: { "studio.example.ts.net:443": { Handlers: {
            "/pwragent-federation": { Proxy: "http://127.0.0.1:47830" },
          } } },
        }));
      }
      return commandResult("{}");
    });
    const service = new FederationTailscaleService({
      discoverCommand: async () => ({
        command: "/usr/local/bin/tailscale",
        version: "1.98.10",
      }),
      runCommand,
    });

    await expect(service.readStatus()).resolves.toEqual({
      installed: true,
      connected: true,
      version: "1.98.10",
      backendState: "Running",
      dnsName: "studio.example.ts.net",
      tailnetName: "Example Tailnet",
      serveConfigured: true,
      funnelConfigured: false,
      gatewayUrl: "wss://studio.example.ts.net/pwragent-federation",
      unavailableReason: undefined,
    });
    expect(runCommand).toHaveBeenCalledWith(
      "/usr/local/bin/tailscale",
      ["status", "--json", "--peers=false"],
    );
    expect(runCommand).not.toHaveBeenCalledWith(
      "/usr/local/bin/tailscale",
      ["funnel", "status", "--json"],
    );
  });

  it("does not mistake a private Serve handler for Funnel", async () => {
    const service = new FederationTailscaleService({
      discoverCommand: async () => ({ command: "tailscale" }),
      runCommand: async (_command, args) => commandResult(
        args[0] === "status"
          ? JSON.stringify({
              BackendState: "Running",
              Self: { Online: true, DNSName: "studio.example.ts.net." },
            })
          : JSON.stringify({
              TCP: { "443": { HTTPS: true } },
              Web: {
                "studio.example.ts.net:443": {
                  Handlers: {
                    "/pwragent-federation": {
                      Proxy: "http://127.0.0.1:47830",
                    },
                  },
                },
              },
            }),
      ),
    });

    await expect(service.readStatus()).resolves.toMatchObject({
      serveConfigured: true,
      funnelConfigured: false,
    });
  });

  it("configures only the dedicated PwrAgent Funnel path", async () => {
    let configured = false;
    const events: string[] = [];
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "status") {
        return commandResult(JSON.stringify({
          BackendState: "Running",
          Self: { Online: true, DNSName: "studio.example.ts.net." },
        }));
      }
      if (args[0] === "funnel" && args[1] === "--bg") {
        events.push("publish");
        configured = true;
        return commandResult("");
      }
      if (args[0] === "serve") {
        return commandResult(configured
          ? JSON.stringify({
              Web: {
                "studio.example.ts.net:443": {
                  Handlers: {
                    "/pwragent-federation": {
                      Proxy: "http://127.0.0.1:47830",
                    },
                  },
                },
              },
              AllowFunnel: {
                "studio.example.ts.net:443": true,
              },
            })
          : "{}");
      }
      return commandResult("{}");
    });
    const service = new FederationTailscaleService({
      discoverCommand: async () => ({ command: "tailscale" }),
      runCommand,
      verifyListener: async () => {
        events.push("verify-listener");
      },
    });

    await expect(service.configure({
      mode: "funnel",
      listenPort: 47_830,
    })).resolves.toMatchObject({
      gatewayUrl: "wss://studio.example.ts.net/pwragent-federation",
      status: { funnelConfigured: true },
    });
    expect(runCommand).toHaveBeenCalledWith("tailscale", [
      "funnel",
      "--bg",
      "--yes",
      "--set-path=/pwragent-federation",
      "http://127.0.0.1:47830",
    ]);
    expect(runCommand.mock.calls.flatMap((call) => call[1])).not.toContain("reset");
    expect(events).toEqual(["verify-listener", "publish"]);
  });

  it("does not run setup while Tailscale is disconnected", async () => {
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "status") {
        return commandResult(JSON.stringify({ BackendState: "Stopped" }));
      }
      return commandResult("{}");
    });
    const service = new FederationTailscaleService({
      discoverCommand: async () => ({ command: "tailscale" }),
      runCommand,
    });

    await expect(service.configure({ mode: "serve", listenPort: 47_830 }))
      .rejects.toThrow("not connected");
    expect(runCommand).not.toHaveBeenCalledWith(
      "tailscale",
      expect.arrayContaining(["--bg"]),
    );
  });

  it("accepts status documents larger than the previous one MiB limit", async () => {
    const largeStatus = JSON.stringify({
      BackendState: "Running",
      Self: { Online: true, DNSName: "studio.example.ts.net." },
      Padding: "x".repeat(2 * 1024 * 1024),
    });
    const service = new FederationTailscaleService({
      discoverCommand: async () => ({ command: "tailscale" }),
      runCommand: async (_command, args) =>
        commandResult(args[0] === "status" ? largeStatus : "{}"),
    });

    await expect(service.readStatus()).resolves.toMatchObject({
      connected: true,
      dnsName: "studio.example.ts.net",
    });
  });

  it("never exposes raw command output through status errors", async () => {
    const privateTopology = "private-peer.internal 100.64.0.42 nodekey:secret";
    const service = new FederationTailscaleService({
      discoverCommand: async () => ({ command: "tailscale" }),
      runCommand: async () => {
        throw new Error(privateTopology);
      },
    });

    const status = await service.readStatus();
    expect(status.unavailableReason).toContain("command failed");
    expect(status.unavailableReason).not.toContain(privateTopology);
    expect(status).not.toHaveProperty("stdout");
    expect(status).not.toHaveProperty("stderr");
  });

  it("does not publish when listener ownership verification fails", async () => {
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "status") {
        return commandResult(JSON.stringify({
          BackendState: "Running",
          Self: { Online: true, DNSName: "studio.example.ts.net." },
        }));
      }
      return commandResult("{}");
    });
    const service = new FederationTailscaleService({
      discoverCommand: async () => ({ command: "tailscale" }),
      runCommand,
      verifyListener: async () => {
        throw new Error("PwrAgent listener is not bound.");
      },
    });

    await expect(service.configure({ mode: "funnel", listenPort: 47_830 }))
      .rejects.toThrow("not bound");
    expect(runCommand).not.toHaveBeenCalledWith(
      "tailscale",
      expect.arrayContaining(["--bg"]),
    );
  });

  it("never exposes raw command output through setup errors", async () => {
    const privateTopology = "private-peer.internal 100.64.0.42 nodekey:secret";
    const service = new FederationTailscaleService({
      discoverCommand: async () => ({ command: "tailscale" }),
      runCommand: async (_command, args) => {
        if (args[0] === "status") {
          return commandResult(JSON.stringify({
            BackendState: "Running",
            Self: { Online: true, DNSName: "studio.example.ts.net." },
          }));
        }
        if (args[0] === "serve" && args[1] === "--bg") {
          throw new Error(privateTopology);
        }
        return commandResult("{}");
      },
      verifyListener: async () => undefined,
    });

    const setup = service.configure({ mode: "serve", listenPort: 47_830 });
    await expect(setup)
      .rejects.toThrow(
        "Tailscale Serve command failed. Run it in Terminal for details.",
      );
    await expect(setup)
      .rejects.not.toThrow(privateTopology);
  });
});

function commandResult(stdout: string) {
  return { stdout, stderr: "" };
}
