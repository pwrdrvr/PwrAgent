#!/usr/bin/env node

import { main } from "../src/cli.js";

// Socket ownership and private state creation must precede all runtime work.
process.umask(0o077);
try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
