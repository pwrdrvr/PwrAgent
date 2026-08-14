import { rmSync } from "node:fs";
import {
  E2E_SHUTDOWN_DIAGNOSTICS_FILE_ENV,
} from "../src/main/e2e-shutdown-diagnostics";
import {
  E2E_SHUTDOWN_CIRCUIT_STATE_FILE_ENV,
  resetElectronShutdownCircuit,
} from "./fixtures/electron-shutdown-policy";
import {
  E2E_SHUTDOWN_FIRST_FAILURE_ARTIFACT_DIR_ENV,
} from "./fixtures/electron-shutdown-artifacts";

/** Reset per-shard state once, before Playwright can replace a failed worker. */
export default function globalSetup(): void {
  const diagnosticsFile = process.env[E2E_SHUTDOWN_DIAGNOSTICS_FILE_ENV];
  if (diagnosticsFile) {
    rmSync(diagnosticsFile, { force: true });
  }
  const failureArtifactDir =
    process.env[E2E_SHUTDOWN_FIRST_FAILURE_ARTIFACT_DIR_ENV];
  if (failureArtifactDir) {
    rmSync(failureArtifactDir, { force: true, recursive: true });
  }
  resetElectronShutdownCircuit(
    process.env[E2E_SHUTDOWN_CIRCUIT_STATE_FILE_ENV],
  );
}
