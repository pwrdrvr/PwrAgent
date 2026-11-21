import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { FederationHealthStatus } from "@pwragent/shared/contracts/federation";
import type { ListFederationInstancesResult } from "@pwragent/shared/contracts/federation-tools";
import { createFederationAgentToolsHandler } from "../federation/federation-agent-tools-service";
import type { DesktopFederationRuntime } from "../federation/federation-runtime";

vi.mock("../settings/desktop-settings-singleton", () => ({
  getDesktopSettingsService: () => ({ readFederationConfig: () => ({ instanceLabel: "Local" }) }),
}));

async function expectQualifiedQuery(label: string, query: string) {
  const base = { label, role: "client" as const, status: "connected" as const, capabilities: [] };
  const health: FederationHealthStatus = { enabled: true, role: "gateway", status: "listening", instanceId: "local",
    peers: [{ ...base, id: "pwr_default", profileName: "default" }, { ...base, id: "pwr_dev", profileName: "dev" }] };
  const handler = createFederationAgentToolsHandler({
    runtime: () => ({ health: async () => health }) as DesktopFederationRuntime,
    collectHostInfo: async () => { throw new Error("No fixture host data"); },
  });
  const result = await handler({ operation: "list_federation_instances",
    context: { backend: "codex", threadId: "thread", turnId: "turn", callId: "call" }, args: { query } });
  if (!result.ok) throw new Error(result.error.message);
  const { instances } = result.data as ListFederationInstancesResult;
  expect(instances.map(({ instanceId, label, profileName }) => ({ instanceId, label, profileName })))
    .toEqual([{ instanceId: "pwr_default", label, profileName: "default" }]);
}

it("accepts qualified default profile names without including the qualifier in the returned label", async () => {
  await fc.assert(fc.asyncProperty(fc.stringMatching(/^Host[A-Z]{0,6}$/), fc.boolean(), fc.boolean(), async (label, compact, uppercase) => {
    const query = `${label}${compact ? "/" : " / "}default`;
    await expectQualifiedQuery(label, uppercase ? query.toUpperCase() : query);
  }), { numRuns: 30 });
});

it("finds the default instance with a query for Host / default", async () => {
  await expectQualifiedQuery("Host", "Host / default");
});
