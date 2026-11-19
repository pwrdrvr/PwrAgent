import { getRuntimeFederationLeaseCoordinator } from "../runtime-federation-lease";
import { getRuntimeMessagingLeaseCoordinator } from "../runtime-messaging-lease";
import { getDesktopConfigStore } from "../settings/config-store/desktop-config-store-singleton";
import { getDesktopAutomationService } from "../automations/desktop-automation-service";
import { getScheduledThreadActionService } from "../scheduled-actions/scheduled-thread-action-service";
import { getMcpConnectionGatewayService } from "../mcp-connections/mcp-connection-gateway-service";
import { afterAll, expect, expectTypeOf, it, vi } from "vitest";
import type { ResearchPorts } from "@pwragent/owner-core/research-service";
import * as researchRuntime from "../research/research-runtime";
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

let researchPorts: ResearchPorts;
it("returns the root's instances through every owner getter", async () => {
  const initialize = researchRuntime.initializeResearchRuntime;
  const capture = vi.spyOn(researchRuntime, "initializeResearchRuntime").mockImplementation((ports) => {
    researchPorts = ports;
    return initialize(ports);
  });
  const services = await startOwnerServices(getOwnerHostServices(), { bootMode: "bootstrap", startedAt: 0 }).finally(() => capture.mockRestore());
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

it.each(["Lost response after admission", "Transport closed during start"])("does not certify non-admission from a caught start error: %s", async (message) => {
  const workspace = { mode: "none", git: { kind: "none", worktreeCreationAvailable: false, unavailableReason: "Scratch worker" } } as const;
  const handoff = vi.spyOn(getDesktopBackendRegistry(), "handoffResearchWorker").mockResolvedValue({ ok: true, data: {
    backend: "codex", threadId: "possibly-admitted", turnStartFailure: { message, phase: "turn" },
    threadUrl: "pwragent://thread/possibly-admitted?backend=codex", threadLink: "[Worker](pwragent://thread/possibly-admitted?backend=codex)",
    seedMode: "clean", groupingMode: "subthread", inheritedSettings: { backend: "codex" }, workspace,
    origin: { sourceBackend: "codex", sourceThreadId: "parent", seedMode: "clean", groupingMode: "subthread", createdAt: 1000, workspace },
    messagingAttachment: { requested: false, outcome: "not_requested" },
  } });
  try {
    await expect(researchPorts.spawn({ backend: "codex", threadId: "parent", kind: "agent", turnId: "turn", callId: "call" }, "Task", "Title", "none", () => {})).rejects.toThrow(message);
  } finally { handoff.mockRestore(); }
});

it("a live Experimental settings transition disables admissions and stops owned research", async () => {
  const stop = vi.spyOn(researchRuntime.getResearchService(), "stopOwnedRuns").mockResolvedValue();
  try {
    expect(researchPorts.enabled?.()).toBe(false);
    await getDesktopSettingsService().writeConfigPatchTargeted({ experimental: { researchEnabled: true } });
    expect(researchPorts.enabled?.()).toBe(true);
    await getDesktopSettingsService().writeConfigPatchTargeted({ experimental: { researchEnabled: false } });
    expect(researchPorts.enabled?.()).toBe(false);
    await vi.waitFor(() => expect(stop).toHaveBeenCalledExactlyOnceWith("Research runs were disabled in Experimental settings"));
  } finally { stop.mockRestore(); }
});

it("turning Codex Tool Discovery off stops only the native runs a Codex thread coordinates", async () => {
  const stop = vi.spyOn(researchRuntime.getResearchService(), "stopOwnedRuns").mockResolvedValue();
  const settings = getDesktopSettingsService();
  try {
    await settings.writeConfigPatchTargeted({ experimental: { researchEnabled: true, codexToolDiscovery: true } });
    expect(stop).not.toHaveBeenCalled();
    await settings.writeConfigPatchTargeted({ experimental: { codexToolDiscovery: false } });
    expect(researchPorts.enabled?.()).toBe(true);
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    const [reason, include] = stop.mock.calls[0]!;
    expect(reason).toContain("Codex Tool Discovery");
    const header = (backend: "codex" | "claude" | "acp:kimi", harness: boolean) => ({ coordinator: { backend, threadId: "coordinator" }, ...(harness ? { harness: {} } : {}) }) as unknown as Parameters<NonNullable<typeof include>>[0];
    expect([header("codex", false), header("claude", false), header("acp:kimi", false), header("codex", true)].map((run) => include!(run))).toEqual([true, false, false, false]);
    // Turning it back on, with Research still on, stops nothing.
    await settings.writeConfigPatchTargeted({ experimental: { codexToolDiscovery: true } });
    expect(stop).toHaveBeenCalledOnce();
  } finally {
    await settings.writeConfigPatchTargeted({ experimental: { researchEnabled: false, codexToolDiscovery: true } });
    stop.mockRestore();
  }
});

afterAll(async () => {
  const context = getDesktopBackendRegistry().context;
  prepareOwnerShutdown();
  await disposeOwnerServices("test");
  expect(context.lifecycle.closed).toBe(true);
  disposeOwnerServicesSync();
  disposeAppState();
});
