import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { openResearchHarnessProcess } from "../research/research-harness-process";
import { harnessRecords } from "./fixtures/research-harness-records";
import { discoveryRecords } from "./fixtures/research-discovery-records";

describe("Harness process and upstream socket oracle", () => {
  it("uses the actual discovery UI operation names and preserves bounded source snapshots", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pd-"));
    const socket = process.platform === "win32" ? `\\\\.\\pipe\\pwr-discovery-${randomUUID()}` : path.join(root, "ui.sock");
    const observed: unknown[] = [];
    const records = discoveryRecords();
    const server = net.createServer((connection) => {
      let input = "";
      connection.on("data", (chunk) => {
        input += chunk;
        if (!input.includes("\n")) return;
        const request = JSON.parse(input); observed.push(request);
        const value = records[request.op.slice("runs.".length) as keyof typeof records];
        connection.end(`${JSON.stringify({ id: request.id, ok: value })}\n`);
      });
    });
    server.listen(socket); await once(server, "listening");
    const bridge = openResearchHarnessProcess({ command: process.execPath, args: [path.resolve("scripts/research-harness-ui-bridge.mjs"), socket] }, root,
      async () => { throw new Error("Observation cannot call a model"); }, () => {});
    try {
      expect(await bridge.request("hello", {})).toMatchObject({ discovery: true, execute: false });
      for (const kind of ["status", "problems", "tree"] as const) {
        const params = { project: "fixture-project", run: "fixture-run", ...(kind === "tree" ? { problem: "fixture_problem" } : {}) };
        expect(await bridge.request(`discovery.${kind}`, params)).toEqual(records[kind]);
        expect(observed.at(-1)).toEqual({ id: 1, op: `runs.${kind}`, ...params });
      }
    } finally { await bridge.close(); server.close(); await once(server, "close"); rmSync(root, { force: true, recursive: true }); }
  });

  it("imports a service page through a real child and the actual UI request/response envelope", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ph-"));
    const socket = process.platform === "win32" ? `\\\\.\\pipe\\pwr-harness-${randomUUID()}` : path.join(root, "ui.sock");
    const observed: Record<string, unknown>[] = [];
    const server = net.createServer((connection) => {
      connection.setEncoding("utf8");
      let input = "";
      connection.on("data", (chunk) => {
        input += chunk;
        if (!input.includes("\n")) return;
        const request = JSON.parse(input.trim()); observed.push(request);
        const answer = `${JSON.stringify({ id: request.id, ok: { swarm: "fixture-swarm", records: harnessRecords().slice(0, 4), next: 4 } })}\n`;
        // Deliberately split a JSON frame; process pipes and sockets do not preserve records.
        connection.write(answer.slice(0, 19)); connection.end(answer.slice(19));
      });
    });
    server.listen(socket); await once(server, "listening");
    const error = vi.fn();
    const bridge = openResearchHarnessProcess({ command: process.execPath, args: [path.resolve("scripts/research-harness-ui-bridge.mjs"), socket] }, root,
      async () => { throw new Error("Read-only observation must not request a model"); }, error);
    try {
      expect(await bridge.request("hello", { version: 1 })).toMatchObject({ import: true, execute: false, cancel: false });
      expect(await bridge.request("records", { project: "fixture-project", session: "fixture-session", swarm: "fixture-swarm", after: 0, limit: 50 }))
        .toMatchObject({ swarm: "fixture-swarm", next: 4, records: harnessRecords().slice(0, 4) });
      expect(observed).toEqual([{ id: 1, op: "swarm.records", project: "fixture-project", session: "fixture-session", swarm: "fixture-swarm", after: 0, limit: 50 }]);
      await expect(bridge.request("execute", {})).rejects.toThrow("refused");
    } finally {
      await bridge.close(); server.close(); await once(server, "close"); rmSync(root, { force: true, recursive: true });
    }
    expect(error).not.toHaveBeenCalled();
  });

  it.each(["missing-result", "oversized", "exit"])("settles outstanding calls and owns child cleanup on %s", async (kind) => {
    const source = kind === "missing-result" ? "process.stdin.once('data', () => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1})+'\\n'))"
      : kind === "oversized" ? "process.stdin.once('data', () => process.stdout.write('x'.repeat(512001)))"
        : "process.stdin.once('data', () => process.exit(0))";
    const bridge = openResearchHarnessProcess({ command: process.execPath, args: ["-e", source] }, process.cwd(), async () => ({}), () => {});
    try { await expect(bridge.request("hello", {})).rejects.toThrow(); }
    finally { await bridge.close(); }
  });
});
