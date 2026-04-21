import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export const DEFAULT_PROCESS_OUTPUT_LIMIT_BYTES = 1024 * 1024;

export type ProcessOutputStream = "stdout" | "stderr";

export type ProcessOutputDelta = {
  stream: ProcessOutputStream;
  text: string;
  bytes: number;
};

export type ProcessRunStatus =
  | "completed"
  | "failed_to_start"
  | "timed_out"
  | "cancelled"
  | "stopped";

export type ProcessRunOptions = {
  command: string;
  args?: string[];
  cwd?: string;
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  killGraceMs?: number;
  signal?: AbortSignal;
  outputLimitBytes?: number;
  onOutputDelta?: (delta: ProcessOutputDelta) => void;
  onStdoutChunk?: (chunk: Buffer, control: ProcessRunControl) => void;
  onStderrChunk?: (chunk: Buffer, control: ProcessRunControl) => void;
};

export type ProcessRunControl = {
  stop: () => void;
};

export type ProcessRunResult = {
  status: ProcessRunStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  stopped: boolean;
  stdout: string;
  stderr: string;
  output: string;
  stdoutBytes: number;
  stderrBytes: number;
  outputLimitBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  error?: Error;
};

const DEFAULT_KILL_GRACE_MS = 1_000;

export async function runProcess(options: ProcessRunOptions): Promise<ProcessRunResult> {
  const outputLimitBytes =
    options.outputLimitBytes ?? DEFAULT_PROCESS_OUTPUT_LIMIT_BYTES;
  const stdout = new CappedOutputBuffer(outputLimitBytes);
  const stderr = new CappedOutputBuffer(outputLimitBytes);
  let child: ChildProcessWithoutNullStreams | undefined;
  let timedOut = false;
  let cancelled = false;
  let stopped = false;
  let settled = false;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

  const control: ProcessRunControl = {
    stop: () => {
      stopped = true;
      terminateChild("SIGTERM");
    },
  };

  const cleanup = () => {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = undefined;
    }
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = undefined;
    }
    options.signal?.removeEventListener("abort", onAbort);
  };

  const terminateChild = (signal: NodeJS.Signals) => {
    if (settled) {
      return;
    }
    if (!child) {
      return;
    }
    try {
      child.kill(signal);
    } catch {
      return;
    }
    if (signal === "SIGTERM" && !forceKillTimer) {
      forceKillTimer = setTimeout(() => {
        terminateChild("SIGKILL");
      }, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    }
  };

  const onAbort = () => {
    cancelled = true;
    terminateChild("SIGTERM");
  };

  try {
    child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      shell: options.shell ?? false,
      env: { ...process.env, ...(options.env ?? {}), FORCE_COLOR: "0" },
    });
  } catch (error) {
    return buildResult({
      status: "failed_to_start",
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelled: false,
      stopped: false,
      stdout,
      stderr,
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }

  const runningChild = child;

  return await new Promise<ProcessRunResult>((resolve) => {
    runningChild.stdout.on("data", (chunk: Buffer) => {
      stdout.append(chunk);
      emitDelta("stdout", chunk);
      options.onStdoutChunk?.(chunk, control);
    });
    runningChild.stderr.on("data", (chunk: Buffer) => {
      stderr.append(chunk);
      emitDelta("stderr", chunk);
      options.onStderrChunk?.(chunk, control);
    });
    runningChild.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(
        buildResult({
          status: "failed_to_start",
          exitCode: null,
          signal: null,
          timedOut,
          cancelled,
          stopped,
          stdout,
          stderr,
          error,
        }),
      );
    });
    runningChild.on("close", (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(
        buildResult({
          status: cancelled
            ? "cancelled"
            : timedOut
              ? "timed_out"
              : stopped
                ? "stopped"
                : "completed",
          exitCode,
          signal,
          timedOut,
          cancelled,
          stopped,
          stdout,
          stderr,
        }),
      );
    });

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminateChild("SIGTERM");
      }, options.timeoutMs);
    }

    if (options.signal?.aborted) {
      onAbort();
    } else {
      options.signal?.addEventListener("abort", onAbort, { once: true });
    }

    function emitDelta(stream: ProcessOutputStream, chunk: Buffer) {
      options.onOutputDelta?.({
        stream,
        text: chunk.toString("utf8"),
        bytes: chunk.length,
      });
    }
  });
}

function buildResult(params: {
  status: ProcessRunStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  stopped: boolean;
  stdout: CappedOutputBuffer;
  stderr: CappedOutputBuffer;
  error?: Error;
}): ProcessRunResult {
  const stdout = params.stdout.toString();
  const stderr = params.stderr.toString();
  return {
    status: params.status,
    exitCode: params.exitCode,
    signal: params.signal,
    timedOut: params.timedOut,
    cancelled: params.cancelled,
    stopped: params.stopped,
    stdout,
    stderr,
    output: formatCombinedOutput(stdout, stderr),
    stdoutBytes: params.stdout.totalBytes,
    stderrBytes: params.stderr.totalBytes,
    outputLimitBytes: params.stdout.limitBytes,
    stdoutTruncated: params.stdout.truncated,
    stderrTruncated: params.stderr.truncated,
    ...(params.error ? { error: params.error } : {}),
  };
}

function formatCombinedOutput(stdout: string, stderr: string): string {
  const trimmedStdout = stdout.trim();
  const trimmedStderr = stderr.trim();
  return [trimmedStdout, trimmedStderr ? `STDERR: ${trimmedStderr}` : ""]
    .filter(Boolean)
    .join("\n");
}

class CappedOutputBuffer {
  readonly limitBytes: number;
  totalBytes = 0;
  truncated = false;
  private chunks: Buffer[] = [];
  private head: Buffer | undefined;
  private tail: Buffer | undefined;

  constructor(limitBytes: number) {
    this.limitBytes = Math.max(0, limitBytes);
  }

  append(chunk: Buffer): void {
    if (chunk.length === 0 || this.limitBytes === 0) {
      this.totalBytes += chunk.length;
      this.truncated ||= chunk.length > 0;
      return;
    }
    this.totalBytes += chunk.length;
    if (!this.truncated) {
      const current = Buffer.concat([...this.chunks, chunk]);
      if (current.length <= this.limitBytes) {
        this.chunks = [current];
        return;
      }
      this.truncated = true;
      this.setHeadTail(current);
      this.chunks = [];
      return;
    }
    const tailSource = Buffer.concat([this.tail ?? Buffer.alloc(0), chunk]);
    this.tail = tailSource.subarray(
      Math.max(0, tailSource.length - this.tailLimit),
    );
  }

  toString(): string {
    if (!this.truncated) {
      return Buffer.concat(this.chunks).toString("utf8");
    }
    return [
      (this.head ?? Buffer.alloc(0)).toString("utf8"),
      `\n... output truncated to ${this.limitBytes} retained bytes ...\n`,
      (this.tail ?? Buffer.alloc(0)).toString("utf8"),
    ].join("");
  }

  private setHeadTail(buffer: Buffer): void {
    this.head = buffer.subarray(0, this.headLimit);
    this.tail = buffer.subarray(Math.max(0, buffer.length - this.tailLimit));
  }

  private get headLimit(): number {
    return Math.ceil(this.limitBytes / 2);
  }

  private get tailLimit(): number {
    return Math.floor(this.limitBytes / 2);
  }
}
