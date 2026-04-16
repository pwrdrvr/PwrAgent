export type NormalizedResponseOutput = {
  assistantText: string;
  providerResponseId?: string;
};

export function normalizeXaiResponse(response: unknown): NormalizedResponseOutput {
  const record = asRecord(response);
  const providerResponseId = readString(record, ["id"]);
  const directOutputText = readString(record, ["output_text"]);
  if (directOutputText) {
    return {
      assistantText: directOutputText,
      providerResponseId,
    };
  }

  const output = Array.isArray(record.output) ? record.output : [];
  const chunks: string[] = [];
  for (const item of output) {
    const itemRecord = asRecord(item);
    const content = Array.isArray(itemRecord.content) ? itemRecord.content : [];
    for (const contentItem of content) {
      const contentRecord = asRecord(contentItem);
      const text = readString(contentRecord, ["text"]);
      if (text) {
        chunks.push(text);
      }
    }
  }

  return {
    assistantText: chunks.join("\n").trim(),
    providerResponseId,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}
