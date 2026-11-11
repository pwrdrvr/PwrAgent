import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { handleOutpostCommand } from "../headless/outpost";

it("issuing an invite preserves an existing gateway and its live peer sessions", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 65535 }), fc.constantFrom("gateway", "dual"), async (listenPort, mode) => {
    const write = vi.fn(), restart = vi.fn(), apply = vi.fn(), invite = vi.fn().mockResolvedValue({ invite: "fixture" });
    const services = { settings: { readFederationConfig: () => ({ mode, listenPort, listenHost: "127.0.0.1" }), writeConfigPatchTargeted: write },
      federationRuntime: { restart, generateInvite: invite }, onConfigPatchWritten: apply };
    expect(await handleOutpostCommand(services as unknown as Parameters<typeof handleOutpostCommand>[0], "federation-invite", {})).toEqual({ invite: "fixture" });
    expect(write).not.toHaveBeenCalled(); expect(restart).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
    expect(invite).toHaveBeenCalledOnce();
  }), { numRuns: 8 });
});
