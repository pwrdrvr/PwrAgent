import type { Server } from "node:http";

export type PortableDiagnostic = {
  stage: string;
  phase?: string;
  canceled?: boolean;
  status?: number;
  inputBytes?: number;
  outputBytes?: number;
  toolBytes?: number;
  toolCount?: number;
};
export function startPortableCodeModeTransport(options: {
  send: (body: Record<string, unknown>, signal: AbortSignal) => Promise<Response>;
  onDiagnostic?: (event: PortableDiagnostic) => void;
  clientApiKey?: string;
  requireNestedDiscovery?: boolean;
}): Promise<Server>;
export function translateCodeModeRequest(request: Record<string, unknown>): {
  body: Record<string, unknown>;
  translateResponse: (value: unknown) => unknown;
  translateEvent: (value: Record<string, unknown>) => Record<string, unknown> | null;
};
export function portableThreadRequest(message: string): string;
