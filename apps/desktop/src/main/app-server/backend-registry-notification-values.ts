



export function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function readOptionalString(value: unknown): string | undefined;
export function readOptionalString(
  record: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined;
export function readOptionalString(
  value: unknown,
  keys?: string[],
): string | undefined {
  if (keys) {
    return (
      readStringLike(
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : undefined,
        keys,
      ) ?? undefined
    );
  }
  return typeof value === "string" ? value : undefined;
}

export function readNonEmptyRawString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function readStringLike(
  record: Record<string, unknown> | undefined,
  keys: string[],
): string | null | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    if (!(key in record)) {
      continue;
    }
    const value = record[key];
    if (value === null) {
      return null;
    }
    if (typeof value === "string") {
      return value.trim() || null;
    }
  }
  return undefined;
}

export function readBooleanLike(
  record: Record<string, unknown> | undefined,
  keys: string[],
): boolean | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

export function firstDefinedStringLike(
  ...values: Array<string | null | undefined>
): string | null | undefined {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}
