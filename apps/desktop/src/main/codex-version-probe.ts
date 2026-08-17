import { execFile } from "node:child_process";
import { createCommandInvocation } from "@pwrdrvr/agent-transport";

/**
 * Anchored to Codex's own `--version` banner (`codex-cli 0.146.0`).
 *
 * A bare `\d+\.\d+\.\d+` matches anything in the combined output — a node
 * deprecation notice, an npm warning, even a version-shaped directory in an
 * error message. That was survivable while a junk version only mislabeled a
 * row, but selection now ranks automatic candidates by version descending, so
 * an unanchored match can outrank a genuine install and become the launched
 * command.
 */
export const CODEX_VERSION_PATTERN =
  /\bcodex(?:-cli)?[\s/v]+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/i;

/**
 * How long a Codex CLI gets to answer `--version` on a desktop-owned probe.
 *
 * `@pwrdrvr/codex-discovery` probes with a hard 2s timeout on every platform.
 * That is generous for a native binary (`codex.exe` answers in ~0.3s) and
 * marginal for a shim: on the Windows lab guest `codex.cmd` answers in ~1.5s
 * even warm, because the invocation is a `cmd.exe -> node -> shim` chain. A
 * loaded machine blows straight through 2s.
 *
 * That matters more than a slow boot, because a timed-out probe is not
 * reported as "slow" — it is indistinguishable from "no Codex here". The
 * candidate comes back without a version, `normalizeCodexDiscoverySnapshot`
 * demotes it (a version is required for protocol-compatibility gating), no
 * candidate is selected, and `resolve()` throws `CodexCliNotInstalledError`.
 * Nothing retries, so one slow moment strands the app with Codex reported
 * missing until the operator forces a refresh from Settings.
 *
 * 10s matches the budget the Windows sibling probe already used.
 */
export const CODEX_VERSION_PROBE_TIMEOUT_MS = 10_000;

export type CodexCommandRunner = (
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    timeout: number;
    windowsHide: boolean;
    windowsVerbatimArguments?: boolean;
  },
) => Promise<{ stderr?: string | Buffer; stdout?: string | Buffer }>;

export type CodexVersionProbeResult = {
  failureReason?: string;
  version?: string;
};

export async function runCodexOneShot(
  command: string,
  args: string[],
  options: Parameters<CodexCommandRunner>[2],
): Promise<{ stderr?: string | Buffer; stdout?: string | Buffer }> {
  return await new Promise((resolve, reject) => {
    const child = execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stderr, stdout });
    });
    // A `--version` probe reads to EOF and never writes, so close stdin.
    if (child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.end();
    }
  });
}

/**
 * Run one `--version` probe and report the version or why it could not be
 * read. Callers own the interpretation: this does not decide whether a
 * version is new enough, only whether the command answered.
 */
export async function probeCodexVersion(params: {
  command: string;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  runner?: CodexCommandRunner;
  timeoutMs?: number;
}): Promise<CodexVersionProbeResult> {
  const runner = params.runner ?? runCodexOneShot;
  try {
    const invocation = createCommandInvocation({
      command: params.command,
      args: ["--version"],
      env: params.env,
      ...(params.platform ? { platform: params.platform } : {}),
    });
    const result = await runner(invocation.command, invocation.args, {
      env: params.env,
      timeout: params.timeoutMs ?? CODEX_VERSION_PROBE_TIMEOUT_MS,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    const output = `${result.stdout?.toString() ?? ""}\n${
      result.stderr?.toString() ?? ""
    }`;
    const version = output.match(CODEX_VERSION_PATTERN)?.[1];
    return version ? { version } : { failureReason: "version_not_reported" };
  } catch (error) {
    return { failureReason: classifyProbeFailure(error) };
  }
}

/**
 * `execFile`'s error shape is not what the obvious `code === "ENOENT"` test
 * expects here. A `.cmd` probe runs through the cmd.exe wrapper, and cmd.exe
 * always exists, so `code` arrives as a numeric exit status (49, say) and a
 * timeout arrives as `code: null` with `killed: true` and `signal: "SIGTERM"`.
 * Classifying on the errno string alone left `not_found` unreachable and made
 * every timeout render as a generic launch failure.
 */
export function classifyProbeFailure(error: unknown): string {
  const failure = error as NodeJS.ErrnoException & {
    killed?: boolean;
    signal?: string;
  };
  if (failure?.killed || failure?.signal === "SIGTERM") {
    return "version_probe_timed_out";
  }
  const code = failure?.code;
  if (code === "ENOENT" || code === "ENOTDIR") {
    return "not_found";
  }
  return error instanceof Error ? error.message : String(error);
}
