import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MCP_CONNECTION_TOOL_APPROVALS,
  resolveMcpConnectionToolApproval,
  upsertMcpConnectionProjectToolApproval,
  type McpConnectionProjectToolApproval,
  type McpConnectionToolApproval,
} from "../mcp-connections";

const mode = fc.constantFrom(...MCP_CONNECTION_TOOL_APPROVALS);
// A few repositories, each spelled several ways, so writes collide often.
const repository = fc.tuple(
  fc.constantFrom("pwrapps", "pwragent", "docs"),
  fc.constantFrom(
    (repo: string) => `github.com/pwrdrvr/${repo}`,
    (repo: string) => `GitHub.com/PwrDrvr/${repo.toUpperCase()}`,
    (repo: string) => `https://github.com/pwrdrvr/${repo}.git`,
  ),
).map(([repo, spell]) => spell(repo));
const write = fc.record({ repository, toolApproval: fc.option(mode, { nil: null }) });

/** The model: one mode per repository, compared without case. */
function applyModel(model: Map<string, McpConnectionToolApproval>, step: { repository: string; toolApproval: McpConnectionToolApproval | null }) {
  const key = step.repository.replace(/^https:\/\//, "").replace(/\.git$/, "").toLowerCase();
  if (step.toolApproval === null) model.delete(key);
  else model.set(key, step.toolApproval);
}

describe("MCP project tool approval", () => {
  it("keeps one entry per project and resolves a thread by its project, else the connection", () => {
    fc.assert(fc.property(fc.array(write, { maxLength: 24 }), mode, repository, (steps, connectionMode, threadRepository) => {
      let entries: McpConnectionProjectToolApproval[] | undefined = [];
      const model = new Map<string, McpConnectionToolApproval>();
      for (const step of steps) {
        entries = upsertMcpConnectionProjectToolApproval(entries, step.repository, step.toolApproval);
        applyModel(model, step);
      }
      expect(entries).toBeDefined();
      expect(new Set(entries!.map((entry) => entry.repository.toLowerCase())).size).toBe(entries!.length);
      expect(new Map(entries!.map((entry) => [entry.repository.toLowerCase(), entry.toolApproval]))).toEqual(model);
      const threadKey = threadRepository.replace(/^https:\/\//, "").replace(/\.git$/, "").toLowerCase();
      expect(resolveMcpConnectionToolApproval({ toolApproval: connectionMode, projectToolApprovals: entries }, threadRepository).toolApproval)
        .toBe(model.get(threadKey) ?? connectionMode);
      // A thread with no project always uses the connection's mode.
      expect(resolveMcpConnectionToolApproval({ toolApproval: connectionMode, projectToolApprovals: entries }).toolApproval)
        .toBe(connectionMode);
    }));
  });

  it("refuses a value that names no repository", () => {
    expect(upsertMcpConnectionProjectToolApproval([], "pwrapps", "approve")).toBeUndefined();
  });
});
