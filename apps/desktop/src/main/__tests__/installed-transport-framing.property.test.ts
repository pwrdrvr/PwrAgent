import fc from "fast-check";
import { expect, it } from "vitest";
import { JsonRpcConnection, StdioJsonRpcTransport } from "@pwrdrvr/agent-transport";

// Exercise the actual dependency that is bundled, without mocking its spawn.
// The child waits for our ASCII request, then writes synthetic wire bytes.
const fixture = `
const { writeSync } = require('node:fs');
process.stdin.once('data', () => {
  const { wire, sizes } = JSON.parse(Buffer.from(process.argv[1], 'base64').toString());
  const bytes = Buffer.from(wire);
  for (let offset = 0, i = 0; offset < bytes.length; i++) {
    const end = Math.min(bytes.length, offset + sizes[i % sizes.length]);
    writeSync(1, bytes.subarray(offset, end));
    offset = end;
  }
});
`;

it("the installed transport resolves arbitrary JSON strings across real stdio byte chunks", async () => {
  const text = fc.array(fc.integer({ min: 0, max: 0xffff }), { maxLength: 100 })
    .map((units) => String.fromCharCode(...units));
  await fc.assert(fc.asyncProperty(
    text,
    fc.array(fc.integer({ min: 1, max: 41 }), { minLength: 1, maxLength: 8 }),
    async (value, sizes) => {
      const result = { value, sentinel: "\u2028\u2029é🛰️\r\n\u0000" };
      const wire = JSON.stringify({ jsonrpc: "2.0", id: "rpc-1", result }) + "\r\n";
      const argument = Buffer.from(JSON.stringify({ wire, sizes })).toString("base64");
      const connection = new JsonRpcConnection(new StdioJsonRpcTransport({
        command: process.execPath, args: ["-e", fixture, argument],
      }), 1000);
      try {
        await connection.connect();
        expect(await connection.request("fixture")).toEqual(result);
      } finally {
        await connection.close();
      }
    },
  ), { numRuns: 10 });
});
