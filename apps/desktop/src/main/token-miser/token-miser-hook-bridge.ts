import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import {
  isTokenMiserCodeModeAcceptancePayload,
  isTokenMiserCodeModeOutputPayload,
  isTokenMiserPostToolUsePayload,
  type TokenMiserCodeModeAcceptancePayload,
  type TokenMiserCodeModeReductionOutput,
  type TokenMiserHookOutput,
} from "./token-miser-types.js";
import type { TokenMiserService } from "./token-miser-service.js";
import type { TokenMiserStagedObject } from "./token-miser-store.js";

const MAX_HOOK_REQUEST_BYTES = 32 * 1024 * 1024;
const DEFAULT_CODE_MODE_ACCEPTANCE_TIMEOUT_MS = 60_000;
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

export type TokenMiserCodeModeReducerDescriptor = {
  version: 2;
  url: string;
  acceptance_url: string;
  token: string;
};

type PendingCodeModeReduction = {
  identity: Omit<TokenMiserCodeModeAcceptancePayload, "version" | "response_id">;
  staged: TokenMiserStagedObject;
  state: "pending" | "committing" | "committed" | "discarding";
  timer?: NodeJS.Timeout;
  commitPromise?: Promise<void>;
  discardPromise?: Promise<void>;
};

export class TokenMiserHookBridge {
  private server?: ReturnType<typeof createServer>;
  private descriptor?: TokenMiserBridgeDescriptor;
  private closing?: Promise<void>;
  private shuttingDown = false;
  private readonly pendingCodeModeReductions = new Map<
    string,
    PendingCodeModeReduction
  >();
  private readonly codeModeAcceptanceTimeoutMs: number;
  readonly codeModeReducerDescriptorPath: string;

  constructor(
    private readonly options: {
      stateDir: string;
      service: TokenMiserService;
      codeModeAcceptanceTimeoutMs?: number;
    },
  ) {
    this.codeModeAcceptanceTimeoutMs =
      options.codeModeAcceptanceTimeoutMs
      ?? DEFAULT_CODE_MODE_ACCEPTANCE_TIMEOUT_MS;
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
    this.shuttingDown = false;
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
      version: 2,
      url: `http://127.0.0.1:${address.port}/v1/reduce-code-mode-output`,
      acceptance_url:
        `http://127.0.0.1:${address.port}/v1/accept-code-mode-output`,
      token,
    } satisfies TokenMiserCodeModeReducerDescriptor;
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
    this.shuttingDown = true;
    const server = this.server;
    this.server = undefined;
    this.descriptor = undefined;
    await this.disposePendingCodeModeReductions();
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
      || this.shuttingDown
      || !isAuthorized(request.headers.authorization, token)
    ) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    if (request.url === "/v1/reduce-code-mode-output") {
      await this.handleCodeModeRequest(request, response);
      return;
    }
    if (request.url === "/v1/accept-code-mode-output") {
      await this.handleCodeModeAcceptance(request, response);
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
      if (controller.signal.aborted || this.shuttingDown) {
        await prepared.staged.discard();
        return;
      }
      const responseId = prepared.response.response_id;
      this.registerPendingCodeModeReduction(
        responseId,
        payload,
        prepared.staged,
      );
      const delivered = await sendJsonAndWait(
        response,
        200,
        prepared.response,
      );
      if (!delivered) {
        await this.discardPendingCodeModeReduction(responseId);
        return;
      }
    } catch (error) {
      const status = error instanceof RequestTooLargeError ? 413 : 500;
      sendJson(response, status, { error: "token_miser_unavailable" });
    }
  }

  private async handleCodeModeAcceptance(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const body = await readBody(request);
      const payload: unknown = JSON.parse(body);
      if (!isTokenMiserCodeModeAcceptancePayload(payload)) {
        sendJson(response, 400, { error: "invalid_acceptance_payload" });
        return;
      }
      const pending = this.pendingCodeModeReductions.get(payload.response_id);
      if (!pending || !acceptanceIdentityMatches(pending, payload)) {
        sendJson(response, 404, { error: "acceptance_not_found" });
        return;
      }
      await this.commitPendingCodeModeReduction(payload.response_id, pending);
      sendJson(response, 200, { accepted: true });
    } catch (error) {
      const status = error instanceof RequestTooLargeError ? 413 : 500;
      sendJson(response, status, { error: "token_miser_unavailable" });
    }
  }

  private registerPendingCodeModeReduction(
    responseId: string,
    payload: {
      thread_id: string;
      turn_id: string;
      call_id: string;
      cell_id: string;
    },
    staged: TokenMiserStagedObject,
  ): void {
    const previous = this.pendingCodeModeReductions.get(responseId);
    if (previous) {
      clearPendingTimer(previous);
      void previous.staged.discard().catch(() => undefined);
    }
    const pending: PendingCodeModeReduction = {
      identity: {
        thread_id: payload.thread_id,
        turn_id: payload.turn_id,
        call_id: payload.call_id,
        cell_id: payload.cell_id,
      },
      staged,
      state: "pending",
    };
    this.schedulePendingCodeModeDiscard(responseId, pending);
    this.pendingCodeModeReductions.set(responseId, pending);
  }

  private async commitPendingCodeModeReduction(
    responseId: string,
    pending: PendingCodeModeReduction,
  ): Promise<void> {
    if (pending.state === "committed") {
      return;
    }
    if (pending.state === "committing") {
      await pending.commitPromise;
      return;
    }
    if (pending.state !== "pending") {
      throw new Error("Token Miser reduction is no longer pending.");
    }
    clearPendingTimer(pending);
    pending.state = "committing";
    pending.commitPromise = pending.staged.commit()
      .then(() => {
        pending.state = "committed";
        pending.timer = setTimeout(() => {
          if (this.pendingCodeModeReductions.get(responseId) === pending) {
            this.pendingCodeModeReductions.delete(responseId);
          }
        }, this.codeModeAcceptanceTimeoutMs);
        pending.timer.unref();
      })
      .catch((error: unknown) => {
        pending.state = "pending";
        pending.commitPromise = undefined;
        this.schedulePendingCodeModeDiscard(responseId, pending);
        throw error;
      });
    await pending.commitPromise;
  }

  private async discardPendingCodeModeReduction(
    responseId: string,
  ): Promise<void> {
    const pending = this.pendingCodeModeReductions.get(responseId);
    if (!pending) {
      return;
    }
    if (pending.state === "discarding") {
      await pending.discardPromise;
      return;
    }
    if (pending.state !== "pending") {
      return;
    }
    pending.state = "discarding";
    clearPendingTimer(pending);
    pending.discardPromise = pending.staged.discard()
      .then(() => {
        if (this.pendingCodeModeReductions.get(responseId) === pending) {
          this.pendingCodeModeReductions.delete(responseId);
        }
      })
      .catch((error: unknown) => {
        pending.state = "pending";
        pending.discardPromise = undefined;
        if (!this.shuttingDown) {
          this.schedulePendingCodeModeDiscard(responseId, pending);
        }
        throw error;
      });
    await pending.discardPromise;
  }

  private async disposePendingCodeModeReductions(): Promise<void> {
    const pending = [...this.pendingCodeModeReductions.entries()];
    await Promise.all(pending.map(async ([responseId, reduction]) => {
      clearPendingTimer(reduction);
      if (reduction.state === "committing") {
        await reduction.commitPromise?.catch(() => undefined);
        clearPendingTimer(reduction);
        const stateAfterCommit = reduction.state as PendingCodeModeReduction["state"];
        if (stateAfterCommit === "pending") {
          await this.discardPendingCodeModeReduction(responseId)
            .catch(() => undefined);
          return;
        }
        this.pendingCodeModeReductions.delete(responseId);
        return;
      }
      if (reduction.state === "discarding") {
        await reduction.discardPromise?.catch(() => undefined);
        clearPendingTimer(reduction);
      }
      const stateAfterDiscard = reduction.state as PendingCodeModeReduction["state"];
      if (stateAfterDiscard === "pending") {
        await this.discardPendingCodeModeReduction(responseId)
          .catch(() => undefined);
        return;
      }
      this.pendingCodeModeReductions.delete(responseId);
    }));
  }

  private schedulePendingCodeModeDiscard(
    responseId: string,
    pending: PendingCodeModeReduction,
  ): void {
    clearPendingTimer(pending);
    pending.timer = setTimeout(() => {
      void this.discardPendingCodeModeReduction(responseId)
        .catch(() => undefined);
    }, this.codeModeAcceptanceTimeoutMs);
    pending.timer.unref();
  }
}

function acceptanceIdentityMatches(
  pending: PendingCodeModeReduction,
  payload: TokenMiserCodeModeAcceptancePayload,
): boolean {
  return (
    pending.identity.thread_id === payload.thread_id
    && pending.identity.turn_id === payload.turn_id
    && pending.identity.call_id === payload.call_id
    && pending.identity.cell_id === payload.cell_id
  );
}

function clearPendingTimer(pending: PendingCodeModeReduction): void {
  if (pending.timer) {
    clearTimeout(pending.timer);
    pending.timer = undefined;
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
    accepted?: boolean;
    hookOutput?: TokenMiserHookOutput | null;
    replacement?: TokenMiserCodeModeReductionOutput["replacement"];
    response_id?: string;
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
    response_id?: string;
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
  value: TokenMiserBridgeDescriptor | TokenMiserCodeModeReducerDescriptor,
): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(temporaryPath, filePath);
}

class RequestTooLargeError extends Error {}
