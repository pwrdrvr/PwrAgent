import path from "node:path";
import type { JsonRpcObserver } from "../codex-app-server/json-rpc";
import { ProtocolCaptureStore } from "./capture-store";

const CAPTURE_ENABLED_ENV = "PWRAGNT_PROTOCOL_CAPTURE";
const CAPTURE_ROOT_ENV = "PWRAGNT_PROTOCOL_CAPTURE_ROOT";

export function createProtocolCaptureObserver(params: {
  backend: "codex" | "grok";
  store: ProtocolCaptureStore;
}): JsonRpcObserver {
  return {
    onMessage: async (event) => {
      await params.store.append({
        direction: event.direction,
        raw: event.raw,
        envelope: event.envelope
      });
    }
  };
}

export function createProtocolCaptureFromEnv(params: {
  backend: "codex" | "grok";
  userDataPath: string;
}): {
  store: ProtocolCaptureStore;
  observer: JsonRpcObserver;
} | undefined {
  if (!isCaptureEnabled(process.env[CAPTURE_ENABLED_ENV])) {
    return undefined;
  }

  const rootDir =
    process.env[CAPTURE_ROOT_ENV]?.trim() ||
    path.join(params.userDataPath, "test-artifacts", "protocol-captures");
  const captureId = buildCaptureId(params.backend);
  const store = new ProtocolCaptureStore({
    backend: params.backend,
    captureId,
    rootDir
  });

  return {
    store,
    observer: createProtocolCaptureObserver({
      backend: params.backend,
      store
    })
  };
}

function buildCaptureId(backend: "codex" | "grok"): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${timestamp}-${backend}`;
}

function isCaptureEnabled(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}
