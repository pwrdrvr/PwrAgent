// Both transports use bounded newline-delimited JSON. No shell is involved.
export function readMessages(stream, limit, onMessage, onError) {
  let pending = Buffer.alloc(0);
  let failed = false;
  stream.on("data", (chunk) => {
    if (failed) return;
    try {
      pending = Buffer.concat([pending, chunk]);
      let newline;
      while ((newline = pending.indexOf(10)) !== -1) {
        if (newline > limit) throw new Error("Protocol message exceeds size limit");
        const line = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        if (!line.length) continue;
        const message = JSON.parse(line.toString("utf8"));
        if (!message || typeof message !== "object" || Array.isArray(message)) {
          throw new Error("Expected a protocol object");
        }
        onMessage(message);
      }
      if (pending.length > limit) throw new Error("Protocol message exceeds size limit");
    } catch (error) {
      failed = true;
      onError(error);
    }
  });
  stream.on("end", () => {
    if (!failed && pending.length) onError(new Error("Truncated protocol message"));
  });
}

export const MAX_REQUEST_BYTES = 512 * 1024;
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
