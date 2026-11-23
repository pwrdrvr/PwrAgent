import { spawn as spawnProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { AcpLaunchDescriptor } from "../acp/acp-launch-descriptor.js";
import { AntigravitySignIn, type AntigravitySignInOptions } from "../acp/antigravity-sign-in.js";
import { pruneAntigravityRuntime, withAntigravityRuntimeLock } from "../acp/antigravity-runtime-retention.js";

type SignInSpawn = NonNullable<AntigravitySignInOptions["spawn"]>;

const AUTH_QUERY = "response_type=code&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=fixture";
const AUTH_URL = `https://accounts.google.com/o/oauth2/auth?${AUTH_QUERY}`;
const FIXTURE_CODE = "fixture-code";
const STARTUP_CAP = 128 * 1024;
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
  it.skipIf(process.platform === "win32")("holds the same resolved release through login and ACP verification", async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), async (aliased) => {
      const home = await mkdtemp(path.join(tmpdir(), "fixture-agy-held-sign-in-"));
      vi.stubEnv("PWRAGENT_HOME", home);
      try {
        const root = path.join(home, "agents", "antigravity");
        const makeRelease = async (patch: number) => {
          const command = path.join(root, "versions", `1.5.${patch}-${"d".repeat(128)}`, "agy");
          await mkdir(path.dirname(command), { recursive: true });
          await writeFile(command, "fixture", { mode: 0o700 });
          return await realpath(command);
        };
        const selected = await makeRelease(0);
        const previous = await makeRelease(1);
        const active = await makeRelease(2);
        await symlink(path.relative(await realpath(root), active), path.join(root, "active"));
        const alias = path.join(home, "agy-alias");
        await symlink(selected, alias);
        const prune = async () => await withAntigravityRuntimeLock(root,
          async (assertLocked) => await pruneAntigravityRuntime(root, active, previous, assertLocked));
        const { login, started, signIn, spawn } = fixture();
        const probe = new FixtureChild();
        probe.stdin.on("data", (wire) => {
          const { id, method } = JSON.parse(String(wire));
          const result = method === "initialize" ? { protocolVersion: 1 } : { sessionId: "fixture-session" };
          probe.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
        });
        const attempt = signIn.start({
          ...SELECTED, command: aliased ? alias : selected, managedAntigravityFallback: true,
        });
        try {
          await started;
          login.stdout.write(`${AUTH_URL}\n`);
          await attempt.ready;
          await rm(alias);
          await symlink(active, alias);
          await prune();
          expect((await stat(selected)).isFile()).toBe(true);
          spawn.mockImplementation(() => probe);
          attempt.submitCode(FIXTURE_CODE);
          login.close(0);
          await expect(attempt.completed).resolves.toBe(selected);
          expect(spawn.mock.calls.map(([command]) => command)).toEqual([selected, selected]);
          await prune();
          await expect(stat(selected)).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
          await attempt.cancel();
        }
      } finally {
        vi.unstubAllEnvs();
        await rm(home, { recursive: true, force: true });
      }
    }), { numRuns: 12 });
  });

  it.runIf(process.platform === "darwin")("keeps native open from reaching the inherited PATH", async () => {
    const inheritedBin = await mkdtemp(path.join(tmpdir(), "fixture-agy-open-"));
    // A native opener that reaches the inherited PATH stands in for a browser
    // launch. This fixture can only reach the controller's shim or this file.
    await writeFile(path.join(inheritedBin, "open"), "#!/bin/sh\nexit 37\n", { mode: 0o700 });
    const spawn = vi.fn<SignInSpawn>((_command, _args, options) => spawnProcess(
      process.execPath,
      ["-e", String.raw`
        const { spawnSync } = require('node:child_process');
        const url = ${JSON.stringify(AUTH_URL)};
        const opened = spawnSync('open', [url], { stdio: 'ignore' });
        if (opened.status !== 0) process.exit(37);
        process.stdout.write(url + '\n');
        process.stdin.resume();
      `],
      options,
    ));
    const openExternal = vi.fn(async () => {});
    const attempt = new AntigravitySignIn({ openExternal, spawn }).start({
      ...SELECTED,
      env: { ...SELECTED.env, PATH: inheritedBin },
    });
    try {
      await attempt.ready;
      expect(openExternal.mock.calls).toEqual([[AUTH_URL]]);
    } finally {
      await attempt.cancel();
      await rm(inheritedBin, { recursive: true, force: true });
    }
  });

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

  async function checkStartupBoundary(linkEnd: number, splitAt: number): Promise<void> {
    const { login, started, signIn, openExternal } = fixture();
    const attempt = signIn.start(SELECTED);
    try {
      await started;
      // Include multibyte startup text so the cap measures wire bytes.
      const prefix = "é\n";
      const padding = "x".repeat(linkEnd - Buffer.byteLength(prefix) - AUTH_URL.length - 2);
      const output = `${prefix}${padding}\n${AUTH_URL}\nPaste code: `;
      login.stdout.write(output.slice(0, splitAt));
      login.stdout.write(output.slice(splitAt));
      if (linkEnd <= STARTUP_CAP) await attempt.ready;
      else await expect(attempt.ready).rejects.toThrow("too much output");
      expect(openExternal.mock.calls).toEqual(linkEnd <= STARTUP_CAP ? [[AUTH_URL]] : []);
    } finally {
      await attempt.cancel();
    }
  }

  it("accepts a link ending at the startup cap in the same chunk as the prompt", async () => {
    await checkStartupBoundary(STARTUP_CAP, 0);
  });

  it("counts bytes through the link newline independently of stdout chunking", async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: -2, max: 2 }),
      fc.oneof(fc.integer({ min: 0, max: STARTUP_CAP + 10 }), fc.constant(STARTUP_CAP - 1)),
      async (offset, splitAt) => await checkStartupBoundary(STARTUP_CAP + offset, splitAt),
    ), { numRuns: 25 });
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

  async function checkProbePipeFailure(failOn: "initialize" | "session/new"): Promise<void> {
    const deadline = Promise.withResolvers<() => void>();
    const { login, started, signIn, spawn } = fixture({
      scheduleTimeout: (expire) => {
        deadline.resolve(expire);
        return () => undefined;
      },
    });
    const probe = new FixtureChild();
    const pipeFailed = Promise.withResolvers<void>();
    const methods: string[] = [];
    // Keep the pre-fix fixture worker alive. The model still requires the
    // controller to fail the attempt and stop the child before the deadline.
    probe.stdin.once("error", () => pipeFailed.resolve());
    probe.stdin.on("data", (chunk) => {
      const { id, method } = JSON.parse(String(chunk));
      methods.push(method);
      if (method === failOn) {
        probe.stdin.destroy(Object.assign(new Error("fixture pipe failed"), { code: "EPIPE" }));
        return;
      }
      probe.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: { protocolVersion: 1 } })}\n`);
    });
    const attempt = signIn.start(SELECTED);
    try {
      await started;
      spawn.mockImplementationOnce(() => probe);
      login.stdout.write(`${AUTH_URL}\n`);
      await attempt.ready;
      attempt.submitCode(FIXTURE_CODE);
      login.close(0);
      await pipeFailed.promise;
      // Let the error reach the request's promise and enter teardown before
      // advancing the injected deadline. Filesystem cleanup can finish later.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(probe.signalCode).toBe("SIGTERM");
      await expect(attempt.completed).rejects.toThrow(
        /^Antigravity could not verify sign-in by opening an ACP session\.$/u,
      );
      expect(methods).toEqual(failOn === "initialize" ? ["initialize"] : ["initialize", "session/new"]);
      const next = signIn.start(SELECTED);
      await next.cancel();
    } finally {
      (await deadline.promise)();
      await attempt.cancel();
    }
  }

  it("fails and stops the probe when session/new hits EPIPE after initialize", async () => {
    await checkProbePipeFailure("session/new");
  });

  it("transitions to failure and permits a new attempt when either probe write hits EPIPE", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("initialize", "session/new"), checkProbePipeFailure), {
      numRuns: 10,
    });
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
