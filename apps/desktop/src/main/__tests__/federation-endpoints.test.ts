import { describe, expect, it } from "vitest";
import { orderFederationEndpointAttempts } from "../federation/federation-endpoints";

const LAN = "ws://192.168.1.20:47830";
const TAILSCALE = "wss://studio.example.ts.net/pwragent-federation";
const CLOUDFLARE = "wss://federation.example.com";

describe("orderFederationEndpointAttempts", () => {
  it("keeps configured order", () => {
    expect(orderFederationEndpointAttempts([LAN, TAILSCALE, CLOUDFLARE])).toEqual(
      [LAN, TAILSCALE, CLOUDFLARE],
    );
  });

  it("trims and de-duplicates configured endpoints", () => {
    expect(
      orderFederationEndpointAttempts([` ${LAN} `, LAN, "", TAILSCALE]),
    ).toEqual([LAN, TAILSCALE]);
  });

  it("returns an empty list for no endpoints", () => {
    expect(orderFederationEndpointAttempts([])).toEqual([]);
  });
});
