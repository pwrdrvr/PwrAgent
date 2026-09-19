import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopFederationRuntime } from "../federation/federation-runtime";
import { FederationStore } from "../federation/federation-store";
import { StateDb } from "../state/state-db";
import { openInMemoryStateDb } from "./sqlite-test-utils";

type Harness = {
  store: () => FederationStore;
  revokePeer: (peerId: string) => Promise<unknown>;
  revokeEnrollment: (enrollmentId: string) => Promise<void>;
};

let stateDb: StateDb;
let store: FederationStore;
let runtime: Harness;

beforeEach(() => {
  stateDb = openInMemoryStateDb();
  store = new FederationStore(stateDb);
  runtime = new DesktopFederationRuntime() as unknown as Harness;
  runtime.store = () => store;
  runtime.revokePeer = vi.fn(async () => undefined);
});

afterEach(() => {
  stateDb.close();
});

// A Cloudflare client's Revoke removes its credential from Access, which only
// refuses new connections. These are the two cases for the session it opened.
describe("revoking what a federation invite led to", () => {
  it("revokes the peer that enrolled with the invite, which closes its session", async () => {
    const invite = store.createEnrollment({ token: "tokentokentokentokentokentokent1", generatedAt: 1_000, expiresAt: Date.now() + 60_000 });
    store.upsertPeer({ updatedAt: 1_500, peer: { id: "desktop_one", label: "Travel laptop", role: "client", status: "connected", capabilities: [], protocolVersion: 1 } });
    store.markEnrollmentUsed({ enrollmentId: invite.id, peerId: "desktop_one", usedAt: 1_500 });
    await runtime.revokeEnrollment(invite.id);
    expect(runtime.revokePeer).toHaveBeenCalledWith("desktop_one");
  });

  it("retires an invite nobody has used yet", async () => {
    const invite = store.createEnrollment({ token: "tokentokentokentokentokentokent2", generatedAt: 1_000, expiresAt: Date.now() + 60_000 });
    await runtime.revokeEnrollment(invite.id);
    expect(store.getEnrollment(invite.id)).toMatchObject({ status: "revoked" });
    expect(runtime.revokePeer).not.toHaveBeenCalled();
  });
});
