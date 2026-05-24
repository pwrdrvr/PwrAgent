export const DISABLE_MESSAGING_ARG = "--disable-messaging";
export const DISABLE_MESSAGING_ENV = "PWRAGENT_DISABLE_MESSAGING";
export const DISABLE_AUTOMATIONS_ARG = "--disable-automations";
export const DISABLE_AUTOMATIONS_ENV = "PWRAGENT_DISABLE_AUTOMATIONS";

export type RuntimeMessagingOverride = {
  disabled: boolean;
  reason?: string;
};

export function resolveRuntimeMessagingOverride(options: {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
} = {}): RuntimeMessagingOverride {
  return resolveRuntimeDisableOverride({
    arg: DISABLE_MESSAGING_ARG,
    envKey: DISABLE_MESSAGING_ENV,
    argv: options.argv,
    env: options.env,
  });
}

export type RuntimeAutomationsOverride = {
  disabled: boolean;
  reason?: string;
};

export function resolveRuntimeAutomationsOverride(options: {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
} = {}): RuntimeAutomationsOverride {
  return resolveRuntimeDisableOverride({
    arg: DISABLE_AUTOMATIONS_ARG,
    envKey: DISABLE_AUTOMATIONS_ENV,
    argv: options.argv,
    env: options.env,
  });
}

function resolveRuntimeDisableOverride(options: {
  arg: string;
  envKey: string;
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
}): { disabled: boolean; reason?: string } {
  const argv = options.argv ?? process.argv;
  const env = options.env ?? process.env;

  if (argv.includes(options.arg)) {
    return {
      disabled: true,
      reason: `${options.arg} was provided at startup`,
    };
  }

  const envValue = env[options.envKey]?.trim().toLowerCase();
  if (envValue && ["1", "true", "yes", "on"].includes(envValue)) {
    return {
      disabled: true,
      reason: `${options.envKey} is enabled`,
    };
  }

  return { disabled: false };
}
