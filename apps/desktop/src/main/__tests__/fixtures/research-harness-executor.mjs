// Contrived process oracle. This is not a deployed Open Math Harness runtime.
import { readFileSync } from "node:fs";
import readline from "node:readline";
const records = JSON.parse(readFileSync(process.argv[2], "utf8"));
const callbacks = new Map();
const write = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
const model = (messages) => new Promise((resolve, reject) => {
  callbacks.set("fixture-model-call", { resolve, reject });
  write({ id: "fixture-model-call", method: "model_complete", params: { messages } });
});
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line);
  if (typeof frame.id === "string") {
    const pending = callbacks.get(frame.id); callbacks.delete(frame.id);
    if (frame.error) pending.reject(new Error("Owner refused the model call")); else pending.resolve(frame.result);
    return;
  }
  void Promise.resolve().then(async () => {
    if (frame.method === "hello") return { version: 1, upstreamRevision: "687f2a20dc6ff552d3c881e10910b46c13e84e2a", import: true, execute: true, cancel: true, researchFunctions: true };
    if (frame.method === "execute") {
      const result = await model([{ role: "user", content: "Post one invented queue finding through research_update." }]);
      const fn = result.choices[0].message.tool_calls[0].function;
      if (fn.name !== "research_update") throw new Error("Unexpected function");
      const command = JSON.parse(fn.arguments);
      if (command.action !== "finding") throw new Error("Unexpected command");
      records[3].text = command.text;
      return { admitted: true };
    }
    if (frame.method === "records") {
      const page = records.filter((r) => r.seq > frame.params.after).slice(0, frame.params.limit);
      return { swarm: "fixture-swarm", records: page };
    }
    if (frame.method === "cancel") return { stopped: true, runId: frame.params.runId, swarm: frame.params.swarm };
    throw new Error("Unsupported operation");
  }).then((result) => write({ id: frame.id, result }), () => write({ id: frame.id, error: { code: -32000, message: "Fixture refused request" } }));
});
