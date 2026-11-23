import { spawn as spawnProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { stat } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { AcpLaunchDescriptor } from "../acp/acp-launch-descriptor.js";
import { AntigravitySignIn, type AntigravitySignInOptions } from "../acp/antigravity-sign-in.js";

type SignInSpawn = NonNullable<AntigravitySignInOptions["spawn"]>;

const AUTH_QUERY = "response_type=code&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=fixture";
const AUTH_URL = `https://accounts.google.com/o/oauth2/auth?${AUTH_QUERY}`;
const FIXTURE_CODE = "fixture-code";
const SELECTED: AcpLaunchDescriptor = {
  backendId: "acp:antigravity",
  registryId: "antigravity",
  distributionKind: "local",
  command: path.join(tmpdir(), "selected-agy"),
  args: ["acp", "--process-per-session"],
  env: {
    GEMINI_HOME: path.join(tmpdir(), "fixture-cli-home"),
    GEMINI_API_KEY: "fixture-key",
    agy_adc_auth: "1",
    DISPLAY: "fixture-display",
    BROWSER: "fixture-browser",
  },
};

class FixtureChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  close(code: number): void {
    this.exitCode = code;
    this.emit("close");
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signalCode = signal;
    this.emit("close");
    return true;
  }
}

function fixture(options?: Partial<Pick<AntigravitySignInOptions, "openExternal" | "scheduleTimeout">>) {
  const login = new FixtureChild();
  const started = Promise.withResolvers<void>();
  const writes: string[] = [];
  login.stdin.on("data", (chunk) => writes.push(String(chunk)));
  const openExternal = vi.fn(options?.openExternal ?? (async () => {}));
  const spawn = vi.fn<SignInSpawn>(() => {
    started.resolve();
    return login;
  });
  const signIn = new AntigravitySignIn({ openExternal, spawn, scheduleTimeout: options?.scheduleTimeout });
  return { login, started: started.promise, writes, openExternal, spawn, signIn };
}

describe("Antigravity personal sign-in", () => {
  it("opens a session from a fresh process using the selected CLI's sign-in", async () => {
    // A fixture-only sign-in marker gates session/new in a second Node process.
    // The fixture never writes the supplied code to disk or emits it as output.
    const fixtureSource = String.raw`
      const fs = require('node:fs');
      const readline = require('node:readline');
      const lines = readline.createInterface({ input: process.stdin });
      if (process.argv.includes('--login')) {
        process.stdout.write('Opening Google sign-in\r\n' + ${JSON.stringify(AUTH_URL)} + '\r\nPaste code: ');
        lines.once('line', (code) => {
          if (code !== ${JSON.stringify(FIXTURE_CODE)}) process.exit(2);
          fs.writeFileSync('fixture-signed-in', '1');
          lines.close();
        });
      } else {
        let initialized = false;
        lines.on('line', (line) => {
          const { id, method, params } = JSON.parse(line);
          let response;
          if (method === 'initialize' && params.protocolVersion === 1) {
            initialized = true;
            response = { result: { protocolVersion: 1 } };
          } else if (method === 'session/new' && initialized && fs.realpathSync(params.cwd) === fs.realpathSync(process.cwd())
            && Array.isArray(params.mcpServers) && params.mcpServers.length === 0
            && fs.existsSync('fixture-signed-in')) {
            response = { result: { sessionId: 'fixture-session' } };
          } else {
            response = { error: { code: -32000, message: 'Authentication required' } };
          }
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...response }) + '\n');
        });
      }
    `;
    const spawn = vi.fn<SignInSpawn>((_command, args, options) => spawnProcess(
      process.execPath, ["-e", fixtureSource, "--", ...args], options,
    ));
    const openExternal = vi.fn(async () => {});
    const signIn = new AntigravitySignIn({ openExternal, spawn });
    const attempt = signIn.start(SELECTED);
    try {
      await attempt.ready;
      expect(openExternal.mock.calls).toEqual([[AUTH_URL]]);
      expect(spawn).toHaveBeenCalledTimes(1);
      attempt.submitCode(FIXTURE_CODE);
      await attempt.completed;
    } finally {
      await attempt.cancel();
    }
    expect(spawn.mock.calls.map(([command, args]) => [command, ...args])).toEqual([
      [SELECTED.command, "acp", "--login", "--log-file", devNull],
      [SELECTED.command, "acp", "--process-per-session", "--log-file", devNull],
    ]);
    const loginOptions = spawn.mock.calls[0][2];
    const probeOptions = spawn.mock.calls[1][2];
    for (const options of [loginOptions, probeOptions]) {
      expect(options.env?.GEMINI_HOME).toBe(SELECTED.env.GEMINI_HOME);
      expect(options.env).not.toHaveProperty("GEMINI_API_KEY");
      expect(options.env).not.toHaveProperty("agy_adc_auth");
      expect(options.cwd).toBe(loginOptions.cwd);
    }
    expect(loginOptions.env?.BROWSER).not.toBe(SELECTED.env.BROWSER);
    expect(loginOptions.env).not.toHaveProperty("DISPLAY");
    expect(loginOptions.stdio).toEqual(["pipe", "pipe", "ignore"]);
    expect(spawn.mock.results[1].value.signalCode ?? spawn.mock.results[1].value.exitCode).not.toBeNull();
    await expect(stat(String(loginOptions.cwd))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a zero login exit when ACP still requires authentication", async () => {
    const { login, started, spawn, signIn } = fixture();
    const probe = new FixtureChild();
    const methods: string[] = [];
    probe.stdin.on("data", (chunk) => {
      const { id, method } = JSON.parse(String(chunk));
      methods.push(method);
      const response = method === "initialize"
        ? { result: { protocolVersion: 1 } }
        : { error: { code: -32000, message: `Authentication required ${FIXTURE_CODE}` } };
      probe.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...response })}\n`);
    });
    const attempt = signIn.start(SELECTED);
    try {
      await started;
      spawn.mockImplementation(() => probe);
      login.stdout.write(`${AUTH_URL}\n`);
      await attempt.ready;
      attempt.submitCode(FIXTURE_CODE);
      login.close(0);
      await expect(attempt.completed).rejects.toThrow(
        /^Antigravity could not verify sign-in by opening an ACP session\.$/u,
      );
      expect(methods).toEqual(["initialize", "session/new"]);
      expect(probe.signalCode).toBe("SIGTERM");
    } finally {
      await attempt.cancel();
    }
  });

  it("passes only the exact Google OAuth destination through the opener regardless of chunking", async () => {
    const url = fc.constantFrom(
      AUTH_URL,
      `https://accounts.google.com.evil.invalid/o/oauth2/auth?${AUTH_QUERY}`,
      `https://accounts.google.com@evil.invalid/o/oauth2/auth?${AUTH_QUERY}`,
      `https://evil.invalid@accounts.google.com/o/oauth2/auth?${AUTH_QUERY}`,
      `https://accounts.google.com:443/o/oauth2/auth?${AUTH_QUERY}`,
      `https://accounts.google.com/o/oauth2/v2/auth?${AUTH_QUERY}`,
      `http://accounts.google.com/o/oauth2/auth?${AUTH_QUERY}`,
      `${AUTH_URL}&state=other`,
      `${AUTH_URL}&redirect_uri=https%3A%2F%2Fevil.invalid`,
      AUTH_URL.replace("antigravity.google", "evil.invalid"),
      `${AUTH_URL}#`,
      `${AUTH_URL}&code=fixture`,
    );
    await fc.assert(fc.asyncProperty(url, fc.nat(), async (candidate, splitAt) => {
      const { login, started, signIn, openExternal } = fixture();
      const attempt = signIn.start(SELECTED);
      try {
        await started;
        const output = `Antigravity sign-in\r\n${candidate}\r\n`;
        const split = splitAt % output.length;
        login.stdout.write(output.slice(0, split));
        login.stdout.write(output.slice(split));
        if (candidate === AUTH_URL) await attempt.ready;
        else await expect(attempt.ready).rejects.toThrow("invalid Google sign-in link");
        expect(openExternal.mock.calls).toEqual(candidate === AUTH_URL ? [[AUTH_URL]] : []);
      } finally {
        await attempt.cancel();
      }
    }), { numRuns: 50 });
  });

  it("writes at most one valid code across retries, duplicate starts and cancellation", async () => {
    const action = fc.constantFrom("submit", "invalid", "retry", "cancel");
    await fc.assert(fc.asyncProperty(fc.array(action, { maxLength: 12 }), async (actions) => {
      const { login, started, writes, signIn, spawn } = fixture();
      const attempt = signIn.start(SELECTED);
      let waiting = true;
      let submitted = false;
      try {
        await started;
        expect(() => attempt.submitCode(FIXTURE_CODE)).toThrow("not waiting");
        login.stdout.write(`${AUTH_URL}\n`);
        await attempt.ready;
        for (const step of actions) {
          if (step === "cancel") {
            await attempt.cancel();
            waiting = false;
          } else if (step === "retry") {
            if (!waiting) continue;
            expect(() => signIn.start(SELECTED)).toThrow("already in progress");
          } else if (step === "invalid") {
            expect(() => attempt.submitCode(`${FIXTURE_CODE}\nextra`)).toThrow();
          } else if (waiting && !submitted) {
            attempt.submitCode(FIXTURE_CODE);
            submitted = true;
          } else {
            expect(() => attempt.submitCode(FIXTURE_CODE)).toThrow("not waiting");
          }
          expect(writes).toEqual(submitted ? [`${FIXTURE_CODE}\n`] : []);
        }
      } finally {
        await attempt.cancel();
      }
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(login.signalCode).toBe("SIGTERM");
    }), { numRuns: 50 });
  });

  it("expires while the browser opener is pending and blocks a late submission", async () => {
    const timeout = Promise.withResolvers<() => void>();
    const opening = Promise.withResolvers<void>();
    const openerStarted = Promise.withResolvers<void>();
    const stopTimeout = vi.fn();
    const { login, started, signIn, spawn } = fixture({
      scheduleTimeout: (expire, delayMs) => {
        expect(delayMs).toBe(5 * 60_000);
        timeout.resolve(expire);
        return stopTimeout;
      },
      openExternal: async () => {
        openerStarted.resolve();
        await opening.promise;
      },
    });
    const attempt = signIn.start(SELECTED);
    try {
      await started;
      login.stdout.write(`${AUTH_URL}\n`);
      await openerStarted.promise;
      (await timeout.promise)();
      await expect(attempt.ready).rejects.toThrow("timed out");
      expect(login.signalCode).toBe("SIGTERM");
      opening.resolve();
      await expect(attempt.completed).rejects.toThrow("timed out");
      expect(stopTimeout).toHaveBeenCalledOnce();
      expect(() => attempt.submitCode(FIXTURE_CODE)).toThrow("not waiting");
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      opening.resolve();
      await attempt.cancel();
    }
  });

  it("cancels an in-flight session probe and releases the controller for a new attempt", async () => {
    const { login, started, signIn, spawn } = fixture();
    const probe = new FixtureChild();
    const probing = Promise.withResolvers<void>();
    probe.stdin.on("data", () => probing.resolve());
    const attempt = signIn.start(SELECTED);
    try {
      await started;
      spawn.mockImplementationOnce(() => probe);
      login.stdout.write(`${AUTH_URL}\n`);
      await attempt.ready;
      attempt.submitCode(FIXTURE_CODE);
      login.close(0);
      await probing.promise;
      await attempt.cancel();
      await expect(attempt.completed).rejects.toThrow("cancelled");
      expect(probe.signalCode).toBe("SIGTERM");
      const next = signIn.start(SELECTED);
      await next.cancel();
      await expect(next.completed).rejects.toThrow("cancelled");
    } finally {
      await attempt.cancel();
    }
  });

  it("bounds startup output before the link and ignores echoed code after submission", async () => {
    const excessive = fixture();
    const blocked = excessive.signIn.start(SELECTED);
    try {
      await excessive.started;
      excessive.login.stdout.write("x".repeat(128 * 1024 + 1));
      await expect(blocked.completed).rejects.toThrow("too much output");
      expect(excessive.openExternal).not.toHaveBeenCalled();
    } finally {
      await blocked.cancel();
    }

    const echo = fixture();
    const attempt = echo.signIn.start(SELECTED);
    try {
      await echo.started;
      echo.login.stdout.write(`${AUTH_URL}\n`);
      await attempt.ready;
      attempt.submitCode(FIXTURE_CODE);
      echo.login.stdout.write(`${AUTH_URL}&code=${FIXTURE_CODE}\n${FIXTURE_CODE}\n`);
      echo.login.close(1);
      await expect(attempt.completed).rejects.toThrow(/^Antigravity could not finish Google sign-in\.$/u);
      expect(echo.openExternal.mock.calls).toEqual([[AUTH_URL]]);
      expect(echo.spawn).toHaveBeenCalledTimes(1);
    } finally {
      await attempt.cancel();
    }
  });
});
