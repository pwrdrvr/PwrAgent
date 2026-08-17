import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import {
  isTokenMiserPostToolUsePayload,
  type TokenMiserHookOutput,
} from "./token-miser-types.js";
import type { TokenMiserService } from "./token-miser-service.js";

const MAX_HOOK_REQUEST_BYTES = 32 * 1024 * 1024;

export type TokenMiserBridgeDescriptor = {
  version: 1;
  url: string;
  token: string;
};

export class TokenMiserHookBridge {
  private server?: ReturnType<typeof createServer>;
  private descriptor?: TokenMiserBridgeDescriptor;

  constructor(
    private readonly options: {
      stateDir: string;
      service: TokenMiserService;
    },
  ) {}

  async start(): Promise<TokenMiserBridgeDescriptor> {
    if (this.descriptor) {
      return this.descriptor;
    }
    await fs.mkdir(this.options.stateDir, { recursive: true, mode: 0o700 });
    const token = randomBytes(32).toString("base64url");
    const server = createServer((request, response) => {
      void this.handleRequest(request, response, token);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Token Miser bridge did not receive a TCP address.");
    }
    this.server = server;
    this.descriptor = {
      version: 1,
      url: `http://127.0.0.1:${address.port}/v1/post-tool-use`,
      token,
    };
    await writePrivateJsonAtomic(
      path.join(this.options.stateDir, "bridge.json"),
      this.descriptor,
    );
    return this.descriptor;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.descriptor = undefined;
    await fs.rm(path.join(this.options.stateDir, "bridge.json"), { force: true });
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    token: string,
  ): Promise<void> {
    if (
      request.method !== "POST"
      || request.url !== "/v1/post-tool-use"
      || !isAuthorized(request.headers.authorization, token)
    ) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    try {
      const body = await readBody(request);
      const payload: unknown = JSON.parse(body);
      if (!isTokenMiserPostToolUsePayload(payload)) {
        sendJson(response, 400, { error: "invalid_hook_payload" });
        return;
      }
      const hookOutput = await this.options.service.handlePostToolUse(payload);
      sendJson(response, 200, { hookOutput: hookOutput ?? null });
    } catch (error) {
      const status = error instanceof RequestTooLargeError ? 413 : 500;
      sendJson(response, status, { error: "token_miser_unavailable" });
    }
  }
}

function isAuthorized(header: string | undefined, token: string): boolean {
  const prefix = "Bearer ";
  if (!header?.startsWith(prefix)) {
    return false;
  }
  const supplied = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_HOOK_REQUEST_BYTES) {
      throw new RequestTooLargeError();
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: { hookOutput?: TokenMiserHookOutput | null; error?: string },
): void {
  const contents = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(contents),
    "Cache-Control": "no-store",
  });
  response.end(contents);
}

async function writePrivateJsonAtomic(
  filePath: string,
  value: TokenMiserBridgeDescriptor,
): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(temporaryPath, filePath);
}

class RequestTooLargeError extends Error {}
