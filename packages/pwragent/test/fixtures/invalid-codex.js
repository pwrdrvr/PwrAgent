#!/usr/bin/env node
// A response ID without a result or error must fail all pending requests.
process.stdin.once("data", () => process.stdout.write('{"id":1}\n'));
process.stdin.resume();
