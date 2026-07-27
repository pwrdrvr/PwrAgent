import { createProcessAppServer } from "./process-app-server.js";
import {
  runStdioJsonRpcServer,
  writeDiagnostic,
} from "./stdio-json-rpc-server.js";

redirectConsoleToStderr();

try {
  runStdioJsonRpcServer({
    server: createProcessAppServer(),
  });
} catch (error) {
  writeDiagnostic(process.stderr, "startup failed", error);
  process.exitCode = 1;
}

process.on("uncaughtException", (error) => {
  writeDiagnostic(process.stderr, "uncaught exception", error);
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  writeDiagnostic(process.stderr, "unhandled rejection", error);
  process.exit(1);
});

function redirectConsoleToStderr(): void {
  const write = (...values: unknown[]): void => {
    process.stderr.write(`${values.map(formatDiagnosticValue).join(" ")}\n`);
  };
  console.log = write;
  console.info = write;
  console.debug = write;
  console.warn = write;
  console.error = write;
}

function formatDiagnosticValue(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
