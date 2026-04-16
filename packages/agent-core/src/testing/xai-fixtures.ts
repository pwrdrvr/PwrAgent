export function makeXaiResponse(params?: {
  id?: string;
  text?: string;
}): Record<string, unknown> {
  return {
    id: params?.id ?? "resp_123",
    output: [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: params?.text ?? "All green.",
          },
        ],
      },
    ],
  };
}

export function makeXaiFunctionCallResponse(params?: {
  id?: string;
  calls?: Array<{
    callId?: string;
    name?: string;
    argumentsText?: string;
  }>;
}): Record<string, unknown> {
  return {
    id: params?.id ?? "resp_tool_123",
    output: (params?.calls ?? [
      {
        callId: "call_123",
        name: "search_code",
        argumentsText: JSON.stringify({ query: "needle" }),
      },
    ]).map((call, index) => ({
      type: "function_call",
      call_id: call.callId ?? `call_${index + 1}`,
      name: call.name ?? "search_code",
      arguments: call.argumentsText ?? JSON.stringify({ query: "needle" }),
    })),
  };
}

export function makeDirectOutputResponse(params?: {
  id?: string;
  text?: string;
}): Record<string, unknown> {
  return {
    id: params?.id ?? "resp_direct",
    output_text: params?.text ?? "Direct output",
  };
}
