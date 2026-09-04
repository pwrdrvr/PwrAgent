import { describe, expect, it } from "vitest";
import {
  orderFederationEndpointAttempts,
  resolveFederationClientEndpoints,
} from "../federation/federation-endpoints";

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

describe("resolveFederationClientEndpoints", () => {
  it("appends a learned endpoint behind the operator's own", () => {
    expect(
      resolveFederationClientEndpoints({
        configured: [LAN],
        learned: [TAILSCALE],
      }),
    ).toEqual([LAN, TAILSCALE]);
  });

  it("keeps the configured list when the gateway advertised nothing", () => {
    // An empty learned list means "no update", never "no endpoints" —
    // clearing the dial list here would strand the client.
    expect(
      resolveFederationClientEndpoints({
        configured: [LAN, CLOUDFLARE],
        learned: [],
      }),
    ).toEqual([LAN, CLOUDFLARE]);
  });

  it("prunes a learned endpoint the gateway stopped advertising", () => {
    const stale = "ws://192.168.6.163:47830";
    const first = resolveFederationClientEndpoints({
      configured: [LAN],
      learned: [stale, TAILSCALE],
    });
    expect(first).toContain(stale);
    // The learned list is replaced wholesale, so the drop needs no bookkeeping.
    expect(
      resolveFederationClientEndpoints({
        configured: [LAN],
        learned: [TAILSCALE],
      }),
    ).toEqual([LAN, TAILSCALE]);
  });

  it("de-duplicates case-insensitively across the two sources", () => {
    expect(
      resolveFederationClientEndpoints({
        configured: [` ${LAN} `],
        learned: [LAN.toUpperCase(), TAILSCALE],
      }),
    ).toEqual([LAN, TAILSCALE]);
  });

  it("never drops a configured endpoint to satisfy the cap", () => {
    const configured = Array.from(
      { length: 10 },
      (_, index) => `ws://configured-${index}.example:47830`,
    );
    const resolved = resolveFederationClientEndpoints({
      configured,
      learned: [TAILSCALE],
    });
    expect(resolved).toEqual(configured);
    expect(resolved).not.toContain(TAILSCALE);
  });

  it("caps how many learned endpoints ride along", () => {
    const learned = Array.from(
      { length: 12 },
      (_, index) => `ws://learned-${index}.example:47830`,
    );
    const resolved = resolveFederationClientEndpoints({
      configured: [LAN],
      learned,
    });
    expect(resolved).toHaveLength(8);
    expect(resolved[0]).toBe(LAN);
  });

  it("works from learned endpoints alone", () => {
    expect(
      resolveFederationClientEndpoints({ configured: [], learned: [TAILSCALE] }),
    ).toEqual([TAILSCALE]);
  });
});
