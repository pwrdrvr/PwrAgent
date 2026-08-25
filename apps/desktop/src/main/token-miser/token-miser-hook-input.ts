import type { Readable } from "node:stream";

export function readTokenMiserHookInput(
  input: Readable,
  maxBytes: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes <= maxBytes) {
        chunks.push(buffer);
        return;
      }
      settled = true;
      input.removeListener("data", onData);
      input.destroy();
      reject(new Error(`Token Miser hook input exceeds ${maxBytes} bytes.`));
    };
    input.on("data", onData);
    input.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    input.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}
