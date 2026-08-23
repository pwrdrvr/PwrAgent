import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import {
  isTokenMiserCodeModeOutputPayload,
  isTokenMiserPostToolUsePayload,
  type TokenMiserCodeModeReductionOutput,
  type TokenMiserHookOutput,
} from "./token-miser-types.js";
import type { TokenMiserService } from "./token-miser-service.js";

const MAX_HOOK_REQUEST_BYTES = 32 * 1024 * 1024;
export const TOKEN_MISER_CODE_MODE_REDUCER_DESCRIPTOR_FILENAME_PREFIX =
  "code-mode-reducer";

export function getTokenMiserCodeModeReducerDescriptorPath(
  stateDir: string,
  instanceId: string,
): string {
  return path.join(
    stateDir,
    `${TOKEN_MISER_CODE_MODE_REDUCER_DESCRIPTOR_FILENAME_PREFIX}.${instanceId}.json`,
  );
}

export type TokenMiserBridgeDescriptor = {
  version: 1;
  url: string;
  token: string;
};

export class TokenMiserHookBridge {
  private server?: ReturnType<typeof createServer>;
  private descriptor?: TokenMiserBridgeDescriptor;
  private closing?: Promise<void>;
  readonly codeModeReducerDescriptorPath: string;

  constructor(
    private readonly options: {
      stateDir: string;
      service: TokenMiserService;
    },
  ) {
    this.codeModeReducerDescriptorPath =
      getTokenMiserCodeModeReducerDescriptorPath(
        options.stateDir,
        `${process.pid}-${randomUUID()}`,
      );
  }

  async start(): Promise<TokenMiserBridgeDescriptor> {
    if (this.closing) {
      await this.closing;
    }
    if (this.descriptor) {
      return this.descriptor;
    }
    // Memoize the in-flight start. There are four awaits before `descriptor` is
    // assigned, and two ungated callers (thread start and the config-write
    // listener), so without this two callers bind two listeners and the second
    // overwrites the reference to the first, leaking it past close().
    this.starting ??= this.startOnce().finally(() => {
      this.starting = undefined;
    });
    return await this.starting;
  }

  private starting?: Promise<TokenMiserBridgeDescriptor>;

  private async startOnce(): Promise<TokenMiserBridgeDescriptor> {
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
    const descriptor = {
      version: 1,
      url: `http://127.0.0.1:${address.port}/v1/post-tool-use`,
      token,
    } satisfies TokenMiserBridgeDescriptor;
    const codeModeDescriptor = {
      version: 1,
      url: `http://127.0.0.1:${address.port}/v1/reduce-code-mode-output`,
      token,
    } satisfies TokenMiserBridgeDescriptor;
    try {
      await Promise.all([
        writePrivateJsonAtomic(
          path.join(this.options.stateDir, "bridge.json"),
          descriptor,
        ),
        writePrivateJsonAtomic(
          this.codeModeReducerDescriptorPath,
          codeModeDescriptor,
        ),
      ]);
    } catch (error) {
      this.server = undefined;
      await Promise.all([
        fs.rm(path.join(this.options.stateDir, "bridge.json"), { force: true }),
        fs.rm(
          this.codeModeReducerDescriptorPath,
          { force: true },
        ),
        new Promise<void>((resolve) => server.close(() => resolve())),
      ]);
      throw error;
    }
    this.descriptor = descriptor;
    return descriptor;
  }

  async close(): Promise<void> {
    this.closing ??= this.closeOnce().finally(() => {
      this.closing = undefined;
    });
    await this.closing;
  }

  private async closeOnce(): Promise<void> {
    await this.starting?.catch(() => undefined);
    const server = this.server;
    this.server = undefined;
    this.descriptor = undefined;
    await Promise.all([
      fs.rm(path.join(this.options.stateDir, "bridge.json"), { force: true }),
      fs.rm(
        this.codeModeReducerDescriptorPath,
        { force: true },
      ),
    ]);
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
      || !isAuthorized(request.headers.authorization, token)
    ) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    if (request.url === "/v1/reduce-code-mode-output") {
      await this.handleCodeModeRequest(request, response);
      return;
    }
    if (request.url !== "/v1/post-tool-use") {
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

  private async handleCodeModeRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const body = await readBody(request);
      const payload: unknown = JSON.parse(body);
      if (!isTokenMiserCodeModeOutputPayload(payload)) {
        // A null replacement is an explicit fail-open response in protocol v1.
        // In particular, never flatten image/audio/encrypted items into text.
        sendJson(response, 200, { replacement: null });
        return;
      }
      const controller = new AbortController();
      const abortRequest = () => controller.abort();
      request.once("aborted", abortRequest);
      response.once("close", () => {
        if (!response.writableFinished) {
          abortRequest();
        }
      });
      if (request.aborted || request.socket.destroyed || response.destroyed) {
        abortRequest();
      }
      const prepared = await this.options.service.prepareCodeModeOutput(
        payload,
        { signal: controller.signal },
      );
      if (!prepared) {
        sendJson(response, 200, { replacement: null });
        return;
      }
      await prepared.staged.persist();
      if (request.socket.destroyed || response.destroyed) {
        abortRequest();
      }
      if (controller.signal.aborted) {
        await prepared.staged.discard();
        return;
      }
      const delivered = await sendJsonAndWait(
        response,
        200,
        prepared.response,
      );
      if (!delivered || controller.signal.aborted) {
        await prepared.staged.discard();
        return;
      }
      await prepared.staged.commit();
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
  body: {
    hookOutput?: TokenMiserHookOutput | null;
    replacement?: TokenMiserCodeModeReductionOutput["replacement"];
    error?: string;
  },
): void {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  const contents = `${JSON.stringify(body)}\n`;
  try {
    response.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(contents),
      "Cache-Control": "no-store",
    });
    response.end(contents);
  } catch {
    // Codex owns the reducer timeout. A disconnected client has already taken
    // the protocol's fail-open path, so there is nothing left to send.
  }
}

async function sendJsonAndWait(
  response: ServerResponse,
  status: number,
  body: {
    replacement?: TokenMiserCodeModeReductionOutput["replacement"];
    error?: string;
  },
): Promise<boolean> {
  if (response.destroyed || response.writableEnded) {
    return false;
  }
  const contents = `${JSON.stringify(body)}\n`;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (delivered: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(delivered);
    };
    response.once("finish", () => finish(true));
    response.once("close", () => finish(response.writableFinished));
    response.once("error", () => finish(false));
    try {
      response.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(contents),
        "Cache-Control": "no-store",
      });
      response.end(contents);
    } catch {
      finish(false);
    }
  });
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
