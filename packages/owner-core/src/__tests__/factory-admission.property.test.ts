import fc from "fast-check";
import { expect, it } from "vitest";
import type { DurableTurnReceipt } from "@pwragent/shared/contracts/durable-turn-requests";
import { FactoryAdmission, type FactoryAdmissionPorts, type FactoryAdmissionRow } from "../factory-admission";

const owner = { instanceId: "test-owner", machineId: "mach_00000000-0000-4000-8000-000000000001" };
const now = () => 1_800_000_000_000;
const projectKey = "directory:/fixture";
const issueId = "00000000-1234-4123-9876-000000000262";
const approval = { action: "arm", owner, repository: "asterlabs/fixture", platform: "darwin", brief: "Implement the fixture",
  target: { ...owner, threadId: "test-thread", worktreePath: "/fixture-worktree" } };

it("the durable dispatcher sees at most one start across duplicate requests, lost replies and owner restarts", async () => {
  const actions = fc.array(fc.constantFrom("before", "after", "ack", "restart", "status", "duplicate"),
    { minLength: 3, maxLength: 24, size: "max" });
  const trackers = fc.constantFrom(
    { issueId },
    { workItem: { provider: "linear", id: issueId } },
    { workItem: { provider: "github", kind: "issue", repositoryId: "R_fixture", number: 42 } },
    { workItem: { provider: "github", kind: "pull_request", repositoryId: "R_fixture", number: 42 } },
    { workItem: { provider: "jira", siteId: "fixture-site", id: "10042" } },
  );
  await fc.assert(fc.asyncProperty(trackers, actions, async (tracker, steps) => {
    const subject = { projectKey, ...tracker };
    const arm = { ...approval, ...subject };
    const dispatch = { ...subject, action: "dispatch", brief: arm.brief };
    let row: FactoryAdmissionRow | undefined;
    let receipt: DurableTurnReceipt | null = null;
    let modelHasStarted = false;
    let starts = 0;
    let probes = 0;
    let retriesBeforeAcceptance = 0;
    let fault: string = "";
    const keys = new Set<string>();
    const ports: FactoryAdmissionPorts = {
      now, owner: () => owner, project: async () => true, resource: () => "cpu",
      probe: async () => {
        probes += 1;
        return { machineId: owner.machineId, platform: "darwin", virtualMachine: false, sampledAt: now() };
      },
      store: {
        read: () => row,
        insert: (next) => { row = next; return true; },
        update: (_, next) => { row = next; },
      },
      acquire: async () => "granted", release: async () => true, capacity: async () => null,
      receipt: async () => receipt,
      stop: async () => {},
      submit: async (target, request) => {
        keys.add(JSON.stringify(request.clientRequest));
        if (fault === "before") throw new Error("Interrupted before acceptance");
        starts += 1;
        receipt = {
          version: 1, state: "dispatched", id: request.clientRequest.id, payloadHash: request.clientRequest.payloadHash,
          ownerInstanceId: target.instanceId, backend: "codex", threadId: target.threadId, queueEntryId: "queue",
          acceptedAt: now(), updatedAt: now(), expiresAt: now() + 10_000,
        };
        if (fault === "after") throw new Error("Interrupted after acceptance");
        return receipt;
      },
    };
    let service = new FactoryAdmission(ports);
    const armed = await service.command(arm);
    for (const step of steps) {
      if (step === "restart") service = new FactoryAdmission(ports);
      else if (step === "status") {
        const previous = row?.revision;
        expect((await service.command({ ...subject, action: "status" })).row.revision).toBe(previous);
      } else if (step === "duplicate") {
        expect((await service.command(arm)).row.id).toBe(armed.row.id);
      } else {
        fault = step;
        if (!modelHasStarted) {
          retriesBeforeAcceptance += 1;
          modelHasStarted = step !== "before";
        }
        await service.command(dispatch);
      }
      expect(starts).toBe(Number(modelHasStarted));
      expect(probes).toBe(retriesBeforeAcceptance);
      expect(keys.size).toBeLessThanOrEqual(1);
    }
  }));
});
