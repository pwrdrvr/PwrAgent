import { EventEmitter } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyClaudeGatewaySetting,
  claudeGatewayKeysOf,
  claudeGatewaySignInEnvironment,
  claudeGatewayUrlFromSettings,
  ClaudeGatewaySignInSession,
  normalizeClaudeGatewayUrl,
  parseClaudeGatewayLine,
  restoreClaudeGatewaySetting,
  supportsClaudeGatewaySignIn,
  writeClaudeGatewaySetting,
} from "../claude/claude-gateway";

const OUR_KEYS = new Set(["forceLoginMethod", "forceLoginGatewayUrl"]);
const settingsObject = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 12 }).filter((key) => !OUR_KEYS.has(key) && key !== "__proto__"),
  fc.jsonValue(),
  { maxKeys: 8 },
);
const gatewayUrl = fc.webUrl({ withQueryParameters: false, withFragments: false });

describe("Claude Code settings: the gateway keys", () => {
  it("setting then clearing a gateway leaves every other setting exactly as it was", () => {
    fc.assert(fc.property(settingsObject, gatewayUrl, (settings, url) => {
      const before = JSON.stringify(settings);
      const set = JSON.parse(applyClaudeGatewaySetting(before, url));
      expect(set.forceLoginMethod).toBe("gateway");
      expect(set.forceLoginGatewayUrl).toBe(url);
      expect(claudeGatewayUrlFromSettings(JSON.stringify(set))).toBe(url.trim() || undefined);
      const cleared = JSON.parse(applyClaudeGatewaySetting(JSON.stringify(set), undefined));
      expect(cleared).toEqual(JSON.parse(before));
    }));
  });

  it("clearing leaves a sign-in method that no longer names a gateway untouched", () => {
    fc.assert(fc.property(
      settingsObject,
      fc.constantFrom("claudeai", "console"),
      fc.option(gatewayUrl, { nil: undefined }),
      (settings, method, url) => {
        const text = JSON.stringify({ ...settings, forceLoginMethod: method, ...(url ? { forceLoginGatewayUrl: url } : {}) });
        expect(JSON.parse(applyClaudeGatewaySetting(text, undefined))).toEqual(JSON.parse(text));
      },
    ));
  });

  it("a sign-in that did not finish leaves the file exactly as it found it, whatever the gateway keys held", () => {
    const gatewayKeys = fc.record({
      forceLoginMethod: fc.oneof(fc.constantFrom("gateway", "claudeai", "console"), fc.jsonValue()),
      forceLoginGatewayUrl: fc.oneof(gatewayUrl, fc.jsonValue()),
    }, { requiredKeys: [] });
    fc.assert(fc.property(settingsObject, gatewayKeys, gatewayUrl, (settings, keys, wrote) => {
      const before = JSON.stringify({ ...settings, ...keys });
      const written = applyClaudeGatewaySetting(before, wrote);
      const restored = restoreClaudeGatewaySetting(written, claudeGatewayKeysOf(before), wrote);
      expect(JSON.parse(restored ?? written)).toEqual(JSON.parse(before));
    }));
  });

  it("keeps a gateway someone set after the sign-in started", () => {
    const wrote = "https://gateway.example.com";
    const later = applyClaudeGatewaySetting("{}", "https://other.example.com");
    expect(restoreClaudeGatewaySetting(later, {}, wrote)).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("writes through a symlinked settings file and leaves the link in place", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-claude-settings-link-"));
    try {
      await mkdir(path.join(root, "dotfiles"));
      const target = path.join(root, "dotfiles", "settings.json");
      const link = path.join(root, "settings.json");
      await writeFile(target, JSON.stringify({ model: "opus" }));
      await symlink(target, link);
      await writeClaudeGatewaySetting(link, "https://gateway.example.com");
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect(JSON.parse(await readFile(target, "utf8"))).toMatchObject({ model: "opus", forceLoginMethod: "gateway" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a file that is not a JSON object instead of replacing it", () => {
    for (const text of ["{ not json", "[1, 2]", "\"text\"", "42"]) {
      expect(() => applyClaudeGatewaySetting(text, "https://gateway.example.com", "settings.json")).toThrow(/settings\.json/);
    }
  });

  it("rewrites the file in place and keeps its mode", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-claude-settings-"));
    try {
      const file = path.join(root, "settings.json");
      await writeFile(file, JSON.stringify({ model: "opus", env: { A: "1" } }), { mode: 0o640 });
      await writeClaudeGatewaySetting(file, "https://gateway.example.com");
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
        model: "opus", env: { A: "1" }, forceLoginMethod: "gateway", forceLoginGatewayUrl: "https://gateway.example.com",
      });
      if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o640);
      await writeClaudeGatewaySetting(file, undefined);
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ model: "opus", env: { A: "1" } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("gateway URL and version checks", () => {
  it("normalises to Claude Code's own form and refuses anything a credential could hide in", () => {
    expect(normalizeClaudeGatewayUrl(" https://Gateway.Example.com/llm/ ")).toBe("https://gateway.example.com/llm");
    expect(normalizeClaudeGatewayUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    for (const bad of ["gateway.example.com", "ftp://gateway.example.com", "https://user:pw@gateway.example.com",
      "https://gateway.example.com/?token=x", "https://gateway.example.com/#x"]) {
      expect(() => normalizeClaudeGatewayUrl(bad)).toThrow();
    }
  });

  it("offers the sign-in only from the verified Claude Code version on", () => {
    expect(supportsClaudeGatewaySignIn("2.1.330")).toBe(true);
    expect(supportsClaudeGatewaySignIn("2.1.331")).toBe(true);
    expect(supportsClaudeGatewaySignIn("2.2.0")).toBe(true);
    expect(supportsClaudeGatewaySignIn("2.1.305")).toBe(false);
    expect(supportsClaudeGatewaySignIn(undefined)).toBe(false);
  });

  it("drops the markers that make Claude Code refuse to sign in inside a session", () => {
    expect(claudeGatewaySignInEnvironment({ CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1", PATH: "/bin" }))
      .toEqual({ PATH: "/bin" });
  });
});

describe("parseClaudeGatewayLine", () => {
  it("never throws, and only ever hands on web links", () => {
    const anyLine = fc.oneof(
      fc.string(),
      fc.jsonValue().map((value) => JSON.stringify(value)),
      fc.record({
        state: fc.constantFrom("polling", "trust_prompt", "error", "done", "url_input", "bogus"),
        shown: fc.oneof(fc.string(), fc.integer()),
        browserUrl: fc.oneof(fc.webUrl(), fc.constantFrom("javascript:alert(1)", "file:///etc/passwd", "x")),
        verificationUri: fc.oneof(fc.webUrl(), fc.constant("data:text/html,hi")),
        message: fc.string(),
      }, { requiredKeys: ["state"] }).map((value) => JSON.stringify(value)),
    );
    fc.assert(fc.property(anyLine, (line) => {
      const step = parseClaudeGatewayLine(line);
      if (step?.state === "polling") {
        for (const link of [step.browserUrl, step.verificationUri]) {
          if (link !== undefined) expect(new URL(link).protocol).toMatch(/^https?:$/);
        }
      }
    }));
  });

  it("reads the lines Claude Code 2.1.330 wrote against a local gateway", () => {
    expect(parseClaudeGatewayLine(JSON.stringify({
      version: 1, state: "trust_prompt", shown: "http-loopback", shownLabel: "Certificate fingerprint (SHA-256):",
      title: "Trust gateway 127.0.0.1?", confirmLabel: "Yes, trust this gateway", cancelLabel: "Cancel sign-in",
    }))).toEqual({
      state: "trust_prompt", shown: "http-loopback", shownLabel: "Certificate fingerprint (SHA-256):",
      title: "Trust gateway 127.0.0.1?", confirmLabel: "Yes, trust this gateway", cancelLabel: "Cancel sign-in",
    });
    expect(parseClaudeGatewayLine(JSON.stringify({
      version: 1, state: "polling", detail: "Confirm this code", userCode: "ABCD-EFGH",
      verificationUriLabel: "Browser didn't open? Visit:", verificationUri: "http://127.0.0.1:18765/device",
      browserUrl: "http://127.0.0.1:18765/device?user_code=ABCD-EFGH",
    }))).toEqual({
      state: "polling", detail: "Confirm this code", userCode: "ABCD-EFGH",
      verificationUri: "http://127.0.0.1:18765/device", browserUrl: "http://127.0.0.1:18765/device?user_code=ABCD-EFGH",
    });
  });
});

/** A stand-in for `claude auth login --gateway-json`: lines in, answers out. */
function fakeClaude() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin, stdout, stderr, exitCode: null as number | null, signalCode: null, kill: () => true,
  }) as unknown as ChildProcessWithoutNullStreams;
  const answers: Array<{ state: string; shown: string; accept: boolean }> = [];
  stdin.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) answers.push(JSON.parse(line));
  });
  const say = async (message: Record<string, unknown>) => {
    stdout.write(`${JSON.stringify(message)}\n`);
    // readline delivers on a later tick.
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { child, answers, say };
}

const QUESTION_STATES = ["url_input", "trust_prompt", "confirm_account"] as const;
const GATEWAY = "https://gateway.example.com";

describe("ClaudeGatewaySignInSession", () => {
  const sessions: ClaudeGatewaySignInSession[] = [];
  afterEach(() => { for (const session of sessions.splice(0)) session.cancel(); });

  function open(opened: string[] = []) {
    const fake = fakeClaude();
    const session = new ClaudeGatewaySignInSession({
      executable: "claude", env: {}, url: GATEWAY, homeDir: os.tmpdir(),
      openExternal: (page) => { opened.push(page); },
      spawn: () => fake.child,
    });
    sessions.push(session);
    session.start();
    return { ...fake, session };
  }

  // Model: Claude Code acts on an answer only when its state and shown value
  // match the question it is showing. The session must therefore write an
  // answer only for the question it currently shows, at the revision the
  // operator saw, and must answer the URL question by itself only for the URL
  // the operator asked for. Each question is answered once: Claude Code
  // cancels on an answer for a question it has already moved past.
  it("writes an answer only for the question the operator is looking at", async () => {
    type Command =
      | { kind: "say"; state: (typeof QUESTION_STATES)[number] | "connecting" | "polling"; shown: string }
      | { kind: "answer"; staleBy: number };
    const command: fc.Arbitrary<Command> = fc.oneof(
      fc.record({
        kind: fc.constant("say" as const),
        state: fc.constantFrom(...QUESTION_STATES, "connecting" as const, "polling" as const),
        shown: fc.constantFrom(GATEWAY, "https://other.example.com", "fp:AA:BB", "dev@example.com"),
      }),
      fc.record({ kind: fc.constant("answer" as const), staleBy: fc.constantFrom(0, 0, 1, 2) }),
    );
    await fc.assert(fc.asyncProperty(fc.array(command, { maxLength: 14 }), async (commands) => {
      const { session, answers, say } = open();
      const expected: Array<{ state: string; shown: string; accept: boolean }> = [];
      let answeredRevision = -1;
      for (const next of commands) {
        if (next.kind === "say") {
          await say({ version: 1, state: next.state, ...(next.state === "connecting" || next.state === "polling" ? {} : { shown: next.shown }) });
          if (next.state === "url_input" && next.shown === GATEWAY) expected.push({ state: "url_input", shown: GATEWAY, accept: true });
          continue;
        }
        const { revision, step } = session.progress();
        const accepted = session.answer(revision - next.staleBy);
        const isQuestion = step.state === "url_input" || step.state === "trust_prompt" || step.state === "confirm_account";
        expect(accepted).toBe(next.staleBy === 0 && isQuestion && revision !== answeredRevision);
        if (accepted && isQuestion) {
          answeredRevision = revision;
          expected.push({ state: step.state, shown: step.shown, accept: true });
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(answers).toEqual(expected);
      // The URL question for the requested gateway never reaches the operator.
      const shown = session.progress().step;
      expect(shown.state === "url_input" && shown.shown === GATEWAY).toBe(false);
      session.cancel();
    }), { numRuns: 150 });
  });

  it("runs a whole sign-in: trust, browser, account, done", async () => {
    const opened: string[] = [];
    const { session, answers, say } = open(opened);
    await say({ version: 1, state: "url_input", shown: GATEWAY });
    expect(answers).toEqual([{ state: "url_input", shown: GATEWAY, accept: true }]);
    await say({ version: 1, state: "connecting" });
    await say({ version: 1, state: "trust_prompt", shown: "fp", title: "Trust gateway gateway.example.com?" });
    const trust = await session.wait(0, 10);
    expect(trust.step).toMatchObject({ state: "trust_prompt", shown: "fp" });
    expect(session.answer(trust.revision)).toBe(true);
    const page = `${GATEWAY}/device?user_code=ABCD`;
    await say({ version: 1, state: "polling", userCode: "ABCD", browserUrl: page });
    await say({ version: 1, state: "polling", userCode: "ABCD", browserUrl: page });
    expect(opened).toEqual([page]);
    await say({ version: 1, state: "confirm_account", shown: "dev@example.com" });
    expect(session.answer(session.progress().revision)).toBe(true);
    await say({ version: 1, state: "saving" });
    await say({ version: 1, state: "done" });
    await expect(session.finished).resolves.toEqual({ state: "done" });
    expect(answers.map((answer) => answer.state)).toEqual(["url_input", "trust_prompt", "confirm_account"]);
  });

  it("reports Claude Code's reason when it stops without finishing", async () => {
    const { session, child } = open();
    (child.stderr as PassThrough).write("Cloud gateway sign-in isn't available with this machine's settings.\n");
    await new Promise((resolve) => setImmediate(resolve));
    child.emit("close", 1);
    await expect(session.finished).resolves.toEqual({
      state: "error",
      message: "Claude Code stopped before the gateway sign-in finished.",
      detail: "Cloud gateway sign-in isn't available with this machine's settings.",
    });
  });

  it("cancels by closing Claude Code's input, and ignores lines after that", async () => {
    const { session, child, say } = open();
    let ended = false;
    child.stdin.on("finish", () => { ended = true; });
    session.cancel();
    await say({ version: 1, state: "done" });
    await expect(session.finished).resolves.toEqual({ state: "cancelled" });
    expect(ended).toBe(true);
  });
});
