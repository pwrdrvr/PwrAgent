export const DISABLE_MESSAGING_ARG = "--disable-messaging";
export const DISABLE_MESSAGING_ENV = "PWRAGNT_DISABLE_MESSAGING";

export type RuntimeMessagingOverride = {
  disabled: boolean;
  reason?: string;
};

export function resolveRuntimeMessagingOverride(options: {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
} = {}): RuntimeMessagingOverride {
  const argv = options.argv ?? process.argv;
  const env = options.env ?? process.env;

  if (argv.includes(DISABLE_MESSAGING_ARG)) {
    return {
      disabled: true,
      reason: `${DISABLE_MESSAGING_ARG} was provided at startup`,
    };
  }

  const envValue = env[DISABLE_MESSAGING_ENV]?.trim().toLowerCase();
  if (envValue && ["1", "true", "yes", "on"].includes(envValue)) {
    return {
      disabled: true,
      reason: `${DISABLE_MESSAGING_ENV} is enabled`,
    };
  }

  return { disabled: false };
}
