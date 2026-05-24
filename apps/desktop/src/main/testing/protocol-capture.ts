import path from "node:path";
import type { JsonRpcObserver } from "../codex-app-server/json-rpc";
import { getMainLogger } from "../log";
import { resolveActiveProfilePath } from "../profile";
import { ProtocolCaptureStore } from "./capture-store";

const CAPTURE_ENABLED_ENV = "PWRAGENT_PROTOCOL_CAPTURE";
const CAPTURE_ROOT_ENV = "PWRAGENT_PROTOCOL_CAPTURE_ROOT";
const PROTOCOL_LOG_ENV = "PWRAGENT_APP_SERVER_PROTOCOL_LOG";
const protocolCaptureLog = getMainLogger("pwragent:protocol-capture");

export function createProtocolCaptureObserver(params: {
  backend: string;
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
  backend: string;
  backendInstance: string;
}): {
  store: ProtocolCaptureStore;
  observer: JsonRpcObserver;
} | undefined {
  const enabledBy = captureEnabledBy();
  if (!enabledBy) {
    return undefined;
  }

  const rootDir =
    process.env[CAPTURE_ROOT_ENV]?.trim() ||
    resolveActiveProfilePath("state/protocol-captures");
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
    enabledBy,
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

function buildCaptureId(backend: string, backendInstance: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${timestamp}-${backend}-${sanitizeCapturePart(backendInstance)}`;
}

function sanitizeCapturePart(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return normalized || "default";
}

function captureEnabledBy(): string | undefined {
  if (isCaptureEnabled(process.env[CAPTURE_ENABLED_ENV])) {
    return CAPTURE_ENABLED_ENV;
  }
  if (isCaptureEnabled(process.env[PROTOCOL_LOG_ENV])) {
    return PROTOCOL_LOG_ENV;
  }
  return undefined;
}

function isCaptureEnabled(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}
