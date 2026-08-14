import { rmSync } from "node:fs";
import {
  E2E_SHUTDOWN_DIAGNOSTICS_FILE_ENV,
} from "../src/main/e2e-shutdown-diagnostics";
import {
  E2E_SHUTDOWN_CIRCUIT_STATE_FILE_ENV,
  resetElectronShutdownCircuit,
} from "./fixtures/electron-shutdown-policy";

/** Reset per-shard state once, before Playwright can replace a failed worker. */
export default function globalSetup(): void {
  const diagnosticsFile = process.env[E2E_SHUTDOWN_DIAGNOSTICS_FILE_ENV];
  if (diagnosticsFile) {
    rmSync(diagnosticsFile, { force: true });
  }
  resetElectronShutdownCircuit(
    process.env[E2E_SHUTDOWN_CIRCUIT_STATE_FILE_ENV],
  );
}
