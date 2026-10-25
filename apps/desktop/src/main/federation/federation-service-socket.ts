import type { Socket } from "node:net";

export const SERVICE_CHUNK_BYTES = 16 * 1024;
export const SERVICE_LEASE_MS = 30_000;
export const SERVICE_MAX_STREAMS = 32;
export const SERVICE_MAX_PEER_STREAMS = 8;

export function decodeServiceData(value: unknown): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(SERVICE_CHUNK_BYTES / 3) * 4) {
    throw new Error("Service data exceeds the frame limit.");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > SERVICE_CHUNK_BYTES || bytes.toString("base64") !== value) {
    throw new Error("Invalid service data encoding.");
  }
  return bytes;
}

/** Leave the socket in non-flowing mode: its high water mark bounds unread data. */
export function readServiceData(socket: Socket): Buffer {
  return (socket.read(Math.min(socket.readableLength, SERVICE_CHUNK_BYTES)) as Buffer | null) ?? Buffer.alloc(0);
}

/**
 * Wait until the socket has data or EOF to read, `flushed` settles, or `milliseconds`
 * pass. EOF that was already read ends the wait only when there is no write to wait for.
 * Resolves `false` when the timer ended the wait.
 */
export function waitServiceReadable(socket: Socket, milliseconds = 50, flushed?: Promise<unknown>): Promise<boolean> {
  if (socket.readableLength || socket.destroyed || (socket.readableEnded && !flushed)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (progressed: boolean): void => {
      clearTimeout(timer);
      socket.off("readable", done);
      socket.off("end", done);
      socket.off("close", done);
      resolve(progressed);
    };
    const done = (): void => finish(true);
    const timer = setTimeout(() => finish(false), milliseconds);
    socket.once("readable", done);
    socket.once("end", done);
    socket.once("close", done);
    void flushed?.then(done, done);
  });
}

export async function writeServiceData(socket: Socket, bytes: Buffer, fin: boolean): Promise<void> {
  if (bytes.length) {
    if (socket.destroyed || socket.writableEnded) throw new Error("Service stream is closed.");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("Service socket write stalled."));
      }, 10_000);
      socket.write(bytes, (error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      });
    });
  }
  if (fin && !socket.writableEnded) socket.end();
}
