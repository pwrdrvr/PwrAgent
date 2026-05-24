import { describe, expect, it } from "vitest";

import {
  AUTOMATION_INSPECTION_MCP_COMMAND_ENV,
  buildAutomationInspectionAcpMcpServers,
  resolveAutomationInspectionMcpCommand,
  runAutomationInspectionCli,
} from "../automations/automation-inspection-cli";

describe("automation inspection CLI adapter", () => {
  it("resolves the ACP MCP command from the runtime environment", () => {
    expect(
      resolveAutomationInspectionMcpCommand({
        [AUTOMATION_INSPECTION_MCP_COMMAND_ENV]: "  /usr/local/bin/pwragent-mcp  ",
      } as NodeJS.ProcessEnv),
    ).toBe("/usr/local/bin/pwragent-mcp");
    expect(resolveAutomationInspectionMcpCommand({} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("builds ACP MCP server config only when MCP and session context are available", () => {
    expect(
      buildAutomationInspectionAcpMcpServers({
        backend: "acp:gemini",
        command: "pwragent-automation-tools",
        runtimeCapabilities: {
          schemaVersion: 1,
          status: "discovered",
          agentCapabilities: {
            mcp: {
              http: true,
            },
          },
        },
        threadId: "agent-thread",
      }),
    ).toEqual([
      {
        name: "pwragent_automations",
        command: "pwragent-automation-tools",
        args: [
          "automation-inspection-mcp",
          "--backend",
          "acp:gemini",
          "--thread-id",
          "agent-thread",
        ],
        env: {
          PWRAGENT_AUTOMATION_BACKEND: "acp:gemini",
          PWRAGENT_AUTOMATION_THREAD_ID: "agent-thread",
        },
      },
    ]);

    expect(
      buildAutomationInspectionAcpMcpServers({
        backend: "acp:gemini",
        command: "pwragent-automation-tools",
        runtimeCapabilities: {
          schemaVersion: 1,
          status: "discovered",
        },
        threadId: "agent-thread",
      }),
    ).toEqual([]);
  });

  it("runs read-only automation inspection operations from CLI argv", async () => {
    const result = await runAutomationInspectionCli({
      argv: [
        "list_automations",
        "--backend",
        "codex",
        "--thread-id",
        "agent-thread",
        "--args",
        "{\"limit\":1}",
      ],
      handler: (request) => {
        expect(request).toEqual({
          operation: "list_automations",
          context: {
            backend: "codex",
            threadId: "agent-thread",
          },
          args: { limit: 1 },
        });
        return {
          ok: true,
          operation: "list_automations",
          data: {
            automations: [],
          },
        };
      },
    });

    expect(result).toEqual({
      exitCode: 0,
      stdout: `${JSON.stringify({ automations: [] }, null, 2)}\n`,
      stderr: "",
    });
  });

  it("fails closed when required scope is missing", async () => {
    await expect(
      runAutomationInspectionCli({
        argv: ["list_automations", "--backend", "codex"],
        handler: undefined,
      }),
    ).resolves.toEqual({
      exitCode: 2,
      stdout: "",
      stderr: "Required options: --backend and --thread-id.\n",
    });
  });
});
