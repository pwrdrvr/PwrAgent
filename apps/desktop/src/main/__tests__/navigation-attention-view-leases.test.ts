import { expect, it, vi } from "vitest";
import type { NavigationQueryRequest } from "@pwragent/shared";
import { NavigationAttentionViewLeases } from "../app-server/navigation-attention-view-leases";

const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", query: { kind: "lens", lens: "attention" },
  attentionView: { id: "react-r0", promoteOnTurnEnd: true } };

it("isolates identical renderer view IDs across windows and retains lifetime across lenses", () => {
  const leases = new NavigationAttentionViewLeases(vi.fn(async () => undefined));
  const first = leases.qualify(1, request);
  const second = leases.qualify(2, request);
  expect(first.attentionView?.id).not.toBe(second.attentionView?.id);
  expect(leases.qualify(1, { ...request, query: { kind: "lens", lens: "recents" } }).attentionView?.id).toBe(first.attentionView?.id);
  expect(request.attentionView?.id).toBe("react-r0");
});

it("a delayed teardown releases only its original owner lifetime, never its replacement", async () => {
  let complete!: () => void;
  const release = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
  const leases = new NavigationAttentionViewLeases(release);
  const first = leases.qualify(1, request);
  const pending = leases.release(1, { viewId: "react-r0" });
  const replacement = leases.qualify(1, request);
  expect(replacement.attentionView?.id).not.toBe(first.attentionView?.id);
  expect(release).toHaveBeenCalledWith({ viewId: first.attentionView?.id, federationTarget: undefined });
  complete();
  await pending;
  expect(leases.qualify(1, request).attentionView?.id).toBe(replacement.attentionView?.id);
});

it("window teardown releases every queried owner without touching another window", async () => {
  const release = vi.fn(async () => undefined);
  const leases = new NavigationAttentionViewLeases(release);
  const local = leases.qualify(1, request);
  const remote = leases.qualify(1, { ...request, federationTarget: { scope: "remote", instanceId: "peer" } });
  const other = leases.qualify(2, request);
  await leases.releaseSender(1);
  expect(release).toHaveBeenCalledTimes(2);
  expect(release).toHaveBeenCalledWith({ viewId: local.attentionView?.id, federationTarget: undefined });
  expect(release).toHaveBeenCalledWith({ viewId: remote.attentionView?.id, federationTarget: { scope: "remote", instanceId: "peer" } });
  expect(leases.qualify(2, request).attentionView?.id).toBe(other.attentionView?.id);
});

it("bounds all retained lifetime identifiers and releases admission on teardown", async () => {
  const leases = new NavigationAttentionViewLeases(vi.fn(async () => undefined));
  for (let sender = 0; sender < 256; sender += 1) leases.qualify(sender, request);
  expect(leases.getBudgetUsage().views).toBe(256);
  expect(leases.getBudgetUsage().retainedBytes).toBeLessThan(256 * 1024);
  expect(() => leases.qualify(256, request)).toThrow("admission");
  await leases.releaseSender(0);
  expect(() => leases.qualify(256, request)).not.toThrow();
  await leases.dispose();
  expect(leases.getBudgetUsage().views).toBe(0);
});

it("measures retained UTF-8 identifiers independently of the view count", () => {
  const leases = new NavigationAttentionViewLeases(vi.fn(async () => undefined));
  let failure: unknown;
  for (let index = 0; index < 256; index += 1) {
    try {
      leases.qualify(index, { ...request, federationTarget: { scope: "remote", instanceId: "界".repeat(128) },
        attentionView: { id: "界".repeat(128), promoteOnTurnEnd: true },
      });
    } catch (error) { failure = error; break; }
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain("metadata budget");
  expect(leases.getBudgetUsage().views).toBeLessThan(256);
  expect(leases.getBudgetUsage().retainedBytes).toBeLessThanOrEqual(256 * 1024);
});
