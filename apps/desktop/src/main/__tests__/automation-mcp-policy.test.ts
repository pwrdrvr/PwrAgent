import { describe, expect, it } from "vitest";
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
