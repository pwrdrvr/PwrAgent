import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openResourceCheckoutStore } from "@pwragent/sqlite-storage/resource-checkout-store";
import {
  applyLocalCodexEnvironmentSelection,
  startLocalCodexEnvironmentAction,
  stopCodexEnvironmentDetachedCommand,
  waitForCodexEnvironmentDetachedCommandGone,
} from "../app-server/codex-environment-runtime";
import { ShellAutomationGateRunner } from "../automations/automation-gate-runner";
import * as checkoutRuntime from "../resource-checkouts/checkout-runtime";
import { DesktopResourceCheckoutService } from "../resource-checkouts/resource-checkout-service";
import { resolveWindowsBashShell } from "../windows-shell";

const isWindows = process.platform === "win32";
const SHELL_ENV: NodeJS.ProcessEnv = isWindows
  ? { ...process.env, SHELL: resolveWindowsBashShell() }
  : { ...process.env, SHELL: "/bin/sh" };

function createMachineService(root: string, machineCpuCount: number) {
  return new DesktopResourceCheckoutService({
    viewer: { instanceId: "local", instanceLabel: "Local", profile: "test", machineId: "host" },
    machineStore: openResourceCheckoutStore(path.join(root, "checkout.db"), "host"),
    machineCpuCount,
    bindings: [],
    now: () => 1_000,
    requestPeer: async () => { throw new Error("No peers"); },
    warn: () => {},
  });
}

function snapshotPool(service: DesktopResourceCheckoutService) {
  const [machine] = service.read().resources;
  return {
    condition: machine.condition,
    sharing: machine.sharing,
    allocations: machine.allocations,
    queue: machine.queue,
    cleanup: machine.cleanup,
  };
}

describe("local command isolation from machine resource checkouts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never lets machine checkouts block or get claimed by env setup, detached actions, or automation gates", async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 2, max: 32 }),
      fc.array(
        fc.record({
          holder: fc.constantFrom("operator" as const, "thread-a" as const, "thread-b" as const),
          wholeMachine: fc.boolean(),
          fraction: fc.integer({ min: 1, max: 4 }),
        }),
        { minLength: 0, maxLength: 4 },
      ),
      async (capacity, requests) => {
        const root = mkdtempSync(path.join(os.tmpdir(), "pwragent-checkout-isolation-"));
        const service = createMachineService(root, capacity);
        const runtime = vi.spyOn(checkoutRuntime, "getResourceCheckoutService").mockReturnValue(service);
        try {
          const [{ resourceId }] = service.read().resources;
          for (const [index, entry] of requests.entries()) {
            const units = entry.wholeMachine
              ? undefined
              : Math.min(capacity, Math.max(1, Math.floor((capacity * entry.fraction) / 4)));
            const actor = entry.holder === "operator"
              ? undefined
              : service.threadActor("codex", entry.holder);
            await service.perform({
              kind: "request",
              idempotencyKey: `req-${index}`,
              resourceId,
              purpose: `Cooperative work ${index}`,
              expectedDurationMs: 60_000,
              ...(units === undefined ? {} : { units }),
            }, actor);
          }

          const before = snapshotPool(service);

          const setup = await applyLocalCodexEnvironmentSelection({
            cwd: root,
            env: SHELL_ENV,
            owner: { backend: "codex", threadId: "new-thread" },
            selection: {
              executionTarget: "local",
              runSetup: true,
              environment: {
                id: "env",
                name: "Fixture Env",
                sourcePath: path.join(root, "environment.toml"),
                setupScript: "printf setup-ok",
                actions: [],
              },
            },
          });
          expect(setup?.setupStatus).toBe("completed");
          expect(setup?.setupOutput).toContain("setup-ok");
          expect(snapshotPool(service)).toEqual(before);

          const detachedExit = Promise.withResolvers<{ exitCode: number | null; output: string }>();
          await startLocalCodexEnvironmentAction({
            actionId: "run",
            runId: `run-${capacity}-${requests.length}`,
            env: SHELL_ENV,
            owner: { backend: "codex", threadId: "new-thread" },
            onDetachedExit: (event) => detachedExit.resolve(event),
            runtime: {
              environmentId: "env",
              environmentName: "Fixture Env",
              executionTarget: "local",
              cwd: root,
              setupStatus: "completed",
              actions: [{ id: "run", name: "Run", command: "printf action-ok" }],
            },
          });
          await expect(detachedExit.promise).resolves.toMatchObject({ exitCode: 0, output: "action-ok" });
          expect(snapshotPool(service)).toEqual(before);

          const gate = await new ShellAutomationGateRunner().runGate({
            cwd: root,
            command: "printf gate-ok",
          });
          expect(gate).toMatchObject({ status: "proceed", exitCode: 0, output: "gate-ok" });
          expect(snapshotPool(service)).toEqual(before);
        } finally {
          runtime.mockRestore();
          await service.close();
          rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
      },
    ), { numRuns: isWindows ? 2 : 6 });
  }, isWindows ? 60_000 : 20_000);

  it("allows env setup, detached actions, and automation gates while a 4/10 hold and 8/10 waiter exist", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pwragent-checkout-m4-repro-"));
    const service = createMachineService(root, 10);
    const runtime = vi.spyOn(checkoutRuntime, "getResourceCheckoutService").mockReturnValue(service);
    try {
      const [{ resourceId }] = service.read().resources;
      await expect(service.perform({
        kind: "request",
        idempotencyKey: "focused-tests",
        resourceId,
        purpose: "Focused tests",
        expectedDurationMs: 60_000,
        units: 4,
      }, service.threadActor("codex", "thread-tests"))).resolves.toMatchObject({ outcome: "granted" });
      await expect(service.perform({
        kind: "request",
        idempotencyKey: "desktop-build",
        resourceId,
        purpose: "Build desktop",
        expectedDurationMs: 60_000,
        units: 8,
      }, service.threadActor("codex", "thread-build"))).resolves.toMatchObject({ outcome: "queued", position: 1 });

      const before = snapshotPool(service);

      const setup = await applyLocalCodexEnvironmentSelection({
        cwd: root,
        env: SHELL_ENV,
        selection: {
          executionTarget: "local",
          runSetup: true,
          environment: {
            id: "env",
            name: "PwrAgent",
            sourcePath: path.join(root, "environment.toml"),
            setupScript: "printf ready",
            actions: [],
          },
        },
      });
      expect(setup?.setupStatus).toBe("completed");

      const detachedExit = Promise.withResolvers<{ exitCode: number | null }>();
      await startLocalCodexEnvironmentAction({
        actionId: "dev",
        runId: "dev-under-hold",
        env: SHELL_ENV,
        onDetachedExit: (event) => detachedExit.resolve(event),
        runtime: {
          environmentId: "env",
          environmentName: "PwrGit",
          executionTarget: "local",
          cwd: root,
          setupStatus: "completed",
          actions: [{ id: "dev", name: "Dev", command: "printf dev-started" }],
        },
      });
      await expect(detachedExit.promise).resolves.toMatchObject({ exitCode: 0 });

      await expect(new ShellAutomationGateRunner().runGate({
        cwd: root,
        command: "printf gate",
      })).resolves.toMatchObject({ status: "proceed", output: "gate" });

      expect(snapshotPool(service)).toEqual(before);
    } finally {
      runtime.mockRestore();
      await service.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, isWindows ? 30_000 : 15_000);

  it("does not reserve machine capacity for a running detached dev server or stop it on checkout activity", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pwragent-checkout-idle-dev-"));
    const service = createMachineService(root, 10);
    const runtime = vi.spyOn(checkoutRuntime, "getResourceCheckoutService").mockReturnValue(service);
    const runId = "long-running-dev";
    let exited = false;
    try {
      const [{ resourceId }] = service.read().resources;
      await startLocalCodexEnvironmentAction({
        actionId: "dev",
        runId,
        env: SHELL_ENV,
        owner: { backend: "codex", threadId: "dev-thread" },
        onDetachedExit: () => { exited = true; },
        runtime: {
          environmentId: "env",
          environmentName: "PwrGit",
          executionTarget: "local",
          cwd: root,
          setupStatus: "completed",
          actions: [{ id: "dev", name: "Dev", command: "while true; do sleep 1; done" }],
        },
      });

      expect(service.read().resources[0]).toMatchObject({
        condition: "available",
        sharing: { mode: "counted", capacity: 10, inUse: 0 },
        allocations: [],
        queue: [],
      });
      const hold = await service.perform({
        kind: "request",
        idempotencyKey: "full-suite",
        resourceId,
        purpose: "Full test suite",
        expectedDurationMs: 60_000,
      }, service.threadActor("codex", "test-thread"));
      expect(hold).toMatchObject({ outcome: "granted" });
      expect(exited).toBe(false);
    } finally {
      stopCodexEnvironmentDetachedCommand(runId, "terminate");
      await waitForCodexEnvironmentDetachedCommandGone({ runId, timeoutMs: 5_000 });
      runtime.mockRestore();
      await service.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, isWindows ? 30_000 : 15_000);

  it("allows env setup and automation gates even when the machine checkout authority is unresolved", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pwragent-checkout-unresolved-"));
    const service = new DesktopResourceCheckoutService({
      viewer: { instanceId: "alternate", instanceLabel: "Alternate root", profile: "default", machineId: "host" },
      bindings: [],
      requestPeer: async () => { throw new Error("No peers"); },
      warn: () => {},
    });
    const runtime = vi.spyOn(checkoutRuntime, "getResourceCheckoutService").mockReturnValue(service);
    try {
      expect(service.read().resources[0].condition).toBe("ownership_unresolved");
      const setup = await applyLocalCodexEnvironmentSelection({
        cwd: root,
        env: SHELL_ENV,
        selection: {
          executionTarget: "local",
          runSetup: true,
          environment: {
            id: "env",
            name: "Env",
            sourcePath: path.join(root, "environment.toml"),
            setupScript: "printf ok",
            actions: [],
          },
        },
      });
      expect(setup?.setupStatus).toBe("completed");
      await expect(new ShellAutomationGateRunner().runGate({
        cwd: root,
        command: "printf ok",
      })).resolves.toMatchObject({ status: "proceed", output: "ok" });
    } finally {
      runtime.mockRestore();
      await service.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, isWindows ? 30_000 : 15_000);

  it("projects the local machine pool as advisory without pausing admission", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 32 }),
      fc.array(fc.integer({ min: 1, max: 8 }), { minLength: 0, maxLength: 6 }),
      (capacity, unitRequests) => {
        const root = mkdtempSync(path.join(os.tmpdir(), "pwragent-checkout-proj-"));
        const service = createMachineService(root, capacity);
        try {
          const [{ resourceId }] = service.read().resources;
          for (const [index, rawUnits] of unitRequests.entries()) {
            const units = Math.min(capacity, rawUnits);
            void service.perform({
              kind: "request",
              idempotencyKey: `proj-${index}`,
              resourceId,
              purpose: `Job ${index}`,
              expectedDurationMs: 60_000,
              units,
            }, service.threadActor("codex", `thread-${index}`));
          }
          const [machine] = service.read().resources;
          expect(machine.enforcement.coverage).toBe("advisory");
          expect(machine.admission).toBeUndefined();
          expect(machine.routes.every((route) => route.enforcement === "advisory")).toBe(true);
        } finally {
          void service.close();
          rmSync(root, { recursive: true, force: true });
        }
      },
    ), { numRuns: 20 });
  });
});
