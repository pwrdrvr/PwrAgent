import { describe, expect, it } from "vitest";
import { resolveAutomationEscalationPolicy, resolveAutomationMcpQuestionPolicy, resolveAutomationMcpToolPolicy } from "@pwragent/shared";
import { buildAutomationMcpPolicy } from "../automations/automation-mcp-policy";

describe("automation MCP policy", () => {
  const servers = [
    { name: "datadog", tools: ["get_metrics", "write_monitor"] },
    { name: "other", tools: ["search"] },
  ];

  it("pre-approves the selected server and disables other servers", () => {
    expect(buildAutomationMcpPolicy({ servers, mcpAllowlist: ["datadog"] })).toEqual({
      config: { mcp_servers: {
        datadog: { enabled: true, required: true, default_tools_approval_mode: "approve", tools: {
          get_metrics: { approval_mode: "approve" }, write_monitor: { approval_mode: "approve" },
        } },
        other: { enabled: false },
      } },
      connectionIds: [],
    });
  });

  it("applies tool restrictions to both exposure and approval", () => {
    const result = buildAutomationMcpPolicy({ servers, mcpAllowlist: ["datadog"], toolAllowlist: ["get_metrics"] });
    expect(result.config).toMatchObject({ mcp_servers: { datadog: {
      enabled_tools: ["get_metrics"], tools: { get_metrics: { approval_mode: "approve" } },
    } } });
    expect((result.config as { mcp_servers: Record<string, { tools?: unknown }> }).mcp_servers.datadog.tools).not.toHaveProperty("write_monitor");
  });

  it("inherits and pre-approves the Agent's servers when the list is empty", () => {
    const config = buildAutomationMcpPolicy({ servers, mcpAllowlist: [] }).config;
    expect(config).toMatchObject({
      mcp_servers: { datadog: { default_tools_approval_mode: "approve" }, other: { default_tools_approval_mode: "approve" } },
    });
    expect(config).not.toHaveProperty("mcp_servers.datadog.enabled");
    expect(config).not.toHaveProperty("mcp_servers.datadog.required");
  });

  it("matches a managed bridge by its original server identity", () => {
    const result = buildAutomationMcpPolicy({
      servers: [{ name: "pwragent_datadog_new", aliases: ["datadog", "pwragent_datadog_old"], connectionId: "datadog", config: { command: "fixture", args: [] } }],
      mcpAllowlist: ["pwragent_datadog_old"],
    });
    expect(result.connectionIds).toEqual(["datadog"]);
    expect(result.config).toMatchObject({ mcp_servers: { pwragent_datadog_new: { command: "fixture", enabled: true, default_tools_approval_mode: "approve" } } });
  });

  it("delegates native MCP approvals to the harness when requested", () => {
    expect(buildAutomationMcpPolicy({ servers, mcpAllowlist: ["datadog"], toolApproval: "backend" }).config).toMatchObject({
      mcp_servers: { datadog: { default_tools_approval_mode: "auto", tools: { get_metrics: { approval_mode: "auto" } } } },
    });
  });

  it("requests review for native calls and disables native tools for deny", () => {
    expect(buildAutomationMcpPolicy({ servers, mcpAllowlist: ["datadog"], toolApproval: "auto" }).config).toMatchObject({ mcp_servers: { datadog: { default_tools_approval_mode: "prompt" } } });
    expect(buildAutomationMcpPolicy({ servers, mcpAllowlist: ["datadog"], toolApproval: "deny" }).config).toMatchObject({ mcp_servers: { datadog: { enabled: false } } });
  });

  it("reports an unknown saved server without inventing a transport-less config", () => {
    expect(() => buildAutomationMcpPolicy({ servers, mcpAllowlist: ["missing"] })).toThrow("missing");
  });

  it("refuses ambiguous display names rather than granting multiple connections", () => {
    expect(() => buildAutomationMcpPolicy({
      servers: [{ name: "one", aliases: ["datadog"] }, { name: "two", aliases: ["datadog"] }],
      mcpAllowlist: ["datadog"],
    })).toThrow("multiple connections");
  });

  it("normalizes qualified inventory names and accepts only the matching server's qualified tool", () => {
    const config = buildAutomationMcpPolicy({
      servers: [{ name: "datadog", tools: ["mcp__datadog__get_metrics", "mcp__datadog__write_monitor"] }],
      mcpAllowlist: ["datadog"], toolAllowlist: ["mcp__datadog__get_metrics", "mcp__other__search"],
    }).config;
    expect(config).toMatchObject({ mcp_servers: { datadog: { enabled_tools: ["get_metrics"], tools: { get_metrics: { approval_mode: "approve" } } } } });
    expect(config).not.toHaveProperty("mcp_servers.datadog.tools.write_monitor");
  });
});

describe("automation approval resolution", () => {
  it.each([
    ["default", false, "allow"], ["auto", false, "allow"], ["full-access", false, "allow"],
    ["default", true, "auto"], ["auto", true, "backend"], ["full-access", true, "allow"],
  ] as const)("resolves inherited tool calls in %s with the reviewer %s to %s", (mode, enabled, expected) => {
    expect(resolveAutomationMcpToolPolicy({ tools: "inherit" }, mode, enabled)).toBe(expected);
  });

  it("keeps an explicit tool choice whatever the access or reviewer", () => {
    expect(resolveAutomationMcpToolPolicy({ tools: "deny" }, "full-access", true)).toBe("deny");
    expect(resolveAutomationMcpToolPolicy({ tools: "auto" }, "default", false)).toBe("auto");
  });

  it("reviews questions only with the reviewer on unless an automation chooses", () => {
    expect(resolveAutomationMcpQuestionPolicy(undefined, false)).toBe("reject");
    expect(resolveAutomationMcpQuestionPolicy(undefined, true)).toBe("auto");
    expect(resolveAutomationMcpQuestionPolicy({ questions: "reject" }, true)).toBe("reject");
  });

  it("asks for escalations only when a reviewer can answer them", () => {
    expect(resolveAutomationEscalationPolicy({ escalations: "auto" }, { enabled: false, reviewEscalations: true })).toBe("reject");
    expect(resolveAutomationEscalationPolicy(undefined, { enabled: true, reviewEscalations: false })).toBe("reject");
    expect(resolveAutomationEscalationPolicy(undefined, { enabled: true, reviewEscalations: true })).toBe("auto");
    expect(resolveAutomationEscalationPolicy({ escalations: "auto" }, { enabled: true, reviewEscalations: false })).toBe("auto");
    expect(resolveAutomationEscalationPolicy({ escalations: "reject" }, { enabled: true, reviewEscalations: true })).toBe("reject");
  });
});
