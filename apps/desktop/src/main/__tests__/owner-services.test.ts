import { getRuntimeFederationLeaseCoordinator } from "../runtime-federation-lease";
import { getRuntimeMessagingLeaseCoordinator } from "../runtime-messaging-lease";
import { getDesktopConfigStore } from "../settings/config-store/desktop-config-store-singleton";
import { getDesktopAutomationService } from "../automations/desktop-automation-service";
import { getScheduledThreadActionService } from "../scheduled-actions/scheduled-thread-action-service";
import { getMcpConnectionGatewayService } from "../mcp-connections/mcp-connection-gateway-service";
import { afterAll, expect, expectTypeOf, it } from "vitest";
import type { RegistryContext } from "../app-server/registry-context";
import { getOwnerHostServices } from "../owner-host";
import { startOwnerServices, disposeOwnerServices, disposeOwnerServicesSync, prepareOwnerShutdown } from "../owner-services";
import { getDesktopBackendRegistry } from "../app-server/backend-registry";
import { getDesktopAppServerService } from "../app-server/desktop-app-server-service";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import { getDesktopFederationRuntime } from "../federation/federation-runtime";
import { getDesktopMessagingRuntime } from "../messaging/messaging-runtime";
import { getRuntimeLeaseManager } from "../runtime-lease-manager";
import { disposeAppState } from "../storage/desktop-state-lifecycle";

it("returns the root's instances through every owner getter", async () => {
  const services = await startOwnerServices(getOwnerHostServices(), { bootMode: "bootstrap", startedAt: 0 });
  expect(getDesktopBackendRegistry()).toBe(services.registry);
  expect(getDesktopAppServerService()).toBe(services.service);
  expect(getDesktopSettingsService()).toBe(services.settings);
  expect(getDesktopFederationRuntime()).toBe(services.federationRuntime);
  expect(getDesktopMessagingRuntime()).toBe(services.messagingRuntime);
  expect(getRuntimeLeaseManager()).toBe(services.leaseManager);
  expect(getDesktopConfigStore()).toBe(services.config);
  expect(getRuntimeFederationLeaseCoordinator()).toBe(services.federationLease);
  expect(getRuntimeMessagingLeaseCoordinator()).toBe(services.messagingLease);
  expect(getMcpConnectionGatewayService()).toBe(services.mcpGateway);
  expect(getScheduledThreadActionService()).toBe(services.scheduledActions);
  expect(getDesktopAutomationService()).toBe(services.automations);
  const context = services.registry.context;
  expect(context.lifecycle.closed).toBe(false);
  expect(context.providers.codex).toBeDefined();
  expect(context.providers.claude).toBeDefined();
  expect(context.providers.acp).toBeDefined();
  expectTypeOf<RegistryContext["stores"]["usage"]>().not.toHaveProperty("setThreadExecutionMode");
  expectTypeOf<RegistryContext["stores"]["threads"]>().not.toHaveProperty("upsertThreadUsageLines");
  expectTypeOf<RegistryContext["stores"]["workspaces"]>().not.toHaveProperty("getThreadOverlayState");
  for (const port of Object.values(context.stores)) {
    expect(port).not.toHaveProperty("setThreadExecutionMode");
  }
  expect(() => startOwnerServices(getOwnerHostServices(), { bootMode: "bootstrap", startedAt: 1 })).toThrow(/already/);
});

afterAll(async () => {
  const context = getDesktopBackendRegistry().context;
  prepareOwnerShutdown();
  await disposeOwnerServices("test");
  expect(context.lifecycle.closed).toBe(true);
  disposeOwnerServicesSync();
  disposeAppState();
});
