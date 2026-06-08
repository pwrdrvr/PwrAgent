import { describe, expect, it } from "vitest";
import { ShellAutomationGateRunner } from "../automations/automation-gate-runner";

describe("ShellAutomationGateRunner", () => {
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

  it("kills a runaway command on timeout and never hangs the caller", async () => {
    const startedAt = Date.now();
    const result = await new ShellAutomationGateRunner().runGate({
      command: "sleep 5",
      timeoutMs: 200,
    });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("timed out");
    // Must settle shortly after the timeout (tree-kill → close, or the
    // force-settle net), well before `sleep 5` would have finished on its own.
    // A regression that leaves the child's tree alive would blow past this.
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  }, 10_000);
});
