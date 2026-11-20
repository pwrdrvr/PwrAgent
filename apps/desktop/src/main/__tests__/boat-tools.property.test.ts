import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BOAT_SANDBOX_TYPES,
  boatSandboxTypeRank,
  normalizeBoatSandboxPolicy,
  type BoatSandboxPolicy,
  type BoatSandboxType,
} from "@pwragent/shared/contracts/mcp-connections";
import { BoatApiError, type BoatApiRequest } from "../mcp-connections/boat-api";
import { BOAT_TOOLS, BoatTools, type BoatToolRole } from "../mcp-connections/boat-tools";

/**
 * The rules PwrAgent's Boat tools hold for any arguments an agent sends,
 * stated over every request that would reach Boat. The model is a fake Boat
 * API that records each request and leaks what a careless server might: its
 * caller's key in error text, and the account's identity on every sandbox.
 */

const KEY = "boat_live_0123456789abcdefSECRET";
const ACCOUNT_EMAIL = "operator@example.test";
/** Shaped like a key to a pattern, and not one. */
const ORDINARY_TEXT = "box_shadow_blur_radius boat_registration_number";

type Sent = BoatApiRequest;

function fakeBoat() {
  const sent: Sent[] = [];
  const sandboxes = new Set<string>();
  let next = 0;
  const describe = (id: string) => ({
    id, name: `box-${id}`, state: "ready", type: "small", ttlSeconds: 3600,
    createdBy: ACCOUNT_EMAIL, createdById: "user_1", team: { id: "team_1", name: ACCOUNT_EMAIL },
    ip: "203.0.113.7", sshEndpoint: `ssh://${KEY}@host`, cost: { since: "t", seconds: 1, dollars: 0.01 },
  });
  const api = {
    // What `BoatApi.redact` does for the key it sent.
    redact: (text: string): string => text.replaceAll(KEY, "[Boat key removed]"),
    request: async (request: Sent): Promise<Record<string, unknown>> => {
      sent.push(request);
      const [root, id, action] = request.path;
      if (root === "limits") return { ok: true, canStart: true, activeSandboxes: sandboxes.size, maxActiveSandboxes: 100, email: ACCOUNT_EMAIL };
      if (root !== "sandboxes") throw new BoatApiError(`unexpected path with ${KEY}`, "failed", 500);
      if (!id) {
        const created = `bx_${next++}`;
        sandboxes.add(created);
        return { ok: true, sandbox: describe(created) };
      }
      if (!sandboxes.has(id)) throw new BoatApiError(`sandbox not found for key ${KEY}`, "not_found", 404);
      if (action === "fork") {
        const forked = `bx_${next++}`;
        sandboxes.add(forked);
        return { ok: true, id: forked, status: "provisioning", sandbox: describe(forked) };
      }
      if (action === "host") {
        return { ok: true, port: 3000, url: `https://${id}-3000.on.boat.dev/?_token=t`, access: "private", isProtected: true };
      }
      if (action === "commands") return { ok: true, success: true, exitCode: 0, stdout: `leak ${KEY}`, stderr: "", timedOut: false };
      if (action === "files") return { ok: true, path: "/x", encoding: "utf8", size: 1, content: `token=${KEY} ${ORDINARY_TEXT}`, files: [], truncated: false };
      if (request.method === "DELETE") sandboxes.delete(id);
      return { ok: true, status: "ok", sandbox: describe(id) };
    },
  };
  return { api, sent, sandboxes };
}

function session(boat: ReturnType<typeof fakeBoat>, policy: BoatSandboxPolicy, role: BoatToolRole = "thread") {
  const owned = new Set<string>();
  const everOwned = new Set<string>();
  let keys = 0;
  const tools = new BoatTools({
    api: boat.api,
    policy: () => policy,
    role,
    ownedSandboxIds: () => owned,
    recordOwned: ({ sandboxId }) => { owned.add(sandboxId); everOwned.add(sandboxId); },
    forgetOwned: (sandboxId) => { owned.delete(sandboxId); },
    idempotencyKey: () => `key-${keys++}`,
  });
  return { tools, owned, everOwned };
}

const policyArbitrary = fc.record({
  keepCredentialsOut: fc.boolean(),
  defaultType: fc.constantFrom(...BOAT_SANDBOX_TYPES),
  defaultTtlMinutes: fc.integer({ min: 1, max: 2_000 }),
  maxType: fc.constantFrom(...BOAT_SANDBOX_TYPES),
  maxTtlMinutes: fc.integer({ min: 1, max: 2_000 }),
}).map(normalizeBoatSandboxPolicy);

const toolName = fc.oneof(
  fc.constantFrom(...BOAT_TOOLS.map((tool) => tool.name)),
  fc.constantFrom("make_public", "ssh", "__proto__", ""),
);

/** Arguments a hostile or confused agent might send, known fields included. */
const hostileArgs = fc.record({
  // Mostly ids that exist, this thread's or the other's, so calls get far
  // enough to send something.
  sandboxId: fc.oneof(
    { weight: 6, arbitrary: fc.integer({ min: 0, max: 5 }).map((n) => `bx_${n}`) },
    fc.constantFrom("../limits", "bx_0/host", "", "current", "self"),
    fc.string(),
  ),
  type: fc.oneof(fc.constantFrom(...BOAT_SANDBOX_TYPES), fc.constantFrom("huge", 4)),
  ttlMinutes: fc.oneof(fc.integer({ min: -5, max: 100_000 }), fc.constantFrom(0.5, "60", null)),
  public: fc.boolean(),
  access: fc.constant("public"),
  hostedPorts: fc.constant([{ port: 3000, public: true }]),
  noEnv: fc.constant(false),
  environment: fc.constant("base"),
  visibility: fc.constant("shared"),
  count: fc.constant(50),
  port: fc.oneof(fc.constant(3000), fc.integer({ min: -1, max: 70_000 }), fc.constant("3000")),
  command: fc.oneof(fc.constant("echo hi"), fc.string()),
  path: fc.oneof(fc.constant("/home/user/a.txt"), fc.string()),
  content: fc.string(),
  processId: fc.oneof(fc.integer({ min: 0, max: 5 }), fc.constant("1")),
  detached: fc.boolean(),
  localhost: fc.boolean(),
  env: fc.oneof(fc.dictionary(fc.string(), fc.string(), { maxKeys: 4 }), fc.constant({ A: "1" })),
  name: fc.string({ maxLength: 20 }),
}, { requiredKeys: [] });

const step = fc.record({ thread: fc.integer({ min: 0, max: 1 }), tool: toolName, args: hostileArgs });

function sandboxIdOf(request: Sent): string | undefined {
  return request.path[0] === "sandboxes" ? request.path[1] : undefined;
}

function startsMachine(request: Sent): boolean {
  if (request.method !== "POST" || request.path[0] !== "sandboxes") return false;
  return request.path.length === 1 || request.path[2] === "resume" || request.path[2] === "fork";
}

describe("PwrAgent's Boat tools", () => {
  it("never make a port public, never pass account credentials, stay within the caps, and reach only the thread's own sandboxes", async () => {
    await fc.assert(fc.asyncProperty(
      policyArbitrary, fc.array(step, { maxLength: 40 }),
      async (policy, steps) => {
        const boat = fakeBoat();
        const threads = [session(boat, policy), session(boat, policy)];
        // Each thread starts with a sandbox, so its calls have a target.
        for (const { tools } of threads) await tools.call("create_sandbox", {});
        for (const { thread, tool, args } of steps) {
          const before = boat.sent.length;
          const { tools, everOwned } = threads[thread]!;
          const ownedBefore = new Set(everOwned);
          const result = await tools.call(tool, args);
          const text = JSON.stringify(result);
          // Nothing an agent reads carries the key or who the account is.
          expect(text).not.toContain(KEY);
          expect(text).not.toContain(ACCOUNT_EMAIL);
          // What a file holds is returned as it is.
          if (tool === "read_file" && !result.isError) expect(text).toContain(ORDINARY_TEXT);
          for (const request of boat.sent.slice(before)) {
            const body = request.body ?? {};
            // A port is never public, by any route.
            expect(body.public === true).toBe(false);
            expect(body).not.toHaveProperty("hostedPorts");
            expect(body).not.toHaveProperty("visibility");
            if (request.path[2] === "host") expect(body.public).toBe(false);
            // The account's environment is never named or inherited.
            expect(body).not.toHaveProperty("environment");
            expect(body).not.toHaveProperty("count");
            if (startsMachine(request)) {
              expect(body.noEnv).toBe(policy.keepCredentialsOut ? true : undefined);
            }
            // Size and auto-stop stay within the operator's caps.
            if (body.type !== undefined) {
              expect(boatSandboxTypeRank(body.type as BoatSandboxType))
                .toBeLessThanOrEqual(boatSandboxTypeRank(policy.maxType));
            }
            if (body.ttlSeconds !== undefined) {
              expect(body.ttlSeconds as number).toBeLessThanOrEqual(policy.maxTtlMinutes * 60);
              expect(body.ttlSeconds as number).toBeGreaterThanOrEqual(60);
            }
            // Only a sandbox this thread created or forked is ever addressed.
            const sandboxId = sandboxIdOf(request);
            if (sandboxId !== undefined) expect(ownedBefore.has(sandboxId)).toBe(true);
            // A delete confirms exactly the sandbox it deletes.
            if (request.method === "DELETE" && request.path.length === 2) {
              expect(request.headers?.["x-ascii-confirm-delete"]).toBe(sandboxId);
            }
          }
        }
      },
    ), { numRuns: 300 });
  });

  it("let PwrAgent's cleanup only stop or delete a thread's sandboxes, and a session with no thread call nothing", async () => {
    await fc.assert(fc.asyncProperty(
      policyArbitrary, fc.constantFrom<BoatToolRole>("cleanup", "none"), fc.array(step, { maxLength: 25 }),
      async (policy, role, steps) => {
        const boat = fakeBoat();
        const creator = session(boat, policy);
        await creator.tools.call("create_sandbox", {});
        await creator.tools.call("create_sandbox", {});
        const restricted = session(boat, policy, role);
        // The cleanup session serves the first sandbox's thread only.
        restricted.owned.add("bx_0");
        const before = boat.sent.length;
        for (const { tool, args } of steps) await restricted.tools.call(tool, args);
        const sent = boat.sent.slice(before);
        if (role === "none") {
          expect(sent).toEqual([]);
          return;
        }
        for (const request of sent) {
          expect(sandboxIdOf(request)).toBe("bx_0");
          const stop = request.method === "POST" && request.path[2] === "stop";
          const remove = request.method === "DELETE" && request.path.length === 2;
          expect(stop || remove).toBe(true);
        }
      },
    ), { numRuns: 150 });
  });

  it("refuses a size or auto-stop above the cap instead of quietly lowering it", async () => {
    const boat = fakeBoat();
    const { tools } = session(boat, normalizeBoatSandboxPolicy({ maxType: "default", maxTtlMinutes: 30 }));
    const tooBig = await tools.call("create_sandbox", { type: "xlarge" });
    const tooLong = await tools.call("create_sandbox", { ttlMinutes: 31 });
    expect(tooBig.isError).toBe(true);
    expect(tooLong.isError).toBe(true);
    expect(boat.sent).toEqual([]);
    const allowed = await tools.call("create_sandbox", { type: "default", ttlMinutes: 30 });
    expect(allowed.isError).toBeUndefined();
    expect(boat.sent[0]?.body).toMatchObject({ type: "default", ttlSeconds: 1800, noEnv: true });
  });

  it("sends public: false for every hosted port, whatever else the call carries", async () => {
    await fc.assert(fc.asyncProperty(
      policyArbitrary, hostileArgs, fc.constantFrom(true, "true", 1, { public: true }),
      async (policy, extra, wanted) => {
        const boat = fakeBoat();
        const { tools } = session(boat, policy);
        await tools.call("create_sandbox", {});
        const result = await tools.call("host_port", {
          ...extra, sandboxId: "bx_0", port: 3000, public: wanted, access: "public",
        });
        const host = boat.sent.filter((request) => request.path[2] === "host");
        expect(host).toHaveLength(1);
        expect(host[0]!.body?.public).toBe(false);
        expect(result.structuredContent).toMatchObject({ access: "private" });
      },
    ), { numRuns: 150 });
  });

  it("withholds a URL that Boat reports as public", async () => {
    const boat = fakeBoat();
    const { tools } = session(boat, normalizeBoatSandboxPolicy(undefined));
    await tools.call("create_sandbox", {});
    const request = boat.api.request;
    boat.api.request = async (sent) => sent.path[2] === "host"
      ? { ok: true, url: "https://bx-0-3000.on.boat.dev", access: "public", isProtected: false }
      : await request(sent);
    const result = await tools.call("host_port", { sandboxId: "bx_0", port: 3000 });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("on.boat.dev");
  });
});
