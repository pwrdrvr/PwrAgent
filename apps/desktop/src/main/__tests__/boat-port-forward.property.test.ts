import os from "node:os";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { normalizeBoatSandboxPolicy } from "@pwragent/shared/contracts/mcp-connections";
import { BoatApiError, type BoatApiRequest } from "../mcp-connections/boat-api";
import { BoatPortForwards } from "../mcp-connections/boat-port-forward";
import { BoatTools } from "../mcp-connections/boat-tools";
import { FAKE_HOST_KEY, FAKE_PUBLIC_KEY, fakeTunnelRuntime } from "./helpers/boat-tunnel-fake";

/**
 * The rules a port forward holds, whatever an agent passes and whatever
 * Boat answers: it listens on 127.0.0.1 only, it trusts only the host key
 * Boat returned, it reaches only a sandbox its thread created, and it does
 * not outlive the sandbox's run or the sessions that asked for it.
 */

const KEY = "boat_live_0123456789abcdefSECRET";
const POLICY = normalizeBoatSandboxPolicy({});

type SshAnswer = Record<string, unknown>;

function world(sshAnswer: () => SshAnswer = () => ({ machineIp: "203.0.113.10", sshUser: "user", hostKey: FAKE_HOST_KEY })) {
  const machine = fakeTunnelRuntime();
  const manager = new BoatPortForwards(machine.runtime);
  const sent: BoatApiRequest[] = [];
  const sandboxes = new Set<string>();
  let next = 0;
  const api = {
    redact: (text: string): string => text.replaceAll(KEY, "[Boat key removed]"),
    request: async (request: BoatApiRequest): Promise<Record<string, unknown>> => {
      sent.push(request);
      const [, id, action] = request.path;
      if (!id) {
        const created = `bx_${next++}`;
        sandboxes.add(created);
        return { ok: true, sandbox: { id: created, state: "ready" } };
      }
      if (!sandboxes.has(id)) throw new BoatApiError("sandbox not found", "not_found", 404);
      if (action === "sshkey") return { ok: true, ...sshAnswer() };
      if (request.method === "DELETE") sandboxes.delete(id);
      return { ok: true, status: "ok", sandbox: { id, state: "ready" } };
    },
  };
  const thread = () => {
    const owned = new Set<string>();
    let sessions = 0;
    const session = () => {
      const name = `s${next}-${sessions++}`;
      return {
        name,
        tools: new BoatTools({
          api,
          policy: () => POLICY,
          role: "thread",
          ownedSandboxIds: () => owned,
          recordOwned: ({ sandboxId }) => void owned.add(sandboxId),
          forgetOwned: (sandboxId) => void owned.delete(sandboxId),
          forwards: { manager, session: name },
        }),
      };
    };
    return { owned, session };
  };
  return { machine, manager, sent, thread };
}

async function create(tools: BoatTools): Promise<string> {
  const answer = await tools.call("create_sandbox", {});
  return (answer.structuredContent as { sandbox: { id: string } }).sandbox.id;
}

const optionValue = (args: readonly string[], name: string): string | undefined =>
  args.find((arg, index) => args[index - 1] === "-o" && arg.startsWith(`${name}=`))?.slice(name.length + 1);

describe("Boat port forwards", () => {
  it("listens on loopback only and pins Boat's host key, for any arguments and any answer from Boat", async () => {
    const hostile = fc.oneof(
      fc.constantFrom(
        "-oProxyCommand=touch /tmp/x", "0.0.0.0", "host name", "a;b", "$(id)", "", "-R", "user@evil", "::1",
        "203.0.113.10", "sandbox.example.test",
      ),
      fc.string(),
    );
    await fc.assert(fc.asyncProperty(
      fc.record({
        machineIp: fc.oneof(hostile, fc.constant(null)),
        sshEndpoint: fc.oneof(fc.constant(undefined), fc.constant("203.0.113.9:22001"), hostile),
        sshUser: fc.oneof(fc.constant("user"), hostile),
        hostKey: fc.oneof(
          { weight: 3, arbitrary: fc.constant(FAKE_HOST_KEY) },
          fc.constantFrom(`${FAKE_HOST_KEY}\nevil ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEvil`, "", "* ssh-rsa x"),
          fc.string(),
        ),
      }),
      fc.record({
        port: fc.oneof(fc.integer({ min: 1, max: 65_535 }), fc.integer({ min: -5, max: 70_000 }), fc.constant("3000")),
        bind: fc.constantFrom("0.0.0.0", "::", undefined),
        localPort: fc.constantFrom(80, "0.0.0.0:80", undefined),
        reverse: fc.boolean(),
        public: fc.boolean(),
        gatewayPorts: fc.constant("yes"),
      }),
      fc.boolean(),
      async (answer, args, mine) => {
        const { machine, sent, thread } = world(() => answer);
        const owner = thread();
        const tools = owner.session().tools;
        const other = await create(thread().session().tools);
        const sandboxId = mine ? await create(tools) : other;
        const result = await tools.call("forward_port", { ...args, sandboxId });

        if (!mine) {
          // Another thread's sandbox: Boat is not asked and nothing runs.
          expect(result.isError).toBe(true);
          expect(sent.filter((request) => request.path[2] === "sshkey")).toEqual([]);
          expect(machine.tunnels).toEqual([]);
        }
        // Only the public half of the key ever leaves this machine.
        for (const request of sent.filter((entry) => entry.path[2] === "sshkey")) {
          expect(request.body).toEqual({ key: FAKE_PUBLIC_KEY });
        }
        for (const tunnel of machine.tunnels) {
          const forwards = tunnel.args.filter((_, index) => tunnel.args[index - 1] === "-L");
          expect(forwards).toHaveLength(1);
          expect(forwards[0]).toMatch(new RegExp(`^127\\.0\\.0\\.1:\\d+:127\\.0\\.0\\.1:${String(args.port)}$`));
          for (const flag of ["-R", "-D", "-g", "-A", "-J", "-W"]) expect(tunnel.args).not.toContain(flag);
          expect(optionValue(tunnel.args, "StrictHostKeyChecking")).toBe("yes");
          expect(optionValue(tunnel.args, "GlobalKnownHostsFile")).toBe(os.devNull);
          expect(optionValue(tunnel.args, "HostKeyAlias")).toBe(sandboxId);
          expect(tunnel.args[tunnel.args.indexOf("-F") + 1]).toBe(os.devNull);
          // The pinned key is the one Boat returned, alone.
          const knownHosts = optionValue(tunnel.args, "UserKnownHostsFile")!.replaceAll("\"", "");
          expect(machine.files.get(knownHosts)).toBe(`${sandboxId} ${FAKE_HOST_KEY}\n`);
          // The destination is one argument that cannot be read as an option.
          const destination = tunnel.args.at(-1)!;
          expect(destination).toMatch(/^[a-z_][a-z0-9_-]*@[A-Za-z0-9:][A-Za-z0-9.:-]*$/);
          expect(tunnel.args.join(" ")).not.toContain(KEY);
        }
        if (result.isError) {
          // A refusal leaves nothing behind.
          expect(machine.tunnels.filter((tunnel) => tunnel.alive)).toEqual([]);
          expect(machine.directories.size).toBe(0);
        } else {
          const forward = (result.structuredContent as { forward: { url: string } }).forward;
          expect(forward.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        }
      },
    ), { numRuns: 300 });
  });

  it("keeps a tunnel only while its sandbox runs and a session that asked for it lives", async () => {
    type Step =
      | { kind: "open" | "close"; session: number; sandbox: number; port: number }
      | { kind: "stop" | "resume" | "delete" | "dies"; session: number; sandbox: number }
      | { kind: "sessionEnds"; session: number };
    const pick = { session: fc.integer({ min: 0, max: 2 }), sandbox: fc.integer({ min: 0, max: 1 }) };
    const step: fc.Arbitrary<Step> = fc.oneof(
      { weight: 5, arbitrary: fc.record({ kind: fc.constant("open" as const), ...pick, port: fc.constantFrom(3000, 5432) }) },
      fc.record({ kind: fc.constant("close" as const), ...pick, port: fc.constantFrom(3000, 5432) }),
      fc.record({ kind: fc.constantFrom("stop" as const, "resume" as const, "delete" as const, "dies" as const), ...pick }),
      fc.record({ kind: fc.constant("sessionEnds" as const), session: pick.session }),
    );
    await fc.assert(fc.asyncProperty(fc.array(step, { maxLength: 30 }), async (steps) => {
      const { machine, manager, thread } = world();
      const owner = thread();
      const sessions = [owner.session(), owner.session(), owner.session()];
      const ids = [await create(sessions[0]!.tools), await create(sessions[0]!.tools)];
      // The model: for each open tunnel, the sessions holding it.
      const model = new Map<string, Set<number>>();
      const drop = (sandboxId: string) => {
        for (const key of [...model.keys()]) if (key.startsWith(`${sandboxId}:`)) model.delete(key);
      };

      for (const current of steps) {
        const tools = sessions[current.session]!.tools;
        if (current.kind === "sessionEnds") {
          await manager.closeForSession(sessions[current.session]!.name);
          for (const [key, holders] of [...model]) {
            if (holders.delete(current.session) && holders.size === 0) model.delete(key);
          }
        } else {
          const sandboxId = ids[current.sandbox]!;
          const deleted = !owner.owned.has(sandboxId);
          if (current.kind === "open") {
            const result = await tools.call("forward_port", { sandboxId, port: current.port });
            expect(Boolean(result.isError)).toBe(deleted);
            if (!deleted) {
              const key = `${sandboxId}:${current.port}`;
              model.set(key, (model.get(key) ?? new Set()).add(current.session));
            }
          } else if (current.kind === "close") {
            await tools.call("close_port_forward", { sandboxId, port: current.port });
            if (!deleted) model.delete(`${sandboxId}:${current.port}`);
          } else if (current.kind === "dies") {
            for (const tunnel of machine.tunnels) {
              if (tunnel.alive && tunnel.args.includes(`HostKeyAlias=${sandboxId}`)) tunnel.exit("Connection closed");
            }
            await Promise.resolve();
            drop(sandboxId);
          } else {
            await tools.call(`${current.kind}_sandbox`, { sandboxId });
            if (!deleted) drop(sandboxId);
          }
        }

        const alive = machine.tunnels.filter((tunnel) => tunnel.alive)
          .map((tunnel) => `${tunnel.args.find((arg) => arg.startsWith("HostKeyAlias="))!.slice(13)}:${tunnel.args[tunnel.args.indexOf("-L") + 1]!.split(":").at(-1)}`)
          .toSorted();
        expect(alive).toEqual([...model.keys()].toSorted());
        expect(manager.list(new Set(ids)).map((entry) => `${entry.sandboxId}:${entry.port}`).toSorted()).toEqual(alive);
        // One key directory per live tunnel, and no key left from a dead one.
        expect(machine.directories.size).toBe(alive.length);
      }

      await manager.closeAll();
      expect(machine.tunnels.filter((tunnel) => tunnel.alive)).toEqual([]);
      expect(machine.directories.size).toBe(0);
      expect(machine.files.size).toBe(0);
    }), { numRuns: 200 });
  });

  it("answers the tunnel already open instead of opening a second", async () => {
    const { machine, sent, thread } = world();
    const { tools } = thread().session();
    const sandboxId = await create(tools);
    const [first, second] = await Promise.all([
      tools.call("forward_port", { sandboxId, port: 3000 }),
      tools.call("forward_port", { sandboxId, port: 3000 }),
    ]);
    expect(second.structuredContent).toEqual(first.structuredContent);
    expect(machine.tunnels).toHaveLength(1);
    expect(sent.filter((request) => request.path[2] === "sshkey")).toHaveLength(1);
  });

  it("says why ssh gave up, and leaves no key behind", async () => {
    const { machine, thread } = world();
    const { tools } = thread().session();
    const sandboxId = await create(tools);
    machine.state.failStart = "Warning: something\nuser@203.0.113.10: Permission denied (publickey).\n";
    const result = await tools.call("forward_port", { sandboxId, port: 3000 });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      text: "The SSH tunnel did not start: user@203.0.113.10: Permission denied (publickey).",
    });
    expect(machine.directories.size).toBe(0);
    expect(machine.files.size).toBe(0);
  });
});
