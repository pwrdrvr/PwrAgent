import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { SocketModeClient } from "@slack/socket-mode";
import { createSlackSocketClient } from "../slack-adapter";
import { SlackSocketDiagnostics } from "../slack-socket-diagnostics";

function fixture() {
  let now = 0;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const diagnostics = new SlackSocketDiagnostics(logger, ["private-app-token"], () => now);
  const client = new EventEmitter();
  diagnostics.attach(client);
  return { logger, diagnostics, client, setTime: (value: number) => { now = value; } };
}

describe("Slack socket diagnostics", () => {
  it("reports startup failures, recovery, delayed cleanup, and a separate reconnect", () => {
    const { logger, diagnostics, client, setTime } = fixture();
    client.emit("connecting");
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      setTime(attempt * 10_000);
      client.emit("error", new Error("connection failed"));
      diagnostics.sdkLogger.debug("Before trying to reconnect, this client will wait for 5000 milliseconds");
      client.emit("reconnecting");
      client.emit("connecting");
    }
    setTime(42_000);
    client.emit("connected");
    expect(logger.info).toHaveBeenLastCalledWith("Slack socket connected", {
      phase: "startup", attempts: 5, failures: 4, elapsedMs: 42_000,
    });
    expect(logger.info).toHaveBeenCalledWith("Slack socket retry scheduled", expect.objectContaining({
      retryDelayMs: 5000,
    }));
    diagnostics.sdkLogger.warn("Peer did not complete the close handshake in time; forcing cleanup.");
    expect(logger.warn).toHaveBeenLastCalledWith(
      "Slack socket close handshake timed out; cleaning up a closing socket",
      { currentConnectionHealthy: true, cleanupTimeoutMs: 25_000 },
    );
    client.emit("reconnecting");
    client.emit("connecting");
    setTime(44_000);
    client.emit("connected");
    expect(logger.info).toHaveBeenLastCalledWith("Slack socket connected", {
      phase: "reconnect", attempts: 1, failures: 0, elapsedMs: 2000,
    });
    client.emit("disconnecting");
    diagnostics.sdkLogger.warn("Peer did not complete the close handshake in time; forcing cleanup.");
    expect(logger.warn).toHaveBeenLastCalledWith(expect.any(String), {
      currentConnectionHealthy: false, cleanupTimeoutMs: 25_000,
    });
    client.emit("disconnected");
  });

  it("retains leaf error codes from wrapped aggregate errors without leaking secrets", () => {
    const { logger, client } = fixture();
    const leaf = Object.assign(new Error(
      "failed wss://example.test/socket?ticket=secret private-app-token xoxb-bot-secret\nnext",
    ), { code: "ECONNRESET", syscall: "connect" });
    const aggregate = new AggregateError([leaf], "");
    const wrapper = Object.assign(new Error("", { cause: aggregate }), { original: aggregate });
    Object.assign(leaf, { cause: wrapper });
    client.emit("error", wrapper);
    const details = logger.error.mock.calls[0][1].error;
    expect(details).toContain("ECONNRESET");
    expect(details).toContain("syscall=connect");
    expect(details).toContain("[redacted URL]");
    expect(details).not.toMatch(/ticket=secret|private-app-token|xoxb-bot-secret|\n/);
    expect(details.length).toBeLessThanOrEqual(300);
  });

  it("suppresses lossy duplicate errors and SDK payloads but preserves other diagnostics", () => {
    const { logger, diagnostics } = fixture();
    diagnostics.sdkLogger.error("WebSocket error occurred: ");
    diagnostics.sdkLogger.error("WebSocket error! n");
    diagnostics.sdkLogger.debug("Received a message", { text: "private message" });
    diagnostics.sdkLogger.info("private SDK payload");
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    diagnostics.sdkLogger.error("API failed for https://example.test/private?token=secret");
    expect(logger.error).toHaveBeenCalledWith("Slack socket SDK diagnostic", expect.objectContaining({
      error: "API failed for [redacted URL]",
    }));
  });

  it("wires diagnostics into the real SDK client without opening a connection", () => {
    const logger = { error: vi.fn() };
    const on = vi.spyOn(SocketModeClient.prototype, "on");
    try {
      createSlackSocketClient("xapp-test", logger);
      const index = on.mock.calls.findIndex(([event]) => event === "connected");
      const client = on.mock.contexts[index] as SocketModeClient;
      client.emit("error", Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
      expect(logger.error).toHaveBeenCalledWith("Slack socket connection failed", expect.objectContaining({
        error: expect.stringContaining("ECONNREFUSED"),
      }));
    } finally {
      on.mockRestore();
    }
  });
});
