const LIVE_TEST_LIFECYCLE_EVENT = "test:live";
const LIVE_TEST_LIFECYCLE_SKIP_REASON =
  "Grok live tests run only through the explicit agent-core test:live script";

type LiveAgentCoreRuntimeConfig = {
  apiKey?: string;
  configPath: string;
};

function resolveLiveAgentCoreLifecycleSkipReason(
  lifecycleEvent?: string,
): string | undefined {
  if (lifecycleEvent !== LIVE_TEST_LIFECYCLE_EVENT) {
    return LIVE_TEST_LIFECYCLE_SKIP_REASON;
  }
  return undefined;
}

export function resolveLiveAgentCoreSkipReason(params: {
  apiKey?: string;
  configPath: string;
  lifecycleEvent?: string;
}): string | undefined {
  const lifecycleSkipReason = resolveLiveAgentCoreLifecycleSkipReason(
    params.lifecycleEvent,
  );
  if (lifecycleSkipReason) return lifecycleSkipReason;

  if (!params.apiKey?.trim()) {
    return `XAI_API_KEY is not set in the environment or runtime config at ${params.configPath}`;
  }
  return undefined;
}

export function resolveLiveAgentCoreTestConfig<
  RuntimeConfig extends LiveAgentCoreRuntimeConfig,
>(params: {
  lifecycleEvent?: string;
  resolveRuntimeConfig: () => RuntimeConfig;
}): {
  runtimeConfig?: RuntimeConfig;
  skipReason?: string;
} {
  const lifecycleSkipReason = resolveLiveAgentCoreLifecycleSkipReason(
    params.lifecycleEvent,
  );
  if (lifecycleSkipReason) {
    return { skipReason: lifecycleSkipReason };
  }

  const runtimeConfig = params.resolveRuntimeConfig();
  return {
    runtimeConfig,
    skipReason: resolveLiveAgentCoreSkipReason({
      apiKey: runtimeConfig.apiKey,
      configPath: runtimeConfig.configPath,
      lifecycleEvent: params.lifecycleEvent,
    }),
  };
}
