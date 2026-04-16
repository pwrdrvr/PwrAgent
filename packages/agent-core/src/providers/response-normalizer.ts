import { InvalidToolArgumentsError } from "../tools/tool-errors.js";

export type NormalizedFunctionCall = {
  callId: string;
  name: string;
  argumentsText: string;
};

export type NormalizedResponseOutput = {
  assistantText: string;
  providerResponseId?: string;
  functionCalls: NormalizedFunctionCall[];
};

export function normalizeXaiResponse(response: unknown): NormalizedResponseOutput {
  const record = asRecord(response);
  const providerResponseId = readString(record, ["id"]);
  const directOutputText = readString(record, ["output_text"]);
  if (directOutputText) {
    return {
      assistantText: directOutputText,
      providerResponseId,
      functionCalls: collectFunctionCalls(record),
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
    functionCalls: collectFunctionCalls(record),
  };
}

export function parseNormalizedFunctionArguments(
  toolName: string,
  argumentsText: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsText);
  } catch (error) {
    throw new InvalidToolArgumentsError(
      toolName,
      `arguments must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidToolArgumentsError(toolName, "arguments must decode to an object");
  }
  return parsed as Record<string, unknown>;
}

function collectFunctionCalls(
  record: Record<string, unknown>,
): NormalizedFunctionCall[] {
  const output = Array.isArray(record.output) ? record.output : [];
  const functionCalls: NormalizedFunctionCall[] = [];
  for (const item of output) {
    const itemRecord = asRecord(item);
    if (itemRecord.type !== "function_call") {
      continue;
    }
    const callId = readString(itemRecord, ["call_id"]);
    const name = readString(itemRecord, ["name"]);
    const argumentsText = readString(itemRecord, ["arguments"]);
    if (!callId || !name) {
      continue;
    }
    functionCalls.push({
      callId,
      name,
      argumentsText: argumentsText ?? "{}",
    });
  }
  return functionCalls;
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
