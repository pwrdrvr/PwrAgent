import { describe, expect, it } from "vitest";
import type { FederationActiveConnection } from "@pwragent/shared";
import { federationTransportTag } from "./federation-transport";

const incoming = (remoteAddress: string): FederationActiveConnection =>
  ({ peerId: "peer", direction: "incoming", remoteAddress, localAddress: "192.168.1.10:47830" });
const outgoing = (endpoint: string): FederationActiveConnection =>
  ({ peerId: "peer", direction: "outgoing", endpoint });

describe("federationTransportTag", () => {
  it.each([
    ["192.168.1.20:54321", "LAN"],
    ["10.0.0.5:1", "LAN"],
    ["172.20.1.1:1", "LAN"],
    ["[fd00::2]:54322", "LAN"],
    ["100.101.7.22:51210", "Tailscale"],
    ["[fd7a:115c:a1e0::5]:1", "Tailscale"],
    ["127.0.0.1:61876", "Local"],
    ["[::1]:1", "Local"],
    ["[::ffff:127.0.0.1]:1", "Local"],
    ["203.0.113.7:443", "Direct"],
    ["100.128.0.1:1", "Direct"],
  ])("tags an incoming socket from %s as %s", (address, tag) => {
    expect(federationTransportTag(incoming(address))).toBe(tag);
  });

  it("names the Cloudflare Tunnel rather than the loopback it arrives on", () => {
    expect(federationTransportTag({ ...incoming("127.0.0.1:61876"), via: "cloudflare-tunnel" })).toBe("Cloudflare");
  });

  it.each([
    ["ws://gateway.example.ts.net:47830", "Tailscale"],
    ["ws://192.168.1.20:47830", "LAN"],
    ["ws://studio.local:47830", "LAN"],
    ["wss://fed.example.net", "Direct"],
    ["ws://[fd7a:115c:a1e0::1]:47830", "Tailscale"],
    ["not a url", "Direct"],
  ])("tags an outgoing connection to %s as %s", (endpoint, tag) => {
    expect(federationTransportTag(outgoing(endpoint))).toBe(tag);
  });
});
