import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { AcpStdioJsonRpcTransport } from "../acp/acp-stdio-transport";

const pipes = ["stdin", "stdout", "stderr"] as const;
type Pipe = (typeof pipes)[number];

class FixtureChild extends EventEmitter {
  readonly requests: string[] = [];
  readonly stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      this.requests.push(JSON.parse(String(chunk)).id);
      if (this.onWrite) this.onWrite(callback);
      else callback();
    },
  });
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  onWrite?: (callback: (error?: Error | null) => void) => void;
  readonly kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
    this.signalCode = signal;
    this.emit("close");
    return true;
  });

  constructor() {
    super();
    // Let the pre-fix transport fail the model without crashing the worker.
    for (const pipe of pipes) this[pipe].on("error", () => undefined);
  }

  fail(pipe: Pipe): void {
    this[pipe].emit("error", Object.assign(new Error(`fixture ${pipe} EPIPE`), { code: "EPIPE" }));
  }

  reply(index: number): void {
    const id = this.requests[index];
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: {} })}\n`);
  }
}

type Step = "request" | "reply" | "exit" | "close" | "late error" | Pipe;
type Outcome = "pending" | "resolved" | "rejected";
type ModelRequest = { child: number; write: number; outcome: Outcome };

async function checkNotificationWrite(writeFails: boolean): Promise<void> {
  const child = new FixtureChild();
  const write = Promise.withResolvers<(error?: Error) => void>();
  child.onWrite = write.resolve;
  const transport = new AcpStdioJsonRpcTransport({
    launchDescriptor: {
      backendId: "acp:fixture", registryId: "fixture", distributionKind: "local",
      command: "fixture", args: [], env: {},
    },
    spawn: () => child,
  });
  const outcomes: string[] = [];
  const notification = transport.notify("session/cancel").then(
    () => { outcomes.push("written"); },
    (error: Error) => { outcomes.push(error.message); },
  );
  const complete = await write.promise;
  let completed = false;
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(outcomes).toEqual([]);
    completed = true;
    complete(writeFails ? new Error("fixture EPIPE") : undefined);
    await notification;
    expect(outcomes).toEqual([writeFails ? "fixture EPIPE" : "written"]);
  } finally {
    if (!completed) complete();
    await transport.close();
  }
}

describe("ACP stdio lifecycle", () => {
  it("keeps a notification pending until its write callback completes", async () => {
    await checkNotificationWrite(false);
  });

  it("settles notifications from their own write callbacks", async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), checkNotificationWrite), { numRuns: 16 });
  });

  it("settles each generation's requests and reaps a broken child once", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom(...pipes),
      fc.array(fc.constantFrom<Step>("request", "request", "reply", "exit", "close", "late error", ...pipes), {
        maxLength: 20,
      }),
      async (firstFailure, steps) => {
        const children: FixtureChild[] = [];
        const transport = new AcpStdioJsonRpcTransport({
          launchDescriptor: {
            backendId: "acp:fixture", registryId: "fixture", distributionKind: "local",
            command: "fixture", args: [], env: {}, cwd: "/fixture",
          },
          spawn: () => {
            const child = new FixtureChild();
            children.push(child);
            return child;
          },
        });
        const model = { closed: false, active: -1, children: [] as Array<{ writes: number; kills: number }> };
        const requests: ModelRequest[] = [];
        const outcomes: Outcome[] = [];
        function retireChild(kills: number): void {
          model.children[model.active].kills = kills;
          for (const request of requests) {
            if (request.child === model.active && request.outcome === "pending") request.outcome = "rejected";
          }
          model.active = -1;
        }

        try {
          for (const step of ["request", "request", firstFailure, "request", "late error", ...steps] as Step[]) {
            const child = children[model.active];
            switch (step) {
              case "request": {
                if (!model.closed && model.active === -1) {
                  model.active = model.children.push({ writes: 0, kills: 0 }) - 1;
                }
                requests.push({
                  child: model.active,
                  write: model.closed ? -1 : model.children[model.active].writes++,
                  outcome: model.closed ? "rejected" : "pending",
                });
                const index = outcomes.push("pending") - 1;
                void transport.request("session/new").then(
                  () => { outcomes[index] = "resolved"; },
                  () => { outcomes[index] = "rejected"; },
                );
                break;
              }
              case "reply": {
                const pending = requests.find((request) => request.child === model.active && request.outcome === "pending");
                if (child && pending) {
                  pending.outcome = "resolved";
                  child.reply(pending.write);
                }
                break;
              }
              case "exit":
                if (child) {
                  retireChild(0);
                  child.exitCode = 1;
                  child.emit("close");
                }
                break;
              case "close":
                model.closed = true;
                if (child) retireChild(1);
                await transport.close();
                break;
              case "late error":
                children.find((_child, index) => index !== model.active)?.fail(firstFailure);
                break;
              default:
                if (child) {
                  retireChild(1);
                  child.fail(step);
                }
            }
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(outcomes).toEqual(requests.map(({ outcome }) => outcome));
            expect(children.map((child) => ({
              writes: child.requests.length,
              kills: child.kill.mock.calls.length,
            }))).toEqual(model.children);
          }
        } finally {
          await transport.close();
        }
      },
    ));
  });
});
