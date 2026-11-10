import { getDesktopAutomationService } from "../automations/desktop-automation-service";
import { getScheduledThreadActionService } from "../scheduled-actions/scheduled-thread-action-service";
import { getMcpConnectionGatewayService } from "../mcp-connections/mcp-connection-gateway-service";
import fc from "fast-check";
import { expect, it } from "vitest";
import { getDesktopBackendRegistry } from "../app-server/backend-registry";
import { getDesktopAppServerService } from "../app-server/desktop-app-server-service";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import { getDesktopConfigStore } from "../settings/config-store/desktop-config-store-singleton";
import { getDesktopFederationRuntime } from "../federation/federation-runtime";
import { getDesktopMessagingRuntime } from "../messaging/messaging-runtime";
import { getRuntimeFederationLeaseCoordinator } from "../runtime-federation-lease";
import { getRuntimeMessagingLeaseCoordinator } from "../runtime-messaging-lease";
import { getRuntimeLeaseManager, setRuntimeLeaseManagerForTests } from "../runtime-lease-manager";

it("never constructs an owner through any sequence of getter calls before the root starts", () => {
  setRuntimeLeaseManagerForTests(null);
  const getters = [
    getDesktopBackendRegistry, getDesktopAppServerService, getDesktopSettingsService,
    getDesktopConfigStore, getDesktopFederationRuntime, getDesktopMessagingRuntime,
    getRuntimeLeaseManager, getRuntimeFederationLeaseCoordinator, getRuntimeMessagingLeaseCoordinator, getMcpConnectionGatewayService, getDesktopAutomationService, getScheduledThreadActionService,
  ];
  fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: getters.length - 1 }), { minLength: 1, maxLength: 30 }), (reads) => {
    for (const read of reads) expect(() => getters[read]()).toThrow(/startOwnerServices/);
  }));
});
