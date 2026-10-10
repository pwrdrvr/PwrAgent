import type { AppServerNotification } from "@pwragent/shared";
import type { JsonRpcTransport } from "@pwrdrvr/agent-transport";

/** Contrived protocol data; exercises the production client paginator. */
export class ArchiveCleanupTransport implements JsonRpcTransport {
  static latest: ArchiveCleanupTransport;
  activeIds = ["active", "transition"];
  archivedIds = ["archive-one", "archive-two", "archive-three"];
  readonly listings: Array<{ archived: boolean; cursor?: string }> = [];
  private readonly heldKinds = new Set<boolean>();
  private readonly replies: Array<{ archived: boolean; reply: () => void }> = [];
  private readonly listingWaiters: Array<{ archived: boolean; resolve: () => void }> = [];
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

  emitNotification(notification: AppServerNotification): void {
    this.messageHandler(JSON.stringify({ jsonrpc: "2.0", ...notification }));
  }

  holdNextListing(archived: boolean): void {
    this.heldKinds.add(archived);
  }

  /** Resolves once a `thread/list` of this kind has reached the transport.
   * The client issues it after work no clock can complete (the registry's
   * environment probes stat the host filesystem). */
  whenListing(archived: boolean): Promise<void> {
    if (this.listings.some((listing) => listing.archived === archived)) return Promise.resolve();
    return new Promise((resolve) => { this.listingWaiters.push({ archived, resolve }); });
  }

  releaseListings(archived?: boolean): void {
    const held = this.replies.splice(0);
    for (const response of held) {
      if (archived === undefined || response.archived === archived) response.reply();
      else this.replies.push(response);
    }
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
      for (const waiter of this.listingWaiters.splice(0)) {
        if (waiter.archived === archived) waiter.resolve();
        else this.listingWaiters.push(waiter);
      }
      const page = cursor ? Number(cursor) : 0;
      const ids = archived ? this.archivedIds.slice(page, page + 1) : this.activeIds;
      result = {
        data: ids.map((id) => ({ id, name: id, updatedAt: 1, cwd: "/fixture/project" })),
        nextCursor: archived && page + 1 < this.archivedIds.length ? String(page + 1) : null,
      };
    }
    const reply = () => this.messageHandler(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    if (request.method === "thread/list" && this.heldKinds.delete(request.params?.archived === true)) {
      this.replies.push({ archived: request.params?.archived === true, reply });
    } else {
      reply();
    }
  }
}
