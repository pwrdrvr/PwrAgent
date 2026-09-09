import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { AppServerNotification } from "@pwragent/shared";
import { CodexAppServerClient } from "../codex-app-server/client";
import { isCodexInvalidResponseMessageIdError } from "../codex-app-server/invalid-response-message-id-recovery";

vi.mock("../log", () => ({
  getMainLogger: () => ({
    debug() {},
    info() {},
    warn() {},
    error() {},
  }),
}));

// Opt in with PWRAGENT_CODEX_RECOVERY_LIVE=1. Uses a local HTTP fixture and
// isolated CODEX_HOME; no account credentials or real conversations are used.
// PWRAGENT_CODEX_RECOVERY_COMMAND may select a particular installed version.

it.skipIf(!process.env.PWRAGENT_CODEX_RECOVERY_LIVE).each(["http", "sse"])("repairs a damaged fixture using the installed Codex app-server (%s)", async (transport) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-recovery-live-"));
  const requests: Array<Record<string, unknown>> = [];
  const error = "[ApiIdParam] [input[383].id] [invalid_id_prefix] Invalid 'input[383].id': 'review_rollout_user'. Expected an ID that begins with 'msg'.";
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }
    if (!req.url?.endsWith("/responses")) {
      res.writeHead(404).end();
      return;
    }
    const payload = JSON.parse(body);
    requests.push(payload);
    if (JSON.stringify(payload.input).includes("review_rollout_user")) {
      const apiError = {
        message: error,
        type: "invalid_request_error",
        code: "invalid_id_prefix",
        param: "input[383].id",
      };
      if (transport === "http") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: apiError }));
      } else {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(`event: response.failed\ndata: ${JSON.stringify({
          type: "response.failed",
          response: { id: "resp_fixture", status: "failed", error: apiError },
        })}\n\n`);
      }
      return;
    }
    const response = { id: "resp_fixture", object: "response", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 } };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await writeFile(path.join(root, "config.toml"), `model = "gpt-5.4"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "fixture"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`);
  const client = new CodexAppServerClient({
    command: process.env.PWRAGENT_CODEX_RECOVERY_COMMAND ?? "codex",
    env: { ...process.env, CODEX_HOME: root },
    threadDirectoryEnricher: async () => ({ linkedDirectories: [] }),
  });
  const events: AppServerNotification[] = [];
  client.onNotification((event) => {
    events.push(event);
  });
  async function turn(threadId: string) {
    events.length = 0;
    await client.startTurn({ threadId, input: [{ type: "text", text: "fixture probe" }], cwd: root, approvalPolicy: "never", sandbox: "read-only" });
    await vi.waitFor(() => expect(events.some((e) => e.method === "turn/completed" || e.method === "turn/failed")).toBe(true), { timeout: 15000 });
    return events.find((e) => e.method === "turn/completed" || e.method === "turn/failed")!;
  }
  try {
    const { threadId } = await client.startThread({ cwd: root, approvalPolicy: "never", sandbox: "read-only" });
    expect((await turn(threadId)).method).toBe("turn/completed");
    const thread = (await client.listThreadsForMigration()).find((t) => t.id === threadId)!;
    expect(thread.rolloutPath).toBeTruthy();
    await client.close();
    // This rollout belongs exclusively to this test's isolated CODEX_HOME.
    const original = await readFile(thread.rolloutPath!, "utf8");
    const damaged = original.split("\n").map((line) => {
      if (!line) {
        return line;
      }
      const record = JSON.parse(line);
      if (
        record.type === "response_item"
        && record.payload.type === "message"
        && record.payload.role === "user"
      ) {
        record.payload.id = "review_rollout_user";
      }
      return JSON.stringify(record);
    }).join("\n");
    expect(damaged).toContain("review_rollout_user");
    await writeFile(thread.rolloutPath!, damaged);
    const failure = await turn(threadId);
    expect(failure.method).toBe("turn/failed");
    if (failure.method !== "turn/failed") {
      throw new Error("Expected the damaged fixture to fail");
    }
    const failedTurn = failure as Extract<
      AppServerNotification,
      { method: "turn/failed" }
    >;
    const failureMessage = failedTurn.params.turn.error.message;
    expect(isCodexInvalidResponseMessageIdError(failureMessage)).toBe(true);
    const repaired = await client.recoverInvalidPersistedResponseMessageIds({
      threadId,
      failureMessage,
    });
    expect(repaired.removedMessageIdCount).toBeGreaterThan(0);
    expect(await readFile(repaired.backupPath, "utf8")).toContain("review_rollout_user");
    expect((await turn(threadId)).method).toBe("turn/completed");
    expect(JSON.stringify(requests.at(-1)?.input)).not.toContain("review_rollout_user");
  } finally {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
