import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { ResearchStore } from "@pwragent/sqlite-storage/research-store";
import { ResearchHarnessService } from "@pwragent/owner-core/research-harness-service";
import { probeResearchModel, researchModelRequest } from "@pwragent/owner-core/research-model-adapter";
import { openResearchHarnessProcess } from "../research/research-harness-process";
import { createHarnessModelTransport } from "../research/research-harness-model";
import { StateDb } from "../state/state-db";
import { createTempStateDb } from "./sqlite-test-utils";
import { harnessRecords } from "./fixtures/research-harness-records";

it("executes a real process through an explicit endpoint probe, eager functions and source-record import", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "harness-execution-"));
  const fixture = createTempStateDb("harness-db-");
  const db = StateDb.open(fixture.dbPath);
  const source = path.join(root, "records.json"); writeFileSync(source, JSON.stringify(harnessRecords()));
  const requests: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    expect(req.method).toBe("POST"); expect(req.url).toBe("/v1/chat/completions");
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const call = JSON.parse(body); requests.push(call);
      const nonce = call.tools[0]?.function.parameters.properties.nonce?.enum[0];
      let message;
      if (nonce && call.tool_choice !== "none") message = { tool_calls: [{ id: "probe", type: "function", function: { name: "research_compatibility_probe", arguments: JSON.stringify({ nonce }) } }] };
      else if (nonce) message = { content: JSON.parse(call.messages.find((m: { role: string }) => m.role === "tool").content).nonce };
      else message = { tool_calls: [{ id: "finding", type: "function", function: { name: "research_update", arguments: JSON.stringify({ action: "finding", kind: "lemma", text: "A real process imported this contrived model finding.", paths: [] }) } }] };
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ choices: [{ message }] }));
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address() as { port: number };
  const config = { command: process.execPath, args: [path.resolve("apps/desktop/src/main/__tests__/fixtures/research-harness-executor.mjs"), source],
    endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`, model: "contrived-model" };
  const complete = createHarnessModelTransport(config);
  const service = new ResearchHarnessService(new ResearchStore(db), {
    ownerId: "owner", ownerPid: 1, ownerStartedAt: 100, changed: () => {}, schedule: () => () => {}, onError: (error) => { throw error; },
    open: (cwd) => openResearchHarnessProcess(config, cwd, async (method, params, signal) => {
      if (method !== "model_complete") throw new Error("Only the model adapter is available");
      return await complete(researchModelRequest(config.model, params.messages), signal);
    }, () => {}),
    probe: async (_id, signal) => await probeResearchModel(complete, config.model, signal),
  });
  try {
    const run = await service.start({ backend: "codex", threadId: "fixture-coordinator", requestId: "execute-once", mode: "execute", project: "fixture-project", session: "fixture-session",
      swarm: "fixture-swarm", objective: "Exercise an invented external run", workers: 2, minutes: 1, budgetAcknowledged: true }, root);
    expect(run.status).toBe("exhausted");
    expect(new ResearchStore(db).get(run.id)!.findings[0]?.text).toBe("A real process imported this contrived model finding.");
    expect(new ResearchStore(db).get(run.id)!.submissions[0]?.review).toBeUndefined();
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests)).not.toMatch(/tool_search|defer_loading/);
    expect(requests[2]?.tools).toEqual(researchModelRequest(config.model, [{ role: "user", content: "test" }]).tools);
  } finally {
    await service.close(); server.close(); await once(server, "close"); db.close(); rmSync(root, { force: true, recursive: true }); rmSync(fixture.tempDir, { force: true, recursive: true });
  }
});
