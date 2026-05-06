import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeMattermostContextHmac,
  createMattermostCallbackServer,
  generateMattermostHmacSecret,
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
