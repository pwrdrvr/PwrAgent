// Original PwrAgent implementation of the public Harness UI JSON-lines contract.
// Observation only. Full runtime execution requires a separately installed, authorized bridge.
import net from "node:net";
import path from "node:path";
import readline from "node:readline";

const socket = process.argv[2];
if (!socket || !path.isAbsolute(socket)) throw new Error("Supply an absolute path to an authorized Harness development UI socket");
const revision = "687f2a20dc6ff552d3c881e10910b46c13e84e2a";
let busy = false;
function observe(params) {
  return new Promise((resolve, reject) => {
    const connection = net.createConnection(socket);
    let buffer = "";
    connection.setEncoding("utf8");
    connection.setTimeout(20_000, () => connection.destroy(new Error("Harness UI request timed out")));
    connection.once("error", reject);
    connection.once("connect", () => connection.write(`${JSON.stringify({ id: 1, op: "swarm.records", project: params.project,
      session: params.session, swarm: params.swarm, after: params.after, limit: Math.min(50, params.limit ?? 50) })}\n`));
    connection.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 512_000) { connection.destroy(new Error("Harness UI answer exceeds its bound")); return; }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const answer = JSON.parse(buffer.slice(0, newline));
        if (answer.id !== 1 || answer.error || !answer.ok) throw new Error("Harness UI observation was refused");
        resolve(answer.ok);
      } catch (error) { reject(error); }
      connection.end();
    });
    connection.once("end", () => { if (!buffer.includes("\n")) reject(new Error("Harness UI closed before answering")); });
  });
}
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (Buffer.byteLength(line) > 16_000) { process.exitCode = 1; input.close(); return; }
  let request;
  try { request = JSON.parse(line); } catch { process.exitCode = 1; input.close(); return; }
  const respond = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, ...value })}\n`);
  if (request.jsonrpc !== "2.0" || typeof request.id !== "number" || busy) { respond({ error: { code: -32600, message: "Invalid or concurrent request" } }); return; }
  busy = true;
  void Promise.resolve().then(async () => {
    if (request.method === "hello") return { version: 1, upstreamRevision: revision, import: true, execute: false, cancel: false };
    if (request.method === "records") return await observe(request.params);
    throw new Error("This bridge supports read-only observation only");
  }).then((result) => respond({ result }), () => respond({ error: { code: -32000, message: "Harness observation failed" } })).finally(() => { busy = false; });
});
