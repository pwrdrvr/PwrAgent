/** Codex's complete voice handoff envelope; partial or unfamiliar text stays visible. */
export function parseVoiceRequest(text: string): { request: string; context?: string } | undefined {
  const match = /^\s*<realtime_delegation>\s*<input>([\s\S]*?)<\/input>\s*(?:<transcript_delta>([\s\S]*?)<\/transcript_delta>\s*)?<\/realtime_delegation>\s*$/.exec(text);
  const request = match?.[1]?.trim();
  if (!request) return undefined;
  const context = match?.[2]?.trim();
  return { request, ...(context ? { context } : {}) };
}
