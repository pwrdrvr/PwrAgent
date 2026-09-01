import { vi } from "vitest";
import type {
  AppServerBackendKind,
  AppServerNotification,
  AppServerThreadSummary,
} from "@pwragent/shared";
import { DesktopBackendRegistry } from "../../app-server/backend-registry";
import type { ThreadReadCounts } from "./thread-read-budget";

/**
 * A backend client that serves a fixed thread list and counts what it cost.
 *
 * The registry is the unit under test here, not the provider, so this client
 * does the least a registry needs: answer `thread/list`, accept a notification
 * listener, and record every read. `listCalls` keeps the caller reason of each
 * round trip, which is what makes a budget failure diagnosable — the count says
 * a read was added, the reasons say which caller added it.
 */
export class CountingBackendClient {
  readonly listCalls: Array<{
    callerReason?: string;
    params?: Record<string, unknown>;
  }> = [];
  directoryEnrichmentCallCount = 0;
  /** Resolves before each listing completes, for late-completion ordering. */
  listGate?: Promise<unknown>;
  /** Rejects the next listing, standing in for an unavailable provider. */
  failNextList = false;
  private readonly notificationListeners = new Set<
    (notification: AppServerNotification) => unknown
  >();

  constructor(private threads: AppServerThreadSummary[]) {}

  get counts(): ThreadReadCounts {
    return {
      directoryEnrichments: this.directoryEnrichmentCallCount,
      providerListCalls: this.listCalls.length,
    };
  }

  /** Replace what the provider reports, as an external change would. */
  setThreads(threads: AppServerThreadSummary[]): void {
    this.threads = threads;
  }

  resetCounts(): void {
    this.listCalls.length = 0;
    this.directoryEnrichmentCallCount = 0;
  }

  async close(): Promise<void> {}

  async getInitializeResult(): Promise<unknown> {
    return { methods: ["thread/list", "turn/start"] };
  }

  onNotification(
    listener: (notification: AppServerNotification) => unknown,
  ): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onPendingRequest(): () => void {
    return () => {};
  }

  async listThreads(
    params?: Record<string, unknown>,
    diagnostics?: { callerReason?: string },
  ): Promise<AppServerThreadSummary[]> {
    this.listCalls.push({
      ...(diagnostics?.callerReason
        ? { callerReason: diagnostics.callerReason }
        : {}),
      ...(params ? { params } : {}),
    });
    if (this.listGate) {
      await this.listGate;
    }
    if (this.failNextList) {
      this.failNextList = false;
      throw new Error("provider unavailable");
    }
    return this.threads;
  }

  async enrichThreadDirectories(
    threads: AppServerThreadSummary[],
  ): Promise<AppServerThreadSummary[]> {
    this.directoryEnrichmentCallCount += 1;
    return threads;
  }
}

export function codexThread(
  overrides: Partial<AppServerThreadSummary> & { id: string },
): AppServerThreadSummary {
  return {
    linkedDirectories: [],
    source: "codex",
    title: overrides.id,
    titleSource: "fallback",
    updatedAt: 1_000,
    ...overrides,
  } as AppServerThreadSummary;
}

/**
 * The overlay store surface the registry touches on read paths. Everything the
 * thread-read budgets exercise is a listing or a lookup, so a permissive stub
 * that answers "nothing recorded" keeps these tests about provider reads rather
 * than about sqlite fixtures.
 */
function overlayStoreStub(): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get: (_target, property) => {
        if (property === "then") {
          return undefined;
        }
        const name = String(property);
        return vi.fn(async () => {
          if (name.startsWith("list")) return [];
          if (name.endsWith("States")) return {};
          return undefined;
        });
      },
    },
  ) as Record<string, unknown>;
}

export function createThreadReadRegistry(threads: AppServerThreadSummary[]): {
  client: CountingBackendClient;
  registry: DesktopBackendRegistry;
} {
  const client = new CountingBackendClient(threads);
  const registry = new DesktopBackendRegistry({
    codexClient: client as never,
    overlayStore: overlayStoreStub() as never,
    threadTitleGenerationService: null,
  });
  return { client, registry };
}

/** Publish a provider notification the way a live backend would. */
export async function publishNotification(
  registry: DesktopBackendRegistry,
  notification: AppServerNotification,
  backend: AppServerBackendKind = "codex",
): Promise<void> {
  await registry.publishLocalEvent({ backend, notification });
}
