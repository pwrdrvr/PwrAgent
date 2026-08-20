import { describe, expect, it } from "vitest";
import type { FederationTailscaleStatus } from "@pwragent/shared";
import {
  buildFederationAdvertisedEndpoints,
  federationHostnameEndpointCandidate,
  federationTailscaleAdvertisementFromStatus,
  type FederationAdvertisedEndpointInputs,
} from "../federation/federation-advertised-endpoints";

const LAN_INTERFACE = {
  name: "en0",
  address: "192.168.4.115",
  family: "IPv4" as const,
  internal: false,
};
const LOOPBACK_INTERFACE = {
  name: "lo0",
  address: "127.0.0.1",
  family: "IPv4" as const,
  internal: true,
};

function inputs(
  overrides: Partial<FederationAdvertisedEndpointInputs> = {},
): FederationAdvertisedEndpointInputs {
  return {
    listenHost: "0.0.0.0",
    listenPort: 47830,
    hostname: "studio.local",
    platform: "darwin",
    interfaceAddresses: [LOOPBACK_INTERFACE, LAN_INTERFACE],
    ...overrides,
  };
}

describe("federationHostnameEndpointCandidate", () => {
  it("uses a dotted hostname as-is", () => {
    expect(
      federationHostnameEndpointCandidate({
        hostname: "studio.local",
        platform: "darwin",
      }),
    ).toBe("studio.local");
  });

  it("appends .local to a bare name on an mDNS platform", () => {
    expect(
      federationHostnameEndpointCandidate({
        hostname: "studio",
        platform: "darwin",
      }),
    ).toBe("studio.local");
  });

  it("leaves a bare Windows name alone", () => {
    // Windows answers for its name over LLMNR, not mDNS, so a synthesized
    // .local would never resolve and would cost every client a dial timeout.
    expect(
      federationHostnameEndpointCandidate({
        hostname: "studio",
        platform: "win32",
      }),
    ).toBe("studio");
  });

  it("rejects a hostname that cannot be a URL authority", () => {
    expect(
      federationHostnameEndpointCandidate({
        hostname: "Harold's Mac.local",
        platform: "darwin",
      }),
    ).toBeUndefined();
    expect(
      federationHostnameEndpointCandidate({ hostname: "  ", platform: "linux" }),
    ).toBeUndefined();
  });
});

describe("buildFederationAdvertisedEndpoints", () => {
  it("advertises the machine name ahead of its current address", () => {
    expect(buildFederationAdvertisedEndpoints(inputs())).toEqual([
      "ws://studio.local:47830",
      "ws://192.168.4.115:47830",
    ]);
  });

  it("puts an operator public URL first", () => {
    expect(
      buildFederationAdvertisedEndpoints(
        inputs({ publicUrl: "wss://federation.example.com" }),
      ),
    ).toEqual([
      "wss://federation.example.com",
      "ws://studio.local:47830",
      "ws://192.168.4.115:47830",
    ]);
  });

  it("dials the tailnet name directly when Serve is not configured", () => {
    expect(
      buildFederationAdvertisedEndpoints(
        inputs({ tailscale: { dnsName: "studio.tail1234.ts.net" } }),
      ),
    ).toEqual([
      "ws://studio.local:47830",
      "ws://studio.tail1234.ts.net:47830",
      "ws://192.168.4.115:47830",
    ]);
  });

  it("prefers a configured Serve URL over the raw tailnet dial", () => {
    expect(
      buildFederationAdvertisedEndpoints(
        inputs({
          tailscale: {
            dnsName: "studio.tail1234.ts.net",
            serveUrl: "wss://studio.tail1234.ts.net/pwragent-federation",
          },
        }),
      ),
    ).toEqual([
      "ws://studio.local:47830",
      "wss://studio.tail1234.ts.net/pwragent-federation",
      "ws://192.168.4.115:47830",
    ]);
  });

  it("drops the CGNAT literal that the tailnet name already covers", () => {
    const endpoints = buildFederationAdvertisedEndpoints(
      inputs({
        interfaceAddresses: [
          LAN_INTERFACE,
          {
            name: "utun11",
            address: "100.102.158.117",
            family: "IPv4",
            internal: false,
          },
        ],
        tailscale: { dnsName: "studio.tail1234.ts.net" },
      }),
    );
    expect(endpoints).not.toContain("ws://100.102.158.117:47830");
  });

  it("keeps the CGNAT literal when no tailnet name was resolved", () => {
    expect(
      buildFederationAdvertisedEndpoints(
        inputs({
          interfaceAddresses: [
            {
              name: "utun11",
              address: "100.102.158.117",
              family: "IPv4",
              internal: false,
            },
          ],
        }),
      ),
    ).toContain("ws://100.102.158.117:47830");
  });

  it("skips internal, link-local, and IPv6 addresses", () => {
    expect(
      buildFederationAdvertisedEndpoints(
        inputs({
          hostname: "  ",
          interfaceAddresses: [
            LOOPBACK_INTERFACE,
            {
              name: "en1",
              address: "169.254.10.4",
              family: "IPv4",
              internal: false,
            },
            { name: "en0", address: "fe80::1", family: "IPv6", internal: false },
            {
              name: "en0",
              address: "fd3c:de03::1",
              family: "IPv6",
              internal: false,
            },
            LAN_INTERFACE,
          ],
        }),
      ),
    ).toEqual(["ws://192.168.4.115:47830"]);
  });

  it("skips host-only bridges that no peer can reach", () => {
    // A VM or Internet Sharing bridge is not flagged `internal`, so without
    // the name filter every client burns a connect timeout on it each cycle.
    expect(
      buildFederationAdvertisedEndpoints(
        inputs({
          hostname: "  ",
          interfaceAddresses: [
            {
              name: "bridge100",
              address: "192.168.2.1",
              family: "IPv4",
              internal: false,
            },
            {
              name: "docker0",
              address: "172.17.0.1",
              family: "IPv4",
              internal: false,
            },
            LAN_INTERFACE,
          ],
        }),
      ),
    ).toEqual(["ws://192.168.4.115:47830"]);
  });

  it("advertises only the bound address when the listener is not on a wildcard", () => {
    expect(
      buildFederationAdvertisedEndpoints(
        inputs({
          listenHost: "192.168.4.115",
          interfaceAddresses: [
            LAN_INTERFACE,
            {
              name: "en1",
              address: "10.9.0.2",
              family: "IPv4",
              internal: false,
            },
          ],
        }),
      ),
    ).toEqual(["ws://studio.local:47830", "ws://192.168.4.115:47830"]);
  });

  it("keeps a loopback-bound invite honest about the binding", () => {
    // Names and LAN literals would all refuse: nothing off this machine can
    // reach a loopback listener, and an invite must not imply otherwise.
    expect(
      buildFederationAdvertisedEndpoints(inputs({ listenHost: "127.0.0.1" })),
    ).toEqual(["ws://127.0.0.1:47830"]);
  });

  it("de-duplicates a public URL that repeats a synthesized endpoint", () => {
    expect(
      buildFederationAdvertisedEndpoints(
        inputs({ publicUrl: "ws://Studio.local:47830" }),
      ),
    ).toEqual(["ws://Studio.local:47830", "ws://192.168.4.115:47830"]);
  });

  it("returns nothing for an unusable port", () => {
    expect(buildFederationAdvertisedEndpoints(inputs({ listenPort: 0 }))).toEqual(
      [],
    );
  });
});

describe("federationTailscaleAdvertisementFromStatus", () => {
  function status(
    overrides: Partial<FederationTailscaleStatus> = {},
  ): FederationTailscaleStatus {
    return {
      installed: true,
      connected: true,
      serveConfigured: false,
      funnelConfigured: false,
      dnsName: "studio.tail1234.ts.net",
      gatewayUrl: "wss://studio.tail1234.ts.net/pwragent-federation",
      ...overrides,
    };
  }

  it("ignores the Serve URL until Serve or Funnel is configured", () => {
    expect(federationTailscaleAdvertisementFromStatus(status())).toEqual({
      dnsName: "studio.tail1234.ts.net",
    });
  });

  it("carries the Serve URL once it is configured", () => {
    expect(
      federationTailscaleAdvertisementFromStatus(
        status({ serveConfigured: true }),
      ),
    ).toEqual({
      dnsName: "studio.tail1234.ts.net",
      serveUrl: "wss://studio.tail1234.ts.net/pwragent-federation",
    });
  });

  it("advertises nothing while the device is disconnected", () => {
    expect(
      federationTailscaleAdvertisementFromStatus(status({ connected: false })),
    ).toBeUndefined();
  });

  it("advertises nothing when Tailscale reports no name", () => {
    expect(
      federationTailscaleAdvertisementFromStatus(
        status({ dnsName: undefined, gatewayUrl: undefined }),
      ),
    ).toBeUndefined();
  });
});
