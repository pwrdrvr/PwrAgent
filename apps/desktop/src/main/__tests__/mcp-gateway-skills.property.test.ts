import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AgentToolCallContext } from "../agent-tools/agent-tool-definition";
import { gatewayToolRevision, type McpGatewayCatalog, type McpGatewayTool } from "../mcp-connections/mcp-gateway-catalog";
import { McpGatewayToolService } from "../mcp-connections/mcp-gateway-tool-service";
import type { McpSkillSummary } from "../mcp-connections/mcp-skills-relay";

/*
 * The rules `search_mcp_tools` keeps when a server publishes skills:
 * - skills never cost the result a tool, an exact schema, or a route;
 * - the result stays within its byte budget;
 * - a server entry names only its own server's skills, once each, and only
 *   beside the resource route that can read them;
 * - `skillsComplete` is false exactly when the entry leaves a skill out;
 * - a server with no tools is found by its skills alone.
 * The search without skills talks to an owner that predates them and
 * answers with a bare tool list.
 */

const context: AgentToolCallContext = { backend: "codex", threadId: "thread", turnId: "turn", callId: "call", transport: "codex_dynamic_tool" };
const words = ["issue", "release", "triage", "lookup", "deploy", "notes"] as const;
const word = fc.constantFrom(...words);

type Server = {
  id: string;
  routed: boolean;
  tools: Array<{ name: string; description: string }>;
  published?: { skills: McpSkillSummary[]; complete: boolean };
};

const skill = (id: string) => fc.record({
  name: fc.array(word, { minLength: 1, maxLength: 2 }).map((parts) => parts.join("-")),
  description: fc.option(fc.array(word, { maxLength: 60 }).map((parts) => parts.join(" ")), { nil: undefined }),
  slug: fc.stringMatching(/^[a-z0-9]{1,24}$/u),
}).map(({ name, description, slug }): McpSkillSummary => ({
  name, ...(description ? { description } : {}), uri: `skill://${id}/${slug}/SKILL.md`,
}));

const server = (id: string) => fc.record({
  routed: fc.boolean(),
  tools: fc.uniqueArray(fc.record({
    name: word,
    // Long schemas put the 24 KB result budget under pressure.
    description: fc.integer({ min: 0, max: 9_000 }).map((length) => "x".repeat(length)),
  }), { minLength: 0, maxLength: 4, selector: (tool) => tool.name }),
  published: fc.option(fc.record({
    skills: fc.uniqueArray(skill(id), { minLength: 1, maxLength: 120, selector: (entry) => entry.uri }),
    complete: fc.boolean(),
  }), { nil: undefined }),
}).map((value): Server => ({ id, ...value }));

const servers = fc.tuple(server("one"), server("two"), server("three"));

function catalog(entry: Server, withSkills: boolean): McpGatewayTool[] | McpGatewayCatalog {
  const tools = entry.tools.map((tool): McpGatewayTool => {
    const definition = { name: tool.name, description: tool.description, inputSchema: { type: "object" as const } };
    return {
      connectionId: entry.id, serverName: `Server ${entry.id}`, toolName: tool.name,
      schemaRevision: gatewayToolRevision(entry.id, 1, definition), definition,
    };
  });
  return withSkills
    ? { tools, serverName: `Server ${entry.id}`, ...(entry.published ? { serverSkills: entry.published } : {}) }
    : tools;
}

async function search(all: Server[], query: string, limit: number, withSkills: boolean) {
  const service = new McpGatewayToolService({
    connections: {
      requestGatewayToolOperation: async (params) => catalog(all.find((entry) => entry.id === params.connectionId)!, withSkills && params.skills === true),
    },
    approve: async () => false,
    selectedConnections: async () => all.map((entry) => entry.id),
    serverNameInAgent: (id) => all.find((entry) => entry.id === id)?.routed ? `pwragent_${id}` : undefined,
  });
  return await service.search({ query, limit }, context);
}

describe("gateway search skills", () => {
  it("adds skills without costing the result a tool, and within its budget", async () => {
    await fc.assert(fc.asyncProperty(servers, fc.array(word, { minLength: 1, maxLength: 3 }), fc.integer({ min: 1, max: 5 }), async (all, terms, limit) => {
      const query = terms.join(" ");
      const found = await search(all, query, limit, true);
      const plain = await search(all, query, limit, false);
      expect(found.tools).toEqual(plain.tools);
      expect(found.unavailable).toEqual(plain.unavailable);
      expect(Buffer.byteLength(JSON.stringify(found))).toBeLessThanOrEqual(24_000);
      // Every server the plain search names is still named, unchanged but for skills.
      for (const entry of plain.servers ?? []) {
        const { skills: _skills, skillsComplete: _complete, ...rest } = found.servers!.find((other) => other.connectionId === entry.connectionId)!;
        expect(rest).toEqual(entry);
      }
    }), { numRuns: 150 });
  });

  it("names only its own server's skills, beside a route, and says when it left one out", async () => {
    await fc.assert(fc.asyncProperty(servers, fc.array(word, { minLength: 1, maxLength: 3 }), fc.integer({ min: 1, max: 5 }), async (all, terms, limit) => {
      const found = await search(all, terms.join(" "), limit, true);
      for (const entry of found.servers ?? []) {
        if (entry.skills === undefined) {
          expect(entry.skillsComplete).toBeUndefined();
          continue;
        }
        const published = all.find((candidate) => candidate.id === entry.connectionId)!.published!;
        expect(entry.resourceDiscovery?.server).toBe(`pwragent_${entry.connectionId}`);
        expect(entry.skills.length).toBeGreaterThan(0);
        const uris = entry.skills.map((listed) => listed.uri);
        expect(new Set(uris).size).toBe(uris.length);
        for (const listed of entry.skills) expect(published.skills).toContainEqual(listed);
        expect(entry.skillsComplete).toBe(published.complete && entry.skills.length === published.skills.length);
      }
    }), { numRuns: 150 });
  });

  // Oracle: with room to spare, a routed server that offers skills and
  // appears in the result names every one of them.
  it("names every skill of a routed server when the result has room", async () => {
    await fc.assert(fc.asyncProperty(servers, fc.array(word, { minLength: 1, maxLength: 3 }), async (all, terms) => {
      const small = all.map((entry): Server => ({
        ...entry,
        tools: entry.tools.map((tool) => ({ ...tool, description: "" })),
        published: entry.published && { ...entry.published, skills: entry.published.skills.slice(0, 4) },
      }));
      const found = await search(small, terms.join(" "), 5, true);
      for (const entry of found.servers ?? []) {
        const source = small.find((candidate) => candidate.id === entry.connectionId)!;
        if (!source.routed || !source.published) continue;
        expect(new Set(entry.skills?.map((listed) => listed.uri))).toEqual(new Set(source.published.skills.map((listed) => listed.uri)));
      }
      // A routed server whose skill matches the query is named, tool or not.
      for (const source of small) {
        const matches = source.published?.skills.some((listed) => terms.some((term) => `${listed.name} ${listed.description ?? ""}`.includes(term)));
        if (source.routed && matches) {
          expect(found.servers?.some((entry) => entry.connectionId === source.id)).toBe(true);
        }
      }
    }), { numRuns: 150 });
  });
});
