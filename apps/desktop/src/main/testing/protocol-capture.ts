import path from "node:path";
import type { JsonRpcObserver } from "../codex-app-server/json-rpc";
import { getMainLogger } from "../log";
import { ProtocolCaptureStore } from "./capture-store";

const CAPTURE_ENABLED_ENV = "PWRAGNT_PROTOCOL_CAPTURE";
const CAPTURE_ROOT_ENV = "PWRAGNT_PROTOCOL_CAPTURE_ROOT";
const protocolCaptureLog = getMainLogger("pwragnt:protocol-capture");

export function createProtocolCaptureObserver(params: {
  backend: "codex" | "grok";
  store: ProtocolCaptureStore;
}): JsonRpcObserver {
  return {
    onMessage: async (event) => {
      await params.store.append({
        direction: event.direction,
        diagnostics: event.diagnostics,
        raw: event.raw,
        envelope: event.envelope
      });
    }
  };
}

export function createProtocolCaptureFromEnv(params: {
  backend: "codex" | "grok";
  backendInstance: string;
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
  const captureId = buildCaptureId(params.backend, params.backendInstance);
  const store = new ProtocolCaptureStore({
    backend: params.backend,
    backendInstance: params.backendInstance,
    captureId,
    rootDir
  });
  protocolCaptureLog.info("capture enabled", {
    backend: params.backend,
    backendInstance: params.backendInstance,
    captureId,
    path: store.captureFilePath,
    indexPath: store.indexFilePath,
  });

  return {
    store,
    observer: createProtocolCaptureObserver({
      backend: params.backend,
      store
    })
  };
}

function buildCaptureId(backend: "codex" | "grok", backendInstance: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${timestamp}-${backend}-${sanitizeCapturePart(backendInstance)}`;
}

function sanitizeCapturePart(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return normalized || "default";
}

function isCaptureEnabled(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}
