import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeMattermostContextHmac,
  createMattermostCallbackServer,
  generateMattermostHmacSecret,
  isAcceptedSlashCommandToken,
  parseSlashCommandBody,
} from "../mattermost-callback-server.ts";

const PORT_BASE = 47900;
let nextPort = PORT_BASE;

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

afterEach(() => {
  silentLogger.debug.mockClear();
  silentLogger.info.mockClear();
  silentLogger.warn.mockClear();
  silentLogger.error.mockClear();
});

describe("generateMattermostHmacSecret", () => {
  it("returns a non-empty hex secret", () => {
    const secret = generateMattermostHmacSecret();
    expect(secret).toMatch(/^[0-9a-f]+$/);
    expect(secret.length).toBeGreaterThan(32);
  });

  it("yields different values across calls", () => {
    expect(generateMattermostHmacSecret()).not.toBe(
      generateMattermostHmacSecret(),
    );
  });
});

describe("computeMattermostContextHmac", () => {
  it("is deterministic for identical inputs", () => {
    const params = {
      hmacSecret: "secret",
      intentId: "intent-1",
      actionId: "act",
      issuedAt: 1000,
    };
    expect(computeMattermostContextHmac(params)).toBe(
      computeMattermostContextHmac(params),
    );
  });

  it("differs when any input changes", () => {
    const base = {
      hmacSecret: "secret",
      intentId: "intent-1",
      actionId: "act",
      issuedAt: 1000,
    };
    const baseHmac = computeMattermostContextHmac(base);
    expect(computeMattermostContextHmac({ ...base, hmacSecret: "other" })).not.toBe(
      baseHmac,
    );
    expect(computeMattermostContextHmac({ ...base, intentId: "other" })).not.toBe(
      baseHmac,
    );
    expect(computeMattermostContextHmac({ ...base, actionId: "other" })).not.toBe(
      baseHmac,
    );
    expect(computeMattermostContextHmac({ ...base, issuedAt: 2000 })).not.toBe(
      baseHmac,
    );
  });
});

describe("MattermostCallbackServer", () => {
  it("dispatches valid callbacks to the handler", async () => {
    const port = nextPort++;
    const handler = vi.fn();
    const hmacSecret = "test-secret";
    const server = createMattermostCallbackServer({
      port,
      hmacSecret,
      handler,
      logger: silentLogger,
    });
    await server.start();
    try {
      const issuedAt = 1234;
      const hmac = computeMattermostContextHmac({
        hmacSecret,
        intentId: "intent-1",
        actionId: "act",
        issuedAt,
      });
      const body = {
        user_id: "user-1",
        channel_id: "channel-1",
        post_id: "post-1",
        context: {
          handle: "h",
          intentId: "intent-1",
          actionId: "act",
          issuedAt,
          hmac,
        },
      };
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("update");
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]?.[0]).toMatchObject({
        user_id: "user-1",
        channel_id: "channel-1",
      });
    } finally {
      await server.stop();
    }
  });

  it("silently rejects callbacks with bad HMAC (200 response, no dispatch)", async () => {
    const port = nextPort++;
    const handler = vi.fn();
    const server = createMattermostCallbackServer({
      port,
      hmacSecret: "real-secret",
      handler,
      logger: silentLogger,
    });
    await server.start();
    try {
      const body = {
        user_id: "user-1",
        channel_id: "channel-1",
        context: {
          handle: "h",
          intentId: "intent-1",
          actionId: "act",
          issuedAt: 1234,
          hmac: "not-the-real-hmac-value-just-bytes-here",
        },
      };
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      expect(handler).not.toHaveBeenCalled();
      expect(silentLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("HMAC"),
        expect.any(Object),
      );
    } finally {
      await server.stop();
    }
  });

  it("rejects non-POST methods with 405", async () => {
    const port = nextPort++;
    const server = createMattermostCallbackServer({
      port,
      hmacSecret: "x",
      handler: vi.fn(),
      logger: silentLogger,
    });
    await server.start();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        method: "GET",
      });
      expect(response.status).toBe(405);
    } finally {
      await server.stop();
    }
  });

  it("routes form-encoded POSTs to the slash-command handler when token matches", async () => {
    const port = nextPort++;
    const interactiveHandler = vi.fn();
    const slashHandler = vi.fn();
    const validTokens = new Set(["valid-token"]);
    const server = createMattermostCallbackServer({
      port,
      hmacSecret: "x",
      handler: interactiveHandler,
      slashCommandHandler: slashHandler,
      validSlashCommandTokens: validTokens,
      logger: silentLogger,
    });
    await server.start();
    try {
      const params = new URLSearchParams({
        token: "valid-token",
        team_id: "team-1",
        channel_id: "channel-1",
        user_id: "user-1",
        user_name: "harold",
        command: "/resume",
        text: "--projects",
      });
      const response = await fetch(`http://127.0.0.1:${port}/command`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
      expect(response.status).toBe(200);
      expect(slashHandler).toHaveBeenCalledTimes(1);
      expect(interactiveHandler).not.toHaveBeenCalled();
      expect(slashHandler.mock.calls[0]?.[0]).toMatchObject({
        command: "/resume",
        text: "--projects",
        user_id: "user-1",
        team_id: "team-1",
      });
    } finally {
      await server.stop();
    }
  });

  it("rejects slash-command POSTs with unknown token (200 response, no dispatch)", async () => {
    const port = nextPort++;
    const slashHandler = vi.fn();
    const validTokens = new Set(["valid-token"]);
    const server = createMattermostCallbackServer({
      port,
      hmacSecret: "x",
      handler: vi.fn(),
      slashCommandHandler: slashHandler,
      validSlashCommandTokens: validTokens,
      logger: silentLogger,
    });
    await server.start();
    try {
      const params = new URLSearchParams({
        token: "spoofed-token",
        team_id: "team-1",
        channel_id: "channel-1",
        user_id: "user-1",
        command: "/resume",
        text: "",
      });
      const response = await fetch(`http://127.0.0.1:${port}/command`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
      expect(response.status).toBe(200);
      expect(slashHandler).not.toHaveBeenCalled();
      expect(silentLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("token"),
        expect.any(Object),
      );
    } finally {
      await server.stop();
    }
  });

  it("signContext produces a verifiable HMAC for matching parameters", async () => {
    const port = nextPort++;
    const server = createMattermostCallbackServer({
      port,
      hmacSecret: "shared-secret",
      handler: vi.fn(),
      logger: silentLogger,
    });
    const { hmac, issuedAt } = server.signContext({
      intentId: "intent",
      actionId: "act",
    });
    const expected = computeMattermostContextHmac({
      hmacSecret: "shared-secret",
      intentId: "intent",
      actionId: "act",
      issuedAt,
    });
    expect(hmac).toBe(expected);
  });
});

describe("parseSlashCommandBody", () => {
  it("parses a well-formed form-encoded body", () => {
    const params = new URLSearchParams({
      token: "tk",
      team_id: "team-1",
      channel_id: "channel-1",
      user_id: "user-1",
      user_name: "harold",
      command: "/resume",
      text: "--projects",
      trigger_id: "tr-1",
    });
    const body = parseSlashCommandBody(params.toString());
    expect(body).toMatchObject({
      token: "tk",
      team_id: "team-1",
      channel_id: "channel-1",
      user_id: "user-1",
      user_name: "harold",
      command: "/resume",
      text: "--projects",
      trigger_id: "tr-1",
    });
  });

  it("returns undefined when required fields are missing", () => {
    const params = new URLSearchParams({
      // missing token
      team_id: "team-1",
      channel_id: "channel-1",
      user_id: "user-1",
      command: "/resume",
    });
    expect(parseSlashCommandBody(params.toString())).toBeUndefined();
  });

  it("treats absent text as empty string (no args is legal)", () => {
    const params = new URLSearchParams({
      token: "tk",
      team_id: "team-1",
      channel_id: "channel-1",
      user_id: "user-1",
      command: "/status",
    });
    const body = parseSlashCommandBody(params.toString());
    expect(body?.text).toBe("");
  });
});

describe("isAcceptedSlashCommandToken", () => {
  it("accepts a token present in the registered set", () => {
    const tokens = new Set(["a", "b", "c"]);
    expect(isAcceptedSlashCommandToken("b", tokens)).toBe(true);
  });

  it("rejects a token absent from the set", () => {
    const tokens = new Set(["a", "b", "c"]);
    expect(isAcceptedSlashCommandToken("d", tokens)).toBe(false);
  });

  it("rejects against an empty set", () => {
    expect(isAcceptedSlashCommandToken("anything", new Set())).toBe(false);
  });

  it("rejects a token whose length matches but content differs (no early-exit leak)", () => {
    const tokens = new Set(["correct-secret"]);
    expect(isAcceptedSlashCommandToken("correct-decoy", tokens)).toBe(false);
  });
});
