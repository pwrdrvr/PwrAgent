import { describe, expect, it } from "vitest";
import {
  federationEndpointAcceptsCloudflareCredentials,
  isFederationGatewayEndpointUrl,
  parseFederationGatewayEndpoint,
} from "../federation";

describe("parseFederationGatewayEndpoint", () => {
  it("normalizes scheme and host casing", () => {
    expect(parseFederationGatewayEndpoint("WSS://Gateway.Example.com/x")).
      toMatchObject({
        scheme: "wss",
        host: "gateway.example.com",
        hostPort: "gateway.example.com",
        isTls: true,
      });
  });

  it("keeps the port as part of the credential-scoping identity", () => {
    expect(parseFederationGatewayEndpoint("ws://host:47830")).toMatchObject({
      host: "host",
      hostPort: "host:47830",
      isTls: false,
    });
  });

  it("parses an ssh endpoint with a user", () => {
    expect(parseFederationGatewayEndpoint("ssh://ops@gateway.lan")).toMatchObject(
      { scheme: "ssh", host: "gateway.lan", user: "ops", isTls: false },
    );
  });

  it("handles IPv6 hosts", () => {
    expect(parseFederationGatewayEndpoint("ws://[::1]:47830")).toMatchObject({
      host: "[::1]",
      hostPort: "[::1]:47830",
    });
  });

  it.each([
    "https://gateway.example.com",
    "http://gateway.example.com",
    "file:///etc/passwd",
    "ws://",
    "not-a-url",
    // Embedded credentials.
    "wss://user:secret@gateway.example.com",
    // Would reach ssh(1) as an option instead of a destination.
    "ssh://-oProxyCommand=touch%20pwned",
    "ssh://-ohost@gateway.lan",
  ])("rejects %s", (value) => {
    expect(parseFederationGatewayEndpoint(value)).toBeUndefined();
    expect(isFederationGatewayEndpointUrl(value)).toBe(false);
  });
});

describe("federationEndpointAcceptsCloudflareCredentials", () => {
  const designated = "wss://federation.example.com";

  it("accepts the designated endpoint", () => {
    expect(
      federationEndpointAcceptsCloudflareCredentials({
        endpoint: designated,
        cloudflareEndpoint: designated,
        configuredEndpointCount: 3,
      }),
    ).toBe(true);
  });

  // These credentials travel in the WebSocket upgrade, before the Noise
  // handshake pins anything, so any other host must never receive them.
  it("refuses a different wss:// host even when one is designated", () => {
    expect(
      federationEndpointAcceptsCloudflareCredentials({
        endpoint: "wss://attacker.example",
        cloudflareEndpoint: designated,
        configuredEndpointCount: 3,
      }),
    ).toBe(false);
  });

  it("refuses a host that only differs by port", () => {
    expect(
      federationEndpointAcceptsCloudflareCredentials({
        endpoint: "wss://federation.example.com:8443",
        cloudflareEndpoint: designated,
        configuredEndpointCount: 2,
      }),
    ).toBe(false);
  });

  it("matches case-insensitively and ignores the path", () => {
    expect(
      federationEndpointAcceptsCloudflareCredentials({
        endpoint: "wss://Federation.Example.com/pwragent-federation",
        cloudflareEndpoint: "WSS://federation.example.com/other",
        configuredEndpointCount: 2,
      }),
    ).toBe(true);
  });

  it("refuses every host when several are configured and none is designated", () => {
    expect(
      federationEndpointAcceptsCloudflareCredentials({
        endpoint: "wss://one.example",
        configuredEndpointCount: 2,
      }),
    ).toBe(false);
  });

  it("keeps single-endpoint behavior without an explicit designation", () => {
    expect(
      federationEndpointAcceptsCloudflareCredentials({
        endpoint: "wss://one.example",
        configuredEndpointCount: 1,
      }),
    ).toBe(true);
  });

  it.each(["ws://lan.example:47830", "ssh://ops@gateway.lan"])(
    "never accepts %s",
    (endpoint) => {
      expect(
        federationEndpointAcceptsCloudflareCredentials({
          endpoint,
          cloudflareEndpoint: endpoint,
          configuredEndpointCount: 1,
        }),
      ).toBe(false);
    },
  );
});
