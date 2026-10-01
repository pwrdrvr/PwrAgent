import type { JsonRpcTransport } from "@pwrdrvr/agent-transport";

/** Contrived protocol data; exercises the production client paginator. */
export class ArchiveCleanupTransport implements JsonRpcTransport {
  static latest: ArchiveCleanupTransport;
  activeIds = ["active", "transition"];
  archivedIds = ["archive-one", "archive-two", "archive-three"];
  readonly listings: Array<{ archived: boolean; cursor?: string }> = [];
  private messageHandler: (message: string) => void = () => {};

  constructor() {
    ArchiveCleanupTransport.latest = this;
  }

  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  setCloseHandler(_handler: (error?: Error) => void): void {}
  setMessageHandler(handler: (message: string) => void): void {
    this.messageHandler = handler;
  }

  send(message: string): void {
    const request = JSON.parse(message) as {
      id?: number;
      method?: string;
      params?: { archived?: boolean; cursor?: string };
    };
    if (request.id === undefined) return;
    let result: unknown = {};
    if (request.method === "initialize") {
      result = { userAgent: "fixture/1.0", codexHome: "/fixture", platformFamily: "unix", platformOs: "linux" };
    } else if (request.method === "thread/list") {
      const archived = request.params?.archived === true;
      const cursor = request.params?.cursor;
      this.listings.push({ archived, cursor });
      const page = cursor ? Number(cursor) : 0;
      const ids = archived ? this.archivedIds.slice(page, page + 1) : this.activeIds;
      result = {
        data: ids.map((id) => ({ id, name: id, updatedAt: 1, cwd: "/fixture/project" })),
        nextCursor: archived && page + 1 < this.archivedIds.length ? String(page + 1) : null,
      };
    }
    this.messageHandler(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  }
}
