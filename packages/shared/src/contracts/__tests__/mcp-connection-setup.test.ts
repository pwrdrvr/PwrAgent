import { describe, expect, it } from "vitest";
import {
  resolveMcpConnectionSetup,
  summarizeMcpConnectionReadiness,
  type McpConnectionStatus,
} from "../mcp-connections";

function connection(
  overrides: Partial<McpConnectionStatus> = {},
): McpConnectionStatus {
  return {
    id: "datadog",
    displayName: "Datadog",
    serverUrl: "https://mcp.example.com/mcp",
    authMode: "oauth",
    kind: "remote",
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    state: "ready",
    configured: true,
    ...overrides,
  };
}

describe("resolveMcpConnectionSetup", () => {
  it("never reports availability for a connection it holds no credentials for", () => {
    // The shipped row rendered `Not connected` beside an `On` switch, because
    // `enabled` defaults to true and the two were peers. Both statements were
    // true; together they read as a defect.
    const summary = resolveMcpConnectionSetup({
      connection: connection({ configured: false, state: "disconnected" }),
      gatewayEnabled: true,
    });
    expect(summary.state).toBe("not_authorized");
    expect(summary.headline).toBe("Not set up");
    expect(summary.offersAvailabilitySwitch).toBe(false);
    expect(summary.threadSelectable).toBe(false);
  });

  it("puts the gateway above every other reason", () => {
    // While the gateway is off, authorizing or flipping the row's own switch
    // changes nothing, so naming either remedy would send the operator to a
    // control that cannot help.
    const summary = resolveMcpConnectionSetup({
      connection: connection({ configured: false }),
      gatewayEnabled: false,
    });
    expect(summary.state).toBe("gateway_off");
    expect(summary.threadSelectable).toBe(false);
  });

  it("distinguishes a local app that is missing from one that is merely closed", () => {
    expect(
      resolveMcpConnectionSetup({
        connection: connection({ kind: "pwrgit", configured: false }),
        gatewayEnabled: true,
        localAvailability: "not_installed",
      }).state,
    ).toBe("app_not_installed");
    expect(
      resolveMcpConnectionSetup({
        connection: connection({ kind: "pwrgit", configured: false }),
        gatewayEnabled: true,
        localAvailability: "installed",
      }).state,
    ).toBe("app_not_running");
  });

  it("separates parked from broken", () => {
    // Parking keeps credentials; only `remove` discards them. Reporting both
    // as "off" left the operator unable to tell which one they were looking
    // at.
    expect(
      resolveMcpConnectionSetup({
        connection: connection({ enabled: false }),
        gatewayEnabled: true,
      }).state,
    ).toBe("parked");
    expect(
      resolveMcpConnectionSetup({
        connection: connection({ state: "reauthorization_required" }),
        gatewayEnabled: true,
      }).state,
    ).toBe("login_required");
  });

  it("calls a connection selectable only when a thread could actually reach it", () => {
    expect(
      resolveMcpConnectionSetup({ connection: connection(), gatewayEnabled: true })
        .threadSelectable,
    ).toBe(true);
    for (const broken of [
      connection({ enabled: false }),
      connection({ configured: false }),
      connection({ state: "temporarily_unavailable" }),
    ]) {
      expect(
        resolveMcpConnectionSetup({ connection: broken, gatewayEnabled: true })
          .threadSelectable,
      ).toBe(false);
    }
  });
});

describe("summarizeMcpConnectionReadiness", () => {
  it("counts readiness rather than the availability switch", () => {
    // The shipped chip read "2 of 2 on" while one of the two held no
    // credentials and could not serve a single tool.
    const summaries = [
      connection(),
      connection({ id: "pwrsnap", configured: false, state: "disconnected" }),
    ].map((entry) =>
      resolveMcpConnectionSetup({ connection: entry, gatewayEnabled: true }),
    );
    expect(summarizeMcpConnectionReadiness(summaries)).toEqual({
      ready: 1,
      parked: 0,
      needsSetup: 1,
      gatewayOff: 0,
      total: 2,
    });
  });

  it("keeps gateway-off rows out of the setup count", () => {
    // Every state collapses to `gateway_off` while the switch is off, so
    // counting them as setup work told the operator four authorized
    // connections needed attention they did not need.
    const summaries = [connection(), connection({ id: "atlassian" })].map(
      (entry) =>
        resolveMcpConnectionSetup({ connection: entry, gatewayEnabled: false }),
    );
    expect(summarizeMcpConnectionReadiness(summaries)).toEqual({
      ready: 0,
      parked: 0,
      needsSetup: 0,
      gatewayOff: 2,
      total: 2,
    });
  });
});
