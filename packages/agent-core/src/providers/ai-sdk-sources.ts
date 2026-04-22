import type { ProviderSource } from "./provider-contract.js";

export function normalizeAiSdkSources(value: unknown): ProviderSource[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((source) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      return [];
    }
    const record = source as Record<string, unknown>;
    const url = readString(record.url);
    const title = readString(record.title);
    const id = readString(record.id);
    const sourceType = readString(record.sourceType ?? record.type);
    if (!url && !title && !id) {
      return [];
    }
    return [
      stripUndefined({
        id,
        sourceType,
        url,
        title,
        providerMetadata: readRecord(record.providerMetadata),
      }),
    ];
  });
}

export function normalizeProviderMetadata(value: unknown): Record<string, unknown> | undefined {
  return readRecord(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}
