import { describe, expect, it, vi } from "vitest";
import type { JsonRpcTransport } from "../codex-app-server/json-rpc";

class MockTransport implements JsonRpcTransport {
  readonly sentMessages: string[] = [];
  private messageHandler: (message: string) => void = () => undefined;
  private closeHandler: (error?: Error) => void = () => undefined;

  async connect(): Promise<void> {
    return;
  }

  async close(): Promise<void> {
    this.closeHandler();
  }

  send(message: string): void {
    this.sentMessages.push(message);

    const payload = JSON.parse(message) as {
      id?: string;
      method?: string;
    };

    if (payload.method === "initialize") {
      this.messageHandler(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            serverInfo: {
              name: "Codex App Server",
              version: "1.0.0"
            }
          }
        })
      );
      return;
    }

    if (payload.method === "thread/list") {
      this.messageHandler(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            threads: [
              {
                id: "thread-2",
                title: "Ship desktop shell",
                summary: "Hook up Electron and the sidebar",
                updatedAt: 1_763_500_000,
                session: {
                  cwd: "/Users/huntharo/pwrdrvr/PwrAgnt"
                }
              },
              {
                id: "thread-1",
                title: "Plan Codex compatibility",
                text: "Do not leak this planning prompt into the thread browser",
                updatedAt: 1_763_400_000,
                session: {
                  cwd: "/Users/huntharo/pwrdrvr/openclaw-codex-app-server"
                }
              }
            ]
          }
        })
      );
      return;
    }

    if (payload.method === "thread/read") {
      this.messageHandler(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            messages: [
              {
                role: "user",
                text: "Show me the current desktop thread shell"
              },
              {
                role: "assistant",
                text: "The desktop shell is live and listing Codex threads."
              }
            ]
          }
        })
      );
    }
  }

  setMessageHandler(handler: (message: string) => void): void {
    this.messageHandler = handler;
  }

  setCloseHandler(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }
}

vi.mock("../codex-app-server/stdio-transport", () => {
  class MockStdioJsonRpcTransport extends MockTransport {
    constructor() {
      super();
    }
  }

  return {
    StdioJsonRpcTransport: MockStdioJsonRpcTransport
  };
});

describe("CodexAppServerClient", () => {
  it("initializes once and normalizes thread/list results", async () => {
    const { CodexAppServerClient } = await import("../codex-app-server/client");

    const client = new CodexAppServerClient({
      command: "codex",
      directoryResolver: async (projectKey) =>
        projectKey
          ? [
              {
                id: "/Users/huntharo/pwrdrvr/PwrAgnt",
                label: "PwrAgnt",
                path: "/Users/huntharo/pwrdrvr/PwrAgnt",
                kind: "worktree"
              }
            ]
          : []
    });

    const threads = await client.listThreads();

    expect(threads).toHaveLength(2);
    expect(threads[0]).toMatchObject({
      id: "thread-2",
      title: "Ship desktop shell",
      source: "codex",
      linkedDirectories: [
        {
          id: "/Users/huntharo/pwrdrvr/PwrAgnt",
          label: "PwrAgnt",
          path: "/Users/huntharo/pwrdrvr/PwrAgnt",
          kind: "worktree"
        }
      ]
    });
    expect(threads[1]?.title).toBe("Plan Codex compatibility");

    await client.close();
  });

  it("does not synthesize summaries from raw conversation text", async () => {
    const { CodexAppServerClient } = await import("../codex-app-server/client");

    const client = new CodexAppServerClient({
      command: "codex",
      directoryResolver: async () => []
    });

    const threads = await client.listThreads();

    expect(threads[1]?.summary).toBeUndefined();

    await client.close();
  });

  it("extracts last user and assistant messages from thread/read", async () => {
    const { CodexAppServerClient } = await import("../codex-app-server/client");

    const client = new CodexAppServerClient({
      command: "codex",
      directoryResolver: async () => []
    });

    const replay = await client.readThread({
      threadId: "thread-2"
    });

    expect(replay).toEqual({
      lastUserMessage: "Show me the current desktop thread shell",
      lastAssistantMessage: "The desktop shell is live and listing Codex threads."
    });

    await client.close();
  });
});
