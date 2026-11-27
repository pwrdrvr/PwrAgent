const { appendFileSync, readFileSync } = require("node:fs");
const { createInterface } = require("node:readline");

const [catalogPath, listingLog] = process.argv.slice(2);
const tools = JSON.parse(readFileSync(catalogPath, "utf8"));

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;

  const response = { jsonrpc: "2.0", id: request.id };
  if (request.method === "initialize") {
    response.result = {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "model-request-fixture", version: "1" },
    };
  } else if (request.method === "tools/list") {
    appendFileSync(listingLog, `${tools.length}\n`);
    response.result = { tools };
  } else {
    response.error = { code: -32601, message: "Unsupported benchmark fixture method" };
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
});
