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
});
