import { spawn, type SpawnOptions } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { createCommandInvocation } from "@pwrdrvr/agent-transport";
import { buildPwrAgentChildProcessEnv } from "../child-process-env.js";
import { isSafeExternalOpenUrl } from "../external-url-policy.js";
import { terminateOwnedProcessTree } from "../process-tree.js";
import type { AcpLaunchDescriptor } from "./acp-launch-descriptor.js";
import { AcpStdioJsonRpcTransport, type AcpStdioSpawn } from "./acp-stdio-transport.js";
import { holdAntigravityExecutable, MANAGED_ANTIGRAVITY_ENV } from "./antigravity-runtime-retention.js";

export const ANTIGRAVITY_SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const PROCESS_STOP_OPTIONS = { gracefulTimeoutMs: 1_000, forceTimeoutMs: 2_000 };
const MAX_AUTH_URL_LENGTH = 16_384;
const MAX_STARTUP_OUTPUT_BYTES = 128 * 1024;
const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/auth";
const ANTIGRAVITY_CALLBACK = "https://antigravity.google/oauth-callback";
const ALTERNATE_CREDENTIAL_ENV = new Set([
  "AGY_ADC_AUTH",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_GENAI_USE_VERTEXAI",
]);

export type AntigravitySignInAttempt = {
  /** Resolves when the validated Google sign-in page has been opened. */
  ready: Promise<void>;
  /** The executable that opened a fresh ACP session after sign-in. */
  completed: Promise<string>;
  submitCode(code: string): void;
  openPage(): Promise<void>;
  copyLink(writeText: (url: string) => void): void;
  cancel(): Promise<void>;
};

export type AntigravitySignInOptions = {
  openExternal: (url: string) => Promise<void>;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ReturnType<AcpStdioSpawn>;
  scheduleTimeout?: (expire: () => void, delayMs: number) => () => void;
};

type LoginInput = { writeCode?: (code: string) => void; url?: string };

/** Keep one controller per desktop owner and the attempt handle with its initiating client. */
export class AntigravitySignIn {
  private active = false;

  constructor(private readonly options: AntigravitySignInOptions) {}

  /** Supply the active launch descriptor from PwrAgent's Antigravity discovery. */
  start(launch: AcpLaunchDescriptor): AntigravitySignInAttempt {
    if (this.active) {
      throw new Error("Antigravity sign-in is already in progress.");
    }
    if (launch.backendId !== "acp:antigravity" || launch.registryId !== "antigravity"
      || !path.isAbsolute(launch.command) || launch.args[0] !== "acp") {
      throw new Error("Select an Antigravity installation before signing in.");
    }
    const selected = { ...launch, args: [...launch.args], env: { ...launch.env } };
    const controller = new AbortController();
    const ready = Promise.withResolvers<void>();
    const input: LoginInput = {};
    const stopTimeout = (this.options.scheduleTimeout ?? scheduleTimeout)(() => {
      controller.abort(new Error("Antigravity sign-in timed out."));
    }, ANTIGRAVITY_SIGN_IN_TIMEOUT_MS);
    this.active = true;
    const completed = this.run(selected, controller.signal, input, ready.resolve)
      .catch((error: unknown) => {
        ready.reject(error);
        throw error;
      })
      .finally(() => {
        stopTimeout();
        this.active = false;
      });
    // A client can disconnect or cancel before it begins awaiting either promise.
    void ready.promise.catch(() => undefined);
    void completed.catch(() => undefined);
    return {
      ready: ready.promise,
      completed,
      submitCode: (code) => {
        if (!input.writeCode || controller.signal.aborted) {
          throw new Error("Antigravity sign-in is not waiting for a code.");
        }
        if (typeof code !== "string" || code.length === 0 || code.length > 2048
          || /[^\w./~-]/u.test(code)) {
          throw new Error("Enter the code shown on the Antigravity sign-in page.");
        }
        const writeCode = input.writeCode;
        input.writeCode = undefined;
        input.url = undefined;
        writeCode(code);
      },
      openPage: async () => {
        if (!input.url || controller.signal.aborted) {
          throw new Error("Start Antigravity sign-in again for a new link.");
        }
        await this.options.openExternal(input.url).catch(() => {
          throw new Error("Could not open the Google sign-in page.");
        });
      },
      copyLink: (writeText) => {
        if (!input.url || controller.signal.aborted) {
          throw new Error("Start Antigravity sign-in again for a new link.");
        }
        writeText(input.url);
      },
      cancel: async () => {
        controller.abort(new Error("Antigravity sign-in was cancelled."));
        await completed.catch(() => undefined);
      },
    };
  }

  private async run(
    launch: AcpLaunchDescriptor,
    signal: AbortSignal,
    input: LoginInput,
    onReady: () => void,
  ): Promise<string> {
    const cwd = await mkdtemp(path.join(tmpdir(), "pwragent-agy-sign-in-")).catch(() => {
      throw new Error("Could not create an Antigravity sign-in workspace.");
    });
    try {
      signal.throwIfAborted();
      const hold = await holdAntigravityExecutable(
        launch.command, { cwd, env: { ...process.env, ...launch.env } }, launch.managedAntigravityFallback,
      );
      try {
        const exact = {
          ...launch,
          cwd,
          command: hold.command,
          env: hold.managed ? { ...launch.env, ...MANAGED_ANTIGRAVITY_ENV } : launch.env,
          managedAntigravityFallback: false,
        };
        await this.runLogin(exact, signal, input, onReady);
        signal.throwIfAborted();
        await this.probe(exact, signal);
        signal.throwIfAborted();
        return hold.command;
      } finally {
        hold.release();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true }).catch(() => {
        throw new Error("Could not clean up the Antigravity sign-in workspace.");
      });
    }
  }

  private async runLogin(
    launch: AcpLaunchDescriptor & { cwd: string },
    signal: AbortSignal,
    input: LoginInput,
    onReady: () => void,
  ): Promise<void> {
    const browserBin = process.platform === "darwin" ? await createMacBrowserShim(launch.cwd) : undefined;
    signal.throwIfAborted();
    const child = this.spawnLogin(launch, browserBin);
    const done = Promise.withResolvers<void>();
    const fail = (message: string) => done.reject(new Error(message));
    const abort = () => done.reject(signal.reason);
    let submitted = false;
    let exited = false;
    let stopReading: (() => void) | undefined;
    child.on("error", () => fail("Could not run Antigravity sign-in."));
    child.on("close", () => {
      exited = true;
      input.writeCode = undefined;
      if (child.exitCode === 0 && submitted) {
        done.resolve();
      } else {
        fail("Antigravity could not finish Google sign-in.");
      }
    });
    signal.addEventListener("abort", abort, { once: true });
    try {
      const { stdin, stdout } = child;
      if (!stdin || !stdout) {
        throw new Error("Antigravity sign-in pipes are unavailable.");
      }
      stdout.on("error", () => fail("Could not read the Antigravity sign-in link."));
      stdin.on("error", () => fail("Could not send the Antigravity sign-in code."));
      stopReading = readLoginUrl(stdout, (url) => {
        if (!isGoogleSignInUrl(url) || !isSafeExternalOpenUrl(url)) {
          fail("Antigravity returned an invalid Google sign-in link.");
          return;
        }
        void Promise.resolve().then(async () => {
          if (exited || signal.aborted) return;
          await this.options.openExternal(url);
          if (exited || signal.aborted) return;
          input.url = url;
          input.writeCode = (code) => {
            submitted = true;
            // The code is passed only through the CLI's private stdin pipe.
            try {
              stdin.end(`${code}\n`);
            } catch {
              fail("Could not send the Antigravity sign-in code.");
            }
          };
          onReady();
        }).catch(() => fail("Could not open the Google sign-in page."));
      }, fail);
      if (signal.aborted) abort();
      await done.promise;
    } finally {
      exited = true;
      input.writeCode = undefined;
      input.url = undefined;
      stopReading?.();
      signal.removeEventListener("abort", abort);
      // Error handlers can still run during teardown, including on missing pipes.
      void done.promise.catch(() => undefined);
      await terminateOwnedProcessTree(child, PROCESS_STOP_OPTIONS).catch(() => {
        throw new Error("Could not stop the Antigravity sign-in process.");
      });
    }
  }

  private spawnLogin(launch: AcpLaunchDescriptor, browserBin?: string): ReturnType<AcpStdioSpawn> {
    try {
      const env = personalAuthEnv(buildPwrAgentChildProcessEnv(process.env, launch.env));
      for (const key of Object.keys(env)) {
        if (["DISPLAY", "WAYLAND_DISPLAY", "BROWSER", "ELECTRON_RUN_AS_NODE"].includes(key.toUpperCase())) {
          delete env[key];
        }
      }
      // agy prints the link directly, and on macOS it invokes `open` through
      // PATH even when BROWSER is set. Suppress both launch paths.
      if (browserBin) env.PATH = `${browserBin}${path.delimiter}${env.PATH ?? "/usr/bin:/bin"}`;
      const runtime = process.platform === "win32" ? process.execPath.replaceAll("\\", "/") : process.execPath;
      if (runtime.includes(path.delimiter) || /[\r\n\0]|%s/u.test(runtime)) {
        throw new Error("Unsupported browser helper path.");
      }
      env.BROWSER = `'${runtime.replaceAll("'", "'\"'\"'")}' -e 'process.exit(0)' -- %s`;
      if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
      const invocation = createCommandInvocation({
        command: launch.command,
        args: ["acp", "--login", "--log-file", devNull],
        env,
      });
      return (this.options.spawn ?? spawn)(invocation.command, invocation.args, {
        env,
        cwd: launch.cwd,
        detached: process.platform !== "win32",
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      throw new Error("Could not start Antigravity sign-in.");
    }
  }

  private async probe(launch: AcpLaunchDescriptor, signal: AbortSignal): Promise<void> {
    const pipeFailure = Promise.withResolvers<never>();
    const failPipe = () => pipeFailure.reject(new Error("Antigravity session probe pipe failed."));
    const transport = new AcpStdioJsonRpcTransport({
      launchDescriptor: { ...launch, args: [...launch.args, "--log-file", devNull] },
      spawn: (command, args, options) => {
        const child = (this.options.spawn ?? spawn)(command, args, {
          ...options,
          env: personalAuthEnv(options.env ?? {}),
        });
        // Stream errors are independent of the child process's own error and
        // exit events. Reject the probe even if the process stays alive.
        child.stdin?.on("error", failPipe);
        child.stdin?.on("close", failPipe);
        child.stdout?.on("error", failPipe);
        child.stderr?.on("error", failPipe);
        return child;
      },
    });
    const abort = () => void transport.close().catch(() => undefined);
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      const initialized = await Promise.race([
        transport.request("initialize", { protocolVersion: 1 }),
        pipeFailure.promise,
      ]);
      if ((initialized as { protocolVersion?: unknown } | null)?.protocolVersion !== 1) {
        throw new Error();
      }
      const session = await Promise.race([
        transport.request("session/new", { cwd: launch.cwd, mcpServers: [] }),
        pipeFailure.promise,
      ]);
      const sessionId = (session as { sessionId?: unknown } | null)?.sessionId;
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        throw new Error();
      }
    } catch {
      signal.throwIfAborted();
      throw new Error("Antigravity could not verify sign-in by opening an ACP session.");
    } finally {
      signal.removeEventListener("abort", abort);
      await transport.close().catch(() => {
        throw new Error("Could not stop the Antigravity session probe.");
      });
    }
  }
}

async function createMacBrowserShim(cwd: string): Promise<string> {
  const bin = path.join(cwd, "browser-bin");
  try {
    if (bin.includes(path.delimiter)) {
      throw new Error("Browser shim path contains a PATH separator.");
    }
    await mkdir(bin, { mode: 0o700 });
    await writeFile(path.join(bin, "open"), "#!/bin/sh\nexit 0\n", { flag: "wx", mode: 0o700 });
    return bin;
  } catch {
    throw new Error("Could not suppress the Antigravity browser launcher.");
  }
}

function scheduleTimeout(expire: () => void, delayMs: number): () => void {
  const timer = setTimeout(expire, delayMs);
  return () => clearTimeout(timer);
}

function personalAuthEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Preserve the CLI's home and credential store. Alternate env credentials
  // must not make a failed Google sign-in look like an authenticated session.
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !ALTERNATE_CREDENTIAL_ENV.has(key.toUpperCase())),
  );
}

function isGoogleSignInUrl(value: string): boolean {
  if (!value.startsWith(`${GOOGLE_AUTH_ENDPOINT}?`) || /[\s\p{Cc}#\\]/u.test(value)) {
    return false;
  }
  const params = new URL(value).searchParams;
  const state = params.get("state");
  return params.getAll("response_type").length === 1 && params.get("response_type") === "code"
    && params.getAll("redirect_uri").length === 1 && params.get("redirect_uri") === ANTIGRAVITY_CALLBACK
    && params.getAll("state").length === 1 && !!state && state.length <= 512 && !/[\s\p{Cc}]/u.test(state)
    && !params.has("code");
}

function readLoginUrl(
  stdout: NonNullable<ReturnType<AcpStdioSpawn>["stdout"]>,
  onUrl: (url: string) => void,
  fail: (message: string) => void,
): () => void {
  let pending = "";
  let bytesRead = 0;
  const stop = () => {
    pending = "";
    stdout.removeListener("data", read);
    stdout.resume();
  };
  const read = (chunk: string) => {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf("\n", start);
      const fragment = chunk.slice(start, newline === -1 ? chunk.length : newline);
      bytesRead += Buffer.byteLength(fragment) + (newline === -1 ? 0 : 1);
      if (bytesRead > MAX_STARTUP_OUTPUT_BYTES) {
        stop();
        fail("Antigravity printed too much output before the sign-in link.");
        return;
      }
      if (newline === -1) {
        pending += fragment;
        return;
      }
      const candidate = (pending + fragment).trim();
      pending = "";
      if (/^https?:\/\//iu.test(candidate)) {
        stop();
        if (candidate.length <= MAX_AUTH_URL_LENGTH) onUrl(candidate);
        else fail("Antigravity returned an invalid Google sign-in link.");
        return;
      }
      start = newline + 1;
    }
  };
  stdout.setEncoding("utf8");
  stdout.on("data", read);
  return stop;
}
