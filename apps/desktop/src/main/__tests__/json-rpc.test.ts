import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonRpcConnection, type JsonRpcTransport } from "../codex-app-server/json-rpc";

const jsonRpcLogError = vi.hoisted(() => vi.fn());

vi.mock("../log", () => ({
  getMainLogger: vi.fn(() => ({
    error: jsonRpcLogError,
  })),
}));

class MockTransport implements JsonRpcTransport {
  readonly sentMessages: string[] = [];
  sendError: Error | undefined;
  private messageHandler: (message: string) => void = () => undefined;
  private closeHandler: (error?: Error) => void = () => undefined;

  async connect(): Promise<void> {
    return;
  }

  async close(): Promise<void> {
    this.closeHandler();
  }

  emitRaw(message: string): void {
    this.messageHandler(message);
  }

  send(message: string): void {
    if (this.sendError) {
      throw this.sendError;
    }
    this.sentMessages.push(message);
  }

  setCloseHandler(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }

  setMessageHandler(handler: (message: string) => void): void {
    this.messageHandler = handler;
  }
}

describe("JsonRpcConnection", () => {
  afterEach(() => {
    jsonRpcLogError.mockClear();
    vi.restoreAllMocks();
  });

  it("continues outbound traffic when the observer throws", async () => {
    const transport = new MockTransport();
    const connection = new JsonRpcConnection(
      transport,
      1_000,
      {
        onMessage: async () => {
          throw new Error("disk full");
        },
      },
      { logContext: { backend: "codex" } },
    );

    await connection.connect();

    const requestPromise = connection.request("initialize", {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    const outboundEnvelope = JSON.parse(transport.sentMessages[0] ?? "{}") as {
      id?: string;
    };

    transport.emitRaw(
      JSON.stringify({
        jsonrpc: "2.0",
        id: outboundEnvelope.id,
        result: {
          ok: true
        }
      })
    );

    await expect(requestPromise).resolves.toEqual({ ok: true });
    expect(jsonRpcLogError).toHaveBeenCalledWith(
      "observer failed",
      expect.objectContaining({
        backend: "codex",
        error: "disk full",
      }),
    );

    await connection.close();
  });

  it("still delivers inbound notifications when the observer throws", async () => {
    const transport = new MockTransport();
    const connection = new JsonRpcConnection(transport, 1_000, {
      onMessage: async () => {
        throw new Error("capture write failed");
      }
    });
    const notifications: Array<{ method: string; params: unknown }> = [];

    connection.setNotificationHandler((method, params) => {
      notifications.push({ method, params });
    });

    await connection.connect();
    transport.emitRaw(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "thread/status/changed",
        params: {
          threadId: "thread-1",
          status: { type: "idle" }
        }
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifications).toEqual([
      {
        method: "thread/status/changed",
        params: {
          threadId: "thread-1",
          status: { type: "idle" }
        }
      }
    ]);
    expect(jsonRpcLogError).toHaveBeenCalled();

    await connection.close();
  });

  it("clears pending requests when the transport send fails", async () => {
    const transport = new MockTransport();
    const connection = new JsonRpcConnection(transport, 1_000);
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };

    process.on("unhandledRejection", onUnhandledRejection);

    try {
      await connection.connect();
      transport.sendError = new Error("codex app server stdio not connected");

      await expect(connection.request("thread/list", {})).rejects.toThrow(
        "codex app server stdio not connected",
      );

      await connection.close();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });
});
