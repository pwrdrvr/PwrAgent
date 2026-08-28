import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { request } from "node:http";
import { readTokenMiserHookInput } from "./token-miser-hook-input.js";

const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 55_000;
const TOKEN_MISER_BRIDGE_DESCRIPTOR_ENV =
  "PWRAGENT_TOKEN_MISER_BRIDGE_DESCRIPTOR_PATH";

type BridgeDescriptor = {
  version: 1;
  url: string;
  token: string;
};

async function main(): Promise<void> {
  try {
    const rawHookPayload = await readTokenMiserHookInput(
      process.stdin,
      MAX_REQUEST_BYTES,
    );
    const descriptor = readDescriptor();
    if (!descriptor) {
      return;
    }
    const hookOutput = await postHookPayload(descriptor, rawHookPayload);
    if (hookOutput) {
      // A successful write is not acceptance: Codex parses and selects the
      // replacement only after this subprocess exits. The supporting fork
      // acknowledges hookSpecificOutput.response_id through the reducer
      // descriptor after selection; this relay must never publish it early.
      writeFileSync(1, `${JSON.stringify(hookOutput)}\n`);
    }
  } catch {
    // Token Miser is fail-open: a missing desktop bridge, invalid descriptor,
    // timeout, or summarizer failure must leave the original tool result alone.
  }
}

function readDescriptor(): BridgeDescriptor | undefined {
  const inheritedPath = process.env[TOKEN_MISER_BRIDGE_DESCRIPTOR_ENV]?.trim();
  const commandPath = process.argv[2]?.trim();
  if (
    !inheritedPath
    || !commandPath
    || !path.isAbsolute(inheritedPath)
    || path.resolve(commandPath) !== path.resolve(inheritedPath)
  ) {
    return undefined;
  }
  try {
    const value = JSON.parse(readFileSync(inheritedPath, "utf8")) as BridgeDescriptor;
    return (
      value?.version === 1
      && typeof value.url === "string"
      && value.url.startsWith("http://127.0.0.1:")
      && typeof value.token === "string"
      && value.token.length > 0
    )
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function postHookPayload(
  descriptor: BridgeDescriptor,
  body: string,
): Promise<unknown | undefined> {
  return new Promise((resolve) => {
    const url = new URL(descriptor.url);
    const requestHandle = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          Authorization: `Bearer ${descriptor.token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes <= MAX_RESPONSE_BYTES) {
            chunks.push(buffer);
          }
        });
        response.on("end", () => {
          if (response.statusCode !== 200 || bytes > MAX_RESPONSE_BYTES) {
            resolve(undefined);
            return;
          }
          try {
            const parsed = JSON.parse(
              Buffer.concat(chunks).toString("utf8"),
            ) as { hookOutput?: unknown };
            resolve(parsed.hookOutput ?? undefined);
          } catch {
            resolve(undefined);
          }
        });
      },
    );
    requestHandle.setTimeout(REQUEST_TIMEOUT_MS, () => {
      requestHandle.destroy();
      resolve(undefined);
    });
    requestHandle.on("error", () => resolve(undefined));
    requestHandle.end(body);
  });
}

void main();
