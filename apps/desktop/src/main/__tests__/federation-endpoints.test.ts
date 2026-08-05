import { describe, expect, it } from "vitest";
import { orderFederationEndpointAttempts } from "../federation/federation-endpoints";

const LAN = "ws://192.168.1.20:47830";
const TAILSCALE = "wss://studio.example.ts.net/pwragent-federation";
const CLOUDFLARE = "wss://federation.example.com";

describe("orderFederationEndpointAttempts", () => {
  it("keeps configured order without a last-good endpoint", () => {
    expect(orderFederationEndpointAttempts([LAN, TAILSCALE, CLOUDFLARE])).toEqual(
      [LAN, TAILSCALE, CLOUDFLARE],
    );
  });

  it("moves the last-good endpoint to the front", () => {
    expect(
      orderFederationEndpointAttempts([LAN, TAILSCALE, CLOUDFLARE], CLOUDFLARE),
    ).toEqual([CLOUDFLARE, LAN, TAILSCALE]);
  });

  it("ignores a last-good endpoint that is no longer configured", () => {
    expect(
      orderFederationEndpointAttempts([LAN, TAILSCALE], "wss://removed.example"),
    ).toEqual([LAN, TAILSCALE]);
  });

  it("trims and de-duplicates configured endpoints", () => {
    expect(
      orderFederationEndpointAttempts([` ${LAN} `, LAN, "", TAILSCALE]),
    ).toEqual([LAN, TAILSCALE]);
  });

  it("returns an empty list for no endpoints", () => {
    expect(orderFederationEndpointAttempts([], LAN)).toEqual([]);
  });
});
