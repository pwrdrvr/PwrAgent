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

export function makeDirectOutputResponse(params?: {
  id?: string;
  text?: string;
}): Record<string, unknown> {
  return {
    id: params?.id ?? "resp_direct",
    output_text: params?.text ?? "Direct output",
  };
}
