import type { Server } from "node:http";

export type LocalModelCatalog = {
  models: Array<{ slug: string; input_modalities: string[]; [key: string]: unknown }>;
  [key: string]: unknown;
};
export function discoverModelCatalog(upstream: string, template: LocalModelCatalog, apiKey?: string): Promise<LocalModelCatalog>;
export function startBridge(upstream: string, apiKey?: string): Promise<Server>;
export function translateRequest(request: Record<string, unknown>): {
  body: Record<string, unknown>;
  names: Map<string, { name: string; namespace?: string }>;
};
export function translateResponse(value: unknown, names: Map<string, { name: string; namespace?: string }>): unknown;
