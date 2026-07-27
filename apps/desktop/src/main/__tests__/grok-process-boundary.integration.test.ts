import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import type { AppServerNotification } from "@pwragent/shared";
import { GrokAppServerClient } from "../grok-app-server/client";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "..",
);
const appServerRoot = path.join(repositoryRoot, "apps", "grok-app-server");
const buildScript = path.join(appServerRoot, "build.mjs");
const productionEntry = path.join(appServerRoot, "dist", "index.mjs");
const requestingEntry = path.join(
  appServerRoot,
  "dist",
  "requesting-entrypoint.mjs",
);
const failingEntry = path.join(
  appServerRoot,
  "src",
  "testing",
  "failing-entrypoint.mjs",
);

beforeAll(async () => {
  await execFileAsync(process.execPath, [buildScript], {
    cwd: appServerRoot,
  });
}, 30_000);

describe("Grok child app-server process boundary", () => {
  it("launches the production bundle for initialize, thread operations, persistence, and shutdown", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "pwragent-grok-process-production-"),
    );
    const env = {
      ...process.env,
      PWRAGENT_HOME: tempRoot,
      PWRAGENT_PROFILE: "integration",
    };

    try {
      const firstClient = new GrokAppServerClient({
        apiKey: "integration-key",
        command: process.execPath,
        entryPath: productionEntry,
        env,
        requestTimeoutMs: 10_000,
      });
      const initialize = await firstClient.getInitializeResult();
      expect(initialize.serverInfo?.name).toBe("@pwragent/grok-app-server");
      expect(initialize.methods).toEqual(
        expect.arrayContaining(["thread/start", "thread/list", "thread/read"]),
      );

      const created = await firstClient.startThread({
        cwd: tempRoot,
        model: "grok-4.20-non-reasoning",
      });
      await firstClient.renameThread({
        threadId: created.threadId,
        name: "Process-backed Grok",
      });
      await expect(firstClient.listThreads()).resolves.toMatchObject([
        {
          id: created.threadId,
          title: "Process-backed Grok",
          source: "grok",
        },
      ]);
      await expect(
        firstClient.readThread({ threadId: created.threadId }),
      ).resolves.toMatchObject({
        entries: [],
        messages: [],
      });
      await expect(
        fs.stat(
          path.join(
            tempRoot,
            "profiles",
            "integration",
            "state",
            "grok-app-server",
            "threads",
            created.threadId,
            "thread.toml",
          ),
        ),
      ).resolves.toBeDefined();
      await firstClient.close();

      const secondClient = new GrokAppServerClient({
        apiKey: "integration-key",
        command: process.execPath,
        entryPath: productionEntry,
        env,
        requestTimeoutMs: 10_000,
      });
      await expect(secondClient.listThreads()).resolves.toMatchObject([
        {
          id: created.threadId,
          title: "Process-backed Grok",
        },
      ]);
      await secondClient.close();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps keychain credential precedence while resolving model and base URL in the child", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "pwragent-grok-process-config-"),
    );
    const requests: Array<{
      authorization?: string;
      body: string;
      url?: string;
    }> = [];
    const xaiServer = http.createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push({
          authorization:
            typeof request.headers.authorization === "string"
              ? request.headers.authorization
              : undefined,
          body,
          url: request.url,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify(
            makeAiSdkXaiResponse(
              JSON.stringify({ title: "Process-generated title" }),
              64,
            ),
          ),
        );
      });
    });
    xaiServer.listen(0, "127.0.0.1");
    await once(xaiServer, "listening");
    const address = xaiServer.address();
    if (!address || typeof address === "string") {
      throw new Error("xAI fixture server address unavailable");
    }

    const configDirectory = path.join(tempRoot, "grok-app-server");
    await fs.mkdir(configDirectory, { recursive: true });
    await fs.writeFile(
      path.join(configDirectory, "config.toml"),
      [
        'xai_api_key = "config-key"',
        `xai_base_url = "http://127.0.0.1:${address.port}/v1"`,
        'grok_model = "grok-config-model"',
        "",
      ].join("\n"),
    );
    const client = new GrokAppServerClient({
      apiKey: "keychain-key",
      command: process.execPath,
      entryPath: productionEntry,
      env: {
        ...process.env,
        PWRAGENT_HOME: tempRoot,
        PWRAGENT_PROFILE: "integration",
        XAI_API_KEY: "parent-env-key",
      },
      requestTimeoutMs: 10_000,
    });

    try {
      await expect(
        client.generateObject({
          promptCacheKey: "process-boundary-test",
          schema: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
            additionalProperties: false,
          },
          schemaName: "thread_title",
          system: "Return a title.",
          prompt: "Name this thread.",
        }),
      ).resolves.toEqual({
        object: { title: "Process-generated title" },
        cachedTokens: 64,
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        authorization: "Bearer keychain-key",
        url: "/v1/responses",
      });
      expect(requests[0]?.body).toContain('"model":"grok-config-model"');
      expect(requests[0]?.body).toContain(
        '"prompt_cache_key":"process-boundary-test"',
      );
    } finally {
      await client.close();
      xaiServer.close();
      await once(xaiServer, "close");
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("carries turn notifications and server request responses across stdio", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "pwragent-grok-process-request-"),
    );
    const client = new GrokAppServerClient({
      command: process.execPath,
      entryPath: requestingEntry,
      env: {
        ...process.env,
        PWRAGENT_HOME: tempRoot,
        PWRAGENT_PROFILE: "integration",
      },
      requestTimeoutMs: 10_000,
    });
    const inboundRequests: string[] = [];
    const notifications: AppServerNotification[] = [];
    const turnCompleted = new Promise<AppServerNotification>((resolve) => {
      client.onNotification((notification) => {
        notifications.push(notification);
        if (notification.method === "turn/completed") {
          resolve(notification);
        }
      });
    });
    client.onRequest(async (request) => {
      inboundRequests.push(request.method);
      return { decision: "approve" };
    });

    try {
      await client.getInitializeResult();
      await client.startThread({ cwd: tempRoot });
      await expect(
        client.startTurn({
          threadId: "thread-1",
          input: [{ type: "text", text: "Exercise request flow" }],
        }),
      ).resolves.toEqual({
        threadId: "thread-1",
        turnId: "turn-1",
      });
      await expect(turnCompleted).resolves.toMatchObject({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
        },
      });
      expect(inboundRequests).toEqual(["turn/requestApproval"]);
      expect(notifications.map((notification) => notification.method)).toEqual(
        expect.arrayContaining([
          "turn/started",
          "serverRequest/resolved",
          "turn/completed",
        ]),
      );
      await expect(
        client.readThread({ threadId: "thread-1" }),
      ).resolves.toMatchObject({
        lastUserMessage: "Exercise request flow",
        lastAssistantMessage: 'Desktop responded {"decision":"approve"}',
      });
    } finally {
      await client.close();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects initialization when the child exits unexpectedly", async () => {
    const client = new GrokAppServerClient({
      command: process.execPath,
      entryPath: failingEntry,
      requestTimeoutMs: 5_000,
    });

    await expect(client.getInitializeResult()).rejects.toThrow(
      /exited unexpectedly|transport closed/i,
    );
    await client.close();
  });
});

function makeAiSdkXaiResponse(
  text: string,
  cachedTokens: number,
): Record<string, unknown> {
  return {
    id: "resp_123",
    object: "response",
    created_at: 0,
    model: "grok-config-model",
    status: "completed",
    output: [
      {
        id: "msg_1",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    ],
    usage: {
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
      input_tokens_details: { cached_tokens: cachedTokens },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}
