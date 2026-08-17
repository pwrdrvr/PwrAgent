import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { request } from "node:http";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 55_000;

type BridgeDescriptor = {
  version: 1;
  url: string;
  token: string;
};

async function main(): Promise<void> {
  try {
    const rawHookPayload = await readStdin();
    const descriptor = readDescriptor();
    if (!descriptor) {
      return;
    }
    const hookOutput = await postHookPayload(descriptor, rawHookPayload);
    if (hookOutput) {
      writeFileSync(1, `${JSON.stringify(hookOutput)}\n`);
    }
  } catch {
    // Token Miser is fail-open: a missing desktop bridge, invalid descriptor,
    // timeout, or summarizer failure must leave the original tool result alone.
  }
}

function readDescriptor(): BridgeDescriptor | undefined {
  const descriptorPath = process.argv[2]?.trim() || defaultDescriptorPath();
  try {
    const value = JSON.parse(readFileSync(descriptorPath, "utf8")) as BridgeDescriptor;
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

function defaultDescriptorPath(): string {
  const root = process.env.PWRAGENT_HOME?.trim()
    || path.join(homedir(), ".pwragent");
  const profile = process.env.PWRAGENT_PROFILE?.trim() || "default";
  return path.join(
    root,
    "profiles",
    profile,
    "state",
    "token-miser",
    "bridge.json",
  );
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
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
