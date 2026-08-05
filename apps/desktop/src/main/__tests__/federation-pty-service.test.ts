import { describe, expect, it, vi } from "vitest";
import type { FederationRequestEnvelope } from "@pwragent/shared";
import { FEDERATION_PROTOCOL_VERSION } from "@pwragent/shared";
import {
  FEDERATION_PTY_HIGH_WATER_BYTES,
  FEDERATION_PTY_LOW_WATER_BYTES,
  FEDERATION_PTY_METHOD_CAPABILITIES,
  FEDERATION_PTY_METHODS,
  FEDERATION_PTY_OUTPUT_CHUNK_CHARS,
  FederationPtyService,
  registerFederationPtyHandlers,
  type FederationPtyOutputParams,
  type FederationPtyProcess,
} from "../federation/federation-pty-service";
import { FederationRouter } from "../federation/federation-router";

class FakePty implements FederationPtyProcess {
  pid = 4242;
  written: string[] = [];
  resizes: { cols: number; rows: number }[] = [];
  killed = false;
  paused = false;
  pauseCount = 0;
  resumeCount = 0;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<
    (event: { exitCode: number; signal?: number }) => void
  >();

  write(data: string): void {
    this.written.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  kill(): void {
    this.killed = true;
    this.emitExit(0);
  }

  pause(): void {
    this.paused = true;
    this.pauseCount += 1;
  }

  resume(): void {
    this.paused = false;
    this.resumeCount += 1;
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(
    listener: (event: { exitCode: number; signal?: number }) => void,
  ): { dispose(): void } {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  emitData(data: string): void {
    for (const listener of Array.from(this.dataListeners)) {
      listener(data);
    }
  }

  emitExit(exitCode: number): void {
    for (const listener of Array.from(this.exitListeners)) {
      listener({ exitCode });
    }
  }
}

type SentNotification = {
  peerId: string;
  method: string;
  params: unknown;
};

function createHarness(options?: {
  graceMs?: number;
  deliverable?: () => boolean;
  spawnPty?: () => Promise<{
    pty: FederationPtyProcess;
    cwd: string;
    shell: { file: string; args: string[] };
  }>;
}) {
  const pty = new FakePty();
  const sent: SentNotification[] = [];
  const audits: { peerId: string; kind: string; detail: string }[] = [];
  const service = new FederationPtyService({
    spawnPty:
      options?.spawnPty ??
      (async () => ({
        pty,
        cwd: "/owner/worktree",
        shell: { file: "/bin/zsh", args: ["-l"] },
      })),
    resolveThreadCwd: async () => "/owner/worktree",
    sendNotification: (peerId, method, params) => {
      if (options?.deliverable && !options.deliverable()) return false;
      sent.push({ peerId, method, params });
      return true;
    },
    onAudit: (entry) =>
      audits.push({
        peerId: entry.peerId,
        kind: entry.kind,
        detail: entry.detail,
      }),
    graceMs: options?.graceMs ?? 10_000,
  });
  return { audits, pty, sent, service };
}

const OPEN_REQUEST = {
  backend: "codex" as const,
  threadId: "thread-1",
  cols: 80,
  rows: 24,
};

describe("FederationPtyService capability map", () => {
  it("requires remote_pty for every control method", () => {
    const methods = Object.values(FEDERATION_PTY_METHODS);
    expect(methods).toHaveLength(5);
    for (const method of methods) {
      expect(FEDERATION_PTY_METHOD_CAPABILITIES[method]).toBe("remote_pty");
    }
  });
});

describe("FederationPtyService sessions", () => {
  it("opens with the owner-resolved cwd and audits the open", async () => {
    const { audits, service } = createHarness();
    const opened = await service.open("peer-a", OPEN_REQUEST);
    expect(opened.sessionId).toBeTruthy();
    expect(opened.cwd).toBe("/owner/worktree");
    expect(opened.shell).toBe("/bin/zsh");
    expect(audits).toEqual([
      {
        peerId: "peer-a",
        kind: "remote_pty_open",
        detail: "codex:thread-1",
      },
    ]);
  });

  it("rejects input, resize, ack, and close from a non-opener peer", async () => {
    const { pty, service } = createHarness();
    const { sessionId } = await service.open("peer-a", OPEN_REQUEST);
    const dataBase64 = Buffer.from("whoami\r").toString("base64");

    expect(() => service.input("peer-b", { sessionId, dataBase64 })).toThrow(
      /not found for this peer/,
    );
    expect(() =>
      service.resize("peer-b", { sessionId, cols: 100, rows: 30 }),
    ).toThrow(/not found for this peer/);
    expect(() => service.ack("peer-b", { sessionId, bytes: 1 })).toThrow(
      /not found for this peer/,
    );
    expect(() => service.close("peer-b", { sessionId })).toThrow(
      /not found for this peer/,
    );
    expect(pty.written).toEqual([]);

    service.input("peer-a", { sessionId, dataBase64 });
    expect(pty.written).toEqual(["whoami\r"]);
  });

  it("streams output as gapless chunked frames and applies ack-window flow control", async () => {
    const { pty, sent, service } = createHarness();
    const { sessionId } = await service.open("peer-a", OPEN_REQUEST);

    // 2 MiB of ASCII: crosses the 1 MiB high-water mark in one burst.
    const burst = "x".repeat(2 * 1024 * 1024);
    pty.emitData(burst);

    const outputs = sent.filter((entry) => entry.method === "pty.output");
    expect(outputs.length).toBe(
      Math.ceil(burst.length / FEDERATION_PTY_OUTPUT_CHUNK_CHARS),
    );
    const seqs = outputs.map(
      (entry) => (entry.params as FederationPtyOutputParams).seq,
    );
    expect(seqs).toEqual(outputs.map((_, index) => index + 1));
    const totalBytes = outputs.reduce(
      (sum, entry) =>
        sum +
        Buffer.from(
          (entry.params as FederationPtyOutputParams).dataBase64,
          "base64",
        ).length,
      0,
    );
    expect(totalBytes).toBe(burst.length);

    // Above high water: paused exactly once.
    expect(pty.pauseCount).toBe(1);
    expect(pty.paused).toBe(true);

    // Ack down to (but not below) the low-water mark: still paused.
    service.ack("peer-a", {
      sessionId,
      bytes: burst.length - FEDERATION_PTY_LOW_WATER_BYTES - 1,
    });
    expect(pty.resumeCount).toBe(0);

    // Cross the low-water mark: resumed.
    service.ack("peer-a", { sessionId, bytes: 1 });
    expect(pty.resumeCount).toBe(1);
    expect(pty.paused).toBe(false);
    expect(FEDERATION_PTY_HIGH_WATER_BYTES).toBeGreaterThan(
      FEDERATION_PTY_LOW_WATER_BYTES,
    );
  });

  it("keeps counting undeliverable output toward the pause threshold", async () => {
    let deliverable = true;
    const { pty, sent, service } = createHarness({
      deliverable: () => deliverable,
    });
    await service.open("peer-a", OPEN_REQUEST);
    deliverable = false;
    pty.emitData("y".repeat(FEDERATION_PTY_HIGH_WATER_BYTES + 1));
    expect(sent.filter((entry) => entry.method === "pty.output")).toHaveLength(0);
    expect(pty.paused).toBe(true);
  });

  it("notifies exit and forgets the session", async () => {
    const { pty, sent, service } = createHarness();
    const { sessionId } = await service.open("peer-a", OPEN_REQUEST);
    pty.emitExit(3);
    expect(sent.at(-1)).toEqual({
      peerId: "peer-a",
      method: "pty.exit",
      params: { sessionId, exitCode: 3, signal: null },
    });
    expect(() =>
      service.input("peer-a", { sessionId, dataBase64: "" }),
    ).toThrow(/not found for this peer/);
  });
});

describe("FederationPtyService reaping", () => {
  it("kills the session after the grace period on peer disconnect", async () => {
    vi.useFakeTimers();
    try {
      const { audits, pty, service } = createHarness({ graceMs: 10_000 });
      await service.open("peer-a", OPEN_REQUEST);
      service.notifyPeerDisconnected("peer-a");
      vi.advanceTimersByTime(9_999);
      expect(pty.killed).toBe(false);
      vi.advanceTimersByTime(1);
      expect(pty.killed).toBe(true);
      expect(audits.at(-1)).toMatchObject({
        kind: "remote_pty_close",
        detail: "disconnect",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the disconnect reap when the peer reconnects inside the grace", async () => {
    vi.useFakeTimers();
    try {
      const { pty, service } = createHarness({ graceMs: 10_000 });
      const { sessionId } = await service.open("peer-a", OPEN_REQUEST);
      service.notifyPeerDisconnected("peer-a");
      vi.advanceTimersByTime(5_000);
      service.notifyPeerConnected("peer-a");
      vi.advanceTimersByTime(60_000);
      expect(pty.killed).toBe(false);
      // The renderer still holds the sessionId and keeps typing into it.
      service.input("peer-a", {
        sessionId,
        dataBase64: Buffer.from("ls\r").toString("base64"),
      });
      expect(pty.written).toEqual(["ls\r"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies the grace to explicit closes and does not let a reconnect cancel them", async () => {
    vi.useFakeTimers();
    try {
      const { pty, service } = createHarness({ graceMs: 10_000 });
      const { sessionId } = await service.open("peer-a", OPEN_REQUEST);
      service.close("peer-a", { sessionId });
      service.notifyPeerConnected("peer-a");
      vi.advanceTimersByTime(10_000);
      expect(pty.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not leak a shell when the peer disconnects during spawn", async () => {
    const pty = new FakePty();
    let releaseSpawn: (() => void) | undefined;
    const { service } = createHarness({
      spawnPty: async () => {
        await new Promise<void>((resolve) => {
          releaseSpawn = resolve;
        });
        return {
          pty,
          cwd: "/owner/worktree",
          shell: { file: "/bin/zsh", args: ["-l"] },
        };
      },
    });
    const openPromise = service.open("peer-a", OPEN_REQUEST);
    // Let open() progress through resolveThreadCwd into the pending spawn.
    await vi.waitFor(() => {
      expect(releaseSpawn).toBeTypeOf("function");
    });
    service.notifyPeerDisconnected("peer-a");
    releaseSpawn!();
    await expect(openPromise).rejects.toThrow(/disconnected while the terminal/);
    expect(pty.killed).toBe(true);
    expect(service.sessionCountForPeer("peer-a")).toBe(0);
  });

  it("kills every session immediately on owner shutdown", async () => {
    const { pty, service } = createHarness();
    await service.open("peer-a", OPEN_REQUEST);
    service.disposeAll();
    expect(pty.killed).toBe(true);
  });
});

describe("federation pty router integration", () => {
  function buildEnvelope(
    method: string,
    params: unknown,
    sourceInstanceId: string,
  ): FederationRequestEnvelope {
    return {
      id: `req-${method}-${sourceInstanceId}`,
      kind: "request",
      method,
      params,
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      sourceInstanceId,
      targetInstanceId: "owner",
      createdAt: Date.now(),
    };
  }

  function createRouterHarness() {
    const { service, sent } = createHarness();
    const router = new FederationRouter({
      localInstanceId: "owner",
      methodCapabilities: { ...FEDERATION_PTY_METHOD_CAPABILITIES },
    });
    registerFederationPtyHandlers({ router, service });
    return { router, sent, service };
  }

  it("rejects pty methods from a peer without remote_pty", async () => {
    const { router } = createRouterHarness();
    router.registerConnection({
      peerId: "viewer",
      capabilities: ["thread_detail"],
      sendEnvelope: () => undefined,
    });
    const result = await router.routeEnvelope({
      envelope: buildEnvelope(FEDERATION_PTY_METHODS.open, OPEN_REQUEST, "viewer"),
      sourcePeerId: "viewer",
    });
    expect(result).toMatchObject({
      status: "rejected",
      code: "capability_denied",
    });
  });

  it("rejects a gateway-relayed open instead of streaming through a relay", async () => {
    const { router } = createRouterHarness();
    router.registerConnection({
      peerId: "gateway",
      capabilities: ["remote_pty", "gateway_relay"],
      sendEnvelope: () => undefined,
    });
    // The envelope claims to originate from "viewer" but arrived over the
    // gateway's authenticated link.
    const result = await router.routeEnvelope({
      envelope: buildEnvelope(FEDERATION_PTY_METHODS.open, OPEN_REQUEST, "viewer"),
      sourcePeerId: "gateway",
    });
    expect(result).toMatchObject({ status: "rejected" });
    expect((result as { message?: string }).message).toMatch(/point-to-point/);
  });

  it("opens a session for a directly connected peer with remote_pty", async () => {
    const { router, service } = createRouterHarness();
    router.registerConnection({
      peerId: "viewer",
      capabilities: ["remote_pty"],
      sendEnvelope: () => undefined,
    });
    const result = await router.routeEnvelope({
      envelope: buildEnvelope(FEDERATION_PTY_METHODS.open, OPEN_REQUEST, "viewer"),
      sourcePeerId: "viewer",
    });
    expect(result.status).toBe("handled");
    expect(service.sessionCountForPeer("viewer")).toBe(1);
  });
});
