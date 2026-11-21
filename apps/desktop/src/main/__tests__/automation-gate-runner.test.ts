import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { openResourceCheckoutStore } from "@pwragent/sqlite-storage/resource-checkout-store";
import { DesktopResourceCheckoutService } from "../resource-checkouts/resource-checkout-service";
import * as checkoutRuntime from "../resource-checkouts/checkout-runtime";
import { describe, expect, it, vi } from "vitest";
import { ShellAutomationGateRunner } from "../automations/automation-gate-runner";

describe("ShellAutomationGateRunner", () => {
  it("refuses a local gate while an operator holds machine capacity", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pwragent-gate-admission-"));
    const service = new DesktopResourceCheckoutService({
      viewer: { instanceId: "local", instanceLabel: "Local", profile: "test", machineId: "host" },
      machineStore: openResourceCheckoutStore(path.join(root, "checkout.db"), "host"),
      bindings: [], requestPeer: async () => { throw new Error("No peers"); }, warn: () => {},
    });
    const runtime = vi.spyOn(checkoutRuntime, "getResourceCheckoutService").mockReturnValue(service);
    try {
      const [{ resourceId }] = service.read().resources;
      await expect(service.perform({
        kind: "request", resourceId, idempotencyKey: "quiet", purpose: "Quiet time", expectedDurationMs: 60_000,
      })).resolves.toMatchObject({ outcome: "granted" });
      await expect(new ShellAutomationGateRunner().runGate({ command: "printf forbidden" })).resolves.toMatchObject({
        status: "failed", output: "", errorMessage: expect.stringContaining("capacity is reserved"),
      });
    } finally {
      runtime.mockRestore();
      await service.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("maps exit 0 to proceed with capped output", async () => {
    const result = await new ShellAutomationGateRunner().runGate({
      command: "printf 'ready'",
      outputLimitChars: 10,
    });

    expect(result).toMatchObject({
      status: "proceed",
      exitCode: 0,
      output: "ready",
    });
  });

  it("maps exit 10 to skip", async () => {
    const result = await new ShellAutomationGateRunner().runGate({
      command: "printf 'skip'; exit 10",
    });

    expect(result).toMatchObject({
      status: "skip",
      exitCode: 10,
      output: "skip",
    });
  });

  it("maps other exits to failed", async () => {
    const result = await new ShellAutomationGateRunner().runGate({
      command: "printf 'bad'; exit 3",
    });

    expect(result).toMatchObject({
      status: "failed",
      exitCode: 3,
      output: "bad",
      errorMessage: "Automation gate exited with 3.",
    });
  });

  it.skipIf(process.platform === "win32")(
    "does not pass PwrAgent's renderer URL to automation gates",
    async () => {
      const originalRendererUrl = process.env.ELECTRON_RENDERER_URL;
      process.env.ELECTRON_RENDERER_URL = "http://localhost:5175";
      try {
        const result = await new ShellAutomationGateRunner().runGate({
          command: 'printf "%s" "${ELECTRON_RENDERER_URL-unset}"',
        });

        expect(result).toMatchObject({ status: "proceed", output: "unset" });
      } finally {
        if (originalRendererUrl === undefined) {
          delete process.env.ELECTRON_RENDERER_URL;
        } else {
          process.env.ELECTRON_RENDERER_URL = originalRendererUrl;
        }
      }
    },
  );

  it("kills a runaway command on timeout and never hangs the caller", async () => {
    const startedAt = Date.now();
    // Leave enough time on Windows for the native Job wrapper to compile and
    // prove that it kills a running Git Bash descendant, rather than timing
    // out before the shell starts.
    const timeoutMs = process.platform === "win32" ? 3_000 : 200;
    const result = await new ShellAutomationGateRunner().runGate({
      command: "sleep 5",
      timeoutMs,
    });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("timed out");
    // Must settle shortly after the timeout (tree-kill → close, or the
    // force-settle net), well before `sleep 5` would have finished on its own.
    // A regression that leaves the child's tree alive would blow past this.
    expect(Date.now() - startedAt).toBeLessThan(
      process.platform === "win32" ? 4_500 : 4_000,
    );
  }, 10_000);
});
