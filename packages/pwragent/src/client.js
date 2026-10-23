import net from "node:net";
import path from "node:path";
import { readMessages, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES } from "./wire.js";

export function call(directory, method, params = {}) {
  const data = JSON.stringify({ version: 1, method, params }) + "\n";
  if (Buffer.byteLength(data) > MAX_REQUEST_BYTES) return Promise.reject(new Error("Request exceeds 512 KiB"));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path.join(directory, "rpc.sock"));
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    socket.setTimeout(45000, () => finish(new Error("Daemon request timed out; use the same job ID to check acceptance")));
    socket.on("error", (error) => finish(new Error(`Cannot contact headless daemon (${error.code || error.message})`)));
    socket.on("close", () => finish(new Error("Daemon disconnected; use the same job ID to check acceptance")));
    socket.on("connect", () => socket.write(data));
    readMessages(socket, MAX_RESPONSE_BYTES, (message) => {
      if (typeof message.error === "string") finish(new Error(message.error));
      else if ("result" in message) finish(null, message.result);
      else finish(new Error("Invalid daemon response"));
    }, (error) => finish(error));
  });
}
