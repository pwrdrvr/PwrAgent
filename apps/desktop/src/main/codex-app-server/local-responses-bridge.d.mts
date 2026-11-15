import type { Server } from "node:http";

export type LocalModelCatalog = {
  models: Array<{ slug: string; input_modalities: string[]; [key: string]: unknown }>;
  [key: string]: unknown;
};
export function discoverModelCatalog(upstream: string, template: LocalModelCatalog, apiKey?: string): Promise<LocalModelCatalog>;
/** How long the bridge waits on a silent upstream socket. */
export const DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS: number;
export type RequestSizeSummary = {
  wireBytes: number;
  jsonBytes: number;
  envelopeBytes: number;
  fieldBytes: Record<string, number>;
  toolCount: number;
  deferredToolCount: number;
  namespaceCount: number;
  inputCount: number;
  roles: Record<string, number>;
  contentTypes: Record<string, number>;
  imageBytes: number;
  largestTools: Array<{ name: string; bytes: number; descriptionBytes: number; schemaBytes: number }>;
  largestNamespaces: Array<{ name: string; bytes: number; descriptionBytes: number }>;
  largestInput: Array<{ index: number; role: string; type: string; bytes: number }>;
};
export type LocalRequestDiagnostic = {
  schemaVersion: number;
  requestId: string;
  threadId?: string;
} & (
  | { kind: "request"; incoming: RequestSizeSummary; outgoing: RequestSizeSummary }
  | { kind: "response"; status: number; promptTokens?: number; contextTokens?: number }
  | { kind: "failure"; aborted: boolean }
);
export function summarizeRequest(request: Record<string, unknown>, wireBytes?: number): RequestSizeSummary;
export function startBridge(upstream: string, apiKey?: string, options?: {
  idleTimeoutMs?: number;
  onDiagnostic?: (event: LocalRequestDiagnostic) => void;
}): Promise<Server>;
export function translateRequest(request: Record<string, unknown>): {
  body: Record<string, unknown>;
  names: Map<string, { name: string; namespace?: string; nativeSearch?: boolean }>;
};
export function translateResponse(value: unknown, names: Map<string, { name: string; namespace?: string; nativeSearch?: boolean }>): unknown;
