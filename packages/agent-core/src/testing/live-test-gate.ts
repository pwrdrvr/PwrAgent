export function resolveLiveAgentCoreSkipReason(params: {
  apiKey?: string;
  configPath: string;
  lifecycleEvent?: string;
}): string | undefined {
  if (params.lifecycleEvent !== "test:live") {
    return "Grok live tests run only through the explicit agent-core test:live script";
  }
  if (!params.apiKey?.trim()) {
    return `XAI_API_KEY is not set in the environment or runtime config at ${params.configPath}`;
  }
  return undefined;
}
