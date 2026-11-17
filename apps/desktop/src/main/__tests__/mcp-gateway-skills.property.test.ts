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
  // Shrunk from seed -1730384507 (path 116:1:0:10:2:2:2:2:3:3:5:6:6:21:21:53:52:51:56:37).
  // No server publishes skills. Each tool was admitted against the budget,
  // but a later tool that did not fit added its notice to `unavailable`
  // unmeasured, and that notice took the result to 24,001 bytes.
  it("keeps a turned-away tool's notice inside the result budget", async () => {
    const tool = (name: string, length: number) => ({ name, description: "x".repeat(length) });
    const all: Server[] = [
      { id: "one", routed: false, tools: [tool("lookup", 4_265)] },
      { id: "two", routed: true, tools: [tool("notes", 0), tool("lookup", 8_132)] },
      { id: "three", routed: true, tools: [tool("lookup", 3_996), tool("issue", 5_766)] },
    ];
    for (const withSkills of [true, false]) {
      const found = await search(all, "notes lookup issue", 5, withSkills);
      expect(found.unavailable.length).toBeGreaterThan(0);
      expect(Buffer.byteLength(JSON.stringify(found))).toBeLessThanOrEqual(24_000);
    }
  });

  // Random schemas rarely land within a notice's length of the budget, so
  // the general property found the overflow only once. Here a filler tool
  // is sized around the last byte a result can hold while a later tool is
  // always turned away; the probe measures the room, not the notice.
  it("never passes its budget when a later tool is turned away", async () => {
    const filler = (length: number): Server => ({ id: "a", routed: true, tools: [{ name: "lookup", description: "x".repeat(length) }] });
    const oversized: Server = { id: "b", routed: true, tools: [{ name: "lookup_more", description: "x".repeat(30_000) }] };
    const room = 24_000 - Buffer.byteLength(JSON.stringify(await search([filler(0), oversized], "lookup", 5, true)));
    // Offset 0 fills the result to its last byte; 1 is the first byte over.
    const offset = fc.oneof(fc.constantFrom(-1, 0, 1), fc.integer({ min: -400, max: 400 }));
    await fc.assert(fc.asyncProperty(offset, fc.boolean(), async (offset, withSkills) => {
      const found = await search([filler(Math.max(0, room + offset)), oversized], "lookup", 5, withSkills);
      expect(found.unavailable.map((entry) => entry.connectionId)).toContain("b");
      expect(Buffer.byteLength(JSON.stringify(found))).toBeLessThanOrEqual(24_000);
      // A schema is admitted whole or not at all.
      for (const tool of found.tools) {
        const source = [filler(Math.max(0, room + offset)), oversized].find((entry) => entry.id === tool.connectionId)!;
        expect(tool.definition.description).toBe(source.tools.find((candidate) => candidate.name === tool.toolName)!.description);
      }
    }));
  });

  // Built by hand: shrinking 62 long errors outlasts the test timeout. On
  // the previous code this search came to 28,276 bytes. Later connections
  // fail first, so the entries are fitted in selection order, not in the
  // order the fan-out finished in.
  it("names every failed connection within the budget when their errors alone would pass it", async () => {
    const failed = Array.from({ length: 24 }, (_, index) => `f${String(index).padStart(63, "0")}`);
    const found = await new McpGatewayToolService({
      connections: {
        requestGatewayToolOperation: async (params) => {
          for (let tick = failed.indexOf(params.connectionId); tick < failed.length; tick += 1) await Promise.resolve();
          throw new Error("\u0001".repeat(400));
        },
      },
      approve: async () => false,
      selectedConnections: async () => failed,
    }).search({ query: "lookup" }, context);
    expect(Buffer.byteLength(JSON.stringify(found))).toBeLessThanOrEqual(24_000);
    expect(found.unavailable.map((entry) => entry.connectionId)).toEqual(failed);
    // The first entries keep their own errors; the rest give the short form.
    expect(found.unavailable[0]!.message).toBe("\u0001".repeat(180));
    expect(found.unavailable.at(-1)!.message).toBe("Unavailable. Search this connectionId alone for the error.");
  });

  // Five turned-away tools with long names would otherwise spend their own
  // notices' worth of the budget on names alone.
  it("names at most 128 characters of a turned-away tool", async () => {
    // Emoji are two UTF-16 units each; a cut by units would split one.
    for (const name of [`lookup_${"n".repeat(1_000)}`, `lookup_${"😀".repeat(1_000)}`]) {
      const found = await search([{ id: "a", routed: true, tools: [{ name, description: "x".repeat(30_000) }] }], "lookup", 1, true);
      expect(found.unavailable).toEqual([{
        connectionId: "a",
        message: `The exact schema for ${Array.from(name).slice(0, 127).join("")}… exceeds this result's size budget. Search part of its name with this connectionId alone, or use native MCP invocation.`,
      }]);
      expect(found.unavailable[0]!.message.isWellFormed()).toBe(true);
    }
  });

  // The budget's own worst case: the most failures with the longest escaped
  // errors, beside the most turned-away tools with long escaped names. The
  // limit asked for is past the contract's five, which the search keeps to.
  it("fits the most failures beside five turned-away tools with long names", async () => {
    const failed = Array.from({ length: 62 }, (_, index) => `f${String(index).padStart(63, "0")}`);
    const names = Array.from({ length: 20 }, (_, index) => `lookup${String(index).padStart(2, "0")}${"\u0001".repeat(2_000)}`);
    const found = await new McpGatewayToolService({
      connections: {
        requestGatewayToolOperation: async (params) => {
          if (params.connectionId !== "a") throw new Error("\u0001".repeat(400));
          return catalog({ id: "a", routed: true, tools: names.map((name) => ({ name, description: "x".repeat(30_000) })) }, false);
        },
      },
      approve: async () => false,
      selectedConnections: async () => ["a", ...failed],
    }).search({ query: "lookup", limit: 20 }, context);
    expect(Buffer.byteLength(JSON.stringify(found))).toBeLessThanOrEqual(24_000);
    expect(found.tools).toEqual([]);
    expect(found.unavailable.filter((entry) => entry.connectionId === "a")).toHaveLength(5);
    expect(found.unavailable.filter((entry) => entry.connectionId !== "a").map((entry) => entry.connectionId)).toEqual(failed);
  });

  // A search names each selected connection that fails, with its error.
  // Sixty-two failures with 180 characters of escaped or multibyte text came
  // to several times the budget before any tool was measured. The filler is
  // sized around the last byte again, since the errors move that byte.
  it("never passes its budget however many selected connections fail", async () => {
    const connectionId = fc.stringMatching(/^[c-z][a-z0-9_-]{0,63}$/u);
    // Characters JSON escapes to six bytes, or UTF-8 spends four on.
    const error = fc.string({ unit: fc.constantFrom("x", "é", "漢", "😀", "\u0001", "\"", "\\"), maxLength: 400, size: "max" });
    const failures = fc.uniqueArray(fc.record({ id: connectionId, error }), { maxLength: 62, size: "max", selector: (failure) => failure.id });
    const offset = fc.oneof(fc.constantFrom(-1, 0, 1), fc.integer({ min: -400, max: 400 }));
    const search = async (failed: Array<{ id: string; error: string }>, fillerLength: number, withSkills: boolean) => {
      const filler: Server = { id: "a", routed: true, tools: [{ name: "lookup", description: "x".repeat(fillerLength) }] };
      const oversized: Server = { id: "b", routed: true, tools: [{ name: "lookup_more", description: "x".repeat(30_000) }] };
      const errors = new Map(failed.map((failure) => [failure.id, failure.error]));
      return await new McpGatewayToolService({
        connections: {
          requestGatewayToolOperation: async (params) => {
            const message = errors.get(params.connectionId);
            if (message !== undefined) throw new Error(message);
            return catalog(params.connectionId === "a" ? filler : oversized, withSkills && params.skills === true);
          },
        },
        approve: async () => false,
        selectedConnections: async () => ["a", "b", ...failed.map((failure) => failure.id)],
        serverNameInAgent: (id) => `pwragent_${id}`,
      }).search({ query: "lookup", limit: 5 }, context);
    };
    await fc.assert(fc.asyncProperty(failures, offset, fc.boolean(), async (failed, offset, withSkills) => {
      const room = 24_000 - Buffer.byteLength(JSON.stringify(await search(failed, 0, withSkills)));
      const fillerLength = Math.max(0, room + offset);
      const found = await search(failed, fillerLength, withSkills);
      expect(Buffer.byteLength(JSON.stringify(found))).toBeLessThanOrEqual(24_000);
      // Each failed connection is named once, with its own error or the
      // short form, and the turned-away tool keeps its notice.
      for (const failure of failed) {
        const entries = found.unavailable.filter((entry) => entry.connectionId === failure.id);
        expect(entries).toHaveLength(1);
        expect([failure.error.slice(0, 180), "Unavailable. Search this connectionId alone for the error."]).toContain(entries[0]!.message);
      }
      expect(found.unavailable.map((entry) => entry.connectionId)).toContain("b");
      // A schema is admitted whole or not at all.
      for (const tool of found.tools) expect(tool.definition.description).toBe("x".repeat(fillerLength));
    }), { numRuns: 60 });
  });

  it("adds skills without costing the result a tool, and within its budget", async () => {
    await fc.assert(fc.asyncProperty(servers, fc.array(word, { minLength: 1, maxLength: 3 }), fc.integer({ min: 1, max: 5 }), async (all, terms, limit) => {
      const query = terms.join(" ");
      const found = await search(all, query, limit, true);
      const plain = await search(all, query, limit, false);
      expect(found.tools).toEqual(plain.tools);
      expect(found.unavailable).toEqual(plain.unavailable);
      expect(Buffer.byteLength(JSON.stringify(found))).toBeLessThanOrEqual(24_000);
      expect(Buffer.byteLength(JSON.stringify(plain))).toBeLessThanOrEqual(24_000);
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
